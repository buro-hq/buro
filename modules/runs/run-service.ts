import { randomUUID } from 'node:crypto';
import type { Notifications } from '../events/notifications.ts';
import type { Projects } from '../projects/project.ts';
import type { Tasks } from '../tasks/task.ts';
import type { Sessions } from '../sessions/session.ts';
import type { Workspaces } from '../workspaces/workspace.ts';
import type { Settings } from '../settings/settings.ts';
import type { Materials } from '../materials/material.ts';
import type { Run, RunStore, RunOptions, RunResult, Runs } from './run.ts';
import { reviewRun } from './review.ts';
import type { ActivityHistory } from '../sessions/activity.ts';

/** A run is one isolated attempt. Sessions own their tool loop and report their own result. */
export class RunService implements Runs {
  private store: RunStore;
  private tasks: Tasks;
  private projects: Projects;
  private sessions: Sessions;
  private workspaces: Workspaces;
  private events: Notifications;
  private settings: Settings;
  private materials: Materials;
  private activity: ActivityHistory;
  private jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private starting = new Set<{ controller: AbortController; settled: Promise<void> }>();
  private closing = false;

  /** Connects feature APIs through ordinary calls, without a workflow engine or role catalog. */
  constructor(input: {
    store: RunStore;
    tasks: Tasks;
    projects: Projects;
    sessions: Sessions;
    workspaces: Workspaces;
    events: Notifications;
    settings: Settings;
    materials: Materials;
    activity: ActivityHistory;
  }) {
    this.store = input.store;
    this.tasks = input.tasks;
    this.projects = input.projects;
    this.sessions = input.sessions;
    this.workspaces = input.workspaces;
    this.events = input.events;
    this.settings = input.settings;
    this.materials = input.materials;
    this.activity = input.activity;
  }

  /** Lists attempts, optionally restricted to one task or project. */
  async list(input: { taskId?: string; projectId?: string } = {}): Promise<Run[]> {
    return (await this.store.list()).filter(
      (run) =>
        (!input.taskId || run.taskId === input.taskId) &&
        (!input.projectId || run.projectId === input.projectId),
    );
  }

  /** Returns one attempt, independently of the task's current contents. */
  async get(input: { id: string }): Promise<Run | undefined> {
    return this.store.get(input.id);
  }

  /** Starts an independent attempt; another run in the same project is not a blocker. */
  async start(input: {
    taskId: string;
    options?: RunOptions;
    previousRunId?: string;
  }): Promise<RunResult> {
    if (this.closing)
      return { ok: false, error: 'Run service is closed.' };

    let release!: () => void;
    const entry = {
      controller: new AbortController(),
      settled: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    this.starting.add(entry);
    try {
      return await this.startAttempt(structuredClone(input), entry.controller);
    } catch (error) {
      if (entry.controller.signal.aborted)
        return { ok: false, error: 'Run startup was interrupted. Saved work is preserved.' };

      throw error;
    } finally {
      this.starting.delete(entry);
      release();
    }
  }

  private async startAttempt(
    input: { taskId: string; options?: RunOptions; previousRunId?: string },
    controller: AbortController,
  ): Promise<RunResult> {
    input = structuredClone(input);
    const previous = input.previousRunId ? await this.store.get(input.previousRunId) : undefined;
    if (input.previousRunId && (!previous || previous.taskId !== input.taskId))
      return { ok: false, error: 'The earlier attempt does not belong to this task.' };

    const task =
      (await this.tasks.get({
        id: input.taskId,
      })) ??
      (previous?.title !== undefined
        ? {
            id: previous.taskId,
            projectId: previous.projectId,
            title: previous.title,
            description: previous.description ?? '',
          }
        : undefined);
    if (!task)
      return { ok: false, error: 'Task not found.' };

    const project = await this.projects.get({
      id: task.projectId,
    });
    if (!project)
      return { ok: false, error: 'Project not found.' };

    if (previous && this.jobs.has(previous.id))
      return { ok: false, error: 'Stop the current attempt before starting its successor.' };

    const history = previous
      ? await this.sessions.get({
          id: previous.sessionId,
        })
      : undefined;
    const settings = await this.settings.get();
    const review = { ...settings.review, ...input.options?.review };
    const materials = await this.materials.list({
      projectId: project.id,
      taskId: task.id,
    });
    const id = randomUUID();
    controller.signal.throwIfAborted();
    const prompt = [
      task.title,
      task.description,
      materials.length
        ? 'Attached context (read text ranges with material_read):\n' + JSON.stringify(materials)
        : '',
      previous
        ? 'Continue from the saved files and previous conversation. This is a new attempt. Inspect the current state rather than repeating completed actions.'
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const created = await this.sessions.create({
      runId: id,
      context: prompt,
      modelId: input.options?.modelId ?? history?.modelId ?? settings.defaultModelId,
      instructions: input.options?.instructions ?? history?.instructions ?? settings.instructions,
      access: { tools: input.options?.tools, readOnly: input.options?.readOnly },
      sourceSessionId: history?.id,
    });
    if (!created.ok)
      return { ok: false, error: created.error };

    let workspace;
    try {
      const prepared = await this.workspaces.create({
        runId: id,
        root: project.root,
        base: input.options?.base,
        signal: controller.signal,
        previous: previous
          ? { path: previous.workspace, base: previous.base, source: project.root }
          : undefined,
      });
      if (!prepared.ok || !prepared.workspace) {
        await this.sessions.delete({
          id: created.sessionId,
        });
        return { ok: false, error: prepared.error };
      }

      workspace = prepared.workspace;
    } catch (error) {
      await this.sessions.delete({
        id: created.sessionId,
      });
      throw error;
    }
    const run: Run = {
      id,
      taskId: task.id,
      title: task.title,
      description: task.description,
      projectId: project.id,
      sessionId: created.sessionId,
      workspace: workspace.path,
      base: workspace.base,
      status: 'running',
      createdAt: new Date().toISOString(),
      previousRunId: previous?.id,
      options: structuredClone(input.options ?? {}),
      ...(review.enabled
        ? { review: { configuration: structuredClone(review), status: 'pending', reports: [] } }
        : {}),
    };
    let release!: (start: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const promise = (async () => {
      try {
        const start = await ready;
        if (start)
          await this.execute({
            run,
            prompt,
            options: input.options ?? {},
            signal: controller.signal,
          });
      } finally {
        this.jobs.delete(id);
      }
    })();
    this.jobs.set(id, {
      controller,
      promise,
    });
    // Keep background failures observed; callers can still see them through wait/close.
    void promise.catch((error) =>
      this.events.publish({
        type: 'run.error',
        data: { runId: id, error: error instanceof Error ? error.message : String(error) },
      }));
    try {
      await this.save(run);
      release(true);
    } catch (error) {
      release(false);
      throw error;
    }
    return { ok: true, run: structuredClone(run) };
  }

  /** Continues preserved work as a new run with its own workspace and linked conversation. */
  async retry(input: { id: string; options?: RunOptions }): Promise<RunResult> {
    const run = await this.store.get(input.id);
    if (!run)
      return { ok: false, error: 'Run not found.' };

    if (this.jobs.has(run.id))
      return { ok: false, error: 'Stop the current attempt before starting its successor.' };

    const { modelId: _initialModel, base: _initialBase, ...retained } = run.options ?? {};
    return this.start({
      taskId: run.taskId,
      previousRunId: run.id,
      options: {
        ...retained,
        ...input.options,
        ...(retained.review || input.options?.review
          ? { review: { ...retained.review, ...input.options?.review } }
          : {}),
      },
    });
  }

  /** Requests cancellation without discarding files or historical messages. */
  cancel(input: { id: string }): void {
    this.jobs.get(input.id)?.controller.abort();
  }

  /** Waits for the current attempt and returns its persisted result. */
  async wait(input: { id: string }): Promise<Run | undefined> {
    await this.jobs.get(input.id)?.promise;
    return this.store.get(input.id);
  }

  /** Marks abandoned attempts interrupted; continuing them creates new attempts rather than replaying steps. */
  async recover(): Promise<void> {
    for (const run of await this.store.list())
      if (run.status === 'running' && !this.jobs.has(run.id))
        await this.save({
          ...run,
          status: 'interrupted',
          ...(run.review && ['pending', 'running'].includes(run.review.status)
            ? {
                review: {
                  ...run.review,
                  status: 'interrupted',
                  reports: run.review.reports.map((report) => report.status === 'running'
                    ? { ...report, status: 'interrupted' }
                    : report),
                },
              }
            : {}),
          finishedAt: new Date().toISOString(),
          error:
            'The previous process stopped. Continue as a new attempt using the saved workspace and history.',
        });
  }

  /** Stops model work and waits for every active run to settle before storage closes. */
  async close(): Promise<void> {
    this.closing = true;
    for (const entry of this.starting)
      entry.controller.abort();
    for (const job of this.jobs.values())
      job.controller.abort();
    await Promise.all([...this.starting].map((entry) => entry.settled));
    for (const job of this.jobs.values())
      job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
  }

  private async execute(input: {
    run: Run;
    prompt: string;
    options: RunOptions;
    signal: AbortSignal;
  }): Promise<void> {
    let run = input.run;
    try {
      let result = await this.sessions.run({
        sessionId: input.run.sessionId,
        input: input.prompt,
        workspace: input.run.workspace,
        projectId: input.run.projectId,
        tools: input.options.tools,
        readOnly: input.options.readOnly,
        signal: input.signal,
      });
      await this.sessions.close({
        runId: input.run.id,
      });
      if (result.ok && run.review) {
        const reviewed = await reviewRun({
          sessions: this.sessions,
          activity: this.activity,
          run,
          prompt: input.prompt,
          result,
          configuration: run.review.configuration,
          signal: input.signal,
          update: async (progress) => {
            run = {
              ...run,
              review: {
                configuration: run.review!.configuration,
                status: progress.status,
                reports: progress.reviews,
                error: progress.error,
              },
            };
            await this.save(run);
          },
        });
        result = reviewed.result;
      }

      await this.sessions.close({
        runId: run.id,
      });
      await this.save({
        ...run,
        status: result.ok ? 'completed' : result.interrupted ? 'interrupted' : 'failed',
        result: result.text,
        error: result.error,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.sessions.close({
        runId: input.run.id,
      });
      await this.save({
        ...run,
        status: input.signal.aborted ? 'interrupted' : 'failed',
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      });
    }
  }

  private async save(run: Run): Promise<void> {
    await this.store.save(run);
    this.events.publish({
      type: 'run.updated',
      data: run,
    });
  }
}
