import { DomainError, type MutableProjectRegistry, type ProjectStore } from './ports.ts';

/** Owns registered stores, independently of their storage implementation. */
export class ProjectStoreRegistry implements MutableProjectRegistry {
  #stores = new Map<string, ProjectStore>();
  #closing = false;
  #disposal?: Promise<void>;

  constructor(stores: ProjectStore[] = []) {
    for (const store of stores) this.add(store);
  }

  #assertOpen() {
    if (this.#closing)
      throw new DomainError('PROJECT_REGISTRY_CLOSED', 'The project registry is closing.');
  }

  get(id: string): ProjectStore {
    this.#assertOpen();
    const store = this.#stores.get(id);
    if (!store) throw new DomainError('PROJECT_NOT_FOUND', 'Project is not registered.');
    return store;
  }

  add(store: ProjectStore): void {
    this.#assertOpen();
    const id = store.snapshot().project.id;
    if (!id.trim()) throw new DomainError('INVALID_PROJECT', 'A project needs a nonempty ID.');
    if (this.#stores.has(id))
      throw new DomainError('PROJECT_EXISTS', 'A project with this ID is already open.');
    this.#stores.set(id, store);
  }

  list() {
    this.#assertOpen();
    return [...this.#stores.values()].map((store) => structuredClone(store.snapshot().project));
  }

  close(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#closing = true;
    this.#disposal = (async () => {
      const results = await Promise.allSettled(
        [...this.#stores.values()].map((store) => Promise.resolve().then(() => store.close())),
      );
      this.#stores.clear();
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, 'Project storage cleanup failed.');
    })();
    return this.#disposal;
  }
}
