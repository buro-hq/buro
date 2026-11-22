import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectStoreFactory } from '../adapters/files/project-store-factory.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { defaultRoles } from './fixtures/roles.ts';
import type { ProjectStore, ProjectStoreOpenSpec } from '../core/ports.ts';
import type { Snapshot } from '../protocol/domain.ts';
import { GoalService } from '../core/services.ts';

function memoryStore(id: string, close: () => Promise<void> = async () => {}) {
  const snapshot: Snapshot = {
    version: 1,
    project: { id, name: id, root: `memory:${id}` },
    revision: 0,
    sequence: 0,
    roles: [],
    goals: [],
    runs: [],
    capabilities: [],
  };
  const store: ProjectStore = {
    snapshot: () => snapshot,
    receipt: () => undefined,
    transact: async () => {
      throw Error('Not used by registry.');
    },
    subscribe: () => () => {},
    close,
  };
  return { store, snapshot };
}

test('registry supports non-file stores without overwriting duplicate ownership', async () => {
  let rejectedCloses = 0;
  const first = memoryStore('one');
  const second = memoryStore('two');
  const duplicate = memoryStore('one', async () => {
    rejectedCloses++;
  });
  const registry = new ProjectStoreRegistry([first.store]);
  registry.add(second.store);
  assert.equal(registry.get('one'), first.store);
  assert.throws(() => registry.add(duplicate.store), { code: 'PROJECT_EXISTS' });
  assert.throws(() => new ProjectStoreRegistry([first.store, duplicate.store]), {
    code: 'PROJECT_EXISTS',
  });
  assert.equal(registry.get('one'), first.store);
  assert.throws(() => registry.get('missing'), { code: 'PROJECT_NOT_FOUND' });
  assert.equal(rejectedCloses, 0, 'a rejected store remains owned by its caller');
  await registry.close();
});

test('registry metadata cannot mutate the storage-owned project', async () => {
  const { store, snapshot } = memoryStore('one');
  const registry = new ProjectStoreRegistry([store]);
  const projects = registry.list();
  projects[0].name = 'external mutation';
  projects.push({ id: 'injected', name: 'Injected', root: 'memory:injected' });
  assert.equal(snapshot.project.name, 'one');
  assert.deepEqual(registry.list(), [snapshot.project]);
  await registry.close();
});

test('registry refuses new ownership during disposal and closes each store once', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closes = 0;
  const { store } = memoryStore('one', async () => {
    closes++;
    await waiting;
  });
  const registry = new ProjectStoreRegistry([store]);
  const closing = registry.close();
  assert.equal(registry.close(), closing);
  assert.throws(() => registry.add(memoryStore('two').store), { code: 'PROJECT_REGISTRY_CLOSED' });
  assert.throws(() => registry.get('one'), { code: 'PROJECT_REGISTRY_CLOSED' });
  assert.throws(() => registry.list(), { code: 'PROJECT_REGISTRY_CLOSED' });
  release();
  await closing;
  await registry.close();
  assert.equal(closes, 1);
});

test('registry drains all stores despite synchronous or asynchronous close failure', async () => {
  const syncFailure = Error('sync close failed');
  const asyncFailure = Error('async close failed');
  const closed: string[] = [];
  const registry = new ProjectStoreRegistry([
    memoryStore('sync', () => {
      closed.push('sync');
      throw syncFailure;
    }).store,
    memoryStore('async', async () => {
      closed.push('async');
      throw asyncFailure;
    }).store,
    memoryStore('healthy', async () => {
      closed.push('healthy');
    }).store,
  ]);
  const closing = registry.close();
  await assert.rejects(closing, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [syncFailure, asyncFailure]);
    return true;
  });
  assert.deepEqual(closed.sort(), ['async', 'healthy', 'sync']);
  assert.equal(registry.close(), closing, 'failed disposal must not retry already closed stores');
});

async function directoryFixture(t: any) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'store-factory-')));
  const opened: ProjectStore[] = [];
  t.after(async () => {
    await Promise.all(opened.map((store) => store.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const factory = new FileProjectStoreFactory();
  const spec = {
    storageAddress: path.join(directory, 'state'),
    project: { id: 'sample', name: 'Sample', root: directory },
  };
  const open = async (input: ProjectStoreOpenSpec = spec) => {
    const store = await factory.open(input);
    opened.push(store);
    return store;
  };
  return { directory, factory, spec, open };
}

test('production file factory creates an empty team and captures caller-owned inputs', async (t) => {
  const f = await directoryFixture(t);
  const opening = f.open();
  f.spec.project.name = 'mutated while opening';
  const store = await opening;
  assert.equal(store.snapshot().project.name, 'Sample');
  assert.deepEqual(store.snapshot().roles, []);
  assert.deepEqual(store.snapshot().runs, []);
});

test('factory reopening preserves explicit roles, committed goals and idempotency receipts', async (t) => {
  const f = await directoryFixture(t);
  const roles = structuredClone(defaultRoles.slice(0, 1));
  const store = await f.open({ ...f.spec, roles });
  roles[0].title = 'mutated after opening';
  const registry = new ProjectStoreRegistry([store]);
  const service = new GoalService({
    projects: registry,
    now: () => '2026-11-22T00:00:00Z',
    id: () => 'goal-one',
  });
  const input = { projectId: 'sample', title: 'Persist me', body: 'A goal', criteria: '' };
  const created = await service.create('request', 'fingerprint', input);
  const before = store.snapshot();
  assert.notEqual(before.roles[0].title, roles[0].title);
  await registry.close();
  const reopened = await f.open();
  assert.deepEqual(reopened.snapshot(), before);
  const restored = new GoalService({
    projects: new ProjectStoreRegistry([reopened]),
    now: () => '',
    id: () => 'unexpected',
  });
  assert.deepEqual(await restored.create('request', 'fingerprint', input), created);
  assert.equal(reopened.snapshot().goals.length, 1);
});

test('factory retains writer exclusivity without poisoning the existing owner', async (t) => {
  const f = await directoryFixture(t);
  const first = await f.open();
  await assert.rejects(f.factory.open(f.spec), { code: 'PROJECT_LOCKED' });
  assert.equal(first.snapshot().project.id, 'sample');
  await first.close();
  assert.equal((await f.open()).snapshot().project.id, 'sample');
  assert.throws(() => f.factory.open({ ...f.spec, storageAddress: '  ' }), {
    code: 'INVALID_STORAGE_ADDRESS',
  });
});

test('raw file storage starts without roles and never seeds on reopen', async (t) => {
  const f = await directoryFixture(t);
  const options = { directory: f.spec.storageAddress, project: f.spec.project };
  const store = await FileProjectStore.open(options);
  t.after(() => store.close());
  assert.deepEqual(store.snapshot().roles, []);
  assert.equal(store.snapshot().sequence, 0);
  await store.close();
  const reopened = await FileProjectStore.open(options);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.snapshot().roles, []);
  assert.equal(reopened.snapshot().sequence, 0);
});
