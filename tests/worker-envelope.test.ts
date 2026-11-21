import { virtualWorkspaceRevision } from './fixtures/virtual-workspace.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileChange, Role, Run } from '../protocol/domain.ts';
import { DomainError, type AgentRuntime } from '../core/ports.ts';
import type { ExecutionPolicy, WorkspacePort } from '../core/execution-ports.ts';
import {
  buildWorkerEnvelope,
  publicWorkerInput,
  validateWorkerTask,
  workerInstructions,
  workerPrompt,
} from '../core/worker-envelope.ts';
import { runWorkerAssignments } from '../core/worker-assignments.ts';

const role: Role = {
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
  allowedPaths: ['src/'],
  protectedPaths: ['checks/'],
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
  assert.deepEqual(envelope.scope.allowedPaths, ['src/session.ts']);
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
  assert.deepEqual(envelope.scope.allowedPaths, ['src/session.ts']);
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
    () => build(fixture(), { policy: { ...policy, protectedPaths: ['src/session.ts'] } }),
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
  } = {},
) {
  const run = fixture(
    options.overflow
      ? { workerTasks: undefined, goalText: 'Oversized requirement. '.repeat(10000) }
      : {},
  );
  const controller = new AbortController();
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
      assert.deepEqual(input.assignment!.allowedPaths, ['src/session.ts']);
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
      if (diffs === 1) return [];
      if (options.unverifiable) throw Error('Diff unavailable');
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
    policy,
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
