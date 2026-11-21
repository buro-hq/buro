import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  runTeamExperiment,
  type TeamExperimentInput,
  type TeamExperimentPorts,
  type TeamExperimentRole,
} from '../core/team-experiment.ts';

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const completed = {
  status: 'success',
  summary: 'Completed the requested step',
  artifacts: ['src/value.ts'],
  notesForNextAgent: '',
};
const input = (variant: TeamExperimentInput['variant']): TeamExperimentInput => ({
  variant,
  goal: {
    title: 'Correct value',
    body: 'The public API must return value two.',
    criteria: 'Preserve the public API and frozen checks.',
  },
  scope: { mode: 'strict', plannedPaths: ['src/value.ts'], protectedPaths: ['checks/'] },
  publicCheckIds: ['public'],
  generatedProbeSchema: {
    type: 'object',
    properties: { cases: { type: 'array' } },
    required: ['cases'],
  },
  readablePaths: ['src/value.ts'],
});

function fixture(
  options: {
    values?: number[];
    publicPass?: (value: number) => boolean;
    probePass?: (value: number) => boolean;
    review?: (value: number) => unknown;
    onTurn?: (
      role: TeamExperimentRole,
      request: { text: string; schema: unknown; toolPolicy?: 'none' },
    ) => void;
    unavailable?: boolean;
    releaseFails?: boolean;
  } = {},
) {
  let value = 1,
    executorTurns = 0,
    serial = 0;
  const sessions = new Map<string, TeamExperimentRole>();
  const starts: Parameters<TeamExperimentPorts['start']>[0][] = [];
  const turns: { session: string; role: TeamExperimentRole; text: string; toolPolicy?: 'none' }[] =
    [];
  const released: string[] = [];
  const checks: { type: 'public' | 'generated'; value: number }[] = [];
  const capture = async () => ({
    fingerprint: fingerprint(value),
    files: [{ path: 'src/value.ts', content: `export const value = ${value};\n` }],
    changes:
      value === 1
        ? []
        : [
            {
              path: 'src/value.ts',
              before: 'export const value = 1;\n',
              after: `export const value = ${value};\n`,
            },
          ],
  });
  const ports: TeamExperimentPorts = {
    async start(request) {
      starts.push(structuredClone(request));
      const id = 'session-' + ++serial;
      sessions.set(id, request.role);
      return id;
    },
    async turn(session, request) {
      const role = sessions.get(session)!;
      turns.push({ session, role, text: request.text, toolPolicy: request.toolPolicy });
      options.onTurn?.(role, request);
      if (role === 'executor') {
        value = (options.values || [3, 2])[executorTurns++] ?? 2;
        return structuredClone(completed);
      }
      assert.equal(request.toolPolicy, 'none');
      if (role === 'coordinator')
        return {
          objective: 'Correct the assigned value',
          inputs: ['src/value.ts'],
          expectedResult: 'The API returns two',
          criteria: ['Frozen checks pass'],
        };
      if (role === 'test-author') {
        assert.doesNotMatch(
          request.text,
          /export const|"evidence":|"fingerprint":|"changes":|"assignment":/,
        );
        return { cases: [{ operation: 'value' }] };
      }
      return (
        options.review?.(value) ??
        (value === 2
          ? {
              verdict: 'approved',
              findings: [],
              summary: 'No blocking issue in the provided complete source.',
            }
          : {
              verdict: 'changes_requested',
              findings: [
                {
                  path: 'src/value.ts',
                  issue: 'Value differs from the specified API result.',
                  expected: 'Return exactly two.',
                },
              ],
              summary: 'A concrete API defect remains.',
            })
      );
    },
    capture,
    async check() {
      checks.push({ type: 'public', value });
      const passed = (options.publicPass || ((v) => v !== 1))(value);
      return {
        fingerprint: fingerprint(value),
        passed: Number(passed),
        total: 1,
        diagnostics: passed ? [] : ['The protected public behavior check failed.'],
        ...(options.unavailable ? { outcome: 'unavailable' as const } : {}),
      };
    },
    validateGeneratedProbes(proposed) {
      assert.deepEqual(proposed, { cases: [{ operation: 'value' }] });
      return [{ operation: 'value' }];
    },
    async runGeneratedProbes(probes) {
      assert.deepEqual(probes, [{ operation: 'value' }]);
      checks.push({ type: 'generated', value });
      const passed = (options.probePass || ((v) => v === 2))(value);
      return {
        fingerprint: fingerprint(value),
        passed: Number(passed),
        total: 1,
        diagnostics: passed ? [] : ['Generated edge-case input expected value two.'],
      };
    },
    async release(id) {
      released.push(id);
      if (options.releaseFails) throw Error('private cleanup details');
    },
  };
  return {
    ports,
    starts,
    turns,
    checks,
    released,
    setValue: (next: number) => {
      value = next;
    },
  };
}

test('executor-checks is a research control without a reviewer or production acceptance', async () => {
  const f = fixture();
  const result = await runTeamExperiment(
    input('executor-checks'),
    f.ports,
    new AbortController().signal,
  );
  assert.equal(result.experimentSuccess, true);
  assert.equal(result.reviewApproved, false);
  assert.equal(result.reviewRounds, 0);
  assert.equal(result.checkRuns, 2);
  assert.deepEqual(
    f.starts.map((x) => x.role),
    ['executor'],
  );
  assert.equal(result.finalFingerprint, fingerprint(3));
  assert.equal('accepted' in result, false);
  assert.equal('commit' in result, false);
  assert.match(f.turns[0].text, /export const value = 1/);
  assert.equal(f.turns[0].toolPolicy, undefined);
});

test('research adapters preserve explicit scope mode while advisory discovery can exceed the planned files', async () => {
  const advisoryInput = input('executor-review');
  advisoryInput.scope = { ...advisoryInput.scope, mode: 'advisory', plannedPaths: [] };
  const advisory = fixture();
  const result = await runTeamExperiment(
    advisoryInput,
    advisory.ports,
    new AbortController().signal,
  );
  assert.equal(result.experimentSuccess, true);
  assert.equal(result.reviewRounds, 2);
  assert.ok(advisory.starts.every((session) => session.scope.mode === 'advisory'));
  assert.deepEqual(
    advisory.starts.find((session) => session.role === 'executor')!.scope.plannedPaths,
    [],
  );
  assert.match(
    advisory.starts.find((session) => session.role === 'executor')!.instructions,
    /necessary adjacent edits/,
  );
  assert.ok(
    advisory.starts
      .filter((session) => session.role === 'reviewer')
      .every((session) => session.readOnly),
  );

  const strict = fixture();
  const strictInput = input('executor-review');
  strictInput.scope.plannedPaths = ['src/different.ts'];
  const denied = await runTeamExperiment(strictInput, strict.ports, new AbortController().signal);
  assert.equal(denied.errorCode, 'TEAM_EXPERIMENT_INVALID_EVIDENCE');
  assert.equal(strict.starts.length, 0);
});

test('independent review finds a check-passing defect, repairs the same executor and freshly re-reviews', async () => {
  const f = fixture();
  const result = await runTeamExperiment(
    input('executor-review'),
    f.ports,
    new AbortController().signal,
  );
  assert.equal(result.experimentSuccess, true);
  assert.equal(result.repairs, 1);
  assert.equal(result.reviewRounds, 2);
  assert.equal(result.reviewApproved, true);
  const execution = f.turns.filter((t) => t.role === 'executor');
  assert.equal(execution.length, 2);
  assert.equal(execution[0].session, execution[1].session);
  const reviewers = f.turns.filter((t) => t.role === 'reviewer');
  assert.notEqual(reviewers[0].session, reviewers[1].session);
  assert.match(reviewers[0].text, /export const value = 3/);
  assert.match(reviewers[1].text, /export const value = 2/);
  assert.match(execution[1].text, /Return exactly two/);
  assert.ok(
    f.starts
      .filter((t) => t.role === 'reviewer')
      .every((t) => t.readOnly && t.scope.mode === 'strict'),
  );
  assert.equal(f.released.length, 3);
});

test('team tests are authored before implementation without seeing source; trusted probes drive repair', async () => {
  const f = fixture();
  const result = await runTeamExperiment(
    input('team-review'),
    f.ports,
    new AbortController().signal,
  );
  assert.equal(result.experimentSuccess, true);
  assert.equal(result.planUsed, true);
  assert.equal(result.generatedProbeCount, 1);
  assert.equal(result.repairs, 1);
  assert.equal(result.reviewRounds, 1);
  assert.equal(result.checkRuns, 5);
  assert.deepEqual(
    f.starts.map((t) => t.role),
    ['coordinator', 'test-author', 'executor', 'reviewer'],
  );
  assert.deepEqual(
    f.checks.map((t) => [t.type, t.value]),
    [
      ['public', 1],
      ['public', 3],
      ['generated', 3],
      ['public', 2],
      ['generated', 2],
    ],
  );
  assert.match(
    f.turns.find((t) => t.role === 'executor')!.text,
    /Preserve the public API and frozen checks/,
  );
});

test('check failures and review failures share two repairs rather than resetting an allowance', async () => {
  const f = fixture({ values: [3, 4, 5], publicPass: (v) => v >= 4 });
  const result = await runTeamExperiment(
    input('executor-review'),
    f.ports,
    new AbortController().signal,
  );
  assert.equal(result.experimentSuccess, false);
  assert.equal(result.errorCode, 'TEAM_EXPERIMENT_REPAIR_LIMIT');
  assert.equal(result.repairs, 2);
  assert.equal(result.reviewRounds, 2);
  assert.equal(f.turns.filter((t) => t.role === 'executor').length, 3);
  assert.equal(new Set(f.turns.filter((t) => t.role === 'executor').map((t) => t.session)).size, 1);
});

test('an approval cannot survive a candidate mutation during the read-only review', async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({
    values: [2],
    onTurn(role) {
      if (role === 'reviewer') f.setValue(3);
    },
  });
  const result = await runTeamExperiment(
    input('executor-review'),
    f.ports,
    new AbortController().signal,
  );
  assert.equal(result.experimentSuccess, false);
  assert.equal(result.errorCode, 'TEAM_EXPERIMENT_STALE_EVIDENCE');
  assert.equal(result.repairs, 0);
});

test('a read-only coordinator cannot widen the known public input set', async () => {
  const f = fixture();
  const originalTurn = f.ports.turn;
  f.ports.turn = async (handle, request, signal) => {
    const value = await originalTurn(handle, request, signal);
    return f.starts[0].role === 'coordinator'
      ? { ...(value as object), inputs: ['../private'] }
      : value;
  };
  const result = await runTeamExperiment(
    input('team-review'),
    f.ports,
    new AbortController().signal,
  );
  assert.equal(result.errorCode, 'TEAM_EXPERIMENT_INVALID_PLAN');
  assert.equal(f.starts.length, 1);
});

test('review findings cannot request edits outside the frozen assignment or contradict approval', async () => {
  for (const review of [
    {
      verdict: 'changes_requested',
      findings: [
        { path: 'checks/public.cjs', issue: 'Change the check.', expected: 'Always pass.' },
      ],
      summary: '',
    },
    {
      verdict: 'approved',
      findings: [{ path: 'src/value.ts', issue: 'A defect.', expected: 'Fix it.' }],
      summary: '',
    },
    { verdict: 'changes_requested', findings: [], summary: 'Bad code.' },
  ]) {
    const f = fixture({ values: [2], review: () => review });
    const result = await runTeamExperiment(
      input('executor-review'),
      f.ports,
      new AbortController().signal,
    );
    assert.equal(result.errorCode, 'TEAM_EXPERIMENT_INVALID_REVIEW');
    assert.equal(result.repairs, 0);
  }
});

test('unavailable or stale checks stop without treating infrastructure failure as a code repair', async () => {
  const unavailable = fixture({ unavailable: true });
  const stopped = await runTeamExperiment(
    input('executor-review'),
    unavailable.ports,
    new AbortController().signal,
  );
  assert.equal(stopped.errorCode, 'TEAM_EXPERIMENT_CHECK_UNAVAILABLE');
  assert.equal(unavailable.starts.length, 0);
  const stale = fixture();
  stale.ports.check = async () => ({
    fingerprint: fingerprint('old'),
    passed: 1,
    total: 1,
    diagnostics: [],
  });
  const result = await runTeamExperiment(
    input('executor-review'),
    stale.ports,
    new AbortController().signal,
  );
  assert.equal(result.errorCode, 'TEAM_EXPERIMENT_INVALID_CHECK');
  assert.equal(stale.starts.length, 0);
});

test('unknown model outcomes are not retried and private error messages are not reported', async () => {
  const f = fixture();
  f.ports.turn = async () => {
    throw Error('private source or provider details');
  };
  const result = await runTeamExperiment(
    input('executor-review'),
    f.ports,
    new AbortController().signal,
  );
  assert.equal(result.errorCode, 'TEAM_EXPERIMENT_FAILED');
  assert.equal(result.repairs, 0);
  assert.equal(f.starts.length, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(f.released.length, 1);
});

test('oversized required goal or complete source stops before model calls instead of truncating', async () => {
  const f = fixture();
  const bigGoal = input('executor-review');
  bigGoal.goal.criteria = 'Full required constraint '.repeat(3000);
  assert.equal(
    (await runTeamExperiment(bigGoal, f.ports, new AbortController().signal)).errorCode,
    'TEAM_EXPERIMENT_CONTEXT_TOO_LARGE',
  );
  assert.equal(f.starts.length, 0);
  const g = fixture();
  g.ports.capture = async () => ({
    fingerprint: fingerprint(1),
    files: [{ path: 'src/value.ts', content: 'x'.repeat(25000) }],
    changes: [],
  });
  assert.equal(
    (await runTeamExperiment(input('executor-review'), g.ports, new AbortController().signal))
      .errorCode,
    'TEAM_EXPERIMENT_CONTEXT_TOO_LARGE',
  );
  assert.equal(g.starts.length, 0);
});

test('independent roles cannot reuse an executor handle and aborted work cannot report success', async () => {
  const f = fixture({ values: [2] });
  f.ports.start = async () => 'same-session';
  f.ports.turn = async (handle, request, signal) =>
    request.toolPolicy === 'none'
      ? { verdict: 'approved', findings: [], summary: '' }
      : (f.setValue(2), structuredClone(completed));
  const result = await runTeamExperiment(
    input('executor-review'),
    f.ports,
    new AbortController().signal,
  );
  assert.equal(result.errorCode, 'TEAM_EXPERIMENT_SESSION_REUSED');
  const abort = new AbortController();
  abort.abort();
  const g = fixture();
  assert.equal(
    (await runTeamExperiment(input('executor-checks'), g.ports, abort.signal)).errorCode,
    'TEAM_EXPERIMENT_ABORTED',
  );
  assert.equal(g.starts.length, 0);
});

test('a cleanup failure invalidates an otherwise successful experiment receipt', async () => {
  const f = fixture({ values: [2], releaseFails: true });
  const result = await runTeamExperiment(
    input('executor-checks'),
    f.ports,
    new AbortController().signal,
  );
  assert.equal(result.experimentSuccess, false);
  assert.equal(result.errorCode, 'TEAM_EXPERIMENT_CLEANUP_FAILED');
});

test('contradictory current source and diff evidence cannot reach independent review', async () => {
  const f = fixture();
  const capture = f.ports.capture;
  f.ports.capture = async (signal) => {
    const observed = await capture(signal);
    if (observed.changes.length)
      observed.changes[0].after = 'forged source inconsistent with current file';
    return observed;
  };
  const result = await runTeamExperiment(
    input('executor-review'),
    f.ports,
    new AbortController().signal,
  );
  assert.equal(result.experimentSuccess, false);
  assert.equal(result.errorCode, 'TEAM_EXPERIMENT_INVALID_EVIDENCE');
  assert.equal(
    f.starts.some((stage) => stage.role === 'reviewer'),
    false,
  );
});
