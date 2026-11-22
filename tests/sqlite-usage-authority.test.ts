import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import type { UsageAuthorityTransaction, UsageAuthorityEvent } from '../core/usage-authority.ts';

const owner = { kind: 'run' as const, runId: 'test-run' };
const policy = {
  version: 1 as const,
  maxRequests: 10,
  maxReservedOutputTokens: 100,
  maxToolCalls: 10,
  reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
};
const command = (id: string) => ({ id, fingerprint: id });
const generation = (id = 'generation') => ({
  accountId: 'private-account',
  operationId: id,
  phase: 'work' as const,
  requestedOutputTokens: 10,
  minimumOutputTokens: 1,
});
async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-sql-authority-')));
  const events: UsageAuthorityEvent[] = [];
  const open = () =>
    SqliteProjectUsageAuthority.open({
      directory: path.join(root, 'state'),
      project: { id: 'p', name: 'Synthetic project', root: path.join(root, 'state') },
      onEvent: (event) => {
        events.push(event);
      },
    });
  let authority = await open();
  t.after(async () => {
    await authority.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    get authority() {
      return authority;
    },
    events,
    async reopen() {
      await authority.close();
      authority = await open();
    },
  };
}

test('SQLite default-none accounts retain absent quotas, charged unknown work and immutable receipts across reopen', async (t) => {
  const f = await fixture(t);
  await f.authority.transaction(command('none-account'), (tx) =>
    tx.usage.createAccount(owner, { id: 'private-account', policy: { version: 1 } }),
  );
  let firstReceipt: unknown;
  for (let index = 0; index < 80; index++) {
    if (index === 40) await f.reopen();
    const operationId = 'PRIVATE_NONE_OPERATION-' + index;
    const receipt = await f.authority.transaction(command('none-request-' + index), (tx) => {
      const admitted = tx.usage.admitGeneration(owner, {
        ...generation(operationId),
        requestedOutputTokens: 2048,
      });
      assert.equal(admitted.kind, 'applied');
      return tx.usage.observeUsage(owner, {
        accountId: 'private-account',
        operationId,
        outcome: 'unknown',
      });
    });
    if (index === 0) firstReceipt = receipt;
  }
  await f.authority.transaction(command('none-tools'), (tx) => {
    const result = tx.usage.admitTools(owner, {
      accountId: 'private-account',
      operationId: 'PRIVATE_NONE_TOOLS',
      phase: 'work',
      count: 1000,
    });
    assert.equal(result.kind, 'applied');
    return result;
  });
  const before = (await f.authority.account(owner))!;
  assert.deepEqual(before.policy, { version: 1 });
  assert.deepEqual(before.admitted.work, {
    requests: 80,
    reservedOutputTokens: 163840,
    toolCalls: 1000,
  });
  assert.equal(before.observed.unknownUsageRequests, 80);
  assert.equal(before.outstandingOutputTokens, 163840);
  assert.equal(before.status, 'open');
  await f.reopen();
  assert.deepEqual(await f.authority.account(owner), before);
  assert.deepEqual(
    await f.authority.transaction(command('none-request-0'), () => {
      throw Error('A durable command receipt must replay after reopening.');
    }),
    firstReceipt,
  );
  for (const conflicting of [
    { version: 1 as const, maxRequests: 1000 },
    { version: 1 as const, reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 } },
  ]) {
    await assert.rejects(
      f.authority.transaction(command('none-policy-' + JSON.stringify(conflicting)), (tx) =>
        tx.usage.createAccount(owner, { id: 'private-account', policy: conflicting }),
      ),
      { code: 'USAGE_ACCOUNT_CONFLICT' },
    );
  }
  const replay = await f.authority.transaction(command('none-operation-replay'), (tx) =>
    tx.usage.admitGeneration(owner, {
      ...generation('PRIVATE_NONE_OPERATION-0'),
      requestedOutputTokens: 2048,
    }),
  );
  assert.equal(replay.kind, 'replayed');
  const conflict = await f.authority.transaction(command('none-observation-conflict'), (tx) =>
    tx.usage.observeUsage(owner, {
      accountId: 'private-account',
      operationId: 'PRIVATE_NONE_OPERATION-0',
      outcome: 'observed',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  );
  assert.equal(conflict.kind, 'denied');
  assert.deepEqual(await f.authority.account(owner), before);
  const operation = await f.authority.operation(owner, 'PRIVATE_NONE_OPERATION-0');
  assert.equal(operation?.kind === 'generation' && operation.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_NONE_|private-account|observationKey/);
});

test('SQLite authority creates private database companions and project-bound metadata', async (t) => {
  const f = await fixture(t);
  assert.equal((await fs.stat(f.authority.directory)).mode & 0o777, 0o700);
  for (const file of ['authority.sqlite', 'authority.sqlite-wal', 'authority.sqlite-shm'])
    assert.equal((await fs.stat(path.join(f.authority.directory, file))).mode & 0o777, 0o600);
  await assert.rejects(
    SqliteProjectUsageAuthority.open({
      directory: f.authority.directory,
      project: { id: 'another-project', name: 'Synthetic project', root: f.authority.directory },
    }),
    { code: 'USAGE_PROJECT_MISMATCH' },
  );
  await f.authority.transaction(command('still-usable'), (tx) =>
    tx.usage.createAccount(owner, { id: 'private-account', policy }),
  );
  assert.equal((await f.authority.account(owner))?.id, 'private-account');
});

test('symlink ancestors, database targets and preexisting SQLite companions are rejected', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-sql-private-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const actual = path.join(root, 'actual');
  await fs.mkdir(actual);
  await fs.symlink(actual, path.join(root, 'alias'));
  await assert.rejects(
    SqliteProjectUsageAuthority.open({
      directory: path.join(root, 'alias', 'nested'),
      project: { id: 'p', name: 'Synthetic project', root: path.join(root, 'alias', 'nested') },
    }),
    { code: 'UNSAFE_USAGE_STORAGE' },
  );
  const sentinel = path.join(root, 'sentinel');
  await fs.writeFile(sentinel, 'Must stay unchanged');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const directory = path.join(root, 'state' + (suffix || '-db'));
    await fs.mkdir(directory);
    await fs.symlink(sentinel, path.join(directory, 'authority.sqlite' + suffix));
    await assert.rejects(
      SqliteProjectUsageAuthority.open({
        directory,
        project: { id: 'p', name: 'Synthetic project', root: directory },
      }),
      {
        code: 'UNSAFE_USAGE_STORAGE',
      },
    );
  }
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'Must stay unchanged');
});

test('void command results replay without invoking the callback or adding an event', async (t) => {
  const f = await fixture(t);
  let retained!: UsageAuthorityTransaction;
  const result = await f.authority.transaction(command('void'), (tx) => {
    retained = tx;
    tx.usage.createAccount(owner, { id: 'private-account', policy });
  });
  assert.equal(result, undefined);
  const replay = await f.authority.transaction(command('void'), () => {
    throw Error('A committed void receipt must replay.');
  });
  assert.equal(replay, undefined);
  assert.equal(f.events.length, 1);
  assert.throws(
    () =>
      retained.usage.createAccount({ kind: 'run', runId: 'late' }, { id: 'late-account', policy }),
    { code: 'USAGE_TRANSACTION_CLOSED' },
  );
  const snapshot = await f.authority.account(owner);
  snapshot!.policy.maxRequests = 1;
  assert.equal((await f.authority.account(owner))?.policy.maxRequests, 10);
});

test('async callbacks roll back all work and retained capabilities close before their continuation', async (t) => {
  const f = await fixture(t);
  let late: Promise<unknown> | undefined;
  await assert.rejects(
    f.authority.transaction(command('async'), (tx) => {
      tx.usage.createAccount(owner, { id: 'private-account', policy });
      late = Promise.resolve().then(() =>
        assert.throws(() => tx.usage.admitGeneration(owner, generation()), {
          code: 'USAGE_TRANSACTION_CLOSED',
        }),
      );
      return late;
    }),
    { code: 'ASYNC_USAGE_TRANSACTION' },
  );
  await late;
  assert.equal(await f.authority.account(owner), undefined);
  assert.deepEqual(f.events, []);
  assert.deepEqual((await f.authority.pagedEvents({ after: 0, limit: 5 })).events, []);
  await f.authority.transaction(command('async'), (tx) =>
    tx.usage.createAccount(owner, { id: 'private-account', policy }),
  );
  assert.equal(f.events.length, 1, 'failed async attempt did not save its command receipt');
});

test('non-JSON results and thenables cannot commit partial mutations or execute result getters', async (t) => {
  const f = await fixture(t);
  let getters = 0;
  const getterResult = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      getters++;
      throw Error('Not a data value');
    },
  });
  const getterArray = Object.defineProperty([0], '0', {
    enumerable: true,
    get() {
      getters++;
      return 0;
    },
  });
  const thenable = Object.defineProperty({}, 'then', {
    get() {
      getters++;
      return () => {};
    },
  });
  const cases = [new Map(), 1n, () => {}, { nested: NaN }, getterResult, getterArray];
  for (const [index, result] of cases.entries()) {
    await assert.rejects(
      f.authority.transaction(command('invalid-' + index), (tx) => {
        tx.usage.createAccount(owner, { id: 'private-account', policy });
        return result;
      }),
      { code: 'USAGE_RESULT_NOT_JSON' },
    );
  }
  await assert.rejects(
    f.authority.transaction(command('thenable'), (tx) => {
      tx.usage.createAccount(owner, { id: 'private-account', policy });
      return thenable;
    }),
    { code: 'ASYNC_USAGE_TRANSACTION' },
  );
  const canonical = await f.authority.transaction(command('canonical-optional'), () => ({
    nested: undefined,
    value: -0,
  }));
  assert.deepEqual(canonical, { value: 0 });
  assert.deepEqual(
    await f.authority.transaction(command('canonical-optional'), () => {
      throw Error('Already canonical');
    }),
    canonical,
  );
  assert.equal(getters, 0);
  assert.equal(await f.authority.account(owner), undefined);
  assert.deepEqual(f.events, []);
});

test('applied poison and its private receipt persist while public events exclude request identities', async (t) => {
  const f = await fixture(t);
  await f.authority.transaction(command('admission'), (tx) => {
    tx.usage.createAccount(owner, { id: 'private-account', policy });
    return tx.usage.admitGeneration(owner, generation('PRIVATE_OPERATION_MARKER'));
  });
  const observation = {
    accountId: 'private-account',
    operationId: 'PRIVATE_OPERATION_MARKER',
    outcome: 'observed' as const,
    usage: { inputTokens: 2, outputTokens: 11 },
  };
  const poisoned = await f.authority.transaction(command('poison'), (tx) =>
    tx.usage.observeUsage(owner, observation),
  );
  assert.equal(poisoned.kind, 'applied');
  if (poisoned.kind === 'denied') throw Error(poisoned.code);
  assert.ok(poisoned.error);
  assert.equal((await f.authority.account(owner))?.status, 'poisoned');
  const operation = await f.authority.operation(owner, observation.operationId);
  assert.equal(operation?.kind, 'generation');
  if (operation?.kind !== 'generation') throw Error('Missing receipt');
  assert.equal(operation.usage?.outputTokens, 11);
  const page = await f.authority.pagedEvents({ after: 0, limit: 100 });
  const publicBytes = JSON.stringify(page);
  assert.doesNotMatch(
    publicBytes,
    /PRIVATE_OPERATION_MARKER|private-account|observationKey|invalidUsage/,
  );
  assert.equal(page.events.length, 3);
  const replay = await f.authority.transaction(command('poison'), () => {
    throw Error('Do not observe twice');
  });
  assert.deepEqual(replay, poisoned);
  assert.equal(f.events.length, 3);
});

test('observer failures do not turn committed receipts into failed transactions', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-sql-observers-')));
  const authority = await SqliteProjectUsageAuthority.open({
    directory: root,
    project: { id: 'p', name: 'Synthetic project', root: root },
    onQuery() {
      throw Error('Query observer failed');
    },
    onEvent() {
      throw Error('Event observer failed');
    },
  });
  t.after(async () => {
    await authority.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const original = await authority.transaction(command('save'), (tx) =>
    tx.usage.createAccount(owner, { id: 'private-account', policy }),
  );
  assert.deepEqual(
    await authority.transaction(command('save'), () => {
      throw Error('Already committed');
    }),
    original,
  );
  assert.equal((await authority.pagedEvents({ after: 0, limit: 1 })).events.length, 1);
});

test('close drains admitted work once and refuses new reads and writes', async (t) => {
  const f = await fixture(t);
  const pending = f.authority.transaction(command('admitted'), (tx) =>
    tx.usage.createAccount(owner, { id: 'private-account', policy }),
  );
  const closing = f.authority.close();
  assert.equal(f.authority.close(), closing);
  assert.equal((await pending).id, 'private-account');
  await closing;
  await assert.rejects(f.authority.account(owner), { code: 'USAGE_AUTHORITY_CLOSED' });
  await assert.rejects(
    f.authority.transaction(command('late'), () => null),
    { code: 'USAGE_AUTHORITY_CLOSED' },
  );
});

test('project authority identity cannot be retargeted after opening', async (t) => {
  const f = await fixture(t);
  assert.throws(() => {
    (f.authority as any).projectId = 'another';
  }, TypeError);
  assert.throws(
    () => Object.defineProperty(f.authority, 'projectId', { value: 'another' }),
    TypeError,
  );
  assert.throws(
    () => Object.defineProperty(f.authority, 'directory', { value: '/another' }),
    TypeError,
  );
  await f.authority.transaction(command('identity'), (tx) =>
    tx.usage.createAccount(owner, { id: 'private-account', policy }),
  );
  assert.equal(f.authority.projectId, 'p');
  assert.equal(f.events[0].projectId, 'p');
  assert.equal((await f.authority.pagedEvents({ after: 0, limit: 1 })).events[0].projectId, 'p');
});
