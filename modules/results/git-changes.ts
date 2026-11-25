import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeGit } from '../repositories/git.ts';
import { captureGitTree } from '../repositories/snapshot.ts';
import type { RepositoryChanges, ResultOutcome } from './result.ts';

/** Uses an isolated temporary index, preserving binary changes, executable modes and new files. */
export class GitChanges implements RepositoryChanges {
  /** Snapshots the workspace without staging files in its live index or creating a commit. */
  async inspect(input: { workspace: string; base: string }): Promise<ResultOutcome> {
    const options = { cwd: input.workspace };
    try {
      const tree = await captureGitTree(input);
      const patch = (
        await safeGit(
          ['diff', '--binary', '--no-ext-diff', '--no-renames', input.base, tree],
          options,
        )
      ).stdout;
      const names = (
        await safeGit(['diff', '--name-status', '--no-renames', '-z', input.base, tree], options)
      ).stdout.split('\0');
      const files = [];
      for (let index = 0; index + 1 < names.length; index += 2)
        files.push({ status: names[index], path: names[index + 1] });
      return { ok: true, patch, files, revision: createHash('sha256').update(patch).digest('hex') };
    } catch (error) {
      return this.expected(error);
    }
  }

  /** Applies a whole patch after Git's conflict check; no pristine-tree or review-status gate is required. */
  async apply(input: { root: string; patch: string }): Promise<ResultOutcome> {
    if (!input.patch) return { ok: true };
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-apply-'));
    const filename = path.join(directory, 'changes.patch');
    try {
      await fs.writeFile(filename, input.patch, { mode: 0o600 });
      await safeGit(['apply', '--check', '--binary', filename], { cwd: input.root });
      await safeGit(['apply', '--binary', filename], { cwd: input.root });
      return { ok: true };
    } catch (error) {
      return this.expected(error);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  private expected(error: unknown): ResultOutcome {
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === 'number' ||
      (typeof code === 'string' && ['ENOENT', 'EACCES', 'EPERM'].includes(code))
    )
      return {
        ok: false,
        error:
          'Git could not inspect or apply this result. The repository may be unavailable or the changes may conflict with current source files.',
      };
    throw error;
  }
}
