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
  limits.reviewReserve.requests = 0;
  assert.equal(original.policy.reviewReserve.requests, 1);
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
  assert.equal(ManagedRunBudgetPolicySchema.safeParse(policy({ maxRequests: 1 })).success, false);
  const initial = reserve(fixture(), 'request').ledger;
  const partial = structuredClone(initial) as any;
  delete partial.policy.maxRequests;
  assert.equal(ManagedRunBudgetLedgerSchema.safeParse(partial).success, false);
  const invalid = structuredClone(initial);
  (invalid.operations.request as any).reservedOutputTokens = 10000;
  assert.equal(ManagedRunBudgetLedgerSchema.safeParse(invalid).success, false);
  for (const id of ['__proto__', 'constructor', '../secret', ''])
    assert.throws(() => reserve(initial, id), { code: 'INVALID_RUN_BUDGET' });
});

test('public projection has no private receipts and marks legacy coverage explicitly', () => {
  let ledger = createManagedRunBudget({
    projectId: 'p',
    ownerRunId: 'old-run',
    coverage: 'legacy-managed-api',
  });
  assert.deepEqual(ledger.policy, DEFAULT_MANAGED_RUN_BUDGET_POLICY);
  ledger = reserve(ledger, 'private-operation-uuid').ledger;
  const summary = managedBudgetSummary(ledger);
  assert.equal(summary.coverage, 'legacy-managed-api');
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
