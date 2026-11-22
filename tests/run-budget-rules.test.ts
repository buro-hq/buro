import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createManagedRunBudget,
  managedBudgetSummary,
  ManagedRunBudgetLedgerSchema,
  reserveManagedGeneration,
  reserveManagedTools,
  observeManagedUsage,
  type ManagedRunBudgetLedger,
} from '../core/run-budget.ts';
import {
  DEFAULT_MANAGED_RUN_BUDGET_POLICY,
  ManagedRunBudgetPolicySchema,
  ManagedRunBudgetSummarySchema,
  type ManagedRunBudgetPolicy,
} from '../protocol/run-budget.ts';
import {
  admitGeneration,
  admitTools,
  createUsageAccount,
  observeUsage,
  validateUsageAccount,
  type UsageTransition,
} from '../core/usage-accounting.ts';

const policy = (changes: Partial<ManagedRunBudgetPolicy> = {}): ManagedRunBudgetPolicy => ({
  version: 1,
  maxRequests: 4,
  maxReservedOutputTokens: 4000,
  maxToolCalls: 5,
  reviewReserve: { requests: 1, outputTokens: 1000, toolCalls: 1 },
  ...changes,
});
const fixture = (limits = policy()) =>
  createManagedRunBudget({
    projectId: 'p',
    ownerRunId: 'r',
    coverage: 'managed-api',
    policy: limits,
  });
function reserve(
  ledger: ManagedRunBudgetLedger,
  operationId: string,
  phase: 'work' | 'review' = 'work',
  requestedOutputTokens = 512,
) {
  return reserveManagedGeneration(ledger, {
    operationId,
    phase,
    requestedOutputTokens,
    minimumOutputTokens: 128,
  });
}

test('coordinator and workers collectively stop while review requests and tools remain available', () => {
  let ledger = fixture();
  for (const id of ['coordinator', 'worker-a', 'worker-b']) ledger = reserve(ledger, id).ledger;
  assert.throws(() => reserve(ledger, 'replacement'), { code: 'RUN_BUDGET_EXHAUSTED' });
  ledger = reserveManagedTools(ledger, {
    operationId: 'work-tools',
    phase: 'work',
    count: 4,
  }).ledger;
  assert.throws(
    () => reserveManagedTools(ledger, { operationId: 'more-tools', phase: 'work', count: 1 }),
    { code: 'RUN_BUDGET_EXHAUSTED' },
  );
  ledger = reserve(ledger, 'fresh-review', 'review').ledger;
  ledger = reserveManagedTools(ledger, {
    operationId: 'review-tool',
    phase: 'review',
    count: 1,
  }).ledger;
  const summary = managedBudgetSummary(ledger);
  assert.equal(summary.used.requests, 4);
  assert.equal(summary.workUsed.requests, 3);
  assert.equal(summary.reviewUsed.requests, 1);
  assert.equal(summary.used.toolCalls, 5);
  assert.throws(() => reserve(ledger, 'another-review', 'review'), {
    code: 'RUN_BUDGET_EXHAUSTED',
  });
});

test('output headroom lowers only this grant and preserves protected review output without refunds', () => {
  let ledger = fixture(
    policy({
      maxRequests: 10,
      maxReservedOutputTokens: 1024,
      reviewReserve: { requests: 2, outputTokens: 256, toolCalls: 1 },
    }),
  );
  ledger = reserve(ledger, 'first', 'work', 500).ledger;
  ledger = observeManagedUsage(ledger, {
    operationId: 'first',
    outcome: 'observed',
    usage: { inputTokens: 20, outputTokens: 5 },
  }).ledger;
  const next = reserve(ledger, 'second', 'work', 500);
  assert.equal(next.grant.maxOutputTokens, 268);
  ledger = next.ledger;
  assert.equal(managedBudgetSummary(ledger).used.reservedOutputTokens, 768);
  assert.throws(() => reserve(ledger, 'third'), { code: 'RUN_BUDGET_EXHAUSTED' });
  const reviewer = reserve(ledger, 'review', 'review', 500);
  assert.equal(reviewer.grant.maxOutputTokens, 256);
  assert.equal(managedBudgetSummary(reviewer.ledger).used.reservedOutputTokens, 1024);
});

test('review can use unspent capacity but total remaining allowance still bounds work', () => {
  let ledger = fixture(
    policy({
      maxReservedOutputTokens: 1024,
      reviewReserve: { requests: 1, outputTokens: 256, toolCalls: 1 },
    }),
  );
  ledger = reserve(ledger, 'review', 'review', 900).ledger;
  assert.throws(() => reserve(ledger, 'work'), { code: 'RUN_BUDGET_EXHAUSTED' });
  assert.equal(managedBudgetSummary(ledger).used.reservedOutputTokens, 900);
});

test('generation and tool operation IDs are idempotent only for an identical reservation', () => {
  const first = reserve(fixture(), 'same');
  const duplicate = reserve(first.ledger, 'same');
  assert.deepEqual(duplicate, first);
  assert.throws(() => reserve(first.ledger, 'same', 'review'), { code: 'BUDGET_RECEIPT_CONFLICT' });
  assert.throws(() => reserve(first.ledger, 'same', 'work', 1000), {
    code: 'BUDGET_RECEIPT_CONFLICT',
  });
  assert.throws(
    () => reserveManagedTools(first.ledger, { operationId: 'same', phase: 'work', count: 1 }),
    { code: 'BUDGET_RECEIPT_CONFLICT' },
  );
  const tools = reserveManagedTools(first.ledger, {
    operationId: 'batch',
    phase: 'work',
    count: 2,
  });
  assert.deepEqual(
    reserveManagedTools(tools.ledger, { operationId: 'batch', phase: 'work', count: 2 }),
    tools,
  );
  assert.throws(
    () => reserveManagedTools(tools.ledger, { operationId: 'batch', phase: 'work', count: 1 }),
    { code: 'BUDGET_RECEIPT_CONFLICT' },
  );
});

test('unknown and partial usage remain charged and cannot be rewritten as a new observation', () => {
  let ledger = reserve(fixture(), 'lost').ledger;
  ledger = observeManagedUsage(ledger, { operationId: 'lost', outcome: 'unknown' }).ledger;
  assert.deepEqual(
    observeManagedUsage(ledger, { operationId: 'lost', outcome: 'unknown' }).ledger,
    ledger,
  );
  assert.throws(
    () =>
      observeManagedUsage(ledger, {
        operationId: 'lost',
        outcome: 'observed',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    { code: 'BUDGET_RECEIPT_CONFLICT' },
  );
  ledger = reserve(ledger, 'partial').ledger;
  ledger = observeManagedUsage(ledger, {
    operationId: 'partial',
    outcome: 'observed',
    usage: { inputTokens: 42 },
  }).ledger;
  const summary = managedBudgetSummary(ledger);
  assert.equal(summary.used.reservedOutputTokens, 1024);
  assert.equal(summary.observed.unknownUsageRequests, 2);
  assert.equal(summary.observed.completeUsageRequests, 0);
  assert.equal(summary.observed.inputTokens, 42);
});

test('observed output above reservation returns durable poisoned state before blocking future work', () => {
  const before = reserve(fixture(), 'request').ledger;
  const after = observeManagedUsage(before, {
    operationId: 'request',
    outcome: 'observed',
    usage: { inputTokens: 10, outputTokens: 513 },
  });
  assert.equal(before.violation, undefined);
  assert.equal(after.error?.code, 'RUN_BUDGET_USAGE_EXCEEDED');
  assert.equal(after.ledger.violation, 'OUTPUT_RESERVATION_EXCEEDED');
  assert.equal(managedBudgetSummary(after.ledger).observed.outputTokens, 513);
  assert.equal(managedBudgetSummary(after.ledger).status, 'exceeded');
  assert.throws(() => reserve(after.ledger, 'fresh', 'review'), {
    code: 'RUN_BUDGET_USAGE_EXCEEDED',
  });
  assert.throws(() => reserve(after.ledger, 'request'), { code: 'RUN_BUDGET_USAGE_EXCEEDED' });
  assert.throws(
    () => reserveManagedTools(after.ledger, { operationId: 'tool', phase: 'review', count: 1 }),
    { code: 'RUN_BUDGET_USAGE_EXCEEDED' },
  );
  assert.equal(
    observeManagedUsage(after.ledger, {
      operationId: 'request',
      outcome: 'observed',
      usage: { outputTokens: 513, inputTokens: 10 },
    }).error?.code,
    'RUN_BUDGET_USAGE_EXCEEDED',
  );
});

test('malformed observed usage poisons accounting without retaining raw provider fields', () => {
  for (const invalid of [
    { outputTokens: -1 },
    { outputTokens: 1.5 },
    { inputTokens: NaN },
    { outputTokens: 'private-provider-value' },
    { outputTokens: 1, prompt: 'private-provider-value' },
  ]) {
    const result = observeManagedUsage(reserve(fixture(), 'request').ledger, {
      operationId: 'request',
      outcome: 'observed',
      usage: invalid as any,
    });
    assert.equal(result.ledger.violation, 'INVALID_USAGE');
    assert.equal(result.error?.code, 'RUN_BUDGET_USAGE_EXCEEDED');
    assert.equal(JSON.stringify(result).includes('private-provider-value'), false);
    assert.equal(managedBudgetSummary(result.ledger).observed.unknownUsageRequests, 1);
    assert.throws(() => reserve(result.ledger, 'next'), { code: 'RUN_BUDGET_USAGE_EXCEEDED' });
  }
});

test('ledger transitions and summaries are detached from caller and source objects', () => {
  const limits = policy();
  const original = fixture(limits);
  limits.reviewReserve!.requests = 0;
  assert.equal(original.policy.reviewReserve!.requests, 1);
  const next = reserve(original, 'request');
  assert.deepEqual(original.operations, {});
  const summary = managedBudgetSummary(next.ledger);
  summary.policy.maxRequests = 100;
  summary.used.requests = 0;
  assert.equal(next.ledger.policy.maxRequests, 4);
  assert.equal(managedBudgetSummary(next.ledger).used.requests, 1);
});

test('frozen policies and persisted ledgers reject partial, inconsistent and unsafe data', () => {
  assert.equal(ManagedRunBudgetPolicySchema.safeParse({}).success, false);
  for (const invalid of [null, false, 0, ''])
    assert.throws(
      () =>
        createManagedRunBudget({
          projectId: 'p',
          ownerRunId: 'r',
          coverage: 'managed-api',
          policy: invalid as never,
        }),
      { code: 'INVALID_RUN_BUDGET' },
    );
  assert.equal(ManagedRunBudgetPolicySchema.safeParse(policy({ maxRequests: 1 })).success, false);
  const initial = reserve(fixture(), 'request').ledger;
  const partial = structuredClone(initial) as any;
  delete partial.policy.version;
  assert.equal(ManagedRunBudgetLedgerSchema.safeParse(partial).success, false);
  const invalid = structuredClone(initial);
  (invalid.operations.request as any).reservedOutputTokens = 10000;
  assert.equal(ManagedRunBudgetLedgerSchema.safeParse(invalid).success, false);
  for (const id of ['__proto__', 'constructor', '../secret', ''])
    assert.throws(() => reserve(initial, id), { code: 'INVALID_RUN_BUDGET' });
});

test('default policy has no cumulative quota while every generation, tool and unknown receipt remains charged', () => {
  let ledger = createManagedRunBudget({ projectId: 'p', ownerRunId: 'r', coverage: 'managed-api' });
  assert.deepEqual(ledger.policy, { version: 1 });
  for (let index = 0; index < 80; index++) {
    const operationId = 'request-' + index;
    ledger = reserve(ledger, operationId, index % 2 ? 'review' : 'work', 2048).ledger;
    ledger = observeManagedUsage(ledger, { operationId, outcome: 'unknown' }).ledger;
  }
  ledger = reserveManagedTools(ledger, { operationId: 'tools', phase: 'work', count: 1000 }).ledger;
  const summary = managedBudgetSummary(ledger);
  assert.equal(summary.used.requests, 80);
  assert.equal(summary.used.reservedOutputTokens, 163840);
  assert.equal(summary.used.toolCalls, 1000);
  assert.equal(summary.observed.unknownUsageRequests, 80);
  assert.equal(summary.status, 'open');
  assert.deepEqual(reserve(ledger, 'request-0', 'work', 2048).ledger, ledger);
  assert.throws(
    () =>
      observeManagedUsage(ledger, {
        operationId: 'request-0',
        outcome: 'observed',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    { code: 'BUDGET_RECEIPT_CONFLICT' },
  );
});

test('optional quotas constrain only the requested dimension and reserves require its finite limit', () => {
  const requestOnly = fixture({ version: 1, maxRequests: 1 });
  const reserved = reserve(requestOnly, 'one', 'work', 2048).ledger;
  assert.throws(() => reserve(reserved, 'two', 'review'), { code: 'RUN_BUDGET_EXHAUSTED' });
  assert.equal(
    managedBudgetSummary(
      reserveManagedTools(reserved, {
        operationId: 'unbounded-tools',
        phase: 'work',
        count: 20000,
      }).ledger,
    ).used.toolCalls,
    20000,
  );
  const outputOnly = fixture({ version: 1, maxReservedOutputTokens: 512 });
  assert.equal(reserve(outputOnly, 'lowered', 'review', 1024).grant.maxOutputTokens, 512);
  for (const limits of [
    { version: 1, reviewReserve: { requests: 1, outputTokens: 0, toolCalls: 0 } },
    { version: 1, maxRequests: 5, reviewReserve: { requests: 1, outputTokens: 1, toolCalls: 0 } },
    { version: 1, maxRequests: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.equal(ManagedRunBudgetPolicySchema.safeParse(limits).success, false);
  assert.equal(
    ManagedRunBudgetPolicySchema.safeParse({
      version: 1,
      maxRequests: 2048,
      maxReservedOutputTokens: 33554432,
      maxToolCalls: 32768,
    }).success,
    true,
  );
});

test('a default ledger can exceed the old operation-record ceiling without hiding or resetting receipts', () => {
  const ledger = fixture({ version: 1 });
  for (let index = 0; index < 17409; index++) {
    ledger.operations['tools-' + index] = { kind: 'tools', phase: 'work', count: 1 };
  }
  const parsed = ManagedRunBudgetLedgerSchema.parse(ledger);
  assert.equal(Object.keys(parsed.operations).length, 17409);
  assert.equal(managedBudgetSummary(parsed).used.toolCalls, 17409);
  assert.deepEqual(
    reserveManagedTools(parsed, {
      operationId: 'tools-0',
      phase: 'work',
      count: 1,
    }).ledger,
    parsed,
  );
});

function applied<G>(transition: UsageTransition<G>) {
  assert.notEqual(transition.kind, 'denied');
  if (transition.kind === 'denied') throw Error(transition.code);
  return transition;
}

test('indexed usage accounting shares default-none quota semantics and preserves immutable unknown observations', () => {
  let account = createUsageAccount({ id: 'account', policy: { version: 1 } });
  let first: ReturnType<typeof applied> | undefined;
  for (let index = 0; index < 80; index++) {
    const generation = applied(
      admitGeneration(account, undefined, {
        accountId: account.id,
        operationId: 'request-' + index,
        phase: 'work',
        requestedOutputTokens: 2048,
        minimumOutputTokens: 128,
      }),
    );
    const observed = applied(
      observeUsage(generation.account, generation.operation, {
        accountId: account.id,
        operationId: generation.operation.operationId,
        outcome: 'unknown',
      }),
    );
    first ||= observed;
    account = observed.account;
  }
  account = applied(
    admitTools(account, undefined, {
      accountId: account.id,
      operationId: 'tools',
      phase: 'work',
      count: 20000,
    }),
  ).account;
  assert.equal(account.admitted.work.requests, 80);
  assert.equal(account.admitted.work.reservedOutputTokens, 163840);
  assert.equal(account.observed.unknownUsageRequests, 80);
  assert.equal(account.admitted.work.toolCalls, 20000);
  assert.deepEqual(validateUsageAccount(account), account);
  assert.equal(
    observeUsage(account, first!.operation, {
      accountId: account.id,
      operationId: 'request-0',
      outcome: 'observed',
      usage: { outputTokens: 1 },
    }).kind,
    'denied',
  );
});

test('default-none stops at exact safe-integer representability before a further admission', () => {
  const ledger = reserveManagedTools(fixture({ version: 1 }), {
    operationId: 'last-representable',
    phase: 'work',
    count: Number.MAX_SAFE_INTEGER,
  }).ledger;
  assert.equal(managedBudgetSummary(ledger).used.toolCalls, Number.MAX_SAFE_INTEGER);
  assert.throws(
    () =>
      reserveManagedTools(ledger, {
        operationId: 'overflow',
        phase: 'review',
        count: 1,
      }),
    { code: 'INVALID_RUN_BUDGET' },
  );
  const indexed = applied(
    admitTools(createUsageAccount({ id: 'account', policy: { version: 1 } }), undefined, {
      accountId: 'account',
      operationId: 'last-representable',
      phase: 'work',
      count: Number.MAX_SAFE_INTEGER,
    }),
  ).account;
  assert.deepEqual(
    admitTools(indexed, undefined, {
      accountId: 'account',
      operationId: 'overflow',
      phase: 'review',
      count: 1,
    }),
    {
      kind: 'denied',
      code: 'USAGE_ARITHMETIC_OVERFLOW',
      message: 'Usage counters cannot safely represent another admission.',
    },
  );
  assert.equal(indexed.admitted.review.toolCalls, 0);
});

test('public projection has no private receipts and reports current managed coverage', () => {
  let ledger = createManagedRunBudget({
    projectId: 'p',
    ownerRunId: 'run',
    coverage: 'managed-api',
  });
  assert.deepEqual(ledger.policy, DEFAULT_MANAGED_RUN_BUDGET_POLICY);
  ledger = reserve(ledger, 'private-operation-uuid').ledger;
  const summary = managedBudgetSummary(ledger);
  assert.equal(summary.coverage, 'managed-api');
  assert.equal(JSON.stringify(summary).includes('private-operation-uuid'), false);
  assert.equal(JSON.stringify(summary).includes('operations'), false);
  assert.equal(
    ManagedRunBudgetSummarySchema.safeParse({ ...summary, operations: ledger.operations }).success,
    false,
  );
  assert.equal(
    ManagedRunBudgetSummarySchema.safeParse({
      ...summary,
      observed: { ...summary.observed, unknownUsageRequests: 0 },
    }).success,
    false,
  );
});
