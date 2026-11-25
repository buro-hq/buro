import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeGit } from '../repositories/git.ts';

/** A remote PR operation is separate from local workspace and commit preparation. */
export interface PullRequests {
  /** Creates a draft PR; an omitted description remains empty. */
  create(input: {
    workspace: string;
    remote: string;
    branch: string;
    base: string;
    title: string;
    description: string;
    signal: AbortSignal;
  }): Promise<{ ok: boolean; url?: string; error?: string }>;
}
const exec = promisify(execFile);

/** Uses the user's authenticated GitHub CLI without placing a multiline body in shell arguments. */
export class GitHubPullRequests implements PullRequests {
  async create(
    input: Parameters<PullRequests['create']>[0],
  ): Promise<{ ok: boolean; url?: string; error?: string }> {
    const remote = (
      await safeGit(['remote', 'get-url', '--', input.remote], {
        cwd: input.workspace,
        signal: input.signal,
      })
    ).stdout.trim();
    let repository: string;
    if (/^[^@\s]+@[^:\s]+:.+$/.test(remote))
      repository = remote.slice(remote.indexOf('@') + 1).replace(':', '/');
    else {
      try {
        const url = new URL(remote);
        repository = url.host + url.pathname;
      } catch {
        return {
          ok: false,
          error: 'The branch was pushed, but this remote URL cannot be used by GitHub CLI.',
        };
      }
    }
    repository = repository.replace(/\.git$/, '');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-pr-')),
      filename = path.join(directory, 'body.txt');
    try {
      await fs.writeFile(filename, input.description, { mode: 0o600 });
      const result = await exec(
        'gh',
        [
          'pr',
          'create',
          '--draft',
          '--repo',
          repository,
          '--base',
          input.base,
          '--head',
          input.branch,
          '--title',
          input.title,
          '--body-file',
          filename,
        ],
        { cwd: input.workspace, signal: input.signal, maxBuffer: 1024 * 1024 },
      );
      const url = result.stdout
        .trim()
        .split('\n')
        .reverse()
        .find((line) => /^https?:\/\//.test(line));
      return url
        ? { ok: true, url }
        : {
            ok: false,
            error:
              'The branch was pushed, but GitHub CLI did not return a PR URL. Check the remote before retrying.',
          };
    } catch (error) {
      if (input.signal.aborted) throw error;
      if (
        typeof (error as { code?: unknown }).code === 'number' ||
        ['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        return {
          ok: false,
          error:
            'The branch was pushed, but creating its PR failed. Check GitHub CLI authentication and the remote before retrying.',
        };
      throw error;
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
