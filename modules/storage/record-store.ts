/** A record owned by one feature module. */
export interface StoredRecord {
  id: string;
}

/** Persists current records. The activity journal is independent of this contract. */
export interface RecordStore<T extends StoredRecord> {
  /** Returns a detached record, or undefined when it does not exist. */
  get(id: string): Promise<T | undefined>;
  /** Returns detached records in insertion order. */
  list(): Promise<T[]>;
  /** Inserts or replaces one record without changing the caller's object. */
  save(record: T): Promise<void>;
  /** Merges fields into the latest saved record without replacing unrelated concurrent updates. */
  patch(input: { id: string; changes: Partial<Omit<T, 'id'>> }): Promise<T | undefined>;
  /** Removes one record, including when it has already been removed. */
  delete(id: string): Promise<void>;
}

/** A persistence adapter supplies independent stores for feature modules. */
export interface StorageEngine {
  /** Opens the module's namespace; another module cannot accidentally share it. */
  records<T extends StoredRecord>(namespace: string): RecordStore<T>;
  /** Flushes pending writes and releases storage resources. */
  close(): Promise<void>;
}
