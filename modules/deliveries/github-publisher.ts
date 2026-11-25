import { safeGit } from '../repositories/git.ts';
import { GitWorkspaces } from '../workspaces/git-workspaces.ts';
import { captureGitTree } from '../repositories/snapshot.ts';
import { GitChanges } from '../results/git-changes.ts';
import type { ResultPublisher } from './delivery.ts';
import { GitHubPullRequests, type PullRequests } from './github-pull-requests.ts';

/** Publishes only the run delta onto a fresh remote base, excluding the user's initial dirty files. */
export class GitHubPublisher implements ResultPublisher {
  readonly id = 'github';
  readonly name = 'GitHub draft PR';
  private workspaces: GitWorkspaces;
  private pullRequests: PullRequests;
  private protocols: string[];
  constructor(input: { directory: string; pullRequests?: PullRequests; protocols?: string[] }) {
    this.workspaces = new GitWorkspaces({ directory: input.directory });
    this.pullRequests = input.pullRequests ?? new GitHubPullRequests();
    this.protocols = [...(input.protocols ?? ['https', 'ssh'])];
  }

  async publish(
    input: Parameters<ResultPublisher['publish']>[0],
  ): ReturnType<ResultPublisher['publish']> {
    let workspace: string | undefined,
      commit: string | undefined,
      pushed = false;
    try {
      const source = { cwd: input.root, signal: input.signal },
        network = this.protocols.flatMap((protocol) => ['-c', `protocol.${protocol}.allow=always`]);
      await safeGit(['check-ref-format', '--branch', input.branch], source);
      await safeGit(['remote', 'get-url', '--', input.remote], source);
      const prefix = `refs/remotes/${input.remote}/`;
      const base =
        input.base ??
        (await safeGit(['symbolic-ref', '--quiet', prefix + 'HEAD'], source)).stdout
          .trim()
          .slice(prefix.length);
      await safeGit(['check-ref-format', `refs/heads/${base}`], source);
      const reference = `refs/buro/deliveries/${input.id}/base`;
      await safeGit(
        [...network, 'fetch', '--no-tags', '--', input.remote, `refs/heads/${base}:${reference}`],
        source,
      );
      const prepared = await this.workspaces.create({
        runId: input.id,
        root: input.root,
        base: reference,
        signal: input.signal,
      });
      if (!prepared.workspace) return { ok: false, error: prepared.error };
      workspace = prepared.workspace.path;
      const changes = new GitChanges(),
        applied = await changes.apply({ root: workspace, patch: input.patch });
      if (!applied.ok)
        return {
          ok: false,
          workspace,
          error:
            'The result conflicts with the publication base. The isolated publication workspace is preserved.',
        };
      const tree = await captureGitTree({ workspace, base: prepared.workspace.base }),
        options = { cwd: workspace, signal: input.signal };
      commit = (
        await safeGit(
          [
            '-c',
            'user.name=Buro',
            '-c',
            'user.email=buro@localhost',
            'commit-tree',
            tree,
            '-p',
            prepared.workspace.base,
            '-m',
            input.title,
          ],
          options,
        )
      ).stdout.trim();
      await safeGit(['reset', '--hard', commit], options);
      await safeGit(
        [...network, 'push', '--', input.remote, `${commit}:refs/heads/${input.branch}`],
        options,
      );
      pushed = true;
      const result = await this.pullRequests.create({
        workspace,
        remote: input.remote,
        branch: input.branch,
        base,
        title: input.title,
        description: input.description,
        signal: input.signal,
      });
      return { ...result, workspace, commit };
    } catch (error) {
      if (input.signal.aborted) throw error;
      const code = (error as { code?: unknown }).code;
      if (
        typeof code === 'number' ||
        (typeof code === 'string' && ['ENOENT', 'EACCES', 'EPERM'].includes(code))
      )
        return {
          ok: false,
          workspace,
          commit,
          error: pushed
            ? 'The branch was pushed, but PR creation failed. Check the remote before retrying.'
            : 'Publication failed. Check the remote, its default or explicit base branch, Git authentication and the requested branch name.',
        };
      throw error;
    }
  }
}
