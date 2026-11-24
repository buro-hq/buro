import fs from 'node:fs/promises';
import path from 'node:path';
import { safeGit } from '../../adapters/processes/safe-git.ts';
import { captureGitTree } from './git-snapshot.ts';
import type { Workspace, WorkspaceResult, Workspaces } from './workspace.ts';

/** Isolates run files using Git worktrees; only Git bookkeeping is serialized per repository. */
export class GitWorkspaces implements Workspaces {
  private directory: string;
  private bookkeeping = new Map<string, Promise<unknown>>();

  /** Selects the application-owned workspace directory. */
  constructor(input: { directory: string }) {
    this.directory = input.directory;
  }

  /** Opens a new detached worktree, leaving the source branch and other runs untouched. */
  async create(input: {
    runId: string;
    root: string;
    base?: string;
    previous?: Workspace;
    signal?: AbortSignal;
  }): Promise<WorkspaceResult> {
    if (!/^[a-zA-Z0-9_-]+$/.test(input.runId)) throw new Error('Invalid run workspace ID.');
    let root: string;
    try {
      root = await fs.realpath(input.root);
    } catch (error) {
      if (
        ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        return { ok: false, error: 'The project directory is missing or inaccessible.' };
      throw error;
    }
    const previous = this.bookkeeping.get(root) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const base = (
          await safeGit(
            [
              'rev-parse',
              '--verify',
              '--end-of-options',
              `${input.base ?? input.previous?.base ?? 'HEAD'}^{commit}`,
            ],
            { cwd: root, signal: input.signal },
          )
        ).stdout.trim();
        const target = path.resolve(this.directory, input.runId);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await safeGit(['worktree', 'add', '--detach', target, base], {
          cwd: root,
          signal: input.signal,
        });
        const workspace: Workspace = { path: await fs.realpath(target), source: root, base };
        try {
          if (input.previous)
            await this.copyChanges({ previous: input.previous, target: workspace });
          else if (input.base === undefined) {
            await this.copyChanges({
              previous: { path: root, source: root, base },
              target: workspace,
            });
            const tree = await captureGitTree({ workspace: workspace.path, base });
            const initialTree = (
              await safeGit(['rev-parse', `${base}^{tree}`], { cwd: workspace.path })
            ).stdout.trim();
            if (tree !== initialTree) {
              const baseline = (
                await safeGit(
                  [
                    '-c',
                    'user.name=Buro',
                    '-c',
                    'user.email=buro@localhost',
                    'commit-tree',
                    tree,
                    '-p',
                    base,
                    '-m',
                    'Buro workspace baseline',
                  ],
                  { cwd: workspace.path },
                )
              ).stdout.trim();
              await safeGit(['reset', '--hard', baseline], { cwd: workspace.path });
              workspace.base = baseline;
            }
          }
        } catch (error) {
          await safeGit(['worktree', 'remove', '--force', target], { cwd: root }).catch(() => {});
          throw error;
        }
        return workspace;
      });
    this.bookkeeping.set(root, operation);
    try {
      return { ok: true, workspace: await operation };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (
        typeof code === 'number' ||
        (typeof code === 'string' && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code))
      )
        return {
          ok: false,
          error:
            'The workspace could not be prepared. Check that the Git repository and base revision exist, Git is installed, and the directory is writable.',
        };
      throw error;
    } finally {
      if (this.bookkeeping.get(root) === operation) this.bookkeeping.delete(root);
    }
  }

  private async copyChanges(input: { previous: Workspace; target: Workspace }): Promise<void> {
    const cwd = input.previous.path;
    const tracked = await safeGit(['diff', '--name-only', '-z', input.previous.base], { cwd });
    const untracked = await safeGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd });
    const files = new Set((tracked.stdout + untracked.stdout).split('\0').filter(Boolean));
    for (const file of [...files].sort((a, b) => a.split('/').length - b.split('/').length)) {
      if (file.split('/').some((part) => ['.git', '.buro'].includes(part))) continue;
      if (
        !(await this.directoryParents(cwd, file)) ||
        !(await this.directoryParents(input.target.path, file))
      )
        continue;
      const source = path.join(cwd, file),
        target = path.join(input.target.path, file);
      try {
        await fs.lstat(source);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rm(target, { recursive: true, force: true });
        await fs.cp(source, target, {
          recursive: true,
          force: true,
          dereference: false,
          verbatimSymlinks: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.rm(target, { recursive: true, force: true });
      }
    }
  }

  private async directoryParents(root: string, relative: string): Promise<boolean> {
    let current = root;
    for (const segment of relative.split('/').slice(0, -1)) {
      current = path.join(current, segment);
      try {
        if (!(await fs.lstat(current)).isDirectory()) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        throw error;
      }
    }
    return true;
  }
}
