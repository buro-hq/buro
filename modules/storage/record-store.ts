/** A record owned by one feature module. */
export interface StoredRecord {
  id: string;
}

/** Equality selection and a bounded window, evaluated by the storage adapter. */
export interface RecordQuery<T> {
  where?: Partial<T>;
  orderBy?: keyof T & string;
  descending?: boolean;
  before?: number;
  after?: number;
  limit?: number;
  offset?: number;
}

/** One atomic namespace update, including related records owned by the same feature. */
export interface RecordWrite<T> {
  save?: T[];
  delete?: Partial<T>;
}

/** Persists current records. The activity journal is independent of this contract. */
export interface RecordStore<T extends StoredRecord> {
  /** Returns a detached record, or undefined when it does not exist. */
  get(id: string): Promise<T | undefined>;
  /** Returns detached records in insertion order. */
  list(input?: RecordQuery<T>): Promise<T[]>;
  /** Commits related changes together; deletion is applied before the saved records. */
  write(input: RecordWrite<T>): Promise<void>;
  /** Inserts or replaces one record without changing the caller's object. */
  save(record: T): Promise<void>;
  /** Merges fields into the latest saved record without replacing unrelated concurrent updates. */
  patch(input: {
    id: string;
    changes: Partial<Omit<T, 'id'>>;
    initial?: T;
  }): Promise<T | undefined>;
  /** Removes one record, including when it has already been removed. */
  delete(id: string): Promise<void>;
}

/** A persistence adapter supplies independent stores for feature modules. */
export interface StorageEngine {
  /** Opens the module's namespace; another module cannot accidentally share it. */
  records<T extends StoredRecord>(
    namespace: string,
    input?: { indexes?: (keyof T & string)[][] },
  ): RecordStore<T>;
  /** Flushes pending writes and releases storage resources. */
  close(): Promise<void>;
}
