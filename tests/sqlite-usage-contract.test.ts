import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import type { UsagePolicy, UsageTransition } from '../core/usage-accounting.ts';

const policy: UsagePolicy = {
  version: 1,
  maxRequests: 4,
  maxReservedOutputTokens: 40,
  maxToolCalls: 4,
  reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
};
const command = (id: string) => ({ id, fingerprint: id });
const owner = { kind: 'research' as const, researchId: 'research-json' };
const applied = (transition: UsageTransition<unknown>) => {
  assert.equal(transition.kind, 'applied');
  if (transition.kind !== 'applied') throw Error('Expected an applied transition');
  return transition;
};
async function directory(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-sql-contract-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('SQLite preserves partial usage with undefined optional fields across JSON storage and replay', async (t) => {
  const root = await directory(t);
  let authority = await SqliteProjectUsageAuthority.open({
    directory: root,
    project: { id: 'p', name: 'Synthetic project', root: root },
  });
  t.after(() => authority.close());
  await authority.transaction(command('account'), (tx) =>
    tx.usage.createAccount(owner, { id: 'account-json', policy }),
  );
  const proposal = {
    accountId: 'account-json',
    operationId: 'generation-json',
    phase: 'work' as const,
    requestedOutputTokens: 10,
    minimumOutputTokens: 1,
  };
  applied(
    await authority.transaction(command('admit'), (tx) =>
      tx.usage.admitGeneration(owner, proposal),
    ),
  );
  const observation = {
    accountId: proposal.accountId,
    operationId: proposal.operationId,
    outcome: 'observed' as const,
    usage: { inputTokens: undefined, outputTokens: -0 },
  };
  const settled = applied(
    await authority.transaction(command('observe'), (tx) =>
      tx.usage.observeUsage(owner, observation),
    ),
  );
  assert.equal(settled.account.observed.knownInputRequests, 0);
  assert.equal(settled.account.observed.knownOutputRequests, 1);
  assert.equal(settled.account.observed.partialUsageRequests, 1);
  assert.equal(settled.account.observed.unknownUsageRequests, 1);
  assert.equal(settled.account.outstandingOutputTokens, 0);
  await authority.close();
  authority = await SqliteProjectUsageAuthority.open({
    directory: root,
    project: { id: 'p', name: 'Synthetic project', root: root },
  });
  const saved = await authority.account(owner);
  assert.deepEqual(saved, settled.account);
  const operation = await authority.operation(owner, proposal.operationId);
  assert.deepEqual(operation?.kind === 'generation' && operation.usage, { outputTokens: 0 });
  const replayed = await authority.transaction(command('reobserve'), (tx) =>
    tx.usage.observeUsage(owner, JSON.parse(JSON.stringify(observation))),
  );
  assert.equal(replayed.kind, 'replayed');
  assert.deepEqual(await authority.account(owner), saved);
  assert.equal((await authority.pagedEvents({ after: 0, limit: 10 })).events.length, 3);
});

test('a preexisting foreign SQLite database is rejected without installing authority tables', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'authority.sqlite');
  let database = new DatabaseSync(file);
  database.exec(
    "CREATE TABLE foreign_data (value TEXT); INSERT INTO foreign_data VALUES ('keep');",
  );
  database.close();
  await assert.rejects(
    SqliteProjectUsageAuthority.open({
      directory: root,
      project: { id: 'p', name: 'Synthetic project', root: root },
    }),
    {
      code: 'USAGE_AUTHORITY_FORMAT',
    },
  );
  database = new DatabaseSync(file);
  try {
    assert.deepEqual(database.prepare('SELECT value FROM foreign_data').get()?.value, 'keep');
    assert.deepEqual(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
      ['foreign_data'],
    );
  } finally {
    database.close();
  }
});
