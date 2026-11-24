import type { Notifications } from '../events/notifications.ts';
import type { Projects } from '../projects/project.ts';
import type { Runs } from '../runs/run.ts';
import type { RepositoryChanges, ResultOutcome, Results } from './result.ts';

/** Reads run files through feature APIs; combining them is independent of completion or acceptance. */
export class ResultService implements Results {
  private runs: Runs;
  private projects: Projects;
  private changes: RepositoryChanges;
  private events: Notifications;

  /** Connects run identities to repository mechanics and notifications. */
  constructor(input: {
    runs: Runs;
    projects: Projects;
    changes: RepositoryChanges;
    events: Notifications;
  }) {
    this.runs = input.runs;
    this.projects = input.projects;
    this.changes = input.changes;
    this.events = input.events;
  }

  /** Inspects an attempt even when its task definition was removed or changed. */
  async inspect(input: { runId: string }): Promise<ResultOutcome> {
    const run = await this.runs.get({ id: input.runId });
    if (!run) return { ok: false, error: 'Run not found.' };
    return this.changes.inspect({ workspace: run.workspace, base: run.base });
  }

  /** Applies a concrete patch without requiring a special reviewer or a generated commit. */
  async apply(input: { runId: string; revision?: string }): Promise<ResultOutcome> {
    const run = await this.runs.get({ id: input.runId });
    if (!run) return { ok: false, error: 'Run not found.' };
    const project = await this.projects.get({ id: run.projectId });
    if (!project) return { ok: false, error: 'Project not found.' };
    const snapshot = await this.inspect(input);
    if (!snapshot.ok || snapshot.patch === undefined) return snapshot;
    if (input.revision !== undefined && snapshot.revision !== input.revision)
      return {
        ok: false,
        error:
          'The workspace changed after this view was read. Refresh its changes before applying this revision.',
      };
    const result = await this.changes.apply({ root: project.root, patch: snapshot.patch });
    if (result.ok)
      this.events.publish({
        type: 'result.applied',
        data: { runId: run.id, revision: snapshot.revision },
      });
    return result;
  }
}
