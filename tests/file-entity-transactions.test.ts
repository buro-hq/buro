import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { defaultRoles } from './fixtures/roles.ts';
import type { Goal } from '../protocol/domain.ts';

const command = { id: 'entity-batch', fingerprint: 'entity-batch' };
const goal = (): Goal => ({
  id: 'G-batch',
  projectId: 'p',
  title: 'Batch goal',
  body: 'One change',
  criteria: 'Checked',
  status: 'draft',
  revision: 1,
  createdAt: '2026-11-22T00:00:00Z',
});
const role = () => ({ ...structuredClone(defaultRoles[0]), id: 'batch-role' });
async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-file-entities-')),
  );
  let writes = 0,
    fail = false;
  const store = await FileProjectStore.open({
    directory,
    project: { id: 'p', name: 'Synthetic', root: directory },
    replace: async (from, to) => {
      writes++;
      if (fail) throw Error('Synthetic write failure');
      await fs.rename(from, to);
    },
  });
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    writes: () => writes,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}

test('one file entity transaction commits its batch once and reentrant subscribers see each event once', async (t) => {
  const f = await fixture(t);
  const original: number[] = [],
    joined: number[] = [];
  let unsubscribe: (() => void) | undefined;
  f.store.subscribe(0, (event) => {
    original.push(event.seq);
    if (event.seq === 1) unsubscribe = f.store.subscribe(0, (saved) => joined.push(saved.seq));
  });
  const before = f.writes();
  const result = await f.store.entities.transaction(command, (tx) => ({
    goal: tx.createGoal(goal()),
    role: tx.appendRole(role(), 0),
  }));
  assert.equal(f.writes(), before + 1);
  assert.deepEqual(original, [1, 2]);
  assert.deepEqual(joined, [1, 2]);
  assert.equal(f.store.snapshot().sequence, 2);
  result.goal.title = 'Caller mutation';
  const replay = await f.store.entities.transaction(command, () => {
    throw Error('Replay callback');
  });
  assert.equal((replay as typeof result).goal.title, 'Batch goal');
  assert.equal((await f.store.entities.goal('G-batch'))?.title, 'Batch goal');
  assert.equal(f.writes(), before + 1);
  assert.deepEqual(joined, [1, 2]);
  unsubscribe?.();
});

test('a failed file write rolls back all entity rows, events and receipt before a same-command retry', async (t) => {
  const f = await fixture(t),
    before = f.store.snapshot();
  const events: number[] = [];
  f.store.subscribe(0, (event) => events.push(event.seq));
  const change = () =>
    f.store.entities.transaction(command, (tx) => ({
      goal: tx.createGoal(goal()),
      role: tx.appendRole(role(), 0),
    }));
  f.fail(true);
  await assert.rejects(change(), /Synthetic write failure/);
  assert.deepEqual(f.store.snapshot(), before);
  assert.deepEqual(events, []);
  assert.equal(f.store.receipt(command.id, command.fingerprint), undefined);
  assert.equal(await f.store.entities.goal('G-batch'), undefined);
  assert.equal(await f.store.entities.role('batch-role'), undefined);
  f.fail(false);
  await change();
  assert.deepEqual(events, [1, 2]);
});

test('an async file entity callback cannot retain a query or write capability after rollback', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending!: Promise<void>;
  await assert.rejects(
    f.store.entities.transaction(command, (tx) => {
      pending = (async () => {
        tx.createGoal(goal());
        await held;
        assert.throws(() => tx.goal('G-batch'), { code: 'ENTITY_TRANSACTION_CLOSED' });
        assert.throws(() => tx.appendRole(role(), 0), { code: 'ENTITY_TRANSACTION_CLOSED' });
      })();
      return pending;
    }),
    { code: 'ASYNC_ENTITY_TRANSACTION' },
  );
  release();
  await pending;
  assert.equal(await f.store.entities.goal('G-batch'), undefined);
  assert.equal(await f.store.entities.role('batch-role'), undefined);
  assert.equal(f.store.snapshot().sequence, 0);
  assert.equal(f.store.receipt(command.id, command.fingerprint), undefined);
});
