import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import type { ProjectProfile } from '../protocol/domain.ts';

const profile = (): ProjectProfile => ({
  version: 1,
  revision: 1,
  context: 'Initial',
  scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
  checks: [],
  defaultCheckIds: [],
  setup: [],
  dependencies: 'none',
  maxWorkers: 1,
  maxRepairs: 1,
  turnTimeoutMs: 10000,
  baseBranch: 'main',
});
async function location(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-file-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    project: { id: 'p', name: 'Saved name', root: directory, managed: true },
    profile: profile(),
  };
}

test('File open captures bootstrap inputs before I/O and metadata getter cannot retarget the authority', async (t) => {
  const options = await location(t),
    captured = structuredClone(options);
  const pending = FileProjectStore.open(options);
  options.project.name = 'Mutated caller name';
  options.project.root = '/foreign';
  options.profile.context = 'Mutated caller profile';
  const store = await pending;
  t.after(() => store.close());
  assert.deepEqual(store.project, captured.project);
  assert.deepEqual(await store.settings.profile(), captured.profile);
  store.project.root = '/another';
  assert.equal(store.project.root, captured.project.root);
  assert.throws(
    () => Object.defineProperty(store, 'project', { value: options.project }),
    TypeError,
  );
});

test('equal and newer export proposals cannot replace authoritative File project metadata or settings', async (t) => {
  const options = await location(t);
  let store = await FileProjectStore.open(options);
  try {
    const current = await store.settings.profile();
    const saved = await store.settings.transaction({ id: 'save', fingerprint: 'save' }, (tx) =>
      tx.configure({
        expectedRevision: 1,
        profile: { ...current!, context: 'Authoritative', revision: 2 },
      }),
    );
    await store.close();
    for (const revision of [saved.revision, 999]) {
      store = await FileProjectStore.open({
        ...options,
        project: { ...options.project, name: 'Edited export' },
        profile: { ...saved, context: 'Export proposal', revision },
      });
      assert.deepEqual(store.project, options.project);
      assert.deepEqual(await store.settings.profile(), saved);
      await store.close();
    }
  } finally {
    await store.close();
  }
});

test('File reopening rejects foreign storage bindings without rewriting the saved authority', async (t) => {
  const options = await location(t),
    store = await FileProjectStore.open(options);
  await store.close();
  const file = path.join(options.directory, 'control-state.json'),
    before = await fs.readFile(file);
  for (const patch of [
    { id: 'foreign' },
    { root: '/foreign' },
    { managed: false },
    { dataDirectory: '/foreign' },
  ]) {
    await assert.rejects(
      FileProjectStore.open({ ...options, project: { ...options.project, ...patch } }),
      { code: 'PROJECT_STORAGE_MISMATCH' },
    );
    assert.deepEqual(await fs.readFile(file), before);
  }
  const reopened = await FileProjectStore.open(options);
  await reopened.close();
});

test('registry identity reads avoid snapshots and state transactions cannot rewrite captured metadata', async (t) => {
  const options = await location(t),
    store = await FileProjectStore.open(options);
  const registry = new ProjectStoreRegistry();
  t.after(() => registry.close());
  store.snapshot = () => {
    throw Error('Whole snapshot forbidden');
  };
  registry.add(store);
  assert.deepEqual(registry.list(), [options.project]);
  registry.list()[0].root = '/caller mutation';
  assert.deepEqual(registry.list(), [options.project]);
  await assert.rejects(
    store.transact('retarget', 'retarget', (doc) => {
      doc.project.root = '/foreign';
      return { result: null, change: { type: 'goal.deleted', id: 'unused' } };
    }),
    { code: 'PROJECT_STORAGE_MISMATCH' },
  );
  assert.equal(store.receipt('retarget', 'retarget'), undefined);
  assert.deepEqual(store.project, options.project);
});

test('failed File persistence rolls back configured profile, verification, public events and command receipt', async (t) => {
  const options = await location(t);
  let fail = false;
  const store = await FileProjectStore.open({
    ...options,
    replace: async (from, to) => {
      if (fail) throw Error('Synthetic settings write failure');
      await fs.rename(from, to);
    },
  });
  t.after(() => store.close());
  const seen: unknown[] = [];
  store.subscribe(0, (event) => seen.push(event));
  const command = { id: 'batch', fingerprint: 'batch' };
  const update = () =>
    store.settings.transaction(command, (tx) => {
      const saved = tx.configure({
        expectedRevision: 1,
        profile: { ...profile(), revision: 2, context: 'Saved' },
      });
      tx.saveVerification({
        id: 'V-test',
        profileRevision: saved.revision,
        createdAt: 'now',
        workspace: '/isolated',
        base: 'a'.repeat(40),
        passed: 0,
        total: 0,
        results: [],
      });
      return saved;
    });
  fail = true;
  await assert.rejects(update(), /Synthetic settings write failure/);
  assert.deepEqual(await store.settings.profile(), profile());
  assert.equal(await store.settings.verification(), undefined);
  assert.equal(await store.settings.receipt(command), undefined);
  assert.deepEqual(seen, []);
  fail = false;
  await update();
  assert.equal((await store.settings.profile())?.context, 'Saved');
  assert.equal(seen.length, 2);
});
