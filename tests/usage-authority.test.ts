import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUsageAuthorityTransaction,
  usageOwnerKey,
  validateUsageOwner,
  validateProjectUsageChange,
  type ProjectUsageOwner,
  type UsageTransactionStorage,
  type ProjectUsageChange,
} from '../core/usage-authority.ts';
import {
  validateUsageAccount,
  validateUsageOperation,
  type UsageAccount,
  type UsageOperation,
  type UsagePolicy,
} from '../core/usage-accounting.ts';

const policy: UsagePolicy = {
  version: 1,
  maxRequests: 10,
  maxReservedOutputTokens: 100,
  maxToolCalls: 10,
  reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
};
const binding: ProjectUsageOwner = { kind: 'research', researchId: 'research-1' };
function fixture() {
  let active = true;
  const accounts = new Map<string, UsageAccount>();
  const operations = new Map<string, UsageOperation>();
  const changes: ProjectUsageChange[] = [];
  let mutations = 0;
  const storage: UsageTransactionStorage = {
    account: (owner) => accounts.get(usageOwnerKey(owner)),
    operation: (owner, id) => operations.get(JSON.stringify([usageOwnerKey(owner), id])),
    insertAccount(owner, account) {
      accounts.set(usageOwnerKey(owner), structuredClone(account));
      mutations++;
    },
    applyTransition(owner, transition) {
      const key = usageOwnerKey(owner),
        operationKey = JSON.stringify([key, transition.operation.operationId]);
      assert.deepEqual(accounts.get(key), transition.previousAccount);
      assert.deepEqual(operations.get(operationKey), transition.previousOperation);
      accounts.set(key, structuredClone(transition.account));
      operations.set(operationKey, structuredClone(transition.operation));
      mutations++;
    },
    appendChange: (change) => {
      changes.push(structuredClone(change));
    },
  };
  const tx = createUsageAuthorityTransaction({
    projectId: 'project',
    storage,
    assertActive() {
      if (!active)
        throw Object.assign(Error('Closed transaction.'), { code: 'USAGE_TRANSACTION_CLOSED' });
    },
  });
  return {
    tx,
    accounts,
    operations,
    changes,
    mutations: () => mutations,
    close: () => {
      active = false;
    },
  };
}

test('owner primary identities are unambiguous and additional operation bindings cannot become a new namespace', () => {
  const owners: ProjectUsageOwner[] = [
    { kind: 'run', runId: 'same' },
    { kind: 'research', researchId: 'same' },
    { kind: 'result-preparation', preparationId: 'same', runId: 'run', operationId: 'preview' },
    { kind: 'environment-verification', verificationId: 'same' },
    { kind: 'result-application', applicationId: 'same', runId: 'run' },
  ];
  assert.equal(new Set(owners.map(usageOwnerKey)).size, 5);
  assert.equal(
    usageOwnerKey(owners[2]),
    usageOwnerKey({
      kind: 'result-preparation',
      preparationId: 'same',
      runId: 'other',
      operationId: 'deploy',
    }),
  );
  for (const invalid of [
    null,
    {},
    { ...binding, projectId: 'foreign' },
    { kind: 'research', researchId: '' },
  ])
    assert.throws(() => validateUsageOwner(invalid), { code: 'INVALID_USAGE_OWNER' });
  const copy = validateUsageOwner(owners[0]);
  assert.notEqual(copy, owners[0]);
});

test('semantic transactions call the existing engine and emit only applied account summaries', () => {
  const f = fixture();
  f.tx.usage.createAccount(binding, { id: 'PRIVATE_ACCOUNT', policy });
  const proposal = {
    accountId: 'PRIVATE_ACCOUNT',
    operationId: 'PRIVATE_OPERATION',
    phase: 'work' as const,
    requestedOutputTokens: 100,
    minimumOutputTokens: 1,
  };
  const admitted = f.tx.usage.admitGeneration(binding, proposal);
  assert.equal(admitted.kind, 'applied');
  assert.equal(f.mutations(), 2);
  assert.equal(f.tx.usage.admitGeneration(binding, proposal).kind, 'replayed');
  assert.equal(
    f.tx.usage.admitTools(binding, {
      accountId: proposal.accountId,
      operationId: 'over',
      phase: 'work',
      count: 11,
    }).kind,
    'denied',
  );
  assert.equal(f.mutations(), 2);
  assert.equal(f.changes.length, 2);
  f.tx.usage.createAccount(binding, {
    id: 'PRIVATE_ACCOUNT',
    policy: { ...policy, reviewReserve: { toolCalls: 0, outputTokens: 0, requests: 0 } },
  });
  assert.equal(f.mutations(), 2);
  const poisoned = f.tx.usage.observeUsage(binding, {
    accountId: proposal.accountId,
    operationId: proposal.operationId,
    outcome: 'observed',
    usage: { outputTokens: NaN },
  });
  assert.equal(poisoned.kind, 'applied');
  if (poisoned.kind === 'denied') throw Error(poisoned.code);
  assert.ok(poisoned.error);
  assert.equal(f.tx.usage.account(binding)?.status, 'poisoned');
  assert.equal(f.tx.usage.operation(binding, proposal.operationId)?.kind, 'generation');
  const publicJSON = JSON.stringify(f.changes);
  assert.equal(publicJSON.includes('PRIVATE_'), false);
  assert.equal(publicJSON.includes('observationKey'), false);
  assert.equal(publicJSON.includes('invalidUsage'), false);
  assert.deepEqual(f.changes[2].summary.coverage, {
    admissions: 'recorded-operations-only',
    providerUsage: 'known-subset',
    opaqueBackendUsage: 'unknown',
  });
  assert.deepEqual(
    validateProjectUsageChange(JSON.parse(JSON.stringify(f.changes[2])), 'project'),
    f.changes[2],
  );
});

test('the semantic callback surface has no raw row writes and expires with its owning transaction', () => {
  const f = fixture();
  const account = f.tx.usage.createAccount(binding, { id: 'account', policy });
  account.policy.maxRequests = 100;
  assert.equal(f.tx.usage.account(binding)?.policy.maxRequests, 10);
  assert.throws(() => f.tx.usage.createAccount(binding, { id: 'different', policy }), {
    code: 'USAGE_ACCOUNT_CONFLICT',
  });
  assert.equal('storage' in f.tx, false);
  assert.equal('applyTransition' in f.tx.usage, false);
  f.close();
  for (const call of [
    () => f.tx.usage.account(binding),
    () => f.tx.usage.operation(binding, 'op'),
    () => f.tx.usage.createAccount(binding, { id: 'account', policy }),
    () =>
      f.tx.usage.admitGeneration(binding, {
        accountId: 'account',
        operationId: 'op',
        phase: 'work',
        requestedOutputTokens: 1,
        minimumOutputTokens: 1,
      }),
  ])
    assert.throws(call, { code: 'USAGE_TRANSACTION_CLOSED' });
});

test('persisted validators reject corrupt or private public projections and return detached valid rows', () => {
  const f = fixture();
  const account = f.tx.usage.createAccount(binding, { id: 'account', policy });
  for (const value of [null, false, 'bad', [], { ...account, history: [] }])
    assert.throws(() => validateUsageAccount(value), { code: 'INVALID_USAGE_ACCOUNT' });
  for (const value of [null, false, 'bad', [], {}])
    assert.throws(() => validateUsageOperation(value, account), {
      code: 'INVALID_USAGE_OPERATION',
    });
  for (const value of [
    null,
    { ...f.changes[0], projectId: 'foreign' },
    { ...f.changes[0], summary: { ...f.changes[0].summary, id: 'private' } },
    {
      ...f.changes[0],
      summary: {
        ...f.changes[0].summary,
        coverage: { admissions: 'all', providerUsage: 'complete', opaqueBackendUsage: 'zero' },
      },
    },
  ])
    assert.throws(() => validateProjectUsageChange(value, 'project'), {
      code: 'INVALID_USAGE_EVENT',
    });
});
