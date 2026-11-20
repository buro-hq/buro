import { DomainError, type AgentRuntime, type RuntimeRegistry } from './ports.ts';

/** Process-local adapter catalog. Durable session routing is a separate responsibility. */
export class RuntimeCatalog implements RuntimeRegistry {
  private adapters = new Map<string, AgentRuntime>();
  private closing = false;
  private disposal?: Promise<void>;

  register(adapter: AgentRuntime) {
    this.assertOpen();
    if (!adapter.id.trim()) throw new DomainError('INVALID_RUNTIME', 'A runtime needs an ID.');
    if (this.adapters.has(adapter.id))
      throw new DomainError('RUNTIME_EXISTS', `Runtime already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
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
