import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { QuerySubscription, type QueryResult } from '../src/data/query-subscription.ts';
import { queryAffected } from '../src/data/query-notifications.ts';

test('continuous notifications refresh the view before the stream stops', async (t) => {
  const updates: number[] = [];
  let reads = 0;
  const query = new QuerySubscription({
    read: async () => ++reads,
    update: ({ data }) => {
      if (data !== undefined)
        updates.push(data);
    },
  });
  const stream = setInterval(() => query.invalidate(), 5);
  t.after(() => {
    clearInterval(stream);
    query.close();
  });
  await delay(220);
  assert.ok(updates.length >= 3, `Only ${updates.length} reads during the stream`);
  assert.ok(updates.length < 12, 'Notifications should be coalesced');
});

test('slow reads are applied even when dirty and only one follow-up runs at a time', async () => {
  const pending: ((value: number) => void)[] = [];
  const updates: QueryResult<number>[] = [];
  const query = new QuerySubscription<number>({
    read: () => new Promise((resolve) => pending.push(resolve)),
    update: (state) => updates.push(state),
  });
  try {
    for (let index = 0; index < 20; index++)
      query.invalidate();
    await delay(75);
    assert.equal(pending.length, 1, 'The first read is still in flight');
    pending[0](1);
    await delay(0);
    assert.deepEqual(updates, [{ data: 1, loading: false }]);
    await delay(75);
    assert.equal(pending.length, 2);
    query.invalidate();
    query.close();
    pending[1](2);
    await delay(75);
    assert.equal(pending.length, 2);
    assert.equal(updates.length, 1, 'An unmounted view ignores a late response');
  } finally {
    query.close();
  }
});

test('a failed refresh retains the visible data and the next change can recover', async () => {
  const updates: QueryResult<number>[] = [];
  let reads = 0;
  const query = new QuerySubscription({
    async read() {
      if (++reads === 2)
        throw new Error('Fixture disconnected');

      return reads;
    },
    update: (state) => updates.push(state),
  });
  try {
    await delay(0);
    query.invalidate();
    await delay(75);
    assert.deepEqual(updates.at(-1), {
      data: 1,
      loading: false,
      error: 'Fixture disconnected',
    });
    query.invalidate();
    await delay(75);
    assert.deepEqual(updates.at(-1), {
      data: 3,
      loading: false,
    });
  } finally {
    query.close();
  }
});

test('notifications affect their own feature and owner, with conservative deletion handling', () => {
  const affects = (type: string, data: unknown) =>
    queryAffected({
      method: 'previews.list',
      params: { runId: 'selected' },
      notification: { type, data },
    });
  assert.equal(affects('preview.output', {
    runId: 'selected',
  }), true);
  assert.equal(affects('preview.output', {
    runId: 'other',
  }), false);
  assert.equal(affects('session.updated', {
    runId: 'selected',
  }), false);
  assert.equal(affects('model.saved', {}), false);
  assert.equal(affects('preview.error', {
    id: 'preview',
  }), true);
  assert.equal(
    queryAffected({
      method: 'tasks.list',
      params: { projectId: 'old-project' },
      notification: { type: 'task.updated', data: { projectId: 'new-project' } },
    }),
    true,
    'Moving a task also refreshes its previous project',
  );
  assert.equal(
    queryAffected({
      method: 'sessions.get',
      params: { id: 'selected' },
      notification: { type: 'session.updated', data: { id: 'other' } },
    }),
    false,
  );
  assert.equal(
    queryAffected({
      method: 'results.inspect',
      params: { runId: 'selected' },
      notification: { type: 'run.updated', data: { id: 'other' } },
    }),
    false,
  );
});
