import { DomainError, type RegisteredRuntime, type RuntimeRegistry } from './ports.ts';
import { freezeBackendCapabilities } from './backend-capabilities.ts';

/** Process-local adapter catalog. Durable session routing is a separate responsibility. */
export class RuntimeCatalog implements RuntimeRegistry {
  private adapters = new Map<string, RegisteredRuntime>();
  private closing = false;
  private disposal?: Promise<void>;

  register(adapter: RegisteredRuntime) {
    this.assertOpen();
    if (!adapter.id.trim()) throw new DomainError('INVALID_RUNTIME', 'A runtime needs an ID.');
    if (this.adapters.has(adapter.id))
      throw new DomainError('RUNTIME_EXISTS', `Runtime already registered: ${adapter.id}`);
    const capabilities = freezeBackendCapabilities(adapter.capabilities);
    if (
      (capabilities.structuredTurns && typeof adapter.turn !== 'function') ||
      (capabilities.resumeSessions && typeof adapter.resume !== 'function')
    )
      throw new DomainError(
        'INVALID_BACKEND_CAPABILITIES',
        'The declared backend mechanics require their corresponding execution methods.',
      );
    const registered: RegisteredRuntime = {
      id: adapter.id,
      capabilities,
      start: adapter.start.bind(adapter),
      submit: adapter.submit.bind(adapter),
      interrupt: adapter.interrupt.bind(adapter),
      dispose: adapter.dispose.bind(adapter),
      ...(adapter.resume ? { resume: adapter.resume.bind(adapter) } : {}),
      ...(adapter.turn ? { turn: adapter.turn.bind(adapter) } : {}),
      ...(adapter.subscribe ? { subscribe: adapter.subscribe.bind(adapter) } : {}),
      ...(adapter.canRetry ? { canRetry: adapter.canRetry.bind(adapter) } : {}),
      ...(adapter.release ? { release: adapter.release.bind(adapter) } : {}),
    };
    this.adapters.set(adapter.id, Object.freeze(registered));
  }

  list() {
    this.assertOpen();
    return [...this.adapters.keys()];
  }

  get(id: string) {
    this.assertOpen();
    const adapter = this.adapters.get(id);
    if (!adapter) throw new DomainError('RUNTIME_UNAVAILABLE', `Runtime unavailable: ${id}`);
    return adapter;
  }

  private assertOpen() {
    if (this.closing) throw new DomainError('RUNTIME_CLOSED', 'The runtime registry stopped.');
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    this.disposal = (async () => {
      const results = await Promise.allSettled(
        [...this.adapters.values()].map((adapter) =>
          Promise.resolve().then(() => adapter.dispose()),
        ),
      );
      this.adapters.clear();
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, 'Runtime cleanup failed.');
    })();
    return this.disposal;
  }
}
