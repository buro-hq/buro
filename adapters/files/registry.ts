import { DomainError, type ProjectRegistry, type ProjectStore } from '../../core/ports.ts';
export class FileProjectRegistry implements ProjectRegistry {
  stores: Map<string, ProjectStore>;
  constructor(stores: ProjectStore[]) {
    this.stores = new Map(stores.map((s) => [s.snapshot().project.id, s]));
  }
  get(id: string) {
    const store = this.stores.get(id);
    if (!store) throw new DomainError('PROJECT_NOT_FOUND', 'Project is not registered.');
    return store;
  }
  add(store: ProjectStore) {
    const id = store.snapshot().project.id;
    if (this.stores.has(id))
      throw new DomainError('PROJECT_EXISTS', 'A project with this ID is already open.');
    this.stores.set(id, store);
  }
  list() {
    return [...this.stores.values()].map((s) => s.snapshot().project);
  }
  async close() {
    await Promise.all([...this.stores.values()].map((s) => s.close()));
  }
}
