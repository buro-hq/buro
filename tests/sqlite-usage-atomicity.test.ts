import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import type {
  ProjectUsageOwner,
  UsageAuthorityEvent,
  UsageAuthorityTransaction,
} from '../core/usage-authority.ts';
import type { GenerationOperation, UsagePolicy } from '../core/usage-accounting.ts';
import { saturateUsageRevision } from './fixtures/sqlite-usage-fault.ts';

const owner: ProjectUsageOwner = { kind: 'run', runId: 'run' };
const policy = (): UsagePolicy => ({
  version: 1,
  maxRequests: 100,
  maxReservedOutputTokens: 10000,
  maxToolCalls: 100,
  reviewReserve: { requests: 10, outputTokens: 1000, toolCalls: 10 },
});
const command = (id: string) => ({ id, fingerprint: 'fingerprint:' + id });
const proposal = (operationId: string, accountId = 'account') => ({
  accountId,
  operationId,
  phase: 'work' as const,
  requestedOutputTokens: 100,
  minimumOutputTokens: 1,
});
function applied<T extends { kind: string }>(value: T) {
  assert.equal(value.kind, 'applied', JSON.stringify(value));
  return value;
}
async function fixture(t: any, extra = {}) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-sqlite-atomicity-')),
  );
  await fs.writeFile(path.join(directory, '.usage-fault-fixture'), 'synthetic-only');
  const options = {
    directory,
    project: { id: 'project', name: 'Synthetic project', root: directory },
    ...extra,
  };
  const opened: SqliteProjectUsageAuthority[] = [];
  const open = async () => {
    const authority = await SqliteProjectUsageAuthority.open(options);
    opened.push(authority);
    return authority;
  };
  t.after(async () => {
    await Promise.all(opened.map((authority) => authority.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, options, open, authority: await open() };
}
async function seed(authority: SqliteProjectUsageAuthority, selectedPolicy = policy()) {
  await authority.transaction(command('seed'), (tx) =>
    tx.usage.createAccount(owner, { id: 'account', policy: selectedPolicy }),
  );
}
async function watermark(authority: SqliteProjectUsageAuthority) {
  return (await authority.pagedEvents({ after: 0, limit: 1 })).watermark;
}
function worker(
  t: any,
  directory: string,
  mode: string,
  id: string,
  fingerprint: string,
  operationId = 'generation',
) {
  const child = fork(
    fileURLToPath(new URL('./fixtures/sqlite-usage-worker.mjs', import.meta.url)),
    [directory, 'project', mode, id, fingerprint, operationId],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] },
  );
  let stderr = '',
    exited = false;
  const messages: any[] = [],
    waiters: {
      type: string;
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }[] = [];
  child.stderr!.on('data', (data) => {
    stderr = (stderr + data).slice(-12000);
  });
  child.on('message', (message: any) => {
    messages.push(message);
    for (const waiter of [...waiters])
      if (message.type === waiter.type) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
  });
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => {
      exited = true;
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(Error('Child exited before ' + waiter.type + ': ' + stderr));
      }
      resolve();
    }),
  );
  t.after(async () => {
    if (!exited) child.kill('SIGKILL');
    await closed;
  });
  return {
    child,
    closed,
    wait(type: string): Promise<any> {
      const received = messages.find((message) => message.type === type);
      if (received) return Promise.resolve(received);
      if (exited) return Promise.reject(Error('Child already exited: ' + stderr));
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(Error('Child timed out before ' + type + ': ' + stderr));
          }, 15000),
        };
        waiters.push(waiter);
      });
    },
  };
}

test('account, operation, event and command receipt roll back together and observers see only a committed retry', async (t) => {
  const published: UsageAuthorityEvent[] = [];
  const f = await fixture(t, { onEvent: (event: UsageAuthorityEvent) => published.push(event) });
  await seed(f.authority);
  const baseline = await watermark(f.authority);
  published.length = 0;
  const before = await f.authority.account(owner);
  await assert.rejects(
    f.authority.transaction(command('rollback'), (tx) => {
      applied(tx.usage.admitGeneration(owner, proposal('generation')));
      assert.equal(published.length, 0);
      throw Error('Abort after SQL writes.');
    }),
    /Abort after SQL writes/,
  );
  assert.deepEqual(await f.authority.account(owner), before);
  assert.equal(await f.authority.operation(owner, 'generation'), undefined);
  assert.deepEqual((await f.authority.pagedEvents({ after: baseline, limit: 10 })).events, []);
  assert.equal(published.length, 0);
  const result = await f.authority.transaction(command('rollback'), (tx) =>
    tx.usage.admitGeneration(owner, proposal('generation')),
  );
  assert.equal(result.kind, 'applied');
  assert.equal(published.length, 1);
  assert.equal((await f.authority.account(owner))!.admitted.work.requests, 1);
  await f.authority.close();
  const reopened = await f.open();
  let calls = 0;
  const replay = await reopened.transaction(command('rollback'), () => {
    calls++;
    throw Error('A replay must not invoke this callback.');
  });
  assert.equal(calls, 0);
  assert.deepEqual(replay, result);
  assert.equal((await reopened.pagedEvents({ after: baseline, limit: 10 })).events.length, 1);
  await assert.rejects(
    reopened.transaction({ id: 'rollback', fingerprint: 'different' }, () => {
      calls++;
      return null;
    }),
  );
  assert.equal(calls, 0);
});

test('async and thenable callbacks roll back every write and retained transaction ports close on success or failure', async (t) => {
  const f = await fixture(t);
  await seed(f.authority);
  const before = await f.authority.account(owner),
    baseline = await watermark(f.authority);
  let retained: UsageAuthorityTransaction | undefined,
    thenCalls = 0;
  for (const [id, result] of [
    ['promise', Promise.resolve('invalid')],
    [
      'thenable',
      {
        then() {
          thenCalls++;
        },
      },
    ],
  ] as const) {
    await assert.rejects(
      f.authority.transaction(command(id), (tx) => {
        retained = tx;
        tx.usage.admitGeneration(owner, proposal(id));
        return result;
      }),
    );
    assert.throws(() => retained!.usage.account(owner));
    assert.throws(() => retained!.usage.admitGeneration(owner, proposal('late:' + id)));
    assert.equal(await f.authority.operation(owner, id), undefined);
  }
  assert.equal(thenCalls, 0);
  assert.deepEqual(await f.authority.account(owner), before);
  assert.deepEqual((await f.authority.pagedEvents({ after: baseline, limit: 10 })).events, []);
  await f.authority.transaction(command('success'), (tx) => {
    retained = tx;
    return null;
  });
  assert.throws(() => retained!.usage.account(owner));
  await f.authority.transaction(command('promise'), (tx) =>
    tx.usage.admitGeneration(owner, proposal('promise')),
  );
  assert.equal((await f.authority.account(owner))!.admitted.work.requests, 1);
});

test('applied malformed-usage poison is committed before an outer error, survives reopen and never leaks private accounting identity', async (t) => {
  const f = await fixture(t);
  const privateId = 'private-account-marker',
    privateOperation = 'private-operation-marker',
    malformed = 'private-credential-marker';
  await f.authority.transaction(command('seed'), (tx) =>
    tx.usage.createAccount(owner, { id: privateId, policy: policy() }),
  );
  await f.authority.transaction(command('admit'), (tx) =>
    tx.usage.admitGeneration(owner, proposal(privateOperation, privateId)),
  );
  const observation = {
    accountId: privateId,
    operationId: privateOperation,
    outcome: 'observed' as const,
    usage: { inputTokens: malformed },
  };
  const result = await f.authority.transaction(
    { id: 'private-command-marker', fingerprint: 'private-fingerprint-marker' },
    (tx) => tx.usage.observeUsage(owner, observation as any),
  );
  assert.notEqual(result.kind, 'denied');
  if (result.kind === 'denied') return;
  assert.equal(result.account.status, 'poisoned');
  assert.ok(result.error);
  assert.throws(() => {
    throw Error(result.error!.message);
  });
  await f.authority.close();
  const reopened = await f.open();
  const current = await reopened.account(owner),
    receipt = (await reopened.operation(owner, privateOperation)) as GenerationOperation;
  assert.equal(current!.status, 'poisoned');
  assert.equal(current!.observed.unknownUsageRequests, 1);
  assert.equal(current!.outstandingOutputTokens, 100);
  assert.equal(receipt.status, 'observed');
  assert.equal(receipt.invalidUsage, true);
  assert.ok(receipt.observationKey?.includes(malformed));
  const page = await reopened.pagedEvents({ after: 0, limit: 20 });
  const publicJson = JSON.stringify(page);
  for (const secret of [
    privateId,
    privateOperation,
    malformed,
    'private-command-marker',
    'private-fingerprint-marker',
    'observationKey',
  ])
    assert.equal(publicJson.includes(secret), false, secret);
  assert.equal(page.events.at(-1)!.summary.status, 'poisoned');
  const count = page.watermark;
  const replay = await reopened.transaction(
    { id: 'private-command-marker', fingerprint: 'private-fingerprint-marker' },
    () => {
      throw Error('Not invoked.');
    },
  );
  assert.deepEqual(replay, result);
  assert.equal(await watermark(reopened), count);
});

test('unknown usage and saturated account revisions preserve distinct operation status across reopen', async (t) => {
  const f = await fixture(t);
  await seed(f.authority);
  await f.authority.transaction(command('admit'), (tx) => {
    tx.usage.admitGeneration(owner, proposal('unknown'));
    tx.usage.admitGeneration(owner, proposal('known'));
    return null;
  });
  await f.authority.close();
  await saturateUsageRevision(f.directory, owner);
  const reopened = await f.open();
  await reopened.transaction(command('observe-unknown'), (tx) =>
    tx.usage.observeUsage(owner, {
      accountId: 'account',
      operationId: 'unknown',
      outcome: 'unknown',
    }),
  );
  await reopened.transaction(command('observe-known'), (tx) =>
    tx.usage.observeUsage(owner, {
      accountId: 'account',
      operationId: 'known',
      outcome: 'observed',
      usage: { inputTokens: 2, outputTokens: 3 },
    }),
  );
  await reopened.close();
  const again = await f.open();
  const current = (await again.account(owner))!;
  assert.equal(current.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(current.status, 'poisoned');
  assert.equal(current.observed.completeUsageRequests, 1);
  assert.equal(current.observed.unknownUsageRequests, 1);
  assert.equal(current.outstandingOutputTokens, 100);
  assert.equal(
    ((await again.operation(owner, 'unknown')) as GenerationOperation).status,
    'unknown',
  );
  assert.equal(((await again.operation(owner, 'known')) as GenerationOperation).status, 'observed');
  const before = await watermark(again);
  const denied = await again.transaction(command('reconcile'), (tx) =>
    tx.usage.observeUsage(owner, {
      accountId: 'account',
      operationId: 'unknown',
      outcome: 'observed',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  );
  assert.equal(denied.kind, 'denied');
  assert.equal(await watermark(again), before);
  assert.deepEqual(await again.account(owner), current);
});

test(
  'two processes racing one command commit exactly one accounting transition and one public event',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await seed(f.authority);
    const before = await watermark(f.authority);
    const a = worker(t, f.directory, 'contend', 'same-command', 'same-fingerprint');
    const b = worker(t, f.directory, 'contend', 'same-command', 'same-fingerprint');
    await Promise.all([a.wait('ready'), b.wait('ready')]);
    a.child.send('go');
    b.child.send('go');
    const results = await Promise.all([a.wait('result'), b.wait('result')]);
    await Promise.all([a.closed, b.closed]);
    assert.ok(
      results.every((result) => result.ok),
      JSON.stringify(results),
    );
    assert.equal(
      results.reduce((count, result) => count + result.callbackCalls, 0),
      1,
    );
    assert.deepEqual(results[0].result, results[1].result);
    assert.equal((await f.authority.account(owner))!.admitted.work.requests, 1);
    assert.equal((await f.authority.pagedEvents({ after: before, limit: 10 })).events.length, 1);
  },
);

for (const phase of ['before-commit', 'after-commit']) {
  test(
    `process termination ${phase} leaves a recoverable atomic receipt, not a second admission`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      await seed(f.authority);
      const before = await watermark(f.authority);
      const child = worker(t, f.directory, phase, 'crash-command', 'crash-fingerprint');
      await child.wait(phase);
      child.child.kill('SIGKILL');
      await child.closed;
      await f.authority.close();
      const reopened = await f.open();
      const committed = phase === 'after-commit';
      assert.equal((await reopened.account(owner))!.admitted.work.requests, committed ? 1 : 0);
      assert.equal((await reopened.operation(owner, 'generation')) !== undefined, committed);
      assert.equal(
        (await reopened.pagedEvents({ after: before, limit: 10 })).events.length,
        committed ? 1 : 0,
      );
      let calls = 0;
      await reopened.transaction(
        { id: 'crash-command', fingerprint: 'crash-fingerprint' },
        (tx) => {
          calls++;
          const decision = tx.usage.admitGeneration(owner, proposal('generation'));
          if (decision.kind === 'denied') throw Error(decision.code);
          return { kind: decision.kind, grant: decision.grant };
        },
      );
      assert.equal(calls, committed ? 0 : 1);
      assert.equal((await reopened.account(owner))!.admitted.work.requests, 1);
      assert.equal((await reopened.pagedEvents({ after: before, limit: 10 })).events.length, 1);
    },
  );
}

test(
  'competing command fingerprints admit one process and reject the other before its callback',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await seed(f.authority);
    const before = await watermark(f.authority);
    const a = worker(
      t,
      f.directory,
      'contend',
      'conflicting-command',
      'fingerprint-a',
      'operation-a',
    );
    const b = worker(
      t,
      f.directory,
      'contend',
      'conflicting-command',
      'fingerprint-b',
      'operation-b',
    );
    await Promise.all([a.wait('ready'), b.wait('ready')]);
    a.child.send('go');
    b.child.send('go');
    const results = await Promise.all([a.wait('result'), b.wait('result')]);
    await Promise.all([a.closed, b.closed]);
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    assert.equal(
      results.reduce((count, result) => count + result.callbackCalls, 0),
      1,
    );
    assert.equal(results.find((result) => !result.ok)!.callbackCalls, 0);
    assert.equal((await f.authority.account(owner))!.admitted.work.requests, 1);
    assert.equal((await f.authority.pagedEvents({ after: before, limit: 10 })).events.length, 1);
    const operations = await Promise.all(
      ['operation-a', 'operation-b'].map((id) => f.authority.operation(owner, id)),
    );
    assert.equal(operations.filter(Boolean).length, 1);
  },
);

test('event cursors retain an exact watermark while later writes remain available to a fresh page', async (t) => {
  const f = await fixture(t);
  await seed(f.authority);
  for (const id of ['one', 'two', 'three'])
    await f.authority.transaction(command(id), (tx) =>
      tx.usage.admitGeneration(owner, proposal(id)),
    );
  const first = await f.authority.pagedEvents({ after: 0, limit: 2 });
  assert.equal(first.events.length, 2);
  assert.equal(first.nextAfter, first.events.at(-1)!.sequence);
  await f.authority.transaction(command('later'), (tx) =>
    tx.usage.admitGeneration(owner, proposal('later')),
  );
  const second = await f.authority.pagedEvents({
    after: first.nextAfter!,
    limit: 2,
    watermark: first.watermark,
  });
  assert.equal(second.watermark, first.watermark);
  const sequences = [...first.events, ...second.events].map((event) => event.sequence);
  assert.deepEqual(sequences, [1, 2, 3, 4]);
  assert.equal(second.nextAfter, undefined);
  const tail = await f.authority.pagedEvents({ after: first.watermark, limit: 2 });
  assert.deepEqual(
    tail.events.map((event) => event.sequence),
    [5],
  );
  assert.equal(tail.events[0].summary.admitted.work.requests, 4);
});

test('conflicting policies and owner bindings reject without rewriting accepted private state', async (t) => {
  const f = await fixture(t);
  await seed(f.authority);
  const before = await f.authority.account(owner),
    events = await watermark(f.authority);
  await assert.rejects(
    f.authority.transaction(command('policy-change'), (tx) =>
      tx.usage.createAccount(owner, { id: 'account', policy: { ...policy(), maxRequests: 99 } }),
    ),
  );
  await assert.rejects(
    f.authority.transaction(command('foreign-account'), (tx) =>
      tx.usage.createAccount(
        { kind: 'research', researchId: 'research' },
        { id: 'account', policy: policy() },
      ),
    ),
  );
  const preparation: ProjectUsageOwner = {
    kind: 'result-preparation',
    preparationId: 'preparation',
    runId: 'run',
    operationId: 'result.preview',
  };
  await f.authority.transaction(command('prepare'), (tx) =>
    tx.usage.createAccount(preparation, { id: 'preparation-account', policy: policy() }),
  );
  await assert.rejects(f.authority.account({ ...preparation, runId: 'another-run' }));
  await assert.rejects(
    f.authority.transaction(command('owner-change'), (tx) =>
      tx.usage.createAccount(
        { ...preparation, operationId: 'result.pull-request' },
        { id: 'preparation-account', policy: policy() },
      ),
    ),
  );
  assert.deepEqual(await f.authority.account(owner), before);
  assert.equal(await watermark(f.authority), events + 1);
});

test(
  'point reads and replay touch constant returned SQL rows at 1000, 10000 and 17409 stored operations',
  { timeout: 120000 },
  async (t) => {
    let capture = false;
    const queries: { operation: string; rows: number }[] = [];
    const f = await fixture(t, {
      onQuery: (query: { operation: string; rows: number }) => {
        if (capture) queries.push({ operation: query.operation, rows: query.rows });
      },
    });
    await seed(f.authority, {
      version: 1,
      maxRequests: 20000,
      maxReservedOutputTokens: 20000,
      maxToolCalls: 0,
      reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
    });
    let seeded = 0;
    const traces: { operation: string; rows: number }[][] = [];
    for (const size of [1000, 10000, 17409]) {
      while (seeded < size) {
        const end = Math.min(size, seeded + 250),
          begin = seeded + 1;
        await f.authority.transaction(command('seed:' + begin + ':' + end), (tx) => {
          for (let id = begin; id <= end; id++)
            applied(
              tx.usage.admitGeneration(owner, {
                ...proposal('generation:' + id),
                requestedOutputTokens: 1,
              }),
            );
          return null;
        });
        seeded = end;
      }
      queries.length = 0;
      capture = true;
      const current = await f.authority.account(owner);
      const last = await f.authority.operation(owner, 'generation:' + size);
      const replay = await f.authority.transaction(command('probe:' + size), (tx) =>
        tx.usage.admitGeneration(owner, {
          ...proposal('generation:' + size),
          requestedOutputTokens: 1,
        }),
      );
      capture = false;
      assert.equal(current!.admitted.work.requests, size);
      assert.ok(last);
      assert.equal(replay.kind, 'replayed');
      assert.ok(queries.length > 0);
      assert.ok(
        queries.every((query) => query.rows <= 1),
        JSON.stringify(queries),
      );
      traces.push(structuredClone(queries));
    }
    assert.deepEqual(traces[1], traces[0]);
    assert.deepEqual(traces[2], traces[0]);
  },
);
