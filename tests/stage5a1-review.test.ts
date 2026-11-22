import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUsageAccount,
  admitGeneration,
  admitTools,
  observeUsage,
  type GenerationOperation,
  type UsageTransition,
  type UsageObservation,
} from '../core/usage-accounting.ts';

function accepted<G>(transition: UsageTransition<G>) {
  if (transition.kind === 'denied') assert.fail(transition.code);
  return transition;
}
const policy = {
  version: 1 as const,
  maxRequests: 4,
  maxReservedOutputTokens: 10,
  maxToolCalls: 6,
  reviewReserve: { requests: 1, outputTokens: 2, toolCalls: 2 },
};
function proposal(operationId: string, phase: 'work' | 'review', amount: number) {
  return {
    accountId: 'account',
    operationId,
    phase,
    requestedOutputTokens: amount,
    minimumOutputTokens: amount,
  };
}

test('out-of-order known and partial settlements conserve the finite work/review basis without refunding observed savings', () => {
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  let expected: unknown;
  for (const order of orders) {
    let state = createUsageAccount({ id: 'account', policy });
    const operations: GenerationOperation[] = [];
    for (const input of [
      proposal('review', 'review', 3),
      proposal('work-a', 'work', 5),
      proposal('work-b', 'work', 2),
    ]) {
      const result = accepted(admitGeneration(state, undefined, input));
      state = result.account;
      operations.push(result.operation as GenerationOperation);
    }
    for (const [phase, count] of [
      ['work', 4],
      ['review', 2],
    ] as const)
      state = accepted(
        admitTools(state, undefined, {
          accountId: state.id,
          operationId: 'tools-' + phase,
          phase,
          count,
        }),
      ).account;
    const observations: UsageObservation[] = [
      {
        accountId: state.id,
        operationId: 'review',
        outcome: 'observed',
        usage: { inputTokens: 5, outputTokens: 1 },
      },
      {
        accountId: state.id,
        operationId: 'work-a',
        outcome: 'observed',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      {
        accountId: state.id,
        operationId: 'work-b',
        outcome: 'observed',
        usage: { inputTokens: 7 },
      },
    ];
    for (const position of order) {
      const result = accepted(observeUsage(state, operations[position], observations[position]));
      state = result.account;
      operations[position] = result.operation as GenerationOperation;
    }
    assert.equal(state.outstandingOutputTokens, 2);
    assert.deepEqual(state.observed, {
      inputTokens: 12,
      outputTokens: 1,
      knownInputRequests: 3,
      knownOutputRequests: 2,
      completeUsageRequests: 2,
      partialUsageRequests: 1,
      unknownUsageRequests: 1,
    });
    assert.equal(
      state.admitted.work.reservedOutputTokens + state.admitted.review.reservedOutputTokens,
      10,
    );
    assert.deepEqual(state.admitted.work, { requests: 2, reservedOutputTokens: 7, toolCalls: 4 });
    assert.deepEqual(state.admitted.review, { requests: 1, reservedOutputTokens: 3, toolCalls: 2 });
    for (const phase of ['work', 'review'] as const) {
      assert.deepEqual(admitGeneration(state, undefined, proposal('later-' + phase, phase, 1)), {
        kind: 'denied',
        code: 'USAGE_LIMIT_EXHAUSTED',
        message: 'The finite usage allowance is exhausted.',
      });
      assert.equal(
        admitTools(state, undefined, {
          accountId: state.id,
          operationId: 'later-tools-' + phase,
          phase,
          count: 1,
        }).kind,
        'denied',
      );
    }
    for (let position = 0; position < operations.length; position++) {
      const replay = accepted(observeUsage(state, operations[position], observations[position]));
      assert.equal(replay.kind, 'replayed');
      assert.deepEqual(replay.account, state);
    }
    if (expected === undefined) expected = structuredClone(state);
    else assert.deepEqual(state, expected);
  }
});

test('oversized malformed scalar usage and field names poison observation without copying a provider payload into a hot receipt', () => {
  const marker = 'MALFORMED_PROVIDER_PAYLOAD_'.repeat(50000);
  const bigint = BigInt('9'.repeat(10000));
  for (const usage of [
    marker,
    { outputTokens: marker },
    { [marker]: 1 },
    bigint,
    { inputTokens: bigint },
  ]) {
    const account = createUsageAccount({ id: 'account', policy });
    const admission = accepted(
      admitGeneration(account, undefined, proposal('generation', 'work', 2)),
    );
    const observation = {
      accountId: account.id,
      operationId: 'generation',
      outcome: 'observed',
      usage,
    } as UsageObservation;
    const result = accepted(observeUsage(admission.account, admission.operation, observation));
    assert.equal(result.kind, 'applied');
    assert.equal(result.account.status, 'poisoned');
    assert.equal(result.account.violation, 'INVALID_USAGE');
    assert.equal((result.operation as GenerationOperation).status, 'observed');
    assert.equal((result.operation as GenerationOperation).invalidUsage, true);
    assert.equal(result.account.outstandingOutputTokens, 2);
    assert.equal(result.account.observed.unknownUsageRequests, 1);
    const serialized = JSON.stringify(result.operation);
    assert.ok(
      serialized.length < 4096,
      'Malformed response payload belongs in a private artifact, not the accounting hot row.',
    );
    assert.doesNotMatch(serialized, /MALFORMED_PROVIDER_PAYLOAD_/);
    assert.deepEqual(JSON.parse(JSON.stringify(result)).account, result.account);
    assert.equal(
      admitGeneration(result.account, undefined, proposal('later', 'work', 1)).kind,
      'denied',
    );
  }
});
