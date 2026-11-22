import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import type { EntityTransaction } from '../core/project-entities.ts';

const goal = (id: string) => ({
  id,
  projectId: 'p',
  title: 'Goal',
  body: 'Stored once',
  criteria: '',
  status: 'draft' as const,
  revision: 1,
  createdAt: '2026-11-22T00:00:00Z',
});
const command = (id: string) => ({ id, fingerprint: id });
async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-sql-entities-')),
  );
  const authority = await SqliteProjectUsageAuthority.open({
    directory,
    project: { id: 'p', name: 'Synthetic project', root: directory },
  });
  t.after(async () => {
    await authority.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return authority;
}

test('entity facet identity is frozen and transaction capabilities expire after direct facet use', async (t) => {
  const authority = await fixture(t);
  let retained!: EntityTransaction;
  assert.throws(() => Object.defineProperty(authority, 'entities', { value: {} }), TypeError);
  assert.throws(() => {
    (authority.entities as any).projectId = 'another';
  }, TypeError);
  const created = await authority.entities.transaction(command('goal'), (tx) => {
    retained = tx;
    return tx.createGoal(goal('G-one'));
  });
  assert.equal(created.id, 'G-one');
  assert.throws(() => retained.goal('G-one'), { code: 'USAGE_TRANSACTION_CLOSED' });
  assert.throws(() => retained.createGoal(goal('G-late')), { code: 'USAGE_TRANSACTION_CLOSED' });
  assert.equal(await authority.entities.goal('G-late'), undefined);
  const detached = await authority.entities.goal('G-one');
  detached!.title = 'Caller mutation';
  assert.equal((await authority.entities.goal('G-one'))?.title, 'Goal');
});

test('entity async callbacks roll back and cannot mutate after awaiting', async (t) => {
  const authority = await fixture(t);
  let continuation: Promise<unknown> | undefined;
  await assert.rejects(
    authority.entities.transaction(command('async'), (tx) => {
      tx.createGoal(goal('G-first'));
      continuation = Promise.resolve().then(() =>
        assert.throws(() => tx.createGoal(goal('G-late')), { code: 'USAGE_TRANSACTION_CLOSED' }),
      );
      return continuation;
    }),
    { code: 'ASYNC_USAGE_TRANSACTION' },
  );
  await continuation;
  assert.equal(await authority.entities.goal('G-first'), undefined);
  assert.equal(await authority.entities.goal('G-late'), undefined);
  assert.deepEqual((await authority.pagedEvents({ after: 0, limit: 10 })).events, []);
});

test('entity facade and combined kernel commands share their original receipt namespace', async (t) => {
  const authority = await fixture(t);
  const created = await authority.entities.transaction(command('shared'), (tx) =>
    tx.createGoal(goal('G-one')),
  );
  const replay = await authority.transaction(command('shared'), () => {
    throw Error('A facet must not create a separate receipt namespace.');
  });
  assert.deepEqual(replay, created);
  await assert.rejects(
    authority.transaction({ id: 'shared', fingerprint: 'different' }, () => null),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  assert.equal((await authority.pagedEvents({ after: 0, limit: 10 })).events.length, 1);
  await authority.entities.transaction(command('delete'), (tx) => tx.deleteGoal('G-one', 1));
  assert.equal(await authority.entities.goal('G-one'), undefined);
  await assert.rejects(
    authority.entities.transaction(command('reuse'), (tx) => tx.createGoal(goal('G-one'))),
    { code: 'CONFLICT' },
  );
  const page = await authority.pagedEvents({ after: 0, limit: 10 });
  assert.deepEqual(
    page.events.map((event) => [event.sequence, event.type]),
    [
      [1, 'goal.created'],
      [2, 'goal.deleted'],
    ],
  );
});
