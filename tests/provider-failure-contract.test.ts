import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProviderFailure,
  isProviderFailure,
  providerFailureOutcome,
} from '../agent/contracts/provider-errors.ts';

test('request outcomes are explicit and cannot be rewritten after a failure crosses the host boundary', () => {
  for (const outcome of ['not-dispatched', 'rejected', 'unknown'] as const) {
    const failure = new ProviderFailure('MODEL_AUTH_FAILED', 'Synthetic failure', {
      outcome,
    });
    assert.equal(providerFailureOutcome(failure), outcome);
    assert.equal(isProviderFailure(failure), true);
    assert.throws(() => {
      (failure as { outcome: string }).outcome = 'rejected';
    }, TypeError);
    assert.throws(
      () =>
        Object.defineProperty(failure, 'outcome', {
          value: outcome === 'rejected' ? 'unknown' : 'rejected',
        }),
      TypeError,
    );
    assert.throws(() => {
      (failure as { code: string }).code = 'MODEL_NOT_FOUND';
    }, TypeError);
    assert.equal(providerFailureOutcome(failure), outcome);
  }
});

test('response data, lookalike errors and nested causes cannot declare a trusted provider outcome', () => {
  const direct = new ProviderFailure('MODEL_AUTH_FAILED', 'Synthetic failure', {
    outcome: 'unknown',
  });
  let causeReads = 0;
  const getter = {
    get cause() {
      causeReads++;
      throw Error('Do not walk arbitrary causes');
    },
  };
  for (const value of [
    { code: 'MODEL_AUTH_FAILED', outcome: 'rejected' },
    Object.assign(new Error('ProviderFailure'), {
      name: 'ProviderFailure',
      code: 'MODEL_AUTH_FAILED',
      outcome: 'rejected',
    }),
    new Error('Outer adapter must translate explicitly', {
      cause: direct,
    }),
    { cause: { cause: direct } },
    getter,
    null,
    undefined,
  ]) {
    assert.equal(isProviderFailure(value), false);
    assert.equal(providerFailureOutcome(value), undefined);
  }
  assert.equal(causeReads, 0);
  assert.equal(providerFailureOutcome(direct), 'unknown');
});

test('private causes are retained for explicit host handling but are not serialized as public failure data', () => {
  const cause = {
    credential: 'PRIVATE_PROVIDER_ERROR_FIXTURE',
    partialResponse: 'private continuation',
  };
  const failure = new ProviderFailure('MODEL_STREAM_INTERRUPTED', 'The stream was interrupted.', {
    outcome: 'unknown',
    cause,
  });
  assert.equal(failure.cause, cause);
  assert.doesNotMatch(
    JSON.stringify(failure),
    /PRIVATE_PROVIDER_ERROR_FIXTURE|private continuation|partialResponse/,
  );
  assert.doesNotMatch(String(failure), /PRIVATE_PROVIDER_ERROR_FIXTURE|private continuation/);
});

test('invalid failure metadata is rejected instead of receiving a safe-looking default', () => {
  assert.throws(
    () => new ProviderFailure('bad code', 'Invalid', {
      outcome: 'rejected',
    }),
    TypeError,
  );
  for (const outcome of [undefined, 'observed', 'success'])
    assert.throws(
      () => new ProviderFailure('MODEL_UNAVAILABLE', 'Invalid', {
        outcome,
      } as never),
      TypeError,
    );
});
