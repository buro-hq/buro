import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commandCheckState,
  criterionCheckState,
  getCheckViewState,
} from '../src/features/runs/check-state.ts';
import type { Run, Check, Command } from '../protocol/domain.ts';
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 20, 12, 0, seconds)).toISOString();
const check = (patch: Partial<Check> = {}): Check => ({
  name: 'Protected check',
  command: 'npm test',
  exitCode: 0,
  passed: true,
  ...patch,
});
function run(patch: Partial<Run> = {}): Run {
  return {
    createdAt: at(0),
    completedAt: at(10),
    status: 'completed',
    phase: 'done',
    events: [
      { at: at(4), type: 'phase.checking' },
      { at: at(6), type: 'checks.completed' },
      { at: at(7), type: 'phase.review' },
      { at: at(9), type: 'review.completed' },
    ],
    commands: [],
    acceptance: { passed: 1, total: 1, results: [check()] },
    review: { verdict: 'approved', blockingFindings: [], summary: 'Observed review' },
    independentReviewer: true,
    scopePreserved: true,
    specsUnchanged: true,
    ...patch,
  } as Run;
}

test('a terminal failure with zero acceptance checks is not a failed check or an accepted result', () => {
  const state = getCheckViewState(
    run({
      status: 'failed',
      events: [],
      checkIds: [],
      acceptance: { passed: 0, total: 0, results: [] },
      review: undefined,
      independentReviewer: false,
    }),
    10,
  );
  assert.equal(state.acceptance, 'not-run');
  assert.equal(state.review, 'not-run');
  assert.notEqual(state.overall, 'reviewed');
  assert.deepEqual(state.rows, []);
});
test('command success requires a known zero exit, including when output claims PASS', () => {
  for (const exitCode of [null, undefined, -1, NaN, Infinity, 0.5])
    assert.equal(commandCheckState({ completedAt: at(2), exitCode }), 'unavailable');
  assert.equal(commandCheckState({ completedAt: at(2), exitCode: 0 }), 'passed');
  assert.equal(commandCheckState({ completedAt: at(2), exitCode: 2 }), 'failed');
  assert.equal(commandCheckState({ exitCode: 0 }), 'running');
  const commands: Command[] = [
    {
      id: 'c',
      threadId: 't',
      command: 'npm test',
      startedAt: at(1),
      completedAt: at(2),
      exitCode: null,
      output: '# tests 2\n# pass 2\n# fail 0',
    },
  ];
  assert.equal(getCheckViewState(run({ commands }), 10).project, 'unavailable');
});
test('service criteria distinguish semantic evidence, unavailable execution and actual failures', () => {
  for (const exitCode of [null, undefined, -1])
    assert.equal(criterionCheckState(check({ exitCode })), 'unavailable');
  assert.equal(criterionCheckState(check({ exitCode: 0, passed: false })), 'failed');
  assert.equal(criterionCheckState(check({ exitCode: 1, passed: true })), 'failed');
  assert.equal(criterionCheckState(check({ command: undefined, exitCode: undefined })), 'passed');
  assert.equal(
    criterionCheckState(check({ passed: true, error: 'inconsistent evidence' })),
    'unavailable',
  );
});
test('passed checks do not stand in for an independent review verdict', () => {
  const absent = getCheckViewState(run({ review: undefined, independentReviewer: false }), 10);
  assert.equal(absent.acceptance, 'passed');
  assert.equal(absent.review, 'not-run');
  assert.notEqual(absent.overall, 'reviewed');
  const flag = getCheckViewState(run({ review: undefined, independentReviewer: true }), 10);
  assert.equal(flag.review, 'unavailable');
  assert.equal(flag.overall, 'unavailable');
  const verdict = getCheckViewState(run({ independentReviewer: false }), 10);
  assert.equal(verdict.review, 'unavailable');
  assert.notEqual(verdict.overall, 'reviewed');
});
test('changes requested or blocking findings remain visible despite passed checks', () => {
  for (const review of [
    {
      verdict: 'changes_requested' as const,
      blockingFindings: ['Missing behavior'],
      summary: 'Repair',
    },
    {
      verdict: 'approved' as const,
      blockingFindings: ['Contradictory approval'],
      summary: 'Repair',
    },
  ]) {
    const state = getCheckViewState(run({ review }), 10);
    assert.equal(state.acceptance, 'passed');
    assert.equal(state.review, 'failed');
    assert.equal(state.overall, 'failed');
  }
  assert.equal(getCheckViewState(run(), 10).overall, 'reviewed');
  assert.notEqual(getCheckViewState(run({ scopePreserved: false }), 10).overall, 'reviewed');
});
test('partial evidence and unavailable execution cannot produce all-checks-passed', () => {
  const partial = getCheckViewState(
    run({ acceptance: { passed: 3, total: 3, results: [check()] } }),
    10,
  );
  assert.equal(partial.passed, 1);
  assert.equal(partial.total, 3);
  assert.equal(partial.acceptance, 'unavailable');
  const missing = getCheckViewState(run({ acceptance: { passed: 2, total: 2, results: [] } }), 10);
  assert.equal(missing.acceptance, 'unavailable');
  assert.deepEqual(missing.rows, []);
  const unstarted = getCheckViewState(
    run({ events: [], acceptance: { passed: 0, total: 0, results: [] }, checkIds: ['test'] }),
    10,
  );
  assert.equal(unstarted.acceptance, 'unavailable');
});
test('the playback cursor hides future criteria output and review verdicts', () => {
  const current = run({
    commands: [
      {
        id: 'c',
        threadId: 't',
        command: 'npm test',
        startedAt: at(1),
        completedAt: at(3),
        exitCode: 0,
        output: 'FUTURE_OUTPUT',
      },
    ],
  });
  const early = getCheckViewState(current, 2);
  assert.deepEqual(early.rows, []);
  assert.equal(early.reviewVisible, false);
  assert.equal(early.commands[0].state, 'running');
  assert.equal(early.commands[0].command.completedAt, undefined);
  assert.equal(early.commands[0].command.exitCode, undefined);
  assert.equal(early.commands[0].command.output, undefined);
  const checking = getCheckViewState(current, 5);
  assert.equal(checking.acceptance, 'running');
  assert.deepEqual(checking.rows, []);
  assert.equal(checking.reviewVisible, false);
  const review = getCheckViewState(current, 8);
  assert.equal(review.acceptance, 'passed');
  assert.equal(review.review, 'running');
  assert.equal(review.reviewVisible, false);
  const final = getCheckViewState(current, 10);
  assert.equal(final.overall, 'reviewed');
});
test('current check results never leak into an earlier completed iteration', () => {
  const current = run({
    events: [
      { at: at(2), type: 'checks.completed' },
      { at: at(4), type: 'phase.checking' },
      { at: at(8), type: 'checks.completed' },
    ],
    acceptance: {
      passed: 0,
      total: 1,
      results: [check({ passed: false, exitCode: 1, output: 'LATEST_FAILURE' })],
    },
  });
  const earlier = getCheckViewState(current, 3);
  assert.deepEqual(earlier.rows, []);
  assert.equal(earlier.acceptanceVisible, false);
  const between = getCheckViewState(current, 6);
  assert.deepEqual(between.rows, []);
  assert.equal(between.acceptance, 'running');
  const after = getCheckViewState(current, 9);
  assert.equal(after.acceptance, 'failed');
  assert.equal(after.rows[0].check.output, 'LATEST_FAILURE');
});
test('resuming a run does not present retained acceptance from its old attempt as current evidence', () => {
  const state = getCheckViewState(
    run({
      status: 'running',
      completedAt: undefined,
      phase: 'queued',
      events: [
        { at: at(2), type: 'checks.completed' },
        { at: at(3), type: 'review.completed' },
        { at: at(8), type: 'run.resume-requested' },
        { at: at(8), type: 'phase.queued' },
      ],
    }),
    9,
  );
  assert.equal(state.acceptanceVisible, false);
  assert.equal(state.reviewVisible, false);
  assert.deepEqual(state.rows, []);
  assert.notEqual(state.overall, 'reviewed');
});
test('problems appear first without modifying persisted acceptance order', () => {
  const current = run({
    acceptance: {
      passed: 1,
      total: 3,
      results: [
        check({ name: 'pass' }),
        check({ name: 'unknown', exitCode: null }),
        check({ name: 'fail', exitCode: 1, passed: false }),
      ],
    },
  });
  assert.deepEqual(
    getCheckViewState(current, 10).rows.map((row) => row.check.name),
    ['fail', 'unknown', 'pass'],
  );
  assert.deepEqual(
    current.acceptance.results.map((row) => row.name),
    ['pass', 'unknown', 'fail'],
  );
});
test('legacy recordings without observation timestamps expose evidence only at their terminal endpoint', () => {
  const current = run({ events: [] });
  assert.deepEqual(getCheckViewState(current, 9).rows, []);
  assert.equal(getCheckViewState(current, 9).reviewVisible, false);
  assert.equal(getCheckViewState(current, 10).overall, 'reviewed');
});

test('mixed legacy and current observation events use the newest evidence boundary', () => {
  const current = run({
    events: [
      { at: at(3), type: 'checks.completed' },
      { at: at(8), type: 'acceptance' },
    ],
  });
  assert.equal(getCheckViewState(current, 6).acceptanceVisible, false);
  assert.deepEqual(getCheckViewState(current, 6).rows, []);
  assert.equal(getCheckViewState(current, 9).acceptance, 'passed');
});

test('implementation readiness requires service completion and a saved commit in addition to evidence', () => {
  assert.equal(getCheckViewState(run({ commit: 'abc123' }), 10).implementationReady, true);
  for (const patch of [
    { status: 'failed' as const, commit: 'abc123' },
    { status: undefined, commit: 'abc123' },
    { commit: undefined },
  ])
    assert.equal(getCheckViewState(run(patch), 10).implementationReady, false);
});

test('an observed scope violation fails acceptance without leaking its future result into playback', () => {
  const current = run({ scopePreserved: false, commit: 'abc123' });
  assert.notEqual(getCheckViewState(current, 3).overall, 'failed');
  const final = getCheckViewState(current, 10);
  assert.equal(final.scope, 'failed');
  assert.equal(final.overall, 'failed');
  assert.equal(final.implementationReady, false);
  const neverChecked = getCheckViewState(
    run({
      status: 'failed',
      events: [],
      scopePreserved: false,
      specsUnchanged: false,
      acceptance: { passed: 0, total: 0, results: [] },
      review: undefined,
      independentReviewer: false,
    }),
    10,
  );
  assert.equal(neverChecked.scope, 'unavailable');
});
