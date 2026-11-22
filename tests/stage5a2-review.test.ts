import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import type { ProjectUsageOwner, UsageAuthorityEvent } from '../core/usage-authority.ts';
import type { UsageTransition } from '../core/usage-accounting.ts';

const policy = {
  version: 1 as const,
  maxRequests: 4,
  maxReservedOutputTokens: 40,
  maxToolCalls: 4,
  reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
};
const command = (id: string) => ({ id, fingerprint: id });
const proposal = (accountId: string, operationId = 'same-operation') => ({
  accountId,
  operationId,
  phase: 'work' as const,
  requestedOutputTokens: 10,
  minimumOutputTokens: 1,
});
function applied<G>(transition: UsageTransition<G>) {
  assert.equal(transition.kind, 'applied');
  if (transition.kind === 'denied') throw Error(transition.code);
  return transition;
}
async function fixture(t: any, onEvent?: (event: UsageAuthorityEvent) => void) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-sql-independent-')),
  );
  const opened: SqliteProjectUsageAuthority[] = [];
  const open = async () => {
    const authority = await SqliteProjectUsageAuthority.open({
      directory,
      project: { id: 'p', name: 'Synthetic project', root: directory },
      onEvent,
    });
    opened.push(authority);
    return authority;
  };
  t.after(async () => {
    await Promise.all(opened.map((authority) => authority.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, open, authority: await open() };
}

test('equal domain IDs and operation IDs remain separate across owner namespaces and cannot settle each other', async (t) => {
  const f = await fixture(t);
  const run: ProjectUsageOwner = { kind: 'run', runId: 'same' },
    research: ProjectUsageOwner = { kind: 'research', researchId: 'same' };
  await f.authority.transaction(command('seed-both'), (tx) => {
    tx.usage.createAccount(run, { id: 'run-account', policy });
    tx.usage.createAccount(research, { id: 'research-account', policy });
    applied(tx.usage.admitGeneration(run, proposal('run-account')));
    applied(tx.usage.admitGeneration(research, proposal('research-account')));
  });
  const before = await f.authority.account(run),
    otherBefore = await f.authority.account(research);
  const watermark = (await f.authority.pagedEvents({ after: 0, limit: 10 })).watermark;
  const denied = await f.authority.transaction(command('wrong-owner'), (tx) =>
    tx.usage.observeUsage(run, {
      accountId: 'research-account',
      operationId: 'same-operation',
      outcome: 'observed',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  );
  assert.equal(denied.kind, 'denied');
  assert.deepEqual(await f.authority.account(run), before);
  assert.deepEqual(await f.authority.account(research), otherBefore);
  assert.equal((await f.authority.pagedEvents({ after: 0, limit: 10 })).watermark, watermark);
  await f.authority.transaction(command('observe-run'), (tx) =>
    applied(
      tx.usage.observeUsage(run, {
        accountId: 'run-account',
        operationId: 'same-operation',
        outcome: 'observed',
        usage: { inputTokens: 2, outputTokens: 1 },
      }),
    ),
  );
  await f.authority.close();
  const reopened = await f.open();
  assert.equal((await reopened.operation(run, 'same-operation'))?.kind, 'generation');
  assert.equal((await reopened.account(run))!.observed.completeUsageRequests, 1);
  assert.equal((await reopened.account(research))!.observed.completeUsageRequests, 0);
  assert.equal((await reopened.account(research))!.outstandingOutputTokens, 10);
  const query = { after: 0, limit: 2 };
  const reading = reopened.pagedEvents(query);
  query.after = 9999;
  query.limit = 0;
  const first = await reading;
  assert.deepEqual(
    first.events.map((event) => event.sequence),
    [1, 2],
  );
  first.events[0].summary.policy.maxRequests = 999;
  assert.equal(
    (await reopened.pagedEvents({ after: 0, limit: 1 })).events[0].summary.policy.maxRequests,
    4,
  );
});

test('undefined and sparse result arrays roll back staged account, operation and event rows rather than silently becoming JSON null', async (t) => {
  const f = await fixture(t);
  const owner: ProjectUsageOwner = { kind: 'run', runId: 'r' };
  for (const [index, invalid] of [[undefined], Array(1)].entries()) {
    await assert.rejects(
      f.authority.transaction(command('array-' + index), (tx) => {
        tx.usage.createAccount(owner, { id: 'account', policy });
        applied(tx.usage.admitGeneration(owner, proposal('account')));
        return invalid;
      }),
      { code: 'USAGE_RESULT_NOT_JSON' },
    );
    assert.equal(await f.authority.account(owner), undefined);
    assert.equal(await f.authority.operation(owner, 'same-operation'), undefined);
    assert.deepEqual((await f.authority.pagedEvents({ after: 0, limit: 10 })).events, []);
  }
  const accepted = await f.authority.transaction(command('array-0'), (tx) => {
    tx.usage.createAccount(owner, { id: 'account', policy });
    return [{ optional: undefined, measured: -0 }];
  });
  assert.deepEqual(accepted, [{ measured: 0 }]);
  assert.deepEqual(
    await f.authority.transaction(command('array-0'), () => {
      throw Error('Receipt must replay');
    }),
    accepted,
  );
  assert.equal((await f.authority.pagedEvents({ after: 0, limit: 10 })).events.length, 1);
});

test(
  'a pending async observer cannot delay a committed receipt or close, and its mutated event and late rejection do not change durable history',
  { timeout: 5000 },
  async (t) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    let callbacks = 0;
    const f = await fixture(t, async (event) => {
      callbacks++;
      event.summary.policy.maxRequests = 999;
      event.owner = { kind: 'run', runId: 'observer-rewrite' };
      await held;
      throw Error('Late observer rejection');
    });
    const owner: ProjectUsageOwner = { kind: 'run', runId: 'r' };
    const first = await f.authority.transaction(command('saved'), (tx) =>
      tx.usage.createAccount(owner, { id: 'account', policy }),
    );
    assert.equal(callbacks, 1);
    first.policy.maxRequests = 500;
    const replay = await f.authority.transaction(command('saved'), () => {
      throw Error('Already saved');
    });
    assert.equal((replay as typeof first).policy.maxRequests, 4);
    assert.equal(callbacks, 1);
    await f.authority.close();
    release();
    await setImmediate();
    const reopened = await f.open();
    assert.equal((await reopened.account(owner))!.policy.maxRequests, 4);
    const page = await reopened.pagedEvents({ after: 0, limit: 10 });
    assert.equal(page.events.length, 1);
    assert.deepEqual(page.events[0].owner, owner);
    assert.equal(page.events[0].summary.policy.maxRequests, 4);
  },
);
