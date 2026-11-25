import type { ApiMethods } from '../modules/api/contract.ts';
import type { ApiClient } from '../modules/api/client.ts';
import type { Run } from '../modules/runs/run.ts';
import type { Notification } from '../modules/events/notifications.ts';

/** A thin CLI invokes the same feature methods as the UI, without reconstructing an application snapshot. */
export class FeatureCli {
  private client: ApiClient;
  private observe: (notice: Notification) => void;

  /** Selects transport and notification output independently of process arguments. */
  constructor(input: { client: ApiClient; observe?: (notice: Notification) => void }) {
    this.client = input.client;
    this.observe = input.observe ?? (() => {});
  }

  /** Forwards untrusted input to the server's validation boundary exactly once. */
  async call(input: { method: string; params: unknown }): Promise<unknown> {
    if (input.method === 'status') {
      const [projects, models, settings] = await Promise.all([
        this.client.call('projects.list', {}),
        this.client.call('models.list', {}),
        this.client.call('settings.get', {}),
      ]);
      return { projects, models, settings };
    }
    return this.client.call(
      input.method as keyof ApiMethods,
      input.params as ApiMethods[keyof ApiMethods]['params'],
    );
  }

  /** Observes an attempt until it stops, without imposing an execution time limit. */
  async watch(input: { id: string; signal?: AbortSignal }): Promise<Run> {
    input.signal?.throwIfAborted();
    return new Promise<Run>((resolve, reject) => {
      let settled = false,
        reading = false,
        dirty = false;
      const finish = (run?: Run, error?: unknown) => {
        if (settled) return;
        settled = true;
        off();
        offConnection();
        input.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(run!);
      };
      const read = async () => {
        if (settled) return;
        if (reading) {
          dirty = true;
          return;
        }
        reading = true;
        try {
          const run = await this.client.call('runs.get', { id: input.id });
          if (!run) finish(undefined, new Error('Run not found.'));
          else if (run.status !== 'running') finish(run);
        } catch (error) {
          finish(undefined, error);
        } finally {
          reading = false;
          if (dirty && !settled) {
            dirty = false;
            void read();
          }
        }
      };
      const off = this.client.subscribe((notice) => {
        const data = notice.data as { id?: string; runId?: string };
        if ((notice.type === 'run.updated' && data.id === input.id) || data.runId === input.id)
          this.observe(notice);
        if (notice.type === 'run.updated' && data.id === input.id) void read();
      });
      const offConnection = this.client.onConnection((connection) => {
        if (!connection.connected)
          finish(
            undefined,
            new Error('Connection lost. Reconnect and read the saved run before continuing.'),
          );
      });
      const abort = () => finish(undefined, input.signal?.reason ?? new Error('Watching stopped.'));
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) abort();
      else void read();
    });
  }
}
