import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ExecutionService } from '../core/execution.ts';
import { ExecutionActionCatalog } from '../core/execution-actions.ts';
import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { GoalService } from '../core/services.ts';
import { executionPolicy } from '../core/project-settings.ts';
import { DomainError, type AgentRuntime } from '../core/ports.ts';
import { UnresolvedEffectError, observedTurnFailure } from '../core/run-reconciliation.ts';
import { EnvelopeSchema } from '../protocol/execution.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import type { WorkspaceRevision } from '../core/workspace-revision.ts';
import type { WorkerProposal } from '../protocol/execution.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

const result = () => ({
  status: 'success' as const,
  summary: 'Value and edge contract implemented',
  artifacts: ['src/value.ts'],
  notesForNextAgent: '',
});
const decision = (action: string, input: unknown = {}) => ({ decision: { action, input } });
type ModelStep = {
  output: unknown;
  before?: (f: FixtureControl) => void | Promise<void>;
};
type FixtureControl = {
  service: ExecutionService;
  runId: string;
  write(file: string, content: string): Promise<void>;
};

async function fixture(
  t: { after(action: () => Promise<void>): void },
  options: {
    steps: ModelStep[];
    actions?: ExecutionActionCatalog;
    rejectReviews?: number;
    requireEdge?: boolean;
    nativeStyle?: boolean;
    allowFailingReview?: boolean;
  },
) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-orchestrate-')),
  );
  const source = path.join(directory, 'source');
  const workspace = { path: path.join(directory, 'worktree'), base: 'a'.repeat(40) };
  await fs.mkdir(source);
  await fs.mkdir(path.join(workspace.path, 'src'), { recursive: true });
  const original = 'export const value=1;\n';
  await fs.writeFile(path.join(workspace.path, 'src/value.ts'), original);
  const project = { id: 'p', name: 'Adaptive execution', root: source, managed: true };
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: 'Use actual requirements.',
    scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['AGENTS.md'] },
    checks: [
      { id: 'test', title: 'Requirements', command: 'controlled-requirements', timeoutMs: 1000 },
    ],
    defaultCheckIds: ['test'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 3,
    turnTimeoutMs: 10000,
  };
  const policy = executionPolicy(profile);
  const storage = path.join(directory, 'state');
  let store = await FileProjectStore.open({ directory: storage, project, profile });
  const projects = { get: () => store, list: () => [project] };
  let serial = 0,
    coordinatorTurns = 0,
    checks = 0,
    reviewTurns = 0,
    checkpoints = 0;
  const starts: Parameters<AgentRuntime['start']>[0][] = [];
  const threads = new Map<string, Parameters<AgentRuntime['start']>[0]>();
  const modelInputs: { threadId: string; text: string }[] = [];
  const views: string[] = [];
  let control!: FixtureControl;
  const read = (file: string) => fs.readFile(path.join(workspace.path, file), 'utf8');
  const write = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(workspace.path, file)), { recursive: true });
    await fs.writeFile(path.join(workspace.path, file), content);
  };
  const capture = async (): Promise<WorkspaceRevision> => {
    const files = ['src/value.ts', 'src/edge.ts'];
    const changes = [];
    for (const file of files) {
      const after = await read(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      const before = file === 'src/value.ts' ? original : '';
      if (after !== before) changes.push({ path: file, before, after });
    }
    return {
      version: 1,
      base: workspace.base,
      head: workspace.base,
      index: 'c'.repeat(64),
      tree: createHash('sha1').update(JSON.stringify(changes)).digest('hex'),
      changes,
    };
  };
  const runtime: AgentRuntime = {
    id: 'controlled',
    async start(input) {
      const id = 'thread-' + ++serial;
      starts.push(structuredClone(input));
      threads.set(id, structuredClone(input));
      return { threadId: id };
    },
    async resume(input) {
      assert.ok(threads.has(input.threadId));
      return { threadId: input.threadId };
    },
    async turn(threadId, text, turnOptions) {
      modelInputs.push({ threadId, text });
      const started = threads.get(threadId)!;
      if (started.purpose === 'review') {
        reviewTurns++;
        assert.equal(started.readOnly, true);
        assert.notEqual(started.workspace, workspace.path);
        assert.equal(
          await fs.readFile(path.join(started.workspace!, 'src/value.ts'), 'utf8'),
          options.allowFailingReview ? await read('src/value.ts') : 'export const value=2;\n',
        );
        const reject =
          reviewTurns <= (options.rejectReviews || 0) ||
          (options.allowFailingReview && (await read('src/value.ts')) === original);
        if (options.rejectReviews) {
          const edge = await fs
            .readFile(path.join(started.workspace!, 'src/edge.ts'), 'utf8')
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return '';
              throw error;
            });
          assert.equal(edge, reject ? '' : 'edge ok\n');
        }
        return {
          turnId: 'review-turn-' + reviewTurns,
          text: JSON.stringify({
            verdict: reject ? 'changes_requested' : 'approved',
            blockingFindings: reject
              ? [
                  options.allowFailingReview
                    ? 'The value must be two.'
                    : 'The required edge case is missing.',
                ]
              : [],
            summary: reject ? 'Repair the edge case' : 'Verified actual sources',
          }),
        };
      }
      if (started.purpose === 'implementation') {
        if (
          started.assignment?.roleId === 'edge_author' ||
          text.includes('Repair the reviewed edge case in the same worker.')
        )
          await write('src/edge.ts', 'edge ok\n');
        else await write('src/value.ts', 'export const value=2;\n');
        return { turnId: 'worker-' + ++serial, text: JSON.stringify(result()) };
      }
      assert.equal(started.purpose, 'coordination');
      assert.equal(started.readOnly, false);
      assert.ok(
        (turnOptions.schema as any).properties.decision,
        'The actual turn uses registered action grammar.',
      );
      const step = options.steps[coordinatorTurns++];
      assert.ok(step, 'The controller requested an unplanned extra coordinator turn.');
      await step.before?.(control);
      return { turnId: 'coordinator-' + coordinatorTurns, text: JSON.stringify(step.output) };
    },
    async submit() {
      throw Error('No untracked submission');
    },
    async interrupt() {},
    async release() {},
    async dispose() {},
  };
  const service = new ExecutionService({
    actions: options.actions || createBuiltinExecutionActions(),
    projects,
    policies: { p: policy },
    workflowRoles: createBuiltinWorkflowRoles(),
    selection: fixtureExecutionSelection(
      'controlled',
      fixtureExecutionCapabilities({ toolsFreeTurns: !options.nativeStyle, resumeSessions: true }),
    ),
    id: () => String(++serial),
    now: () => new Date(Date.UTC(2026, 0, 1) + serial * 1000).toISOString(),
    runtime,
    workspaces: {
      async prepare() {
        return workspace;
      },
      async restore() {
        return workspace;
      },
      async changes() {
        return (await capture()).changes;
      },
      captureRevision: capture,
      async openVerificationView(_workspace, revision, input) {
        const id = 'view-' + ++serial;
        const readRoot = path.join(directory, id, 'read');
        await fs.cp(workspace.path, readRoot, { recursive: true });
        views.push(readRoot);
        return {
          version: 1,
          id,
          projectId: input.projectId,
          runId: input.runId,
          sourceWorkspace: workspace.path,
          readRoot,
          outputRoot: path.join(directory, id, 'output'),
          base: revision.base,
          tree: revision.tree,
          outputPaths: [],
        };
      },
      async releaseVerificationView() {},
      async checkpoint(_workspace, _runId, expected) {
        checkpoints++;
        assert.deepEqual(expected, await capture());
        return 'd'.repeat(40);
      },
    },
    checks: {
      async run(_projectId, _workspace, ids, _signal, _profile, input) {
        checks++;
        assert.deepEqual(ids, ['test']);
        assert.ok(input?.verificationView);
        const checkedRoot = input.verificationView.readRoot;
        const value = await fs.readFile(path.join(checkedRoot, 'src/value.ts'), 'utf8');
        const edge = await fs
          .readFile(path.join(checkedRoot, 'src/edge.ts'), 'utf8')
          .catch(() => '');
        const passed =
          value === 'export const value=2;\n' && (!options.requireEdge || edge === 'edge ok\n');
        return {
          passed: Number(passed),
          total: 1,
          results: [
            {
              name: 'Requirements',
              passed,
              ...(passed ? {} : { error: 'The required value or edge behavior is missing.' }),
            },
          ],
        };
      },
    },
  });
  service.schedule = () => {};
  const goal = await new GoalService({
    projects,
    id: () => String(++serial),
    now: () => 'now',
  }).create('goal', 'goal', {
    projectId: 'p',
    title: 'Implement the value contract',
    body: 'Change the value to two.',
    criteria:
      options.requireEdge || options.rejectReviews
        ? 'Preserve the edge contract too.'
        : 'The value is two.',
  });
  const { runId } = await service.start('run', 'run', { projectId: 'p', goalId: goal.id });
  control = { service, runId, write };
  t.after(async () => {
    await service.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    ...control,
    store: () => store,
    starts,
    modelInputs,
    views,
    read,
    run: () => service.get('p', runId),
    counts: () => ({ coordinatorTurns, checks, reviewTurns, checkpoints }),
    async execute() {
      await service.execute('p', runId, new AbortController().signal);
      return service.get('p', runId);
    },
    async reopen() {
      await store.close();
      store = await FileProjectStore.open({ directory: storage, project, profile });
    },
  };
}

const check: ModelStep = { output: decision('check') };
const review: ModelStep = {
  output: decision('review', { result: result(), runtimeId: null, runtimeReason: '' }),
};
const finish: ModelStep = { output: decision('finish', { result: result() }) };
const implement: ModelStep = {
  ...check,
  before: (f) => f.write('src/value.ts', 'export const value=2;\n'),
};

for (const nativeStyle of [false, true]) {
  test(`direct writer chooses checks, fresh review and finish without a fake plan (native-style=${nativeStyle})`, async (t) => {
    const f = await fixture(t, { nativeStyle, steps: [implement, review, finish] });
    const run = await f.execute();
    assert.equal(run.status, 'completed', run.result);
    assert.deepEqual(run.plan, []);
    assert.deepEqual(await f.store().runs.assignments(f.runId), []);
    assert.deepEqual(f.counts(), {
      coordinatorTurns: 3,
      checks: 1,
      reviewTurns: 1,
      checkpoints: 1,
    });
    assert.deepEqual(
      f.starts.map((start) => start.purpose),
      ['coordination', 'review'],
    );
  });
}

test('the model updates a working plan and repairs after rejected review in the same writer session', async (t) => {
  const f = await fixture(t, {
    rejectReviews: 1,
    steps: [
      {
        output: decision('plan', {
          summary: 'Investigate first',
          steps: [{ step: 'Inspect the value contract', owner: 'coordinator' }],
        }),
      },
      implement,
      review,
      {
        output: decision('plan', {
          summary: 'Use the actual finding',
          steps: [{ step: 'Repair the edge case', owner: 'coordinator' }],
        }),
        before: async (control) => {
          await control.write('src/edge.ts', 'edge ok\n');
        },
      },
      check,
      review,
      finish,
    ],
  });
  const run = await f.execute();
  assert.equal(run.status, 'completed', run.result);
  assert.deepEqual(run.plan, [{ step: 'Repair the edge case', owner: 'coordinator' }]);
  const coordinator = f.starts.find((start) => start.purpose === 'coordination')!;
  assert.match(
    coordinator.instructions!,
    /repository command result does not replace service verification/,
  );
  const inputs = f.modelInputs.filter((input) => input.threadId === run.threadId);
  const packet = (index: number) =>
    JSON.parse(
      inputs[index].text
        .split('Current service-owned execution state: ')[1]
        .split('\nReuse only')[0],
    );
  assert.match(packet(3).goal.text, /Change the value to two\./);
  assert.equal(packet(3).review.verdict, 'changes_requested');
  assert.equal(packet(3).checks.passed, 1);
  assert.deepEqual(packet(3).plan, [{ step: 'Inspect the value contract', owner: 'coordinator' }]);
  assert.equal(packet(6).review.verdict, 'approved');
  assert.ok(packet(6).availableActions.some((action: any) => action.id === 'check'));
  assert.equal(run.events.filter((event) => event.type === 'plan.updated').length, 2);
  assert.equal(f.starts.filter((start) => start.purpose === 'coordination').length, 1);
  assert.equal(f.modelInputs.filter((input) => input.threadId === run.threadId).length, 7);
  assert.equal(
    f.counts().coordinatorTurns,
    7,
    'No hidden integration or automatic repair call was added.',
  );
  assert.equal(f.counts().reviewTurns, 2);
  assert.ok(
    f.modelInputs.some((input) => input.text.includes('The required edge case is missing.')),
  );
});

test('diagnostic review runs on failing checks, returns findings and requires a fresh passing revision before acceptance', async (t) => {
  const f = await fixture(t, {
    allowFailingReview: true,
    steps: [finish, review, implement, finish],
  });
  const run = await f.execute();
  assert.equal(run.status, 'completed', run.result);
  assert.equal(f.counts().checkpoints, 1);
  assert.equal(f.counts().reviewTurns, 2);
  assert.match(
    f.modelInputs.filter((i) => !i.text.startsWith('Review goal:'))[2].text,
    /The value must be two/,
  );
  assert.ok(f.modelInputs.filter((input) => input.text.includes('\"passed\":0')).length >= 2);
});

test('a source edit after checks renews evidence before review without an extra coordinator request', async (t) => {
  const f = await fixture(t, {
    steps: [
      implement,
      { ...review, before: (control) => control.write('src/edge.ts', 'edge ok\n') },
      finish,
    ],
  });
  const run = await f.execute();
  assert.equal(run.status, 'completed', run.result);
  assert.equal(f.counts().checks, 2);
  assert.equal(f.counts().reviewTurns, 1);
  assert.equal(f.counts().coordinatorTurns, 3);
});

test('a custom catalog executes arbitrary plugin action names through the same acceptance ports', async (t) => {
  const actions = new ExecutionActionCatalog();
  actions.register({
    id: 'inspect_outcome',
    revision: 'custom-v1',
    description: 'Observe real checks.',
    schema: z.strictObject({}),
    execute: async (input, operations) => ({ ...(await operations.check(input)), exitCode: 0 }),
  });
  actions.register({
    id: 'criticize',
    revision: 'custom-v1',
    description: 'Request an independent critic.',
    schema: z.strictObject({ result: EnvelopeSchema }),
    execute: (input, operations) => operations.review(input),
  });
  actions.register({
    id: 'submit_verified',
    revision: 'custom-v1',
    description: 'Submit proof.',
    schema: z.strictObject({ result: EnvelopeSchema }),
    execute: (input, operations) => operations.finish(input),
  });
  actions.seal();
  const f = await fixture(t, {
    actions,
    steps: [
      { output: decision('inspect_outcome'), before: implement.before },
      { output: decision('criticize', { result: result() }) },
      { output: decision('submit_verified', { result: result() }) },
    ],
  });
  const run = await f.execute();
  assert.equal(run.status, 'completed', run.result);
  assert.deepEqual(
    run.events
      .filter((event) => event.type === 'action.requested')
      .map((event) => JSON.parse(event.text).action),
    ['inspect_outcome', 'criticize', 'submit_verified'],
  );
  assert.ok(f.modelInputs.some((input) => input.text.includes('Service exit code: 0')));
});

test('a model question creates a genuine stopped attempt and preserves work across reopen', async (t) => {
  const question = 'Which edge behavior should be preserved?';
  const f = await fixture(t, {
    steps: [{ output: decision('ask_user', { question }), before: implement.before }],
  });
  const run = await f.execute();
  assert.equal(run.status, 'needs-attention', run.result);
  assert.equal(run.issue?.code, 'OPERATOR_INPUT_REQUIRED');
  assert.equal(run.result, question);
  assert.deepEqual(f.counts(), { coordinatorTurns: 1, checks: 0, reviewTurns: 0, checkpoints: 0 });
  const current = await f.store().runs.currentAttempt(f.runId);
  assert.equal((await f.store().runs.attemptStop(current.attempt.id))?.status, 'needs-attention');
  await f.reopen();
  assert.equal(f.run().result, question);
  assert.equal(await f.read('src/value.ts'), 'export const value=2;\n');
});

test('invalid structured action is corrected from feedback without executing its payload', async (t) => {
  const f = await fixture(t, {
    steps: [
      { output: { decision: { action: 'finish', input: { result: result() }, terminal: true } } },
      { output: decision('ask_user', { question: 'Need a user decision.' }) },
    ],
  });
  const run = await f.execute();
  assert.equal(run.status, 'needs-attention');
  assert.equal(f.counts().checkpoints, 0);
  assert.ok(f.modelInputs[1].text.includes('INVALID_EXECUTION_DECISION'));
});

test('a composite plugin cannot mutate a stopped run after asking the user', async (t) => {
  const actions = new ExecutionActionCatalog();
  actions.register({
    id: 'request_decision',
    revision: 'request-v1',
    description: 'Ask for the required decision.',
    schema: z.strictObject({}),
    async execute(_input, operations) {
      await operations.askUser({ question: 'Choose the intended edge behavior.' });
      await assert.rejects(
        operations.plan({
          summary: 'Too late',
          steps: [{ step: 'Alter stopped work', owner: 'coordinator' }],
        }),
        { code: 'INVALID_STATE' },
      );
      return { content: 'Waiting for the user.' };
    },
  });
  const f = await fixture(t, {
    actions: actions.seal(),
    steps: [{ output: decision('request_decision') }],
  });
  const run = await f.execute();
  assert.equal(run.status, 'needs-attention');
  assert.equal(run.issue?.code, 'OPERATOR_INPUT_REQUIRED');
  assert.deepEqual(run.plan, []);
  assert.equal(
    run.events.some((event) => event.type === 'plan.updated'),
    false,
  );
  assert.deepEqual(f.counts(), { coordinatorTurns: 1, checks: 0, reviewTurns: 0, checkpoints: 0 });
});

test('failed verification returns to the coordinator without a fixed retry or intervention threshold', async (t) => {
  const f = await fixture(t, { steps: [finish, finish, implement, review, finish] });
  const run = await f.execute();
  assert.equal(run.status, 'completed', run.result);
  assert.equal(run.issue, undefined);
  assert.deepEqual(f.counts(), { coordinatorTurns: 5, checks: 3, reviewTurns: 1, checkpoints: 1 });
  assert.ok(f.modelInputs.filter((input) => input.text.includes('\"passed\":0')).length >= 2);
});

test('cancellation after an observed coordinator response blocks action dispatch', async (t) => {
  const f = await fixture(t, {
    steps: [
      {
        output: decision('check'),
        before: async (control) => {
          await control.service.cancel('cancel', 'cancel', {
            projectId: 'p',
            runId: control.runId,
          });
        },
      },
    ],
  });
  const run = await f.execute();
  assert.equal(run.status, 'interrupted', run.result);
  assert.equal(f.counts().checks, 0);
  assert.equal(f.counts().checkpoints, 0);
});

test('an unknown model effect blocks continuation instead of requesting another action', async (t) => {
  const f = await fixture(t, {
    steps: [
      {
        output: decision('check'),
        before: () => {
          throw new UnresolvedEffectError('SESSION_RECONCILIATION_REQUIRED', {
            runtimeId: 'controlled',
            backendSessionId: 'unknown-session',
            operationId: 'unsettled-turn',
          });
        },
      },
      check,
    ],
  });
  const run = await f.execute();
  assert.equal(run.status, 'needs-attention', run.result);
  assert.ok(run.reconciliation);
  assert.equal(f.counts().coordinatorTurns, 1);
  assert.equal(f.counts().checks, 0);
  await assert.rejects(
    f.service.resume('resume', 'resume', {
      projectId: 'p',
      runId: f.runId,
      mode: 'repair',
      instructions: 'Try again',
      useCurrentProfile: false,
    }),
    { code: 'RUN_RECONCILIATION_REQUIRED' },
  );
});

test('changing the configured action catalog after admission blocks dispatch', async (t) => {
  const f = await fixture(t, { steps: [implement, review, finish] });
  const replacement = new ExecutionActionCatalog();
  replacement.register({
    id: 'different',
    revision: 'different-v1',
    description: 'Different configured action.',
    schema: z.strictObject({}),
    execute: (input, operations) => operations.check(input),
  });
  replacement.seal();
  f.service.env.actions = replacement;
  let preparations = 0;
  f.service.env.workspaces.prepare = async () => {
    preparations++;
    throw Error('The changed catalog must reject before preparing a workspace.');
  };
  const run = await f.execute();
  assert.notEqual(run.status, 'completed');
  assert.match(run.result, /admitted action catalog is unavailable/);
  assert.equal(f.starts.length, 0);
  assert.equal(preparations, 0);
  assert.equal(f.counts().checkpoints, 0);
});

function specialist(roleId: string): WorkerProposal {
  return {
    roleId,
    action: 'create',
    title: roleId,
    description: 'A focused reusable specialist.',
    instructions: 'Implement the assigned requirement and report the observed result.',
    kind: 'implementation',
    paths: ['src/'],
    runtimeId: null,
    runtimeReason: '',
    assignment: {
      objective:
        roleId === 'edge_author' ? 'Preserve the edge contract.' : 'Change the value to two.',
      inputs: ['src/value.ts'],
      expectedResult: 'The assigned contract is implemented.',
      criteria: ['Preserve the stated public contract.'],
    },
  };
}

test('the coordinator adds a specialist after observed failure without an initial team plan', async (t) => {
  const f = await fixture(t, {
    requireEdge: true,
    steps: [
      { output: decision('delegate', { worker: specialist('builder') }) },
      check,
      { output: decision('delegate', { worker: specialist('edge_author') }) },
      check,
      review,
      finish,
    ],
  });
  const run = await f.execute();
  assert.equal(run.status, 'completed', run.result);
  const grants = await f.store().runs.assignments(f.runId);
  assert.deepEqual(grants.map((grant) => grant.role.id).sort(), ['builder', 'edge_author']);
  const first = structuredClone(grants.find((grant) => grant.role.id === 'builder'));
  assert.equal(f.counts().checks, 2);
  assert.equal(f.starts.filter((start) => start.purpose === 'implementation').length, 2);
  const delegated = f.modelInputs.find((input) =>
    input.text.startsWith('Service observation for delegate:'),
  )!.text;
  const observation = JSON.parse(
    delegated
      .split('\nChoose the next useful work')[0]
      .split('Service observation for delegate: ')[1],
  );
  assert.equal(observation.roleId, 'builder');
  assert.equal(observation.results[0].status, 'success');
  assert.equal(
    Object.hasOwn(observation, 'result'),
    false,
    'Transport sessions are not repeated in model feedback.',
  );
  const state = JSON.parse(
    delegated.split('Current service-owned execution state: ')[1].split('\nReuse only')[0],
  );
  assert.deepEqual(
    state.workers[0].result,
    result(),
    'The complete worker envelope remains in current state.',
  );
  assert.equal(state.assignments[0].id, first!.id);
  assert.deepEqual(state.assignments[0].paths, first!.paths);
  assert.deepEqual(state.assignments[0].task, first!.task);
  assert.ok(
    f.modelInputs.some((input) =>
      input.text.includes('The required value or edge behavior is missing.'),
    ),
  );
  await f.reopen();
  assert.deepEqual(await f.store().runs.assignment(f.runId, 'builder'), first);
});

test('a delegated author receives review findings and a revised assignment, repairs in the same session and gets fresh approval', async (t) => {
  const worker = specialist('builder');
  const repair = {
    ...worker,
    action: 'reuse' as const,
    instructions: 'Repair the reviewed edge case in the same worker.',
    assignment: {
      ...worker.assignment!,
      objective: 'Repair the reviewed edge case in the same worker.',
    },
  };
  const f = await fixture(t, {
    rejectReviews: 1,
    steps: [
      { output: decision('delegate', { worker }) },
      review,
      { output: decision('delegate', { worker: repair }) },
      review,
      finish,
    ],
  });
  const run = await f.execute();
  assert.equal(run.status, 'completed', run.result);
  assert.equal(f.counts().reviewTurns, 2);
  assert.equal(f.counts().checkpoints, 1);
  assert.equal(f.starts.filter((s) => s.purpose === 'implementation').length, 1);
  const latest = (await f.store().runs.assignments(f.runId))[0];
  assert.ok(latest.previousAssignmentId);
  const author = f.starts.find((s) => s.purpose === 'implementation')!;
  const turns = f.modelInputs.filter(
    (i) => i.threadId === run.agents.find((a) => a.name === 'builder')!.threadId,
  );
  assert.equal(turns.length, 2);
  assert.match(turns[1].text, /The required edge case is missing/);
  assert.match(turns[1].text, /Repair the reviewed edge case in the same worker/);
  assert.equal(author.assignment?.roleId, 'builder');
  assert.equal(run.review?.verdict, 'approved');
});

test('unchanged failed checks are reported as no progress without imposing a retry limit', async (t) => {
  const f = await fixture(t, { steps: [check, check, implement, finish] });
  const run = await f.execute();
  assert.equal(run.status, 'completed', run.result);
  assert.match(f.modelInputs[2].text, /unchanged evidence 2 times/);
  const state = JSON.parse(
    f.modelInputs[2].text
      .split('Current service-owned execution state: ')[1]
      .split('\nReuse only')[0],
  );
  assert.equal(state.progress.unchangedObservations, 2);
});

test('a settled incomplete coordinator response continues from saved work when the runtime proves retry is safe', async (t) => {
  let writes = 0;
  const f = await fixture(t, {
    steps: [
      {
        ...implement,
        before: async (control) => {
          writes++;
          await implement.before!(control);
        },
      },
      {
        output: decision('check'),
        before: () => {
          throw observedTurnFailure(new DomainError('MODEL_INCOMPLETE', 'Output limit reached'));
        },
      },
      finish,
    ],
  });
  f.service.env.runtime.canRetry = async () => true;
  const run = await f.execute();
  assert.equal(run.status, 'completed', run.result);
  assert.equal(writes, 1);
  assert.match(f.modelInputs[2].text, /MODEL_INCOMPLETE/);
  assert.match(f.modelInputs[2].text, /do not restart or repeat completed work/);
  assert.equal(f.counts().checkpoints, 1);
});

test('an incomplete response without proof of a settled retry stops instead of repeating the coordinator', async (t) => {
  const f = await fixture(t, {
    steps: [
      {
        output: decision('check'),
        before: () => {
          throw observedTurnFailure(new DomainError('MODEL_INCOMPLETE', 'Output limit reached'));
        },
      },
    ],
  });
  f.service.env.runtime.canRetry = async () => false;
  const run = await f.execute();
  assert.equal(run.status, 'failed');
  assert.equal(f.modelInputs.length, 1);
  assert.equal(f.counts().checkpoints, 0);
});
