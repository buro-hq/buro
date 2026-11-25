import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { RecordStore, StorageEngine, StoredRecord } from './record-store.ts';

const field = (name: string): string => {
  // Field names are adapter configuration, never interpolated query values.
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name))
    throw new Error('Invalid record field.');

  return `json_extract(data, '$.${name}')`;
};

const selection = (where: object = {}): { sql: string; values: (string | number | null)[] } => {
  const entries = Object.entries(where).filter(([, value]) => value !== undefined);

  return {
    sql: entries.map(([key]) => ` AND ${field(key)} IS ?`).join(''),
    values: entries.map(([, value]) => (typeof value === 'boolean' ? Number(value) : value)),
  };
};

/** Stores current feature records in SQLite; events are not needed to reconstruct them. */
export class SqliteStorage implements StorageEngine {
  private database: DatabaseSync;

  /** Opens an existing database or creates a private database at the supplied path. */
  constructor(input: { filename: string }) {
    if (input.filename !== ':memory:')
      mkdirSync(path.dirname(input.filename), {
        recursive: true,
        mode: 0o700,
      });

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
    if (input.filename !== ':memory:')
      chmodSync(input.filename, 0o600);
  }

  /** Creates a typed view of a module-owned namespace. */
  records<T extends StoredRecord>(
    namespace: string,
    input: { indexes?: (keyof T & string)[][] } = {},
  ): RecordStore<T> {
    const database = this.database;

    for (const fields of input.indexes ?? []) {
      const expressions = fields.map(field).join(',');
      const name = 'records_' + fields.join('_');
      database.exec(`CREATE INDEX IF NOT EXISTS ${name} ON records(namespace,${expressions})`);
    }

    const upsert = database.prepare(
      'INSERT INTO records(namespace,id,data) VALUES (?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET data=excluded.data',
    );

    return {
      async get(id) {
        const row = database
          .prepare('SELECT data FROM records WHERE namespace=? AND id=?')
          .get(namespace, id);
        return row ? (JSON.parse(String(row.data)) as T) : undefined;
      },
      async list(input = {}) {
        const { sql, values } = selection(input.where);
        const order = input.orderBy ? field(input.orderBy) : 'rowid';
        const ranges =
          (input.before === undefined ? '' : ` AND ${order} < ?`) +
          (input.after === undefined ? '' : ` AND ${order} > ?`);

        return database
          .prepare(
            `SELECT data FROM records WHERE namespace=?${sql}${ranges} ORDER BY ${order} ${input.descending ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`,
          )
          .all(
            namespace,
            ...values,
            ...(input.before === undefined ? [] : [input.before]),
            ...(input.after === undefined ? [] : [input.after]),
            input.limit ?? -1,
            input.offset ?? 0,
          )
          .map((row) => JSON.parse(String(row.data)) as T);
      },
      async write(input) {
        // Serialize before BEGIN so a malformed record cannot leave a partial batch.
        const records = (input.save ?? []).map((record) => ({
          id: record.id,
          data: JSON.stringify(record),
        }));
        const deletion = selection(input.delete);
        database.exec('BEGIN IMMEDIATE');
        try {
          if (input.delete)
            database
              .prepare(`DELETE FROM records WHERE namespace=?${deletion.sql}`)
              .run(namespace, ...deletion.values);

          for (const record of records)
            upsert.run(namespace, record.id, record.data);

          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      },
      async save(record) {
        database
          .prepare(
            'INSERT INTO records(namespace,id,data) VALUES (?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET data=excluded.data',
          )
          .run(namespace, record.id, JSON.stringify(record));
      },
      async patch(input) {
        const row = database
          .prepare('SELECT data FROM records WHERE namespace=? AND id=?')
          .get(namespace, input.id);
        if (!row && !input.initial)
          return undefined;

        const next = {
          ...(row ? JSON.parse(String(row.data)) : structuredClone(input.initial)),
          ...structuredClone(input.changes),
          id: input.id,
        } as T;
        database
          .prepare(
            'INSERT INTO records(namespace,id,data) VALUES (?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET data=excluded.data',
          )
          .run(namespace, input.id, JSON.stringify(next));
        return structuredClone(next);
      },
      async delete(id) {
        database.prepare('DELETE FROM records WHERE namespace=? AND id=?').run(namespace, id);
      },
    };
  }

  /** Closes the database after its module owners have stopped using it. */
  async close(): Promise<void> {
    if (this.database.isOpen)
      this.database.close();
  }
}
