import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { RecordStore, StorageEngine, StoredRecord } from './record-store.ts';

/** Stores current feature records in SQLite; events are not needed to reconstruct them. */
export class SqliteStorage implements StorageEngine {
  private database: DatabaseSync;

  /** Opens an existing database or creates a private database at the supplied path. */
  constructor(input: { filename: string }) {
    if (input.filename !== ':memory:') mkdirSync(path.dirname(input.filename), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(input.filename);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records (
        namespace TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        PRIMARY KEY(namespace, id)
      );
    `);
    if (input.filename !== ':memory:') chmodSync(input.filename, 0o600);
  }

  /** Creates a typed view of a module-owned namespace. */
  records<T extends StoredRecord>(namespace: string): RecordStore<T> {
    const database = this.database;
    return {
      async get(id) {
        const row = database.prepare('SELECT data FROM records WHERE namespace=? AND id=?').get(namespace, id);
        return row ? JSON.parse(String(row.data)) as T : undefined;
      },
      async list() {
        return database.prepare('SELECT data FROM records WHERE namespace=? ORDER BY rowid').all(namespace)
          .map(row => JSON.parse(String(row.data)) as T);
      },
      async save(record) {
        database.prepare('INSERT INTO records(namespace,id,data) VALUES (?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET data=excluded.data')
          .run(namespace, record.id, JSON.stringify(record));
      },
      async delete(id) {
        database.prepare('DELETE FROM records WHERE namespace=? AND id=?').run(namespace, id);
      },
    };
  }

  /** Closes the database after its module owners have stopped using it. */
  async close(): Promise<void> {
    if (this.database.isOpen) this.database.close();
  }
}
