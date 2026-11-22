import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUsageAccount,
  admitGeneration,
  admitTools,
  observeUsage,
  type UsagePolicy,
  type UsageTransition,
  type GenerationOperation,
} from '../core/usage-accounting.ts';
const policy = (): UsagePolicy => ({
  version: 1,
  maxRequests: 3,
  maxReservedOutputTokens: 100,
  maxToolCalls: 4,
  reviewReserve: { requests: 1, outputTokens: 20, toolCalls: 1 },
});
function applied<T>(result: UsageTransition<T>) {
  assert.equal(result.kind, 'applied');
  if (result.kind === 'denied') throw Error(result.code);
  return result;
}
const proposal = {
  accountId: 'opaque account',
  operationId: 'first',
  phase: 'work' as const,
  requestedOutputTokens: 70,
  minimumOutputTokens: 10,
};

test('explicit finite zero and all-review policies are real allowances, never sentinels or defaults', () => {
  const zero = createUsageAccount({
    id: 'opaque account',
    policy: {
      version: 1,
      maxRequests: 0,
      maxReservedOutputTokens: 0,
      maxToolCalls: 0,
      reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
    },
  });
  assert.equal(admitGeneration(zero, undefined, proposal).kind, 'denied');
  assert.equal(
    admitTools(zero, undefined, {
      accountId: zero.id,
      operationId: 'tools',
      phase: 'review',
      count: 1,
    }).kind,
    'denied',
  );
  const allReviewPolicy = policy();
  allReviewPolicy.reviewReserve = { requests: 3, outputTokens: 100, toolCalls: 4 };
  const allReview = createUsageAccount({ id: proposal.accountId, policy: allReviewPolicy });
  assert.equal(admitGeneration(allReview, undefined, proposal).kind, 'denied');
  assert.equal(
    admitGeneration(allReview, undefined, { ...proposal, phase: 'review' }).kind,
    'applied',
  );
  assert.throws(() => createUsageAccount({ id: 'x', policy: undefined as never }), {
    code: 'INVALID_USAGE_POLICY',
  });
});

test('fixed-size records reject injected history and forged settlement fields before copying them', () => {
  const account = createUsageAccount({ id: proposal.accountId, policy: policy() });
  const extra = Object.assign({}, account);
  Object.defineProperty(extra, 'history', {
    enumerable: true,
    get() {
      throw Error('Growing history must never be read.');
    },
  });
  assert.throws(() => admitGeneration(extra, undefined, proposal), {
    code: 'INVALID_USAGE_ACCOUNT',
  });
  const forged = admitGeneration(account, undefined, {
    ...proposal,
    usage: { outputTokens: 0 },
  } as never);
  assert.equal(forged.kind, 'denied');
  const pending = applied(admitGeneration(account, undefined, proposal));
  for (const patch of [
    { maxOutputTokens: NaN },
    { maxOutputTokens: 0 },
    { status: 'completed' },
    { history: ['private'] },
    { usage: { outputTokens: 0 } },
  ]) {
    const result = admitGeneration(
      pending.account,
      { ...pending.operation, ...patch } as never,
      proposal,
    );
    assert.equal(result.kind, 'denied');
  }
});

test('policy, proposals, operation grants and returned settlements never alias caller authority', () => {
  const source = policy();
  const account = createUsageAccount({ id: proposal.accountId, policy: source });
  source.maxRequests = 1000;
  const first = applied(admitGeneration(account, undefined, proposal));
  assert.equal(first.account.policy.maxRequests, 3);
  assert.equal(account.admitted.work.requests, 0);
  const before = structuredClone(first);
  const settled = applied(
    observeUsage(first.account, first.operation, {
      accountId: account.id,
      operationId: proposal.operationId,
      outcome: 'observed',
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  );
  assert.deepEqual(first, before);
  (settled.operation as GenerationOperation).usage!.inputTokens = 999;
  settled.account.policy.maxRequests = 500;
  assert.deepEqual(first, before);
});

test('replayed historical grants remain visible under poison but never claim a new dispatch allowance', () => {
  const account = createUsageAccount({ id: proposal.accountId, policy: policy() });
  const first = applied(admitGeneration(account, undefined, proposal));
  const secondProposal = { ...proposal, operationId: 'second', requestedOutputTokens: 10 };
  const second = applied(admitGeneration(first.account, undefined, secondProposal));
  const poisoned = applied(
    observeUsage(second.account, first.operation, {
      accountId: account.id,
      operationId: proposal.operationId,
      outcome: 'observed',
      usage: { outputTokens: 71 },
    }),
  );
  const replayed = admitGeneration(poisoned.account, second.operation, secondProposal);
  assert.equal(replayed.kind, 'replayed');
  if (replayed.kind === 'denied') throw Error(replayed.code);
  assert.equal(replayed.grant!.maxOutputTokens, 10);
  assert.equal(replayed.error?.code, 'USAGE_ACCOUNT_POISONED');
  assert.deepEqual(replayed.account, poisoned.account);
});
