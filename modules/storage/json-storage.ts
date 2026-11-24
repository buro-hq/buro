import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RecordStore, StorageEngine, StoredRecord } from './record-store.ts';

/** Provides the same record contract using one atomic JSON file per feature. */
export class JsonStorage implements StorageEngine {
  private directory: string;
  private stores = new Map<string, JsonRecordStore<StoredRecord>>();

  /** Selects a directory without reading or creating files until a store is used. */
  constructor(input: { directory: string }) {
    this.directory = input.directory;
  }

  /** Opens a module namespace. Paths are validated at this storage boundary. */
  records<T extends StoredRecord>(namespace: string): RecordStore<T> {
    if (!/^[a-z][a-z0-9_-]*$/.test(namespace)) throw new Error('Invalid storage namespace.');
    let store = this.stores.get(namespace);
    if (!store) {
      store = new JsonRecordStore({ filename: path.join(this.directory, namespace + '.json') });
      this.stores.set(namespace, store);
    }
    return store as JsonRecordStore<T>;
  }

  /** Waits for every module's pending writes. */
  async close(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }
}

class JsonRecordStore<T extends StoredRecord> implements RecordStore<T> {
  private filename: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(input: { filename: string }) {
    this.filename = input.filename;
  }

  private async read(): Promise<T[]> {
    try {
      return JSON.parse(await fs.readFile(this.filename, 'utf8')) as T[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private write(update: (records: T[]) => T[]): Promise<void> {
    const work = this.queue.then(async () => {
      const records = update(await this.read());
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = this.filename + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, JSON.stringify(records), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.filename);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }

  async get(id: string): Promise<T | undefined> {
    return (await this.list()).find((record) => record.id === id);
  }

  async list(): Promise<T[]> {
    await this.queue;
    return this.read();
  }

  async save(record: T): Promise<void> {
    const copy = structuredClone(record);
    await this.write((records) => {
      const index = records.findIndex((item) => item.id === copy.id);
      if (index < 0) return [...records, copy];
      return records.map((item, position) => (position === index ? copy : item));
    });
  }

  async delete(id: string): Promise<void> {
    await this.write((records) => records.filter((record) => record.id !== id));
  }

  async patch(input: {
    id: string;
    changes: Partial<Omit<T, 'id'>>;
    initial?: T;
  }): Promise<T | undefined> {
    const changes = structuredClone(input.changes);
    const initial = structuredClone(input.initial);
    let updated: T | undefined;
    await this.write((records) => {
      if (!records.some((record) => record.id === input.id) && initial) {
        updated = { ...initial, ...changes, id: input.id };
        return [...records, updated];
      }
      return records.map((record) => {
        if (record.id !== input.id) return record;
        updated = { ...record, ...changes, id: record.id };
        return updated;
      });
    });
    return updated ? structuredClone(updated) : undefined;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
