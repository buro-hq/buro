import { virtualWorkspaceRevision } from './fixtures/virtual-workspace.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileChange, Role, Run } from '../protocol/domain.ts';
import type { WorkScope } from '../protocol/work-scope.ts';
import { DomainError, type AgentRuntime } from '../core/ports.ts';
import type { ExecutionPolicy, WorkspacePort } from '../core/execution-ports.ts';
import {
  buildWorkerEnvelope,
  publicWorkerInput,
  validateWorkerTask,
  workerInstructions,
  workerPrompt,
} from '../core/worker-envelope.ts';
import {
  assignmentScopeObservations,
  assignmentScopePreserved,
  runWorkerAssignments,
} from '../core/worker-assignments.ts';
import { WorkerEnvelopeSchema } from '../protocol/worker-tasks.ts';
import { workerFailureForReplan } from '../core/worker-recovery.ts';

const role: Role = {
  provenance: { origin: 'user' },
  id: 'builder',
  version: 2,
  title: 'Builder',
  description: 'Scoped implementation',
  instructions: 'Preserve the existing public API.',
  kind: 'implementation',
  createdAt: 'now',
  updatedAt: 'now',
};
const policy: ExecutionPolicy = {
  scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
  checks: [{ id: 'unit', title: 'Unit' }],
  defaultCheckIds: ['unit'],
  maxWorkers: 1,
  maxRepairs: 1,
  turnTimeoutMs: 1000,
  context: 'Keep compatibility with the installed runtime.',
};
function fixture(changes: Partial<Run> = {}): Run {
  return {
    id: 'R-fixture',
    key: 'fixture',
    title: 'Protect session storage',
    summary: '',
    createdAt: 'now',
    threadId: 'coordinator',
    goalId: 'G-fixture',
    agents: [],
    events: [],
    commands: [],
    plan: [
      { step: 'Make replacement atomic.', owner: 'builder' },
      { step: 'Update a separate feature.', owner: 'other' },
      { step: 'Review changes.', owner: 'reviewer' },
    ],
    roleAssignments: { builder: ['src/session.ts'] },
    roleSnapshots: [structuredClone(role)],
    executionPolicySnapshot: structuredClone(policy),
    workerTasks: {
      builder: {
        objective: 'Replace this session JSON atomically.',
        inputs: ['src/session.ts', 'src/shared/types.ts'],
        expectedResult: 'Only session.ts changes; failed writes preserve existing bytes.',
        criteria: [
          'Keep the synchronous API.',
          'Preserve the previous JSON on partial-write and rename errors.',
        ],
      },
    },
    changedFiles: [],
    baseline: {
      passed: 0,
      total: 1,
      results: [
        { name: 'Atomic write', passed: false, output: 'Expected intact JSON', exitCode: 1 },
      ],
    },
    acceptance: { passed: 0, total: 0, results: [] },
    specsUnchanged: true,
    scopePreserved: true,
    independentReviewer: false,
    goalText:
      'An unrelated larger project goal.\nAcceptance criteria:\nKeep all existing behavior.',
    result: '',
    sourceHash: '',
    ...changes,
  };
}
const build = (run = fixture(), changes: Partial<Parameters<typeof buildWorkerEnvelope>[0]> = {}) =>
  buildWorkerEnvelope({
    run,
    role,
    paths: ['src/session.ts'],
    policy,
    workspace: '/temporary/workspace',
    ...changes,
  });

test('saved compact task carries every assigned criterion without global goal or other workers', () => {
  const run = fixture();
  const envelope = build(run);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.task.source, 'coordinator');
  assert.equal(envelope.task.objective, run.workerTasks!.builder.objective);
  assert.deepEqual(envelope.task.criteria, run.workerTasks!.builder.criteria);
  assert.equal(envelope.task.expectedResult, run.workerTasks!.builder.expectedResult);
  assert.deepEqual(envelope.task.inputs, ['src/session.ts', 'src/shared/types.ts']);
  assert.equal(envelope.scope.mode, 'strict');
  assert.deepEqual(envelope.scope.plannedPaths, ['src/session.ts']);
  assert.deepEqual(envelope.scope.protectedPaths, ['checks/']);
  assert.deepEqual(envelope.steps, ['Make replacement atomic.']);
  const prompt = workerPrompt(envelope);
  assert.ok(prompt.startsWith('Execute your assigned work'));
  assert.equal(prompt.includes(run.goalText), false);
  assert.equal(prompt.includes('Update a separate feature.'), false);
  assert.equal(prompt.includes('shared/types.ts'), true);
});

test('legacy assignments keep complete goal and clarification and reject overflow without truncating intent', () => {
  const goalText =
    'Полное требование. '.repeat(500) + '\nAcceptance criteria:\nPreserve every final criterion.';
  const run = fixture({
    workerTasks: undefined,
    goalText,
    continuation: {
      mode: 'repair',
      instructions: 'Preserve the saved draft; do not restart external actions.',
      requestedAt: 'now',
    },
  });
  const envelope = build(run);
  assert.equal(envelope.task.source, 'legacy-goal');
  assert.equal(envelope.task.objective, goalText);
  assert.equal(envelope.clarification, run.continuation!.instructions);
  assert.ok(workerPrompt(envelope).includes('Preserve every final criterion.'));
  assert.ok(workerInstructions(role, policy).includes(role.instructions));
  assert.ok(workerInstructions(role, policy).includes(policy.context!));
  const before = structuredClone(run);
  assert.throws(() => build(run, { maxBytes: 512 }), { code: 'WORKER_ENVELOPE_TOO_LARGE' });
  assert.deepEqual(run, before);
  const constructorRole = { ...role, id: 'constructor' };
  const inheritedNameRun = fixture({
    workerTasks: {},
    roleAssignments: Object.fromEntries([['constructor', ['src/session.ts']]]),
    roleSnapshots: [constructorRole],
  });
  assert.equal(build(inheritedNameRun, { role: constructorRole }).task.source, 'legacy-goal');
});

test('envelope is detached and deeply immutable while source snapshots remain editable', () => {
  const run = fixture();
  const envelope = build(run);
  assert.ok(Object.isFrozen(envelope));
  assert.ok(Object.isFrozen(envelope.task));
  assert.ok(Object.isFrozen(envelope.task.criteria));
  assert.throws(() => envelope.task.criteria.push('Changed'), TypeError);
  run.workerTasks!.builder.criteria.push('A later change');
  run.roleAssignments!.builder[0] = 'src/later.ts';
  assert.equal(envelope.task.criteria.includes('A later change'), false);
  assert.deepEqual(envelope.scope.plannedPaths, ['src/session.ts']);
});

test('advisory envelopes allow adjacent or undiscovered planned work while strict scope stays explicit', () => {
  const advisory: ExecutionPolicy = { ...policy, scope: { ...policy.scope, mode: 'advisory' } };
  const adjacent = fixture({ roleAssignments: { builder: ['tests/session.test.ts'] } });
  const envelope = build(adjacent, { paths: ['tests/session.test.ts'], policy: advisory });
  assert.deepEqual(WorkerEnvelopeSchema.parse(envelope).scope, {
    mode: 'advisory',
    plannedPaths: ['tests/session.test.ts'],
    protectedPaths: ['checks/'],
  });
  assert.match(workerPrompt(envelope), /not a write boundary/);
  assert.match(
    workerInstructions(role, advisory),
    /edit additional files inside this working copy/,
  );
  assert.throws(() => build(adjacent, { paths: ['tests/session.test.ts'] }), {
    code: 'INVALID_ASSIGNMENT',
  });

  const discovery = fixture({ roleAssignments: { builder: [] } });
  const empty = build(discovery, { paths: [], policy: advisory });
  assert.deepEqual(WorkerEnvelopeSchema.parse(empty).scope.plannedPaths, []);
  assert.throws(() => build(discovery, { paths: [] }), { code: 'INVALID_ASSIGNMENT' });
  assert.equal(
    WorkerEnvelopeSchema.safeParse({ ...empty, scope: { ...empty.scope, mode: 'strict' } }).success,
    false,
  );
  assert.match(workerInstructions(role, policy), /final immutable acceptance checks/);
  assert.match(workerInstructions(role, policy), /intermediate worker checks are unavailable/);
  const blocked = fixture({ roleAssignments: { builder: ['checks/trusted.mjs'] } });
  assert.throws(() => build(blocked, { paths: ['checks/trusted.mjs'], policy: advisory }), {
    code: 'INVALID_ASSIGNMENT',
  });
});

test('file inputs can reference shared public files but never expand writes or name private paths', () => {
  assert.equal(publicWorkerInput('src/shared/types.ts'), true);
  for (const file of [
    '',
    '../outside.ts',
    '/outside.ts',
    'C:\\outside.ts',
    'src/',
    'src/../outside.ts',
    'src/*.ts',
    'src/[name].ts',
    '.buro/state.json',
    'src/.env.production',
    'nested/node_modules/lib.ts',
    '.git/config',
    'private/key.txt',
    'identity.pem',
  ]) {
    assert.equal(publicWorkerInput(file), false, file);
    assert.throws(
      () =>
        validateWorkerTask({
          objective: 'Task',
          inputs: [file],
          expectedResult: 'Result',
          criteria: ['Check'],
        }),
      { code: 'INVALID_ASSIGNMENT' },
    );
  }
  assert.throws(() => build(fixture(), { paths: ['src/shared/types.ts'] }), {
    code: 'INVALID_ASSIGNMENT',
  });
  assert.throws(() => build(fixture(), { role: { ...role, version: role.version + 1 } }), {
    code: 'INVALID_ASSIGNMENT',
  });
  assert.throws(
    () => build(fixture(), { role: { ...role, instructions: 'Different live instructions.' } }),
    {
      code: 'INVALID_ASSIGNMENT',
    },
  );
  assert.throws(
    () =>
      build(fixture(), {
        policy: { ...policy, scope: { ...policy.scope, protectedPaths: ['src/session.ts'] } },
      }),
    { code: 'INVALID_ASSIGNMENT' },
  );
});

test('all check identities remain while combined diagnostics are bounded and raw evidence is unchanged', () => {
  const output = '😀 Начало\n' + 'Long actual check output. '.repeat(2000) + '\nКонец 😀';
  const run = fixture({
    acceptance: {
      passed: 1,
      total: 5,
      results: [
        {
          name: 'Already passed',
          passed: true,
          output: 'Large successful log. '.repeat(2000),
          exitCode: 0,
        },
        ...Array.from({ length: 4 }, (_, index) => ({
          name: 'Failed ' + index,
          passed: false,
          output,
          error: 'Actual failure ' + index,
          command: 'node checks/' + index + '.mjs',
          exitCode: 1,
        })),
      ],
    },
  });
  const before = structuredClone(run);
  const envelope = build(run);
  assert.equal(envelope.checks.collection, 'acceptance');
  assert.equal(envelope.checks.total, 5);
  assert.deepEqual(
    envelope.checks.results.map((check) => check.name),
    run.acceptance.results.map((check) => check.name),
  );
  assert.equal(envelope.checks.results[0].diagnostic, undefined);
  const diagnostics = envelope.checks.results.map((check) => check.diagnostic || '');
  assert.ok(
    diagnostics.reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0) <= 2048,
  );
  assert.ok(diagnostics[1].includes('complete check log is retained in the run'));
  assert.ok(diagnostics[1].includes('Конец 😀'));
  assert.equal(
    diagnostics.some((text) => text.includes('�')),
    false,
  );
  assert.deepEqual(
    envelope.checks.results.map((check) => check.index),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(run, before);
});

test('user material references remain staged and complete without embedding their contents', () => {
  const hash = 'a'.repeat(64);
  const run = fixture({
    contextMaterials: [
      {
        id: 'M-1234',
        name: 'Design reference',
        mimeType: 'application/pdf',
        size: 100,
        hash,
        relativePath: 'local/context/' + hash + '.pdf',
        textPath: 'local/context/' + hash + '.txt',
        scope: 'goal',
        active: true,
        createdAt: 'now',
        note: 'Keep the public contract described here.',
      },
    ],
  });
  const envelope = build(run);
  assert.deepEqual(envelope.materials, [
    {
      id: 'M-1234',
      name: 'Design reference',
      mimeType: 'application/pdf',
      hash,
      path: '/temporary/workspace/.buro/context/' + hash + '.txt',
      note: 'Keep the public contract described here.',
    },
  ]);
  assert.equal(workerInstructions(role, policy).includes(hash), false);
});

async function dispatchFailure(
  options: {
    code?: string;
    outOfScope?: boolean;
    unverifiable?: boolean;
    abort?: boolean;
    overflow?: boolean;
    rejectIntent?: boolean;
    startFailure?: boolean;
    flushFailure?: boolean;
    releaseFailure?: boolean;
    rejectFailureSave?: boolean;
    mode?: WorkScope['mode'];
    success?: boolean;
    previous?: FileChange[];
    observed?: FileChange[];
  } = {},
) {
  const run = fixture(
    options.overflow
      ? { workerTasks: undefined, goalText: 'Oversized requirement. '.repeat(10000) }
      : {},
  );
  const controller = new AbortController();
  run.executionPolicySnapshot = {
    ...policy,
    scope: { ...policy.scope, mode: options.mode || 'strict' },
  };
  let starts = 0,
    asks = 0,
    updates = 0,
    diffs = 0,
    releases = 0;
  const runtime: AgentRuntime = {
    id: 'fake',
    async start(input) {
      starts++;
      assert.equal(run.agents[0].status, 'starting');
      assert.deepEqual(
        run.agents[0].assignment!.envelope!.task.criteria,
        run.workerTasks!.builder.criteria,
      );
      assert.deepEqual(input.assignment!.scope.plannedPaths, ['src/session.ts']);
      assert.equal(input.assignment!.scope.mode, options.mode || 'strict');
      if (options.startFailure)
        throw new DomainError('MODEL_INCOMPLETE', 'Client opening outcome is not known.');
      return { threadId: 'worker' };
    },
    async submit() {
      return { turnId: 'turn' };
    },
    async interrupt() {},
    async dispose() {},
    async release() {
      releases++;
      if (options.releaseFailure) throw Error('Client release failed');
    },
  };
  const workspaces: WorkspacePort = {
    async prepare() {
      return { path: '/temporary/workspace', base: 'base' };
    },
    async changes(): Promise<FileChange[]> {
      diffs++;
      if (diffs === 1) return options.previous || [];
      if (options.unverifiable) throw Error('Diff unavailable');
      if (options.observed) return options.observed;
      return [
        {
          path: options.outOfScope ? 'README.md' : 'src/session.ts',
          before: '',
          after: 'Partial but known edit',
        },
      ];
    },
    async captureRevision(workspace: string, base: string) {
      return virtualWorkspaceRevision(await this.changes(workspace, base), base);
    },
    async checkpoint() {
      return 'commit';
    },
  };
  const result = runWorkerAssignments({
    projectId: 'p',
    run,
    roles: [role],
    workspace: { path: '/temporary/workspace', base: 'base' },
    policy: { ...policy, scope: { ...policy.scope, mode: options.mode || 'strict' } },
    runtime,
    workspaces,
    signal: controller.signal,
    now: () => 'now',
    id: () => 'worker',
    async update(apply) {
      updates++;
      if (options.rejectIntent && updates === 1) throw Error('Intent save failed');
      if (options.rejectFailureSave && updates === 3) throw Error('Failure save failed');
      apply(run);
    },
    track() {},
    async flush() {
      if (options.flushFailure) throw Error('Event flush failed');
    },
    async ask(_id, prompt) {
      asks++;
      assert.ok(prompt.includes('Saved assignment v1'));
      if (options.abort) controller.abort();
      if (options.success)
        return { status: 'success', summary: 'Implemented', artifacts: [], notesForNextAgent: '' };
      throw new DomainError(options.code || 'MODEL_INCOMPLETE', 'Known model limit');
    },
  });
  let error: unknown;
  try {
    await result;
  } catch (caught) {
    error = caught;
  }
  return { run, error, starts, asks, updates, diffs, releases };
}

test('known incomplete and context failures qualify only after actual diff scope is verified', async () => {
  for (const code of ['MODEL_INCOMPLETE', 'MODEL_CONTEXT_EXHAUSTED']) {
    const result = await dispatchFailure({ code });
    assert.equal((result.error as DomainError).code, code);
    assert.deepEqual(result.run.agents[0].assignment!.knownFailure, { code, scopeVerified: true });
    assert.equal(result.run.agents[0].status, 'failed');
    assert.equal(result.diffs, 2);
    assert.equal(result.starts, 1);
    assert.equal(result.asks, 1);
    assert.equal(result.releases, 1);
  }
});

test('advisory adjacent edits complete or retain known-failure recovery with persisted review evidence', async () => {
  for (const success of [false, true]) {
    const result = await dispatchFailure({ mode: 'advisory', outOfScope: true, success });
    assert.equal(
      (result.error as DomainError | undefined)?.code,
      success ? undefined : 'MODEL_INCOMPLETE',
    );
    assert.equal(result.run.scopePreserved, true);
    assert.equal(result.run.agents[0].status, success ? 'completed' : 'failed');
    assert.equal(result.run.agents[0].assignment!.envelope!.scope.mode, 'advisory');
    assert.deepEqual(
      result.run.agents[0].assignment!.knownFailure,
      success ? undefined : { code: 'MODEL_INCOMPLETE', scopeVerified: true },
    );
    const events = result.run.events.filter((event) => event.type === 'agent.scope-observed');
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].text!), {
      mode: 'advisory',
      additionalPaths: ['README.md'],
      revertedPaths: [],
    });
    assert.equal(result.releases, 1);
  }
});

test('worker replan binds the observed failure to its original mode, protected paths and saved allocation', async () => {
  for (const mode of ['advisory', 'strict'] as const) {
    const result = await dispatchFailure({ mode });
    assert.equal(workerFailureForReplan(result.run, [role], result.error)?.role.id, role.id);
    const unchanged = structuredClone(result.run);
    for (const change of [
      (run: Run) => {
        run.executionPolicySnapshot!.scope.mode = mode === 'strict' ? 'advisory' : 'strict';
      },
      (run: Run) => {
        run.executionPolicySnapshot!.scope.protectedPaths = ['another-protected/'];
      },
      (run: Run) => {
        run.agents[0].assignment!.envelope!.scope.plannedPaths = ['src/different.ts'];
      },
      (run: Run) => {
        run.executionPolicySnapshot = undefined;
      },
    ]) {
      const changed = structuredClone(unchanged);
      change(changed);
      assert.equal(workerFailureForReplan(changed, [role], result.error), undefined);
      assert.deepEqual(changed.agents[0].assignment!.knownFailure, {
        code: 'MODEL_INCOMPLETE',
        scopeVerified: true,
      });
    }
  }
});

test('recovery keeps advisory plans advisory and never grants a strict assignment outside the user scope', async () => {
  const advisory = await dispatchFailure({ mode: 'advisory', outOfScope: true });
  advisory.run.executionPolicySnapshot!.scope.plannedPaths = ['docs/'];
  assert.equal(workerFailureForReplan(advisory.run, [role], advisory.error)?.role.id, role.id);
  const strict = await dispatchFailure();
  strict.run.executionPolicySnapshot!.scope.plannedPaths = ['docs/'];
  assert.equal(workerFailureForReplan(strict.run, [role], strict.error), undefined);
  assert.deepEqual(
    assignmentScopeObservations([], [{ path: 'src/discovered.ts', before: '', after: 'found' }], {
      mode: 'advisory',
      plannedPaths: [],
      protectedPaths: [],
    }),
    { additionalPaths: [], revertedPaths: [] },
  );
});

test('reverting a previous worker edit is advisory review evidence and a strict violation', async () => {
  const previous = [{ path: 'src/previous.ts', before: 'original', after: 'earlier worker edit' }];
  const observed = [{ path: 'src/session.ts', before: 'original', after: 'current worker edit' }];
  const scope: WorkScope = {
    mode: 'advisory',
    plannedPaths: ['src/session.ts'],
    protectedPaths: ['checks/'],
  };
  assert.equal(assignmentScopePreserved(previous, observed, scope), true);
  assert.deepEqual(assignmentScopeObservations(previous, observed, scope), {
    additionalPaths: ['src/previous.ts'],
    revertedPaths: ['src/previous.ts'],
  });
  const advisory = await dispatchFailure({ mode: 'advisory', previous, observed, success: true });
  assert.equal(advisory.error, undefined);
  const evidence = advisory.run.events.find((event) => event.type === 'agent.scope-observed')!;
  assert.deepEqual(JSON.parse(evidence.text!).revertedPaths, ['src/previous.ts']);
  const strict = await dispatchFailure({ previous, observed, success: true });
  assert.equal((strict.error as DomainError).code, 'WORKER_SCOPE_VIOLATION');
  assert.equal(strict.run.scopePreserved, false);
});

test('advisory worker recovery never authorizes protected, service or symlink changes', async () => {
  for (const file of ['checks/trusted.mjs', '.git/config', '.buro/state.json']) {
    const result = await dispatchFailure({
      mode: 'advisory',
      observed: [{ path: file, before: '', after: 'changed' }],
    });
    assert.equal((result.error as DomainError).code, 'WORKER_SCOPE_VIOLATION', file);
    assert.equal(result.run.agents[0].assignment!.knownFailure, undefined);
  }
  const result = await dispatchFailure({
    mode: 'advisory',
    observed: [{ path: 'src/session.ts', before: '', after: '[symlink /outside]' }],
  });
  assert.equal((result.error as DomainError).code, 'WORKER_SCOPE_VIOLATION');
  assert.equal(result.run.agents[0].assignment!.knownFailure, undefined);
});

test('scope violation, unknown outcome and cancellation cannot acquire a recovery marker', async () => {
  const escaped = await dispatchFailure({ outOfScope: true });
  assert.equal((escaped.error as DomainError).code, 'WORKER_SCOPE_VIOLATION');
  assert.equal(escaped.run.scopePreserved, false);
  assert.equal(escaped.run.agents[0].assignment!.knownFailure, undefined);
  const unavailable = await dispatchFailure({ unverifiable: true });
  assert.equal((unavailable.error as DomainError).code, 'WORKER_OUTCOME_UNVERIFIED');
  assert.equal(unavailable.run.agents[0].assignment!.knownFailure, undefined);
  const unknown = await dispatchFailure({ code: 'ACTION_OUTCOME_UNKNOWN' });
  assert.equal((unknown.error as DomainError).code, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(unknown.diffs, 1);
  assert.equal(unknown.run.agents[0].assignment!.knownFailure, undefined);
  const cancelled = await dispatchFailure({ abort: true });
  assert.equal(cancelled.run.agents[0].status, 'interrupted');
  assert.equal(cancelled.run.agents[0].assignment!.knownFailure, undefined);
  assert.equal(cancelled.diffs, 1);
});

test('invalid oversized assignment and failed intent persistence dispatch no runtime', async () => {
  const overflow = await dispatchFailure({ overflow: true });
  assert.equal((overflow.error as DomainError).code, 'WORKER_ENVELOPE_TOO_LARGE');
  assert.equal(overflow.starts, 0);
  assert.equal(overflow.updates, 0);
  assert.equal(overflow.run.agents.length, 0);
  const unsaved = await dispatchFailure({ rejectIntent: true });
  assert.match((unsaved.error as Error).message, /Intent save failed/);
  assert.equal(unsaved.starts, 0);
  assert.equal(unsaved.asks, 0);
  assert.equal(unsaved.diffs, 0);
});

test('a typed start failure and unsettled flush, release or persistence never qualify for replacement', async () => {
  const starting = await dispatchFailure({ startFailure: true });
  assert.equal((starting.error as DomainError).code, 'MODEL_INCOMPLETE');
  assert.equal(starting.asks, 0);
  assert.equal(starting.diffs, 1);
  assert.equal(starting.run.agents[0].assignment!.knownFailure, undefined);
  for (const options of [
    { flushFailure: true },
    { releaseFailure: true },
    { rejectFailureSave: true },
  ]) {
    const result = await dispatchFailure(options);
    assert.equal(result.run.agents[0].assignment!.knownFailure, undefined);
    assert.equal(result.releases, 1);
    assert.equal(result.asks, 1);
    assert.equal(result.diffs, 2);
    assert.ok(
      !(result.error instanceof DomainError),
      'Infrastructure errors must propagate rather than become model-limit outcomes',
    );
  }
});
