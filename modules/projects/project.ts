import type { RecordStore } from '../storage/record-store.ts';

/** A source directory; model choices belong to application defaults or a run's options. */
export interface Project {
  id: string;
  name: string;
  root: string;
}

/** Stores project identities without owning task or execution records. */
export interface ProjectStore extends RecordStore<Project> {}

/** Project operations expose identities and paths, not a mutable application aggregate. */
export interface Projects {
  /** Lists connected source directories. */
  list(): Promise<Project[]>;
  /** Returns one connected directory. */
  get(input: { id: string }): Promise<Project | undefined>;
  /** Connects a source directory. */
  connect(input: { root: string; name?: string }): Promise<Project>;
  /** Removes the connection without deleting files. */
  disconnect(input: { id: string }): Promise<void>;
}
