import fs from 'node:fs/promises';
import path from 'node:path';
import { safeGit } from '../../adapters/processes/safe-git.ts';
import type { Workspace, Workspaces } from './workspace.ts';

/** Isolates run files using Git worktrees; only Git bookkeeping is serialized per repository. */
export class GitWorkspaces implements Workspaces {
  private directory: string;
  private bookkeeping = new Map<string, Promise<unknown>>();

  /** Selects the application-owned workspace directory. */
  constructor(input: { directory: string }) {
    this.directory = input.directory;
  }

  /** Opens a new detached worktree, leaving the source branch and other runs untouched. */
  async create(input: { runId: string; root: string; base?: string; previous?: Workspace; signal?: AbortSignal }): Promise<Workspace> {
    if (!/^[a-zA-Z0-9_-]+$/.test(input.runId)) throw new Error('Invalid run workspace ID.');
    const root = await fs.realpath(input.root);
    const previous = this.bookkeeping.get(root) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const base = (await safeGit(['rev-parse', '--verify', '--end-of-options', `${input.base ?? input.previous?.base ?? 'HEAD'}^{commit}`],
        { cwd: root, signal: input.signal })).stdout.trim();
      const target = path.resolve(this.directory, input.runId);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await safeGit(['worktree', 'add', '--detach', target, base], { cwd: root, signal: input.signal });
      const workspace: Workspace = { path: await fs.realpath(target), source: root, base };
      try {
        if (input.previous) await this.copyChanges({ previous: input.previous, target: workspace });
      } catch (error) {
        await safeGit(['worktree', 'remove', '--force', target], { cwd: root }).catch(() => {});
        throw error;
      }
      return workspace;
    });
    this.bookkeeping.set(root, operation);
    try { return await operation; }
    finally { if (this.bookkeeping.get(root) === operation) this.bookkeeping.delete(root); }
  }

  private async copyChanges(input: { previous: Workspace; target: Workspace }): Promise<void> {
    const cwd = input.previous.path;
    const tracked = await safeGit(['diff', '--name-only', '-z', input.previous.base], { cwd });
    const untracked = await safeGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd });
    const files = new Set((tracked.stdout + untracked.stdout).split('\0').filter(Boolean));
    for (const file of files) {
      if (file.split('/').some(part => ['.git', '.buro'].includes(part))) continue;
      const source = path.join(cwd, file), target = path.join(input.target.path, file);
      try {
        await fs.lstat(source);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.cp(source, target, { recursive: true, force: true, dereference: false, verbatimSymlinks: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.rm(target, { recursive: true, force: true });
      }
    }
  }
}
