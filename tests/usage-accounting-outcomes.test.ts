import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitGeneration,
  admitTools,
  createUsageAccount,
  observeUsage,
  type GenerationOperation,
  type GenerationProposal,
  type UsageAccount,
  type UsageObservation,
  type UsagePolicy,
  type UsageTransition,
} from '../core/usage-accounting.ts';

const policy = (): UsagePolicy => ({
  version: 1,
  maxRequests: 10,
  maxReservedOutputTokens: 1000,
  maxToolCalls: 20,
  reviewReserve: { requests: 2, outputTokens: 100, toolCalls: 3 },
});
const account = (overrides: Partial<UsagePolicy> = {}) =>
  createUsageAccount({ id: 'project:p/run:r', policy: { ...policy(), ...overrides } });
function persisted<G>(result: UsageTransition<G>) {
  if (result.kind === 'denied') assert.fail(`${result.code}: ${result.message}`);
  return result;
}
function proposal(value: UsageAccount, operationId = 'generation:1'): GenerationProposal {
  return {
    accountId: value.id,
    operationId,
    phase: 'work',
    requestedOutputTokens: 100,
    minimumOutputTokens: 1,
  };
}
function generation(value: UsageAccount, operationId = 'generation:1') {
  const result = persisted(admitGeneration(value, undefined, proposal(value, operationId)));
  assert.equal(result.operation.kind, 'generation');
  return { ...result, operation: result.operation as GenerationOperation };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('unreported, empty and opaque native usage stay unknown rather than becoming a measured zero', () => {
  for (const usage of [undefined, {}]) {
    const admitted = generation(account());
    const observed = persisted(
      observeUsage(admitted.account, admitted.operation, {
        accountId: admitted.account.id,
        operationId: admitted.operation.operationId,
        outcome: 'observed',
        ...(usage ? { usage } : {}),
      }),
    );
    assert.equal(observed.kind, 'applied');
    assert.equal(observed.operation.kind, 'generation');
    assert.equal((observed.operation as GenerationOperation).status, 'observed');
    assert.equal(observed.account.observed.completeUsageRequests, 0);
    assert.equal(observed.account.observed.knownInputRequests, 0);
    assert.equal(observed.account.observed.knownOutputRequests, 0);
    assert.equal(observed.account.observed.unknownUsageRequests, 1);
    assert.equal(observed.account.outstandingOutputTokens, 100);
  }
});

test('input-only reporting preserves a known input subset and the entire unknown output reservation', () => {
  const admitted = generation(account());
  const observed = persisted(
    observeUsage(admitted.account, admitted.operation, {
      accountId: admitted.account.id,
      operationId: admitted.operation.operationId,
      outcome: 'observed',
      usage: { inputTokens: 37 },
    }),
  );
  assert.equal(observed.account.observed.inputTokens, 37);
  assert.equal(observed.account.observed.knownInputRequests, 1);
  assert.equal(observed.account.observed.knownOutputRequests, 0);
  assert.equal(observed.account.observed.completeUsageRequests, 0);
  assert.equal(observed.account.observed.partialUsageRequests, 1);
  assert.equal(observed.account.observed.unknownUsageRequests, 1);
  assert.equal(observed.account.outstandingOutputTokens, 100);
});

test('known output settles exposure without refunding cumulative finite allowance or inventing input usage', () => {
  const admitted = generation(
    account({
      maxReservedOutputTokens: 120,
      reviewReserve: { requests: 2, outputTokens: 20, toolCalls: 3 },
    }),
  );
  const observed = persisted(
    observeUsage(admitted.account, admitted.operation, {
      accountId: admitted.account.id,
      operationId: admitted.operation.operationId,
      outcome: 'observed',
      usage: { outputTokens: 7 },
    }),
  );
  assert.equal(observed.account.observed.outputTokens, 7);
  assert.equal(observed.account.observed.knownOutputRequests, 1);
  assert.equal(observed.account.observed.knownInputRequests, 0);
  assert.equal(observed.account.observed.completeUsageRequests, 0);
  assert.equal(observed.account.observed.unknownUsageRequests, 1);
  assert.equal(observed.account.outstandingOutputTokens, 0);
  assert.equal(observed.account.admitted.work.reservedOutputTokens, 100);
  const next = admitGeneration(
    observed.account,
    undefined,
    proposal(observed.account, 'generation:2'),
  );
  assert.equal(next.kind, 'denied');
  const review = persisted(
    admitGeneration(observed.account, undefined, {
      ...proposal(observed.account, 'review:1'),
      phase: 'review',
      requestedOutputTokens: 20,
    }),
  );
  assert.equal(review.grant?.maxOutputTokens, 20);
});

test('explicit reported zeros are known usage, distinct from a missing usage object', () => {
  const admitted = generation(account());
  const observed = persisted(
    observeUsage(admitted.account, admitted.operation, {
      accountId: admitted.account.id,
      operationId: admitted.operation.operationId,
      outcome: 'observed',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  );
  assert.equal(observed.account.observed.inputTokens, 0);
  assert.equal(observed.account.observed.outputTokens, 0);
  assert.equal(observed.account.observed.knownInputRequests, 1);
  assert.equal(observed.account.observed.knownOutputRequests, 1);
  assert.equal(observed.account.observed.completeUsageRequests, 1);
  assert.equal(observed.account.observed.unknownUsageRequests, 0);
  assert.equal(observed.account.outstandingOutputTokens, 0);
});

test('a lost response keeps its reservation and cannot be silently reconciled by a later ordinary observation', () => {
  const admitted = generation(account());
  const observation: UsageObservation = {
    accountId: admitted.account.id,
    operationId: admitted.operation.operationId,
    outcome: 'unknown',
  };
  const unknown = persisted(observeUsage(admitted.account, admitted.operation, observation));
  const snapshot = structuredClone(unknown);
  assert.equal((unknown.operation as GenerationOperation).status, 'unknown');
  assert.equal(unknown.account.outstandingOutputTokens, 100);
  assert.equal(unknown.account.observed.unknownUsageRequests, 1);
  assert.equal(unknown.account.observed.completeUsageRequests, 0);
  const replay = persisted(observeUsage(unknown.account, unknown.operation, observation));
  assert.equal(replay.kind, 'replayed');
  assert.deepEqual(replay.account, unknown.account);
  assert.equal(
    observeUsage(unknown.account, unknown.operation, {
      ...observation,
      outcome: 'observed',
      usage: { inputTokens: 8, outputTokens: 9 },
    }).kind,
    'denied',
  );
  assert.deepEqual(unknown, snapshot);
});

const malformed: [string, unknown][] = [
  ['negative output', { inputTokens: 3, outputTokens: -1 }],
  ['NaN input', { inputTokens: NaN, outputTokens: 1 }],
  ['infinite output', { outputTokens: Infinity }],
  ['negative infinite input', { inputTokens: -Infinity }],
  ['fractional output', { outputTokens: 1.25 }],
  ['unsafe integer input', { inputTokens: Number.MAX_SAFE_INTEGER + 1 }],
  ['numeric string', { inputTokens: '12', outputTokens: 1 }],
  ['null usage', null],
  ['opaque string', 'not measured'],
];
for (const [name, usage] of malformed) {
  test(`an observed response with ${name} produces a durable poison transition and an observed receipt`, () => {
    const admitted = generation(account());
    const before = structuredClone(admitted);
    const observation = {
      accountId: admitted.account.id,
      operationId: admitted.operation.operationId,
      outcome: 'observed',
      usage,
    } as UsageObservation;
    const result = persisted(
      observeUsage(freeze(admitted.account), freeze(admitted.operation), freeze(observation)),
    );
    assert.equal(result.kind, 'applied');
    assert.equal(result.account.status, 'poisoned');
    assert.equal(result.account.violation, 'INVALID_USAGE');
    assert.equal((result.operation as GenerationOperation).status, 'observed');
    assert.equal((result.operation as GenerationOperation).invalidUsage, true);
    assert.ok(result.error?.code);
    if (typeof usage === 'string') assert.equal(result.error.message.includes(usage), false);
    assert.equal(result.account.observed.completeUsageRequests, 0);
    assert.equal(result.account.observed.unknownUsageRequests, 1);
    assert.equal(result.account.outstandingOutputTokens, 100);
    assert.equal(result.account.admitted.work.requests, 1);
    assert.equal(result.account.admitted.work.reservedOutputTokens, 100);
    const persistedJson = JSON.parse(JSON.stringify(result));
    assert.equal(
      persistedJson.operation.observationKey,
      (result.operation as GenerationOperation).observationKey,
    );
    assert.equal(persistedJson.operation.status, 'observed');
    assert.deepEqual(admitted, before);
    const replay = persisted(observeUsage(result.account, result.operation, observation));
    assert.equal(replay.kind, 'replayed');
    assert.deepEqual(replay.account, result.account);
    assert.deepEqual(replay.error, result.error);
    assert.equal(
      admitGeneration(result.account, undefined, proposal(result.account, 'later')).kind,
      'denied',
    );
    assert.equal(
      admitTools(result.account, undefined, {
        accountId: result.account.id,
        operationId: 'later-tool',
        phase: 'work',
        count: 1,
      }).kind,
      'denied',
    );
  });
}

test('different malformed observations cannot alias through ordinary JSON NaN/null coercion', () => {
  const admitted = generation(account());
  const first = persisted(
    observeUsage(admitted.account, admitted.operation, {
      accountId: admitted.account.id,
      operationId: admitted.operation.operationId,
      outcome: 'observed',
      usage: { inputTokens: NaN },
    }),
  );
  for (const different of [
    { inputTokens: null },
    { inputTokens: Infinity },
    { inputTokens: 'NaN' },
  ]) {
    assert.equal(
      observeUsage(first.account, first.operation, {
        accountId: first.account.id,
        operationId: first.operation.operationId,
        outcome: 'observed',
        usage: different,
      } as UsageObservation).kind,
      'denied',
    );
  }
});

test('deep malformed provider usage cannot throw before producing an observed poison receipt', () => {
  const admitted = generation(account());
  let nested: unknown = 'not a token counter';
  for (let depth = 0; depth < 20000; depth++) nested = { nested };
  const observation = {
    accountId: admitted.account.id,
    operationId: admitted.operation.operationId,
    outcome: 'observed',
    usage: { inputTokens: nested },
  } as UsageObservation;
  const result = persisted(observeUsage(admitted.account, admitted.operation, observation));
  assert.equal(result.kind, 'applied');
  assert.equal(result.account.status, 'poisoned');
  assert.equal(result.account.violation, 'INVALID_USAGE');
  assert.equal((result.operation as GenerationOperation).status, 'observed');
  assert.equal((result.operation as GenerationOperation).invalidUsage, true);
  assert.equal(result.account.observed.completeUsageRequests, 0);
  assert.equal(result.account.observed.unknownUsageRequests, 1);
  assert.equal(result.account.outstandingOutputTokens, 100);
  assert.ok(result.error);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(admitted.operation.status, 'pending');
});

test('over-grant output preserves actual measured usage and permits settlement of another already admitted response', () => {
  const first = generation(account(), 'first');
  const second = generation(first.account, 'already-in-flight');
  const poisoned = persisted(
    observeUsage(second.account, first.operation, {
      accountId: second.account.id,
      operationId: first.operation.operationId,
      outcome: 'observed',
      usage: { inputTokens: 9, outputTokens: 150 },
    }),
  );
  assert.equal(poisoned.account.status, 'poisoned');
  assert.equal(poisoned.account.violation, 'OUTPUT_ALLOWANCE_EXCEEDED');
  assert.equal((poisoned.operation as GenerationOperation).status, 'observed');
  assert.deepEqual((poisoned.operation as GenerationOperation).usage, {
    inputTokens: 9,
    outputTokens: 150,
  });
  assert.equal(poisoned.account.observed.outputTokens, 150);
  assert.equal(poisoned.account.observed.completeUsageRequests, 1);
  assert.equal(poisoned.account.observed.unknownUsageRequests, 1);
  assert.equal(poisoned.account.outstandingOutputTokens, 100);
  assert.ok(poisoned.error);
  const settled = persisted(
    observeUsage(poisoned.account, second.operation, {
      accountId: second.account.id,
      operationId: second.operation.operationId,
      outcome: 'observed',
      usage: { inputTokens: 2, outputTokens: 3 },
    }),
  );
  assert.equal((settled.operation as GenerationOperation).status, 'observed');
  assert.equal(settled.account.status, 'poisoned');
  assert.equal(settled.account.observed.inputTokens, 11);
  assert.equal(settled.account.observed.outputTokens, 153);
  assert.equal(settled.account.observed.completeUsageRequests, 2);
  assert.equal(settled.account.outstandingOutputTokens, 0);
});

test('aggregate input overflow poisons representability without losing either complete observed response', () => {
  const first = generation(account(), 'first');
  const second = generation(first.account, 'second');
  const prior = persisted(
    observeUsage(second.account, first.operation, {
      accountId: second.account.id,
      operationId: first.operation.operationId,
      outcome: 'observed',
      usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
    }),
  );
  assert.equal(prior.account.status, 'open');
  const overflowed = persisted(
    observeUsage(prior.account, second.operation, {
      accountId: second.account.id,
      operationId: second.operation.operationId,
      outcome: 'observed',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  );
  assert.equal(overflowed.kind, 'applied');
  assert.equal(overflowed.account.status, 'poisoned');
  assert.equal(overflowed.account.violation, 'USAGE_ARITHMETIC_OVERFLOW');
  assert.equal(overflowed.account.observed.inputTokens, null);
  assert.equal(overflowed.account.observed.outputTokens, 2);
  assert.equal(overflowed.account.observed.completeUsageRequests, 2);
  assert.equal(overflowed.account.observed.unknownUsageRequests, 0);
  assert.deepEqual((overflowed.operation as GenerationOperation).usage, {
    inputTokens: 1,
    outputTokens: 1,
  });
  assert.ok(overflowed.error);
});

test('revision capacity cannot erase an observed provider response after dispatch', () => {
  const admitted = generation(account());
  admitted.account.revision = Number.MAX_SAFE_INTEGER;
  const observed = persisted(
    observeUsage(admitted.account, admitted.operation, {
      accountId: admitted.account.id,
      operationId: admitted.operation.operationId,
      outcome: 'observed',
      usage: { inputTokens: 6, outputTokens: 4 },
    }),
  );
  assert.equal(observed.kind, 'applied');
  assert.equal(observed.account.status, 'poisoned');
  assert.equal(observed.account.violation, 'USAGE_ARITHMETIC_OVERFLOW');
  assert.equal(observed.account.revision, Number.MAX_SAFE_INTEGER);
  assert.equal((observed.operation as GenerationOperation).status, 'observed');
  assert.deepEqual((observed.operation as GenerationOperation).usage, {
    inputTokens: 6,
    outputTokens: 4,
  });
  assert.equal(observed.account.observed.completeUsageRequests, 1);
  assert.equal(observed.account.outstandingOutputTokens, 0);
  assert.ok(observed.error);
});

test('exact observations replay independently of key order, while changed known or missing counters conflict', () => {
  const admitted = generation(account());
  const first = persisted(
    observeUsage(admitted.account, admitted.operation, {
      accountId: admitted.account.id,
      operationId: admitted.operation.operationId,
      outcome: 'observed',
      usage: { inputTokens: 11, outputTokens: 9 },
    }),
  );
  const exact = persisted(
    observeUsage(first.account, first.operation, {
      operationId: first.operation.operationId,
      accountId: first.account.id,
      usage: { outputTokens: 9, inputTokens: 11 },
      outcome: 'observed',
    }),
  );
  assert.equal(exact.kind, 'replayed');
  assert.deepEqual(exact.account, first.account);
  for (const usage of [undefined, {}, { inputTokens: 11 }, { inputTokens: 12, outputTokens: 9 }])
    assert.equal(
      observeUsage(first.account, first.operation, {
        accountId: first.account.id,
        operationId: first.operation.operationId,
        outcome: 'observed',
        ...(usage ? { usage } : {}),
      }).kind,
      'denied',
    );
});

test('a terminal receipt cannot retain an old observation identity while changing its known usage or status', () => {
  const admitted = generation(account());
  const observation: UsageObservation = {
    accountId: admitted.account.id,
    operationId: admitted.operation.operationId,
    outcome: 'observed',
    usage: { inputTokens: 11, outputTokens: 9 },
  };
  const first = persisted(observeUsage(admitted.account, admitted.operation, observation));
  const original = first.operation as GenerationOperation;
  const corrupted: GenerationOperation[] = [
    { ...structuredClone(original), usage: { inputTokens: 11, outputTokens: 10 } },
    { ...structuredClone(original), usage: { outputTokens: 9 } },
    { ...structuredClone(original), status: 'unknown', usage: undefined },
  ];
  for (const receipt of corrupted) {
    assert.equal(receipt.observationKey, original.observationKey);
    const result = observeUsage(first.account, receipt, observation);
    assert.equal(
      result.kind,
      'denied',
      'A replay cannot publish known contradictory receipt evidence.',
    );
  }
  assert.deepEqual(original.usage, { inputTokens: 11, outputTokens: 9 });
  assert.equal(original.status, 'observed');
});

test('foreign accounts, operation IDs and tool receipts cannot settle a generation', () => {
  const admitted = generation(account());
  const observation: UsageObservation = {
    accountId: admitted.account.id,
    operationId: admitted.operation.operationId,
    outcome: 'observed',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const before = structuredClone(admitted);
  for (const patch of [{ accountId: 'another-owner' }, { operationId: 'another-generation' }])
    assert.equal(
      observeUsage(freeze(admitted.account), freeze(admitted.operation), {
        ...observation,
        ...patch,
      }).kind,
      'denied',
    );
  assert.equal(
    observeUsage(
      admitted.account,
      { ...admitted.operation, accountId: 'another-owner' },
      observation,
    ).kind,
    'denied',
  );
  assert.equal(
    observeUsage(
      admitted.account,
      {
        kind: 'tools',
        accountId: admitted.account.id,
        operationId: admitted.operation.operationId,
        phase: 'work',
        count: 1,
      },
      observation,
    ).kind,
    'denied',
  );
  assert.equal(observeUsage(admitted.account, undefined, observation).kind, 'denied');
  assert.deepEqual(admitted, before);
});

test('denials and detached replay outputs cannot mutate their caller-owned account, policy or accepted receipt', () => {
  const sourcePolicy = policy();
  const initial = createUsageAccount({ id: 'owner', policy: sourcePolicy });
  sourcePolicy.reviewReserve.outputTokens = 0;
  assert.equal(initial.policy.reviewReserve.outputTokens, 100);
  const input = proposal(initial);
  const admitted = persisted(admitGeneration(freeze(initial), undefined, freeze(input)));
  const before = structuredClone(admitted);
  const replay = persisted(
    admitGeneration(freeze(admitted.account), freeze(admitted.operation), input),
  );
  assert.equal(replay.kind, 'replayed');
  replay.account.policy.reviewReserve.outputTokens = 0;
  replay.account.observed.unknownUsageRequests = 0;
  (replay.operation as GenerationOperation).requestedOutputTokens = 1;
  replay.grant!.maxOutputTokens = 1;
  assert.deepEqual(admitted, before);
  const denied = admitGeneration(admitted.account, admitted.operation, {
    ...input,
    requestedOutputTokens: 101,
  });
  assert.equal(denied.kind, 'denied');
  assert.deepEqual(admitted, before);
  assert.equal('operations' in admitted.account, false);
});
