import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import {
  createUsageAuthorityTransaction,
  usageOwnerKey,
  validateUsageOwner,
  validateProjectUsageChange,
  type ProjectUsageAuthority,
  type ProjectUsageOwner,
  type UsageAuthorityTransaction,
  type UsageCommand,
  type UsageAuthorityEvent,
  type UsageEventQuery,
  type UsageEventPage,
  type UsageTransactionStorage,
} from '../../core/usage-authority.ts';
import {
  validateUsageAccount,
  validateUsageOperation,
  type UsageAccount,
  type UsageOperation,
} from '../../core/usage-accounting.ts';
import { DomainError } from '../../core/ports.ts';
import { preparePrivateDatabase, assertPrivateDatabaseFiles } from './private-database.ts';

export type UsageQueryObservation = { operation: string; rows: number };
export type SqliteProjectUsageOptions = {
  directory: string;
  projectId: string;
  onEvent?: (event: UsageAuthorityEvent) => void;
  /** Counts returned/changed rows without exposing SQL parameters or private payloads. */
  onQuery?: (observation: UsageQueryObservation) => void;
};
const format = 'buro-project-authority-v1';
const failure = (code: string, message: string) => new DomainError(code, message);
const stateConflict = () =>
  failure('USAGE_STATE_CONFLICT', 'The stored usage state changed. Refresh before trying again.');
const validString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** A receipt round trip must preserve the exact JSON result returned to the first caller. */
function jsonValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (!value || typeof value !== 'object' || ancestors.has(value))
    throw failure('USAGE_RESULT_NOT_JSON', 'A transaction result must be JSON-safe.');
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw failure('USAGE_RESULT_NOT_JSON', 'A transaction result must be JSON-safe.');
  ancestors.add(value);
  try {
    if (array) {
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1 ||
        keys.some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' ||
              !/^(0|[1-9][0-9]*)$/.test(key) ||
              Number(key) >= value.length),
        )
      )
        throw failure('USAGE_RESULT_NOT_JSON', 'A transaction result must be JSON-safe.');
      return Array.from({ length: value.length }, (_item, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
          throw failure('USAGE_RESULT_NOT_JSON', 'A transaction result must be JSON-safe.');
        return jsonValue(descriptor.value, ancestors);
      });
    }
    const result: [string, unknown][] = [];
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string'))
      throw failure('USAGE_RESULT_NOT_JSON', 'A transaction result must be JSON-safe.');
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable)
        throw failure('USAGE_RESULT_NOT_JSON', 'A transaction result must be JSON-safe.');
      if (descriptor.value !== undefined)
        result.push([key, jsonValue(descriptor.value, ancestors)]);
    }
    return Object.fromEntries(result);
  } finally {
    ancestors.delete(value);
  }
}
const json = (value: unknown) => JSON.stringify(jsonValue(value));
function encodeResult(value: unknown) {
  return value === undefined ? '{"kind":"void"}' : json({ kind: 'json', value });
}
function decodeResult(value: string): unknown {
  const receipt = JSON.parse(value) as { kind: string; value?: unknown };
  if (receipt.kind === 'void' && Object.keys(receipt).length === 1) return undefined;
  if (
    receipt.kind === 'json' &&
    Object.hasOwn(receipt, 'value') &&
    Object.keys(receipt).length === 2
  )
    return jsonValue(receipt.value);
  throw failure('INVALID_USAGE_RECEIPT', 'The saved command receipt is invalid.');
}
function thenable(value: unknown): boolean {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  for (
    let current: object | null = value as object;
    current;
    current = Object.getPrototypeOf(current)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'then');
    if (descriptor) return !('value' in descriptor) || typeof descriptor.value === 'function';
  }
  return false;
}
function commandCopy(command: UsageCommand): UsageCommand {
  const keys = command && typeof command === 'object' ? Reflect.ownKeys(command) : [];
  if (
    keys.length !== 2 ||
    !keys.includes('id') ||
    !keys.includes('fingerprint') ||
    keys.some((key) => !('value' in Object.getOwnPropertyDescriptor(command, key)!)) ||
    !validString(command.id) ||
    !validString(command.fingerprint)
  )
    throw failure('INVALID_USAGE_COMMAND', 'A command identity and fingerprint are required.');
  return { id: command.id, fingerprint: command.fingerprint };
}

/** Standalone project transaction kernel; no JSON store, live scheduler or dispatch grant is wired here. */
export class SqliteProjectUsageAuthority implements ProjectUsageAuthority {
  #projectId: string;
  #directory: string;
  #database: DatabaseSync;
  #statements = new Map<string, StatementSync>();
  #queue: Promise<unknown> = Promise.resolve();
  #closing = false;
  #disposal?: Promise<void>;
  #onEvent?: SqliteProjectUsageOptions['onEvent'];
  #onQuery?: SqliteProjectUsageOptions['onQuery'];

  private constructor(database: DatabaseSync, options: SqliteProjectUsageOptions) {
    this.#database = database;
    this.#projectId = options.projectId;
    this.#directory = options.directory;
    Object.defineProperties(this, {
      projectId: { enumerable: true, configurable: false, get: () => this.#projectId },
      directory: { enumerable: true, configurable: false, get: () => this.#directory },
    });
    this.#onEvent = options.onEvent;
    this.#onQuery = options.onQuery;
  }

  get projectId() {
    return this.#projectId;
  }
  get directory() {
    return this.#directory;
  }

  static async open(options: SqliteProjectUsageOptions) {
    const captured = {
      directory: options.directory,
      projectId: options.projectId,
      onEvent: options.onEvent,
      onQuery: options.onQuery,
    };
    if (!validString(captured.projectId))
      throw failure('INVALID_PROJECT_ID', 'The project identity is invalid.');
    const location = await preparePrivateDatabase(captured.directory, 'authority.sqlite');
    const database = new DatabaseSync(location.file);
    try {
      database.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;');
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all();
      if (tables.length && !tables.some((table) => table.name === 'authority_metadata'))
        throw failure('USAGE_AUTHORITY_FORMAT', 'This file is not a supported project authority.');
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS authority_metadata (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            format TEXT NOT NULL,
            project_id TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS usage_accounts (
            account_id TEXT PRIMARY KEY NOT NULL,
            owner_key TEXT NOT NULL UNIQUE,
            owner_json TEXT NOT NULL CHECK(json_valid(owner_json)),
            account_json TEXT NOT NULL CHECK(json_valid(account_json))
          );
          CREATE TABLE IF NOT EXISTS usage_operations (
            account_id TEXT NOT NULL REFERENCES usage_accounts(account_id),
            operation_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('generation','tools')),
            status TEXT NOT NULL CHECK(status IN ('pending','observed','unknown','tools')),
            operation_json TEXT NOT NULL CHECK(json_valid(operation_json)),
            PRIMARY KEY(account_id,operation_id)
          );
          CREATE TABLE IF NOT EXISTS usage_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            change_json TEXT NOT NULL CHECK(json_valid(change_json))
          );
          CREATE TABLE IF NOT EXISTS command_receipts (
            command_id TEXT PRIMARY KEY NOT NULL,
            fingerprint TEXT NOT NULL,
            result_json TEXT NOT NULL CHECK(json_valid(result_json))
          );
        `);
        const metadata = database
          .prepare('SELECT format,project_id FROM authority_metadata WHERE singleton=1')
          .get();
        if (metadata) {
          if (metadata.format !== format)
            throw failure(
              'USAGE_AUTHORITY_FORMAT',
              'This project authority format is unsupported.',
            );
          if (metadata.project_id !== captured.projectId)
            throw failure('USAGE_PROJECT_MISMATCH', 'The authority belongs to another project.');
        } else {
          if (tables.length)
            throw failure(
              'USAGE_AUTHORITY_FORMAT',
              'The project authority metadata is incomplete.',
            );
          database
            .prepare('INSERT INTO authority_metadata(singleton,format,project_id) VALUES (1,?,?)')
            .run(format, captured.projectId);
        }
        database.exec('COMMIT');
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          /* Preserve the admission error. */
        }
        throw error;
      }
      await assertPrivateDatabaseFiles(location.file);
      return new SqliteProjectUsageAuthority(database, {
        ...captured,
        directory: location.directory,
      });
    } catch (error) {
      database.close();
      throw error;
    }
  }

  #notify(observation: UsageQueryObservation) {
    try {
      void Promise.resolve(this.#onQuery?.({ ...observation })).catch(() => {});
    } catch {
      /* Instrumentation cannot change a storage decision. */
    }
  }
  #statement(sql: string) {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
  #get(operation: string, sql: string, ...values: SQLInputValue[]) {
    const row = this.#statement(sql).get(...values);
    this.#notify({ operation, rows: row ? 1 : 0 });
    return row;
  }
  #run(operation: string, sql: string, ...values: SQLInputValue[]) {
    const result = this.#statement(sql).run(...values);
    this.#notify({ operation, rows: Number(result.changes) });
    return result;
  }
  #enqueue<T>(action: () => T): Promise<T> {
    if (this.#closing)
      return Promise.reject(failure('USAGE_AUTHORITY_CLOSED', 'The project authority is closed.'));
    const work = this.#queue.then(action);
    this.#queue = work.catch(() => {});
    return work;
  }
  #accountRow(owner: ProjectUsageOwner) {
    const binding = validateUsageOwner(owner);
    const row = this.#get(
      'account.read',
      'SELECT account_id,owner_json,account_json FROM usage_accounts WHERE owner_key=?',
      usageOwnerKey(binding),
    );
    if (!row) return undefined;
    if (json(validateUsageOwner(JSON.parse(String(row.owner_json)))) !== json(binding))
      throw failure('USAGE_OWNER_CONFLICT', 'The saved owner has a different immutable binding.');
    const account = validateUsageAccount(JSON.parse(String(row.account_json)));
    if (account.id !== row.account_id)
      throw failure('INVALID_USAGE_ACCOUNT', 'The saved account identity differs from its row.');
    return account;
  }
  #operationRow(owner: ProjectUsageOwner, operationId: string) {
    if (!validString(operationId))
      throw failure('INVALID_USAGE_OPERATION', 'The usage operation identity is invalid.');
    const binding = validateUsageOwner(owner);
    const row = this.#get(
      'operation.read',
      `SELECT a.account_id,a.owner_json,o.kind,o.status,o.operation_json
      FROM usage_operations o JOIN usage_accounts a ON a.account_id=o.account_id
      WHERE a.owner_key=? AND o.operation_id=?`,
      usageOwnerKey(binding),
      operationId,
    );
    if (!row) return undefined;
    if (json(validateUsageOwner(JSON.parse(String(row.owner_json)))) !== json(binding))
      throw failure('USAGE_OWNER_CONFLICT', 'The saved owner has a different immutable binding.');
    const operation = JSON.parse(String(row.operation_json)) as UsageOperation;
    if (
      operation.accountId !== row.account_id ||
      operation.operationId !== operationId ||
      operation.kind !== row.kind ||
      (operation.kind === 'generation' ? operation.status : 'tools') !== row.status
    )
      throw failure(
        'INVALID_USAGE_OPERATION',
        'The saved operation differs from its indexed identity.',
      );
    return operation;
  }

  transaction<T>(command: UsageCommand, apply: (tx: UsageAuthorityTransaction) => T): Promise<T> {
    let captured: UsageCommand;
    try {
      captured = commandCopy(command);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueue(() => {
      const events: UsageAuthorityEvent[] = [];
      let active = true;
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        const saved = this.#get(
          'receipt.read',
          'SELECT fingerprint,result_json FROM command_receipts WHERE command_id=?',
          captured.id,
        );
        if (saved) {
          if (saved.fingerprint !== captured.fingerprint)
            throw failure(
              'IDEMPOTENCY_CONFLICT',
              'This command ID was used with another fingerprint.',
            );
          const result = decodeResult(String(saved.result_json)) as T;
          this.#database.exec('COMMIT');
          return result;
        }
        const storage: UsageTransactionStorage = {
          account: (owner) => this.#accountRow(owner),
          operation: (owner, operationId) => this.#operationRow(owner, operationId),
          insertAccount: (owner, account) => {
            const checked = validateUsageAccount(account);
            try {
              this.#run(
                'account.insert',
                'INSERT INTO usage_accounts(account_id,owner_key,owner_json,account_json) VALUES (?,?,?,?)',
                checked.id,
                usageOwnerKey(owner),
                json(validateUsageOwner(owner)),
                json(checked),
              );
            } catch (error) {
              if ([1555, 2067].includes((error as { errcode?: number }).errcode || 0))
                throw failure(
                  'USAGE_ACCOUNT_CONFLICT',
                  'This account identity or owner is already registered.',
                );
              throw error;
            }
          },
          applyTransition: (owner, transition) => {
            const previous = validateUsageAccount(transition.previousAccount);
            const next = validateUsageAccount(transition.account);
            const operation = validateUsageOperation(transition.operation, next);
            if (previous.id !== next.id || json(previous.policy) !== json(next.policy))
              throw stateConflict();
            const changed = this.#run(
              'account.update',
              `UPDATE usage_accounts SET account_json=? WHERE account_id=? AND owner_key=? AND owner_json=? AND account_json=?`,
              json(next),
              previous.id,
              usageOwnerKey(owner),
              json(validateUsageOwner(owner)),
              json(previous),
            );
            if (Number(changed.changes) !== 1) throw stateConflict();
            if (transition.previousOperation) {
              const prior = validateUsageOperation(transition.previousOperation, previous);
              const changedOperation = this.#run(
                'operation.update',
                `UPDATE usage_operations SET status=?,operation_json=? WHERE account_id=? AND operation_id=? AND kind=? AND status=? AND operation_json=?`,
                operation.kind === 'generation' ? operation.status : 'tools',
                json(operation),
                previous.id,
                prior.operationId,
                prior.kind,
                prior.kind === 'generation' ? prior.status : 'tools',
                json(prior),
              );
              if (Number(changedOperation.changes) !== 1) throw stateConflict();
            } else {
              this.#run(
                'operation.insert',
                'INSERT INTO usage_operations(account_id,operation_id,kind,status,operation_json) VALUES (?,?,?,?,?)',
                previous.id,
                operation.operationId,
                operation.kind,
                operation.kind === 'generation' ? operation.status : 'tools',
                json(operation),
              );
            }
          },
          appendChange: (change) => {
            const checked = validateProjectUsageChange(change, this.#projectId);
            const result = this.#run(
              'event.append',
              'INSERT INTO usage_events(change_json) VALUES (?)',
              json(checked),
            );
            const sequence = Number(result.lastInsertRowid);
            if (!Number.isSafeInteger(sequence) || sequence < 1)
              throw failure(
                'USAGE_SEQUENCE_EXHAUSTED',
                'The event cursor cannot safely represent another change.',
              );
            events.push({ ...checked, sequence });
          },
        };
        const tx = createUsageAuthorityTransaction({
          projectId: this.#projectId,
          storage,
          assertActive: () => {
            if (!active)
              throw failure('USAGE_TRANSACTION_CLOSED', 'This transaction capability is closed.');
          },
        });
        const result = apply(tx);
        active = false;
        if (thenable(result)) {
          if (result instanceof Promise)
            void Promise.prototype.then.call(
              result,
              () => {},
              () => {},
            );
          throw failure(
            'ASYNC_USAGE_TRANSACTION',
            'Project transaction callbacks must be synchronous.',
          );
        }
        const encoded = encodeResult(result);
        this.#run(
          'receipt.insert',
          'INSERT INTO command_receipts(command_id,fingerprint,result_json) VALUES (?,?,?)',
          captured.id,
          captured.fingerprint,
          encoded,
        );
        this.#database.exec('COMMIT');
        for (const event of events) {
          try {
            void Promise.resolve(this.#onEvent?.(structuredClone(event))).catch(() => {});
          } catch {
            /* A broken observer cannot roll back a committed receipt. */
          }
        }
        return decodeResult(encoded) as T;
      } catch (error) {
        try {
          this.#database.exec('ROLLBACK');
        } catch {
          /* Preserve the original transaction failure. */
        }
        throw error;
      } finally {
        active = false;
      }
    });
  }

  account(owner: ProjectUsageOwner): Promise<UsageAccount | undefined> {
    let binding: ProjectUsageOwner;
    try {
      binding = validateUsageOwner(owner);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueue(() => this.#accountRow(binding));
  }
  operation(owner: ProjectUsageOwner, operationId: string): Promise<UsageOperation | undefined> {
    let binding: ProjectUsageOwner;
    try {
      binding = validateUsageOwner(owner);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueue(() => {
      this.#database.exec('BEGIN');
      try {
        const account = this.#accountRow(binding);
        const operation = this.#operationRow(binding, operationId);
        const result =
          operation === undefined
            ? undefined
            : account
              ? validateUsageOperation(operation, account)
              : (() => {
                  throw failure(
                    'INVALID_USAGE_ACCOUNT',
                    'An operation requires its owning account.',
                  );
                })();
        this.#database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.#database.exec('ROLLBACK');
        } catch {
          /* Preserve the read failure. */
        }
        throw error;
      }
    });
  }
  pagedEvents(query: UsageEventQuery): Promise<UsageEventPage> {
    const captured = { ...query };
    if (
      !Number.isSafeInteger(captured.after) ||
      captured.after < 0 ||
      !Number.isSafeInteger(captured.limit) ||
      captured.limit < 1 ||
      captured.limit > 1000 ||
      (captured.watermark !== undefined &&
        (!Number.isSafeInteger(captured.watermark) || captured.watermark < captured.after))
    )
      return Promise.reject(failure('INVALID_USAGE_CURSOR', 'The usage history page is invalid.'));
    return this.#enqueue(() => {
      this.#database.exec('BEGIN');
      try {
        const current = Number(
          this.#get(
            'event.watermark',
            'SELECT COALESCE(MAX(sequence),0) AS sequence FROM usage_events',
          )!.sequence,
        );
        const watermark = captured.watermark ?? current;
        if (captured.after > watermark || watermark > current)
          throw failure(
            'USAGE_CURSOR_AHEAD',
            'The requested event cursor is ahead of saved history.',
          );
        const rows = this.#statement(
          'SELECT sequence,change_json FROM usage_events WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?',
        ).all(captured.after, watermark, captured.limit + 1);
        this.#notify({ operation: 'event.page', rows: rows.length });
        const events = rows.slice(0, captured.limit).map((row) => ({
          ...validateProjectUsageChange(JSON.parse(String(row.change_json)), this.#projectId),
          sequence: Number(row.sequence),
        }));
        this.#database.exec('COMMIT');
        return {
          events,
          watermark,
          ...(rows.length > captured.limit ? { nextAfter: events.at(-1)!.sequence } : {}),
        };
      } catch (error) {
        try {
          this.#database.exec('ROLLBACK');
        } catch {
          /* Preserve the read failure. */
        }
        throw error;
      }
    });
  }
  close(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#closing = true;
    this.#disposal = this.#queue.then(() => {
      this.#statements.clear();
      this.#database.close();
    });
    return this.#disposal;
  }
}
