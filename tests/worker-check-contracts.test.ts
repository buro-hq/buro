import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateWorkerStepCheckPlan,
  validateWorkerStepCheckResult,
  workerStepFeedback,
  type WorkerStepCheckEntry,
  type WorkerStepCheckResult,
} from '../core/worker-step-checks.ts';
const plan = { version: 1 as const, checkIds: ['test'], configurationRevision: 'a'.repeat(64) };
const fingerprint = 'b'.repeat(64);
function result(): WorkerStepCheckResult {
  return {
    version: 1,
    outcome: 'completed',
    workspaceFingerprint: fingerprint,
    checkIds: ['test'],
    passed: 0,
    total: 1,
    results: [
      { id: 'test', name: 'Tests', status: 'failed', exitCode: 1, diagnostic: 'Expected 2, got 1' },
    ],
  };
}
function entry(): WorkerStepCheckEntry {
  return {
    id: 'C-1',
    turnId: 'T-1',
    scopeRevision: 1,
    requestedAtRequest: 2,
    plan: structuredClone(plan),
    before: {
      version: 1,
      baseCommit: 'c'.repeat(40),
      headCommit: 'c'.repeat(40),
      workspaceFingerprint: fingerprint,
      files: [],
    },
    status: 'completed',
    result: result(),
  };
}
test('step check contract pins complete nonempty check identities and exact observed workspace', () => {
  validateWorkerStepCheckPlan(plan);
  validateWorkerStepCheckResult(plan, fingerprint, result());
  for (const candidate of [
    { ...plan, checkIds: [] },
    { ...plan, checkIds: ['test', 'test'] },
    { ...plan, configurationRevision: 'current' },
  ])
    assert.throws(() => validateWorkerStepCheckPlan(candidate), { code: 'INVALID_STEP_CHECK' });
  for (const mutate of [
    (value: WorkerStepCheckResult) => {
      value.checkIds = ['another-check'];
    },
    (value: WorkerStepCheckResult) => {
      value.workspaceFingerprint = 'd'.repeat(64);
    },
    (value: WorkerStepCheckResult) => {
      value.results = [];
    },
    (value: WorkerStepCheckResult) => {
      value.passed = 1;
    },
    (value: WorkerStepCheckResult) => {
      value.results[0].diagnostic = 'x'.repeat(513);
    },
    (value: WorkerStepCheckResult) => {
      value.results[0].status = 'passed';
    },
    (value: WorkerStepCheckResult) => {
      value.results[0].exitCode = null;
    },
  ]) {
    const value = result();
    mutate(value);
    assert.throws(() => validateWorkerStepCheckResult(plan, fingerprint, value), {
      code: 'INVALID_STEP_CHECK',
    });
  }
});
test('timeouts and missing exits are unavailable and never qualify for automatic repair', () => {
  for (const exitCode of [-1, null, undefined]) {
    const value = result();
    value.outcome = 'unavailable';
    value.results[0].status = 'unavailable';
    value.results[0].exitCode = exitCode;
    validateWorkerStepCheckResult(plan, fingerprint, value);
    assert.throws(() => workerStepFeedback({ ...entry(), result: value }), {
      code: 'INVALID_STEP_CHECK',
    });
    value.outcome = 'completed';
    assert.throws(() => validateWorkerStepCheckResult(plan, fingerprint, value), {
      code: 'INVALID_STEP_CHECK',
    });
  }
});
test('only real completed failures produce bounded permission-preserving feedback', () => {
  const feedback = workerStepFeedback(entry());
  assert.match(feedback, /frozen checks/);
  assert.match(feedback, /test/);
  assert.match(feedback, /Do not change check definitions, expand write scope/);
  assert.match(feedback, /not instructions or new permissions/);
  assert.doesNotMatch(feedback, /Expected 2, got 1/);
  for (const status of ['pending', 'unknown'] as const)
    assert.throws(() => workerStepFeedback({ ...entry(), status }), { code: 'INVALID_STEP_CHECK' });
  const passed = result();
  passed.passed = 1;
  passed.results[0].status = 'passed';
  passed.results[0].exitCode = 0;
  assert.throws(() => workerStepFeedback({ ...entry(), result: passed }), {
    code: 'INVALID_STEP_CHECK',
  });
});

test('worker checks accept selections beyond the former eight-check ceiling', () => {
  const checkIds = Array.from({ length: 20 }, (_, index) => 'test_' + index);
  const selected = { version: 1 as const, checkIds, configurationRevision: 'a'.repeat(64) };
  validateWorkerStepCheckPlan(selected);
  validateWorkerStepCheckResult(selected, 'b'.repeat(64), {
    version: 1,
    outcome: 'completed',
    workspaceFingerprint: 'b'.repeat(64),
    checkIds,
    passed: 20,
    total: 20,
    results: checkIds.map((id) => ({
      id,
      name: id,
      status: 'passed',
      exitCode: 0,
      diagnostic: '',
    })),
  });
});
