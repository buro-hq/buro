import { acquireWriterLock } from './writer-lock.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError, type ProjectDocument, type ProjectStore } from '../../core/ports.ts';
import { capabilities, defaultRoles } from '../../core/defaults.ts';
import { parseSnapshot, DomainEventSchema } from '../../protocol/schema.ts';
import type {
  Project,
  Run,
  Snapshot,
  DomainEvent,
  Role,
  ProjectProfile,
  ProjectStorageInfo,
} from '../../protocol/domain.ts';

import { packEvent, expandEvent, type StoredEvent } from './event-log.ts';
import { validateProjectRunBudgets } from './project-run-budgets.ts';
import { validateProjectPlanningPolicies } from './project-planning-policy.ts';
import { validateResultApplyIntents } from '../../core/result-apply.ts';
import { validateRunReconciliationTransitions } from '../../core/reconciliation-transitions.ts';
import { validateProjectOperationContexts } from '../../core/operation-transitions.ts';
import { validateProjectResearchTransitions } from '../../core/project-analysis.ts';
type StoredDocument = ProjectDocument & { events: StoredEvent[]; eventEncoding?: 'run-delta-v1' };
type Options = {
  directory: string;
  project: Project;
  runs?: Run[];
  roles?: Role[];
  profile?: ProjectProfile;
  replace?: (from: string, to: string) => Promise<void>;
};
/** One writer per project. State, events and idempotency receipts share one atomic commit. */
export class FileProjectStore implements ProjectStore {
  directory: string;
  file: string;
  lock: string;
  nonce: string;
  doc: StoredDocument;
  replace: NonNullable<Options['replace']>;
  queue: Promise<unknown> = Promise.resolve();
  listeners = new Set<(event: DomainEvent) => void>();
  closing = false;
  constructor(options: Options, doc: StoredDocument, nonce: string) {
    this.directory = options.directory;
    this.file = path.join(options.directory, 'control-state.json');
    this.lock = path.join(options.directory, 'writer.lock');
    this.doc = doc;
    this.nonce = nonce;
    this.replace = options.replace || fs.rename;
  }
  static async open(options: Options) {
    await fs.mkdir(options.directory, { recursive: true });
    const lock = path.join(options.directory, 'writer.lock'),
      nonce = await acquireWriterLock(options.directory);
    let store: FileProjectStore | undefined;
    try {
      let doc: StoredDocument;
      try {
        doc = JSON.parse(
          await fs.readFile(path.join(options.directory, 'control-state.json'), 'utf8'),
        );
        parseSnapshot({ ...doc, roles: doc.roleVersions, capabilities });
        if (
          doc.project.id !== options.project.id ||
          !Array.isArray(doc.events) ||
          doc.sequence !== doc.events.length ||
          !doc.receipts ||
          doc.version !== 1
        )
          throw Error('Invalid project state.');
        const previousRuns = new Map<string, Run>();
        const packed: StoredEvent[] = [];
        for (const stored of doc.events) {
          const previous =
            stored.change.type === 'run.changed'
              ? previousRuns.get(stored.change.run.id)
              : undefined;
          const event = expandEvent(stored, previousRuns);
          DomainEventSchema.parse(event);
          packed.push(stored.change.type === 'run.delta' ? stored : packEvent(event, previous));
        }
        doc.events = packed;
        doc.eventEncoding = 'run-delta-v1';
        if (doc.events.some((e, i) => e.seq !== i + 1 || e.projectId !== doc.project.id))
          throw Error('Invalid event order.');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        doc = {
          version: 1,
          revision: 0,
          sequence: 0,
          project: options.project,
          roleVersions: structuredClone(options.roles || defaultRoles),
          goals: [],
          runs: options.runs || [],
          events: [],
          receipts: {},
        };
      }
      doc.project = options.project;
      if (options.profile && (!doc.profile || options.profile.revision >= doc.profile.revision))
        doc.profile = options.profile;
      validateProjectRunBudgets(doc);
      validateProjectPlanningPolicies(doc);
      validateProjectOperationContexts(doc);
      validateResultApplyIntents(doc);
      store = new FileProjectStore(options, doc, nonce);
      doc.eventEncoding = 'run-delta-v1';
      await store.persist(doc);
      await store.removeStaleTemps();
      return store;
    } catch (error) {
      await fs.rm(lock, { force: true });
      throw error;
    }
  }
  receipt(id: string, fingerprint: string) {
    const item = Object.hasOwn(this.doc.receipts, id) ? this.doc.receipts[id] : undefined;
    if (item && item.fingerprint !== fingerprint)
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'This ID was used for another command.');
    return item ? structuredClone(item.result) : undefined;
  }
  async persist(doc: StoredDocument) {
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(doc));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.replace(temp, this.file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
  snapshot(): Snapshot {
    const latest = new Map(this.doc.roleVersions.map((r) => [r.id, r]));
    return structuredClone({
      version: 1,
      project: this.doc.project,
      revision: this.doc.revision,
      sequence: this.doc.sequence,
      roles: [...latest.values()],
      goals: this.doc.goals,
      runs: this.doc.runs,
      capabilities,
      ...(this.doc.contextMaterials ? { contextMaterials: this.doc.contextMaterials } : {}),
      ...(this.doc.verification ? { verification: this.doc.verification } : {}),
      ...(this.doc.research ? { research: this.doc.research } : {}),
      ...(this.doc.profile ? { profile: this.doc.profile } : {}),
    });
  }
  transact<T>(
    requestId: string,
    fingerprint: string,
    apply: (draft: ProjectDocument) => { result: T; change: DomainEvent['change'] },
  ): Promise<T> {
    if (this.closing) return Promise.reject(new DomainError('CLOSED', 'Storage is closing.'));
    const work = this.queue.then(async () => {
      const receipt = Object.hasOwn(this.doc.receipts, requestId)
        ? this.doc.receipts[requestId]
        : undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'This ID was used for another command.');
        return structuredClone(receipt.result) as T;
      }
      const { events: history, ...state } = this.doc;
      const draft = structuredClone(state),
        { result, change } = apply(draft);
      validateProjectRunBudgets(draft, this.doc);
      validateProjectPlanningPolicies(draft, this.doc);
      validateProjectOperationContexts(draft, this.doc);
      validateProjectResearchTransitions(this.doc.research, draft.research);
      validateResultApplyIntents(draft, this.doc);
      validateRunReconciliationTransitions(this.doc.runs, draft.runs);
      draft.revision++;
      draft.sequence++;
      const event: DomainEvent = {
        version: 1,
        id: randomUUID(),
        projectId: draft.project.id,
        seq: draft.sequence,
        at: new Date().toISOString(),
        change: structuredClone(change),
      };
      DomainEventSchema.parse(event);
      const previous =
        change.type === 'run.changed' &&
        history.some(
          (item) => item.change.type === 'run.changed' && item.change.run.id === change.run.id,
        )
          ? this.doc.runs.find((r) => r.id === change.run.id)
          : undefined;
      const next: StoredDocument = { ...draft, events: [...history, packEvent(event, previous)] };
      Object.defineProperty(draft.receipts, requestId, {
        value: { fingerprint, result: structuredClone(result) },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      await this.persist(next);
      this.doc = next;
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(event));
        } catch {
          /* A broken observer cannot roll back a committed operation. */
        }
      }
      return structuredClone(result);
    });
    this.queue = work.catch(() => {});
    return work;
  }
  subscribe(after: number, listener: (event: DomainEvent) => void) {
    if (after > this.doc.sequence)
      throw new DomainError('CURSOR_AHEAD', 'A new project state snapshot is required.');
    // Synchronous registration + replay prevents a gap between history and live events.
    if (after < this.doc.sequence) {
      const runs = new Map<string, Run>();
      for (const stored of this.doc.events) {
        const event = expandEvent(stored, runs);
        if (event.seq > after) listener(structuredClone(event));
      }
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async storageInfo(): Promise<ProjectStorageInfo> {
    return {
      stateBytes: (await fs.stat(this.file)).size,
      eventCount: this.doc.events.length,
      compactedEvents: this.doc.events.filter((e) => e.change.type === 'run.delta').length,
      runCount: this.doc.runs.length,
      receiptCount: Object.keys(this.doc.receipts).length,
    };
  }
  async removeStaleTemps() {
    let count = 0,
      bytes = 0;
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!/^control-state\.json\.[a-f0-9-]{36}\.tmp$/.test(entry.name) || !entry.isFile())
        continue;
      const file = path.join(this.directory, entry.name),
        stat = await fs.lstat(file);
      if (!stat.isFile() || Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) continue;
      await fs.unlink(file);
      count++;
      bytes += stat.size;
    }
    return { count, bytes };
  }
  collectGarbage(): Promise<ProjectStorageInfo> {
    if (this.closing) return Promise.reject(new DomainError('CLOSED', 'Storage is closing.'));
    const work = this.queue.then(async () => {
      const before = (await fs.stat(this.file)).size;
      await this.persist(this.doc);
      const removed = await this.removeStaleTemps();
      return {
        ...(await this.storageInfo()),
        removedTempFiles: removed.count,
        reclaimedBytes: removed.bytes + Math.max(0, before - (await fs.stat(this.file)).size),
      };
    });
    this.queue = work.catch(() => {});
    return work;
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    await this.queue;
    this.listeners.clear();
    try {
      const lock = JSON.parse(await fs.readFile(this.lock, 'utf8'));
      if (lock.nonce === this.nonce) await fs.unlink(this.lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
