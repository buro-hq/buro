import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitGeneration,
  createUsageAccount,
  observeUsage,
  type GenerationOperation,
  type UsageObservation,
} from '../core/usage-accounting.ts';

test('optional undefined fields and measured zeros replay after the observation crosses a JSON boundary', () => {
  for (const patch of [
    { usage: undefined },
    { usage: { inputTokens: undefined } },
    { usage: { inputTokens: undefined, outputTokens: 0 } },
    { usage: { inputTokens: 0, outputTokens: undefined } },
    { usage: { inputTokens: -0, outputTokens: -0 } },
  ]) {
    const initial = createUsageAccount({
      id: 'json-account',
      policy: {
        version: 1,
        maxRequests: 1,
        maxReservedOutputTokens: 10,
        maxToolCalls: 0,
        reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
      },
    });
    const admission = admitGeneration(initial, undefined, {
      accountId: initial.id,
      operationId: 'generation',
      phase: 'work',
      requestedOutputTokens: 10,
      minimumOutputTokens: 1,
    });
    if (admission.kind === 'denied') assert.fail(admission.code);
    const observation: UsageObservation = {
      accountId: initial.id,
      operationId: 'generation',
      outcome: 'observed',
      ...patch,
    };
    const settled = observeUsage(admission.account, admission.operation, observation);
    if (settled.kind === 'denied') assert.fail(settled.code);
    assert.equal(settled.kind, 'applied');
    const persisted = JSON.parse(JSON.stringify(settled));
    const replay = observeUsage(
      persisted.account,
      persisted.operation,
      JSON.parse(JSON.stringify(observation)),
    );
    assert.equal(replay.kind, 'replayed');
    if (replay.kind === 'denied') assert.fail(replay.code);
    assert.deepEqual(replay.account, persisted.account);
    assert.deepEqual(replay.operation, persisted.operation);
  }
});

test('opaque malformed usage preserves an observed JSON-safe poison receipt without evaluating provider accessors', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'outputTokens', {
    enumerable: true,
    get() {
      reads++;
      throw Error('Provider accessor must not execute.');
    },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.outputTokens = cyclic;
  for (const usage of [accessor, cyclic, { [Symbol('opaque')]: 3 }]) {
    const initial = createUsageAccount({
      id: 'review-account',
      policy: {
        version: 1,
        maxRequests: 2,
        maxReservedOutputTokens: 20,
        maxToolCalls: 0,
        reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
      },
    });
    const admitted = admitGeneration(initial, undefined, {
      accountId: initial.id,
      operationId: 'generation',
      phase: 'work',
      requestedOutputTokens: 10,
      minimumOutputTokens: 1,
    });
    assert.equal(admitted.kind, 'applied');
    if (admitted.kind === 'denied') throw Error(admitted.code);
    const before = structuredClone(admitted);
    const observation = {
      accountId: initial.id,
      operationId: 'generation',
      outcome: 'observed',
      usage,
    } as UsageObservation;
    const result = observeUsage(admitted.account, admitted.operation, observation);
    assert.equal(result.kind, 'applied');
    if (result.kind === 'denied') throw Error(result.code);
    assert.equal(result.account.status, 'poisoned');
    assert.equal(result.account.violation, 'INVALID_USAGE');
    assert.equal(result.account.outstandingOutputTokens, 10);
    assert.equal(result.account.observed.unknownUsageRequests, 1);
    assert.equal((result.operation as GenerationOperation).status, 'observed');
    assert.equal((result.operation as GenerationOperation).invalidUsage, true);
    assert.equal(result.error?.code, 'USAGE_OBSERVATION_INVALID');
    const persisted = JSON.parse(JSON.stringify(result));
    assert.equal(persisted.operation.status, 'observed');
    assert.equal(persisted.operation.invalidUsage, true);
    assert.equal('usage' in persisted.operation, false);
    assert.equal(observeUsage(result.account, result.operation, observation).kind, 'denied');
    assert.deepEqual(admitted, before);
  }
  assert.equal(reads, 0);
});
