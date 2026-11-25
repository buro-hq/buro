import { randomUUID } from 'node:crypto';
import type { Notifications } from '../events/notifications.ts';
import type { Projects } from '../projects/project.ts';
import type { Results } from '../results/result.ts';
import type { Runs } from '../runs/run.ts';
import type { Tasks } from '../tasks/task.ts';
import type {
  Deliveries,
  Delivery,
  DeliveryOutcome,
  DeliveryStore,
  ResultPublisher,
} from './delivery.ts';

/** Explicit publishing uses the saved result, without role, score or accepted-commit requirements. */
export class DeliveryService implements Deliveries {
  private store: DeliveryStore;
  private runs: Runs;
  private projects: Projects;
  private tasks: Tasks;
  private results: Results;
  private events: Notifications;
  private implementations: Map<string, ResultPublisher>;
  private active = new Set<{ controller: AbortController; settled: Promise<void> }>();
  private closing = false;

  /** Connects feature APIs and independently replaceable publication implementations. */
  constructor(input: {
    store: DeliveryStore;
    runs: Runs;
    projects: Projects;
    tasks: Tasks;
    results: Results;
    events: Notifications;
    publishers: ResultPublisher[];
  }) {
    this.store = input.store;
    this.runs = input.runs;
    this.projects = input.projects;
    this.tasks = input.tasks;
    this.results = input.results;
    this.events = input.events;
    this.implementations = new Map(input.publishers.map((publisher) => [publisher.id, publisher]));
  }

  /** Returns available implementations, without contacting a remote service. */
  publishers(): { id: string; name: string }[] {
    return [...this.implementations.values()].map(({ id, name }) => ({ id, name }));
  }
  /** Reads current publication observations. */
  async list(input: { runId?: string } = {}): Promise<Delivery[]> {
    return (await this.store.list()).filter(
      (delivery) => !input.runId || delivery.runId === input.runId,
    );
  }

  /** Reserves ownership before asynchronous reads, so shutdown cannot close storage underneath a publication. */
  async publish(input: Parameters<Deliveries['publish']>[0]): Promise<DeliveryOutcome> {
    if (this.closing) return { ok: false, error: 'Publication service is closed.' };
    let release!: () => void;
    const entry = {
      controller: new AbortController(),
      settled: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    this.active.add(entry);
    try {
      return await this.perform(input, entry.controller.signal);
    } finally {
      this.active.delete(entry);
      release();
    }
  }

  private async perform(
    input: Parameters<Deliveries['publish']>[0],
    signal: AbortSignal,
  ): Promise<DeliveryOutcome> {
    const run = await this.runs.get({ id: input.runId });
    if (!run) return { ok: false, error: 'Run not found.' };
    const project = await this.projects.get({ id: run.projectId });
    if (!project) return { ok: false, error: 'Project is disconnected.' };
    const publisher = input.publisherId
      ? this.implementations.get(input.publisherId)
      : this.implementations.values().next().value;
    if (!publisher) return { ok: false, error: 'Publication implementation is unavailable.' };
    const snapshot = await this.results.inspect({ runId: run.id });
    if (!snapshot.ok || snapshot.patch === undefined) return { ok: false, error: snapshot.error };
    if (input.revision !== undefined && input.revision !== snapshot.revision)
      return {
        ok: false,
        error:
          'The result changed after it was read. Refresh its changes before publishing this revision.',
      };
    if (!snapshot.patch) return { ok: false, error: 'There are no changes to publish.' };
    const task = await this.tasks.get({ id: run.taskId }),
      id = randomUUID();
    let delivery: Delivery = {
      id,
      runId: run.id,
      publisherId: publisher.id,
      title: input.title ?? task?.title ?? 'Buro change',
      status: 'publishing',
      createdAt: new Date().toISOString(),
      revision: snapshot.revision,
      branch: input.branch ?? `buro/${id}`,
    };
    await this.save(delivery);
    try {
      const result = await publisher.publish({
        id,
        root: project.root,
        patch: snapshot.patch,
        title: delivery.title,
        description: input.description ?? '',
        remote: input.remote ?? 'origin',
        base: input.base,
        branch: delivery.branch!,
        signal,
      });
      const { ok, ...metadata } = result;
      delivery = { ...delivery, ...metadata, status: ok ? 'published' : 'failed' };
      await this.save(delivery);
      return { ok: result.ok, delivery, error: result.error };
    } catch (error) {
      delivery = {
        ...delivery,
        status: signal.aborted ? 'interrupted' : 'failed',
        error: signal.aborted
          ? 'Publication interrupted. Check the remote before retrying.'
          : error instanceof Error
            ? error.message
            : String(error),
      };
      await this.save(delivery);
      if (!signal.aborted) throw error;
      return { ok: false, delivery, error: delivery.error };
    }
  }

  /** Interrupted remote actions are never silently retried. */
  async recover(): Promise<void> {
    for (const delivery of await this.store.list())
      if (delivery.status === 'publishing')
        await this.store.save({
          ...delivery,
          status: 'interrupted',
          error:
            'The previous process exited during publication. Check the remote before retrying.',
        });
  }
  /** Stops owned publications before application resources close. */
  async close(): Promise<void> {
    this.closing = true;
    for (const entry of this.active) entry.controller.abort();
    await Promise.all([...this.active].map((entry) => entry.settled));
  }
  private async save(delivery: Delivery): Promise<void> {
    await this.store.save(delivery);
    this.events.publish({ type: 'delivery.updated', data: delivery });
  }
}
