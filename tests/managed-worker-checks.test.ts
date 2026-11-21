import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import type { ManagedRuntimeOptions } from '../core/managed-runtime-options.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import type { ManagedSession } from '../core/model-ports.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import type { ProjectRegistry, RuntimeEvent } from '../core/ports.ts';
import type { ManagedRunBudgetPort } from '../core/run-budget.ts';
import {
  boundedWorkSegmentPolicy,
  type SegmentEvidence,
  type WorkSegmentPolicy,
} from '../core/work-segments.ts';
import type {
  WorkerStepCheckPlan,
  WorkerStepCheckPort,
  WorkerStepCheckResult,
} from '../core/worker-step-checks.ts';

type Request = Parameters<ModelProvider['complete']>[0];
type Generation = Awaited<ReturnType<ModelProvider['complete']>>;
const response = (content = '{"ok":true}'): Generation => ({
  model: 'fixture-model',
  finish: 'stop',
  message: { role: 'assistant', content },
  usage: { inputTokens: 10, outputTokens: 5 },
});
const tool = (id: string): Generation => ({
  ...response(''),
  finish: 'tools',
  message: {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name: 'edit_file', arguments: { path: 'src/a.ts' } }],
  },
});
const close = (status: 'continue' | 'complete'): Generation =>
  response(
    JSON.stringify({
      status,
      nextTask: status === 'continue' ? 'Continue original assigned work' : '',
    }),
  );
const sequence =
  (...steps: Generation[]) =>
  (_input: Request, index: number): Generation => {
    assert.ok(steps[index - 1], 'Unexpected model request ' + index);
    return steps[index - 1];
  };
const turnOptions = (signal = new AbortController().signal) => ({
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  signal,
  timeoutMs: 5000,
});
function unknownCheckCause(expected: RegExp | { code?: string; name?: string }) {
  return (error: any) => {
    assert.equal(error.code, 'WORKER_CHECK_RECONCILIATION_REQUIRED');
    assert.ok(
      error.cause,
      'Preserve the observed failure behind the durable unknown-check boundary',
    );
    if (expected instanceof RegExp) assert.match(error.cause.message, expected);
    else {
      if (expected.code) assert.equal(error.cause.code, expected.code);
      if (expected.name) assert.equal(error.cause.name, expected.name);
    }
    return true;
  };
}
const plan: WorkerStepCheckPlan = {
  version: 1,
  checkIds: ['test'],
  configurationRevision: 'c'.repeat(64),
};
const policy: WorkSegmentPolicy = {
  ...boundedWorkSegmentPolicy,
  revision: 'worker-check-integration-v1',
  limits: {
    revision: 'worker-check-integration-v1',
    maxToolRounds: 3,
    maxSegments: 4,
    contextThresholdPercent: 80,
  },
};
const evidence = (value = 1): SegmentEvidence => ({
  version: 1,
  baseCommit: 'a'.repeat(40),
  headCommit: 'a'.repeat(40),
  workspaceFingerprint: (value === 1 ? 'b' : 'd').repeat(64),
  files: value === 1 ? [] : [{ path: 'src/a.ts', fingerprint: 'e'.repeat(64) }],
});
function checkResult(
  selection: WorkerStepCheckPlan,
  fingerprint: string,
  status: 'passed' | 'failed' | 'unavailable',
): WorkerStepCheckResult {
  return {
    version: 1,
    outcome: status === 'unavailable' ? 'unavailable' : 'completed',
    workspaceFingerprint: fingerprint,
    checkIds: [...selection.checkIds],
    passed: status === 'passed' ? selection.checkIds.length : 0,
    total: selection.checkIds.length,
    results: selection.checkIds.map((id) => ({
      id,
      name: 'Frozen ' + id,
      status,
      ...(status === 'unavailable' ? {} : { exitCode: status === 'passed' ? 0 : 1 }),
      diagnostic: status === 'failed' ? 'PRIVATE_CHECK_DIAGNOSTIC: expected value 2' : '',
    })),
  };
}
async function fixture(
  t: any,
  options: {
    script?: (input: Request, index: number) => Generation | Promise<Generation>;
    separate?: boolean;
    policy?: WorkSegmentPolicy;
    checkPlan?: WorkerStepCheckPlan | null;
    runCheck?: (
      index: number,
      selection: WorkerStepCheckPlan,
      fingerprint: string,
      signal: AbortSignal,
    ) => WorkerStepCheckResult | Promise<WorkerStepCheckResult>;
    inspect?: (index: number) => SegmentEvidence;
    beforeSave?: (session: ManagedSession) => void | Promise<void>;
    reserveTools?: (
      input: Parameters<ManagedRunBudgetPort['reserveTools']>[0],
    ) => void | Promise<void>;
    maxRequests?: number;
    maxToolCalls?: number;
  } = {},
) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-worker-checks-')),
  );
  const files = new FileManagedSessions(directory);
  let serial = 0,
    inspections = 0,
    checkRuns = 0,
    edits = 0;
  let value = 1;
  const requests: Request[] = [];
  const events: RuntimeEvent[] = [];
  const order: string[] = [];
  const toolReservations: Parameters<ManagedRunBudgetPort['reserveTools']>[0][] = [];
  const generationReservations: Parameters<ManagedRunBudgetPort['reserveGeneration']>[0][] = [];
  const snapshot = {
    project: { id: 'p', root: '/fixture' },
    profile: { scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] } },
    runs: [
      {
        id: 'R-owner',
        workspace: '/fixture',
        baseCommit: 'a'.repeat(40),
        status: 'running',
        acceptance: { passed: 0, total: 1 },
      },
    ],
    contextMaterials: [],
  };
  const projects = {
    get: () => ({ snapshot: () => structuredClone(snapshot) }),
  } as unknown as ProjectRegistry;
  const workerStepChecks: WorkerStepCheckPort = {
    plan() {
      order.push('plan');
      return options.checkPlan === null ? undefined : structuredClone(options.checkPlan || plan);
    },
    async run(_scope, selected, fingerprint, signal) {
      order.push('run-check');
      checkRuns++;
      return options.runCheck
        ? options.runCheck(checkRuns, selected, fingerprint, signal)
        : checkResult(selected, fingerprint, value === 2 ? 'passed' : 'failed');
    },
  };
  const settings: ManagedRuntimeOptions = {
    id: 'managed-fixture',
    model: 'fixture-model',
    projects,
    idGenerator: () => String(++serial),
    limits: {
      contextTokens: 65536,
      maxOutputTokens: 512,
      maxRequestsPerTurn: options.maxRequests || 16,
      maxToolCallsPerTurn: options.maxToolCalls || 16,
      maxSessionRequests: 32,
    },
    segmentPolicy: options.policy || policy,
    segmentEvidence: {
      async inspect() {
        order.push('inspect');
        inspections++;
        return structuredClone(options.inspect ? options.inspect(inspections) : evidence(value));
      },
    },
    workerStepChecks,
    sessions: {
      load: (id) => files.load(id),
      async save(session) {
        await options.beforeSave?.(structuredClone(session));
        if (session.workerStepChecks?.entries.at(-1)?.status === 'pending')
          order.push('save-check-pending');
        if (session.workerStepChecks?.entries.at(-1)?.status === 'completed')
          order.push('save-check-completed');
        if (session.workSegments?.archives.at(-1)?.handoff.kind === 'check-feedback')
          order.push('save-feedback');
        return files.save(session);
      },
    },
    budgets: {
      async reserveGeneration(input) {
        order.push('reserve-generation');
        generationReservations.push(structuredClone(input));
        return { operationId: input.operationId, maxOutputTokens: input.requestedOutputTokens };
      },
      async recordUsage() {
        order.push('usage');
      },
      async reserveTools(input) {
        order.push('reserve-tools');
        toolReservations.push(structuredClone(input));
        await options.reserveTools?.(input);
      },
    },
    tools: {
      definitions: () => [
        {
          name: 'edit_file',
          description: 'Edit one assigned source file',
          parameters: { type: 'object' },
        },
      ],
      async execute() {
        order.push('edit');
        edits++;
        value = 2;
        return { content: 'Edited src/a.ts' };
      },
    },
    provider: {
      id: 'provider',
      revision: 'provider-v1',
      local: true,
      ...(options.separate ? { structuredToolMode: 'separate-turn' as const } : {}),
      async complete(input) {
        order.push('model');
        requests.push(
          structuredClone({
            ...input,
            signal: undefined,
            onProgress: undefined,
            onEvent: undefined,
          }) as unknown as Request,
        );
        return options.script ? options.script(input, requests.length) : response();
      },
    },
  };
  const runtimes: ManagedAgentRuntime[] = [];
  const make = (overrides: Partial<ManagedRuntimeOptions> = {}) => {
    const runtime = new ManagedAgentRuntime({ ...settings, ...overrides });
    runtime.subscribe((event) => events.push(structuredClone(event)));
    runtimes.push(runtime);
    return runtime;
  };
  const start = (
    runtime: ManagedAgentRuntime,
    changes: Partial<Parameters<ManagedAgentRuntime['start']>[0]> = {},
  ) =>
    runtime.start({
      projectId: 'p',
      runId: 'R-owner',
      purpose: 'implementation',
      workspace: '/fixture',
      instructions: 'FROZEN_ROLE: preserve protected checks.',
      assignment: {
        sessionId: 'S-worker',
        roleId: 'builder',
        scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
      },
      ...changes,
    });
  t.after(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    make,
    start,
    files,
    settings,
    requests,
    events,
    order,
    toolReservations,
    generationReservations,
    snapshot,
    workerStepChecks,
    get checkRuns() {
      return checkRuns;
    },
    get inspections() {
      return inspections;
    },
    get edits() {
      return edits;
    },
    set value(next: number) {
      value = next;
    },
  };
}

test('observed failed checks create a focused fresh window, repair with actual tools and preserve the original task and lifetime budgets', async (t) => {
  const f = await fixture(t, {
    script: sequence(response('I believe the work is complete'), tool('repair'), response()),
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await runtime.turn(
    threadId,
    'FROZEN_TASK: change assigned value to 2 and preserve every criterion.',
    turnOptions(),
  );
  assert.equal(f.checkRuns, 2);
  assert.equal(f.edits, 1);
  assert.equal(f.requests.length, 3);
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.requests, 3);
  assert.equal(saved.scope.sessionId, 'S-worker');
  assert.equal(saved.id, threadId);
  assert.equal(saved.workerStepChecks?.feedbackSteps, 1);
  assert.equal(saved.workerStepChecks?.entries.length, 2);
  assert.equal(saved.workerStepChecks?.entries[0].result?.passed, 0);
  assert.equal(saved.workerStepChecks?.entries[1].result?.passed, 1);
  assert.equal(saved.workSegments?.archives.length, 1);
  assert.equal(saved.workSegments?.archives[0].handoff.kind, 'check-feedback');
  assert.ok(f.requests[1].messages.some((message) => message.content.includes('FROZEN_TASK')));
  assert.ok(
    f.requests[1].messages.some((message) =>
      message.content.includes('Next bounded task generated by Buro'),
    ),
  );
  assert.ok(
    f.requests[1].messages.some((message) => message.content.includes('PRIVATE_CHECK_DIAGNOSTIC')),
  );
  assert.ok(
    f.requests[1].messages.some((message) =>
      message.content.includes('"protectedPaths":["checks/"]'),
    ),
  );
  assert.equal(f.generationReservations.length, 3);
  assert.equal(f.toolReservations.length, 3);
  assert.ok(
    f.toolReservations.every(
      (reservation) => reservation.phase === 'work' && reservation.ownerRunId === 'R-owner',
    ),
  );
  assert.equal(f.events.filter((event) => event.type === 'turn.completed').length, 1);
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_CHECK_DIAGNOSTIC|FROZEN_TASK|FROZEN_ROLE/);
});

test('natural completion and closing complete check once, while closing continue and final serialization never run checks', async (t) => {
  for (const separate of [false, true]) {
    const f = await fixture(t, {
      separate,
      policy: { ...policy, limits: { ...policy.limits, maxToolRounds: 1 } },
      script: sequence(
        tool('first'),
        close('continue'),
        tool('second'),
        close('complete'),
        response(),
      ),
    });
    f.value = 2;
    const runtime = f.make();
    const { threadId } = await f.start(runtime);
    await runtime.turn(threadId, 'Finish the assigned work', turnOptions());
    assert.equal(f.requests.length, 5);
    assert.equal(f.checkRuns, 1);
    assert.equal((await f.files.load(threadId))?.workerStepChecks?.entries.length, 1);
  }
  const natural = await fixture(t, {
    separate: true,
    script: sequence(response('Done'), response()),
  });
  natural.value = 2;
  const runtime = natural.make();
  const { threadId } = await natural.start(runtime);
  await runtime.turn(threadId, 'Finish', turnOptions());
  assert.equal(natural.checkRuns, 1);
  assert.equal(natural.requests.length, 2);
});

test('assignments without independently applicable checks skip the feedback loop', async (t) => {
  const f = await fixture(t, { checkPlan: null, script: sequence(response()) });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await runtime.turn(threadId, 'Finish', turnOptions());
  assert.equal(f.checkRuns, 0);
  assert.equal(f.toolReservations.length, 0);
  assert.equal((await f.files.load(threadId))?.workerStepChecks, undefined);
});

test('passing a worker step check does not accept the owning run or create final review evidence', async (t) => {
  const f = await fixture(t);
  f.value = 2;
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await runtime.turn(threadId, 'Finish', turnOptions());
  assert.equal(f.checkRuns, 1);
  assert.equal(f.snapshot.runs[0].status, 'running');
  assert.deepEqual(f.snapshot.runs[0].acceptance, { passed: 0, total: 1 });
  assert.equal('review' in f.snapshot.runs[0], false);
  assert.equal(
    f.events.some((event) => event.type === 'agent.activity'),
    false,
  );
});

test('selected check count is reserved before durable pending intent and check dispatch', async (t) => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const selected = { ...plan, checkIds: ['test', 'types'] };
  f = await fixture(t, {
    checkPlan: selected,
    runCheck: async (_index, selection, fingerprint) => {
      const pending = (await f.files.load('M-1'))!;
      assert.equal(pending.workerStepChecks?.entries.at(-1)?.status, 'pending');
      assert.equal(f.toolReservations.at(-1)?.count, 2);
      return checkResult(selection, fingerprint, 'passed');
    },
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await runtime.turn(threadId, 'Finish', turnOptions());
  const reserve = f.order.indexOf('reserve-tools'),
    pending = f.order.indexOf('save-check-pending'),
    run = f.order.indexOf('run-check');
  assert.ok(reserve >= 0 && reserve < pending && pending < run);
  assert.equal(f.toolReservations.length, 1);
  assert.equal(f.toolReservations[0].count, selected.checkIds.length);
});

test('failed check reservation or pending checkpoint never dispatches the registered check', async (t) => {
  for (const failure of ['reservation', 'checkpoint']) {
    const f = await fixture(t, {
      reserveTools: () => {
        if (failure === 'reservation') throw Error('Check allowance exhausted');
      },
      beforeSave(session) {
        if (
          failure === 'checkpoint' &&
          session.workerStepChecks?.entries.at(-1)?.status === 'pending'
        )
          throw Error('Pending check checkpoint unavailable');
      },
    });
    const runtime = f.make();
    const { threadId } = await f.start(runtime);
    await assert.rejects(
      runtime.turn(threadId, 'Finish', turnOptions()),
      failure === 'reservation' ? /allowance/ : /checkpoint/,
    );
    assert.equal(f.checkRuns, 0);
    assert.equal(f.requests.length, 1);
    assert.equal((await f.files.load(threadId))?.workerStepChecks, undefined);
  }
});

test('a lost check outcome blocks resume and never silently dispatches the check again', async (t) => {
  const f = await fixture(t, {
    runCheck: async () => {
      throw Error('Check process result lost');
    },
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(
    runtime.turn(threadId, 'Finish', turnOptions()),
    unknownCheckCause(/result lost/),
  );
  assert.equal((await f.files.load(threadId))?.workerStepChecks?.entries[0].status, 'unknown');
  await runtime.release(threadId);
  const reopened = f.make();
  await assert.rejects(reopened.turn(threadId, 'Continue', turnOptions()), {
    code: 'WORKER_CHECK_RECONCILIATION_REQUIRED',
  });
  await assert.rejects(
    reopened.resume({
      projectId: 'p',
      runId: 'R-owner',
      workspace: '/fixture',
      threadId,
      instructions: 'Continue',
    }),
    { code: 'WORKER_CHECK_RECONCILIATION_REQUIRED' },
  );
  assert.equal(f.checkRuns, 1);
  assert.equal(f.requests.length, 1);
});

test('a pending check intent left by process loss prevents replay after reopening', async (t) => {
  const f = await fixture(t, {
    beforeSave(session) {
      const status = session.workerStepChecks?.entries.at(-1)?.status;
      if (status === 'completed' || status === 'unknown')
        throw Error('Process lost before check receipt checkpoint');
    },
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  f.value = 2;
  await assert.rejects(
    runtime.turn(threadId, 'Finish', turnOptions()),
    unknownCheckCause(/receipt checkpoint/),
  );
  assert.equal((await f.files.load(threadId))?.workerStepChecks?.entries[0].status, 'pending');
  await runtime.release(threadId);
  await assert.rejects(f.make().turn(threadId, 'Continue', turnOptions()), {
    code: 'WORKER_CHECK_RECONCILIATION_REQUIRED',
  });
  assert.equal(f.checkRuns, 1);
});

test('an unavailable check is recorded but never turned into an automatic repair prompt', async (t) => {
  const f = await fixture(t, {
    runCheck: (_index, selected, fingerprint) => checkResult(selected, fingerprint, 'unavailable'),
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Finish', turnOptions()), {
    code: 'WORKER_CHECK_UNAVAILABLE',
  });
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.workerStepChecks?.entries[0].status, 'completed');
  assert.equal(saved.workerStepChecks?.feedbackSteps, 0);
  assert.equal(saved.workSegments?.archives.length, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.checkRuns, 1);
});

for (const [name, fabricate] of [
  [
    'fingerprint',
    (result: WorkerStepCheckResult) => ({ ...result, workspaceFingerprint: 'f'.repeat(64) }),
  ],
  ['check selection', (result: WorkerStepCheckResult) => ({ ...result, checkIds: ['different'] })],
  ['passed count', (result: WorkerStepCheckResult) => ({ ...result, passed: 99 })],
  [
    'extra diagnostic size',
    (result: WorkerStepCheckResult) => ({
      ...result,
      results: result.results.map((row) => ({ ...row, diagnostic: 'x'.repeat(513) })),
    }),
  ],
] as const)
  test('fabricated ' + name + ' is rejected without a feedback window', async (t) => {
    const f = await fixture(t, {
      runCheck: (_index, selected, fingerprint) =>
        fabricate(checkResult(selected, fingerprint, 'failed')),
    });
    const runtime = f.make();
    const { threadId } = await f.start(runtime);
    await assert.rejects(
      runtime.turn(threadId, 'Finish', turnOptions()),
      unknownCheckCause({ code: 'INVALID_STEP_CHECK' }),
    );
    const saved = (await f.files.load(threadId))!;
    assert.equal(saved.workerStepChecks?.entries[0].status, 'unknown');
    assert.equal(saved.workSegments?.archives.length, 0);
    assert.equal(f.requests.length, 1);
  });

test('the original two-feedback allowance survives reopening and an explicit new turn', async (t) => {
  const f = await fixture(t, {
    runCheck: (_index, selected, fingerprint) => checkResult(selected, fingerprint, 'failed'),
    script: sequence(response(), response(), response()),
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Original task', turnOptions()), {
    code: 'WORKER_CHECK_FEEDBACK_LIMIT',
  });
  const before = (await f.files.load(threadId))!;
  assert.equal(before.requests, 3);
  assert.equal(before.workerStepChecks?.feedbackSteps, 2);
  assert.equal(before.workerStepChecks?.entries.length, 3);
  assert.equal(before.workSegments?.active.index, 3);
  await runtime.release(threadId);
  const reopened = f.make({
    provider: { ...f.settings.provider, complete: async () => response() },
  });
  await reopened.resume({
    projectId: 'p',
    runId: 'R-owner',
    workspace: '/fixture',
    threadId,
    instructions: 'Explicit continuation of same assignment',
  });
  await assert.rejects(reopened.turn(threadId, 'Original task continues', turnOptions()), {
    code: 'WORKER_CHECK_FEEDBACK_LIMIT',
  });
  const after = (await f.files.load(threadId))!;
  assert.equal(after.workerStepChecks?.feedbackSteps, 2);
  assert.equal(after.workSegments?.archives.length, 2);
  assert.equal(after.requests, 4);
  assert.equal(after.workerStepChecks?.entries.length, 4);
});

test('check feedback consumes the existing segment lifetime cap instead of opening an extra allowance', async (t) => {
  const f = await fixture(t, {
    policy: { ...policy, limits: { ...policy.limits, maxSegments: 1 } },
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Finish', turnOptions()), {
    code: 'WORK_SEGMENT_LIMIT',
  });
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.workerStepChecks?.entries.length, 1);
  assert.equal(saved.workerStepChecks?.feedbackSteps, 0);
  assert.equal(saved.workSegments?.active.index, 1);
  assert.equal(f.requests.length, 1);
});

test('cancellation before pending intent and after check completion cannot trigger a repair or next model request', async (t) => {
  for (const phase of ['before', 'after']) {
    const abort = new AbortController();
    const f = await fixture(t, {
      reserveTools: () => {
        if (phase === 'before') abort.abort();
      },
      runCheck: (_index, selected, fingerprint) => {
        if (phase === 'after') abort.abort();
        return checkResult(selected, fingerprint, 'failed');
      },
    });
    const runtime = f.make();
    const { threadId } = await f.start(runtime);
    await assert.rejects(
      runtime.turn(threadId, 'Finish', turnOptions(abort.signal)),
      phase === 'after' ? unknownCheckCause({ name: 'AbortError' }) : { name: 'AbortError' },
    );
    const saved = (await f.files.load(threadId))!;
    assert.equal(saved.workSegments?.archives.length, 0);
    assert.equal(saved.workerStepChecks?.feedbackSteps || 0, 0);
    assert.equal(f.requests.length, 1);
    assert.equal(f.checkRuns, phase === 'before' ? 0 : 1);
    if (phase === 'after') assert.equal(saved.workerStepChecks?.entries[0].status, 'unknown');
  }
});

test('a failed feedback checkpoint preserves the completed check and never starts a fresh model window', async (t) => {
  const f = await fixture(t, {
    beforeSave(session) {
      if (session.workSegments?.archives.at(-1)?.handoff.kind === 'check-feedback')
        throw Error('Feedback checkpoint unavailable');
    },
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Finish', turnOptions()), /Feedback checkpoint/);
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.workerStepChecks?.entries[0].status, 'completed');
  assert.equal(saved.workerStepChecks?.feedbackSteps, 0);
  assert.equal(saved.workSegments?.archives.length, 0);
  assert.equal(f.requests.length, 1);
});

test('a check configuration change cannot silently replace the frozen selection on a later completion', async (t) => {
  const f = await fixture(t, {
    runCheck: (_index, selected, fingerprint) => checkResult(selected, fingerprint, 'passed'),
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await runtime.turn(threadId, 'Finish', turnOptions());
  f.workerStepChecks.plan = () => ({ ...plan, configurationRevision: 'd'.repeat(64) });
  await assert.rejects(runtime.turn(threadId, 'Continue same scope revision', turnOptions()), {
    code: 'WORKER_CHECK_CHANGED',
  });
  assert.equal(f.checkRuns, 1);
  assert.equal((await f.files.load(threadId))?.workerStepChecks?.entries.length, 1);
});

test('a changed workspace after the registered check invalidates its evidence and stops without feedback or automatic replay', async (t) => {
  const f = await fixture(t, {
    inspect(index) {
      return evidence(index >= 3 ? 2 : 1);
    },
    runCheck: (_index, selected, fingerprint) => checkResult(selected, fingerprint, 'failed'),
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(
    runtime.turn(threadId, 'Finish', turnOptions()),
    unknownCheckCause({ code: 'WORKER_CHECK_STALE' }),
  );
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.workerStepChecks?.entries[0].status, 'unknown');
  assert.equal(saved.workerStepChecks?.feedbackSteps, 0);
  assert.equal(saved.workSegments?.archives.length, 0);
  assert.equal(f.requests.length, 1);
  await runtime.release(threadId);
  await assert.rejects(f.make().turn(threadId, 'Continue', turnOptions()), {
    code: 'WORKER_CHECK_RECONCILIATION_REQUIRED',
  });
  assert.equal(f.checkRuns, 1);
});

test('an out-of-scope change made during a service check cannot become a trusted repair baseline', async (t) => {
  const f = await fixture(t, {
    inspect(index) {
      return index >= 3
        ? {
            ...evidence(),
            files: [{ path: 'checks/protected.ts', fingerprint: 'f'.repeat(64) }],
          }
        : evidence();
    },
    runCheck: (_index, selected, fingerprint) => checkResult(selected, fingerprint, 'passed'),
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(
    runtime.turn(threadId, 'Finish', turnOptions()),
    unknownCheckCause({ code: 'SEGMENT_SCOPE_CHANGED' }),
  );
  assert.equal((await f.files.load(threadId))?.workerStepChecks?.entries[0].status, 'unknown');
  assert.equal((await f.files.load(threadId))?.workSegments?.archives.length, 0);
  assert.equal(f.requests.length, 1);
});

test('cancellation after the completed check checkpoint retains its known receipt but forbids feedback activation', async (t) => {
  const abort = new AbortController();
  const f = await fixture(t, {
    beforeSave(session) {
      if (session.workerStepChecks?.entries.at(-1)?.status === 'completed') abort.abort();
    },
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Finish', turnOptions(abort.signal)), {
    name: 'AbortError',
  });
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.workerStepChecks?.entries[0].status, 'completed');
  assert.equal(saved.workerStepChecks?.feedbackSteps, 0);
  assert.equal(saved.workSegments?.archives.length, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(saved.status, 'interrupted');
});

test('check feedback retains the per-turn request ceiling even when a fresh window was durably saved', async (t) => {
  const f = await fixture(t, { maxRequests: 1 });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Finish', turnOptions()), {
    code: 'MODEL_BUDGET_EXHAUSTED',
  });
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.requests, 1);
  assert.equal(saved.workerStepChecks?.feedbackSteps, 1);
  assert.equal(saved.workSegments?.archives.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.generationReservations.length, 1);
});

test('a model tool which spends the last per-turn action prevents a subsequent service check before its reservation or intent', async (t) => {
  const f = await fixture(t, {
    maxToolCalls: 1,
    script: sequence(tool('edit'), response()),
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Finish', turnOptions()), {
    code: 'TOOL_BUDGET_EXHAUSTED',
  });
  assert.equal(f.edits, 1);
  assert.equal(f.checkRuns, 0);
  assert.equal(f.requests.length, 2);
  assert.equal(f.toolReservations.length, 1);
  assert.equal(f.toolReservations[0].count, 1);
  assert.equal((await f.files.load(threadId))?.workerStepChecks, undefined);
});

test('all selected checks must fit the per-turn remainder before any check is reserved or dispatched', async (t) => {
  const f = await fixture(t, {
    maxToolCalls: 1,
    checkPlan: { ...plan, checkIds: ['test', 'types'] },
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Finish', turnOptions()), {
    code: 'TOOL_BUDGET_EXHAUSTED',
  });
  assert.equal(f.checkRuns, 0);
  assert.equal(f.toolReservations.length, 0);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.files.load(threadId))?.workerStepChecks, undefined);
});

test('service-check action charges accumulate with model tools across a feedback window', async (t) => {
  for (const maxToolCalls of [1, 2]) {
    const f = await fixture(t, {
      maxToolCalls,
      script: sequence(response(), tool('repair'), response()),
    });
    const runtime = f.make();
    const { threadId } = await f.start(runtime);
    await assert.rejects(runtime.turn(threadId, 'Finish', turnOptions()), {
      code: 'TOOL_BUDGET_EXHAUSTED',
    });
    const saved = (await f.files.load(threadId))!;
    assert.equal(saved.workerStepChecks?.entries.length, 1);
    assert.equal(saved.workerStepChecks?.feedbackSteps, 1);
    assert.equal(saved.workSegments?.archives.length, 1);
    assert.equal(f.checkRuns, 1);
    assert.equal(f.edits, maxToolCalls - 1);
    assert.equal(f.toolReservations.length, maxToolCalls);
    assert.equal(
      f.toolReservations.reduce((total, item) => total + item.count, 0),
      maxToolCalls,
    );
    assert.equal(f.requests.length, maxToolCalls + 1);
  }
});

test('strict managed workers skip even an injected live check service without inventing a passed receipt', async (t) => {
  const f = await fixture(t);
  f.snapshot.profile.scope.mode = 'strict';
  const runtime = f.make();
  const { threadId } = await f.start(runtime, {
    assignment: {
      sessionId: 'S-worker',
      roleId: 'builder',
      scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
    },
  });
  await runtime.turn(threadId, 'Finish bounded work', turnOptions());
  assert.equal(f.checkRuns, 0);
  assert.ok(!f.order.includes('plan'));
  assert.equal((await f.files.load(threadId))!.workerStepChecks, undefined);
  assert.equal(f.snapshot.runs[0].status, 'running');
});

test('strict mode never clears an existing unknown worker-check receipt on restart or resume', async (t) => {
  const f = await fixture(t);
  f.snapshot.profile.scope.mode = 'strict';
  const runtime = f.make();
  const { threadId } = await f.start(runtime, {
    assignment: {
      sessionId: 'S-worker',
      roleId: 'builder',
      scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
    },
  });
  await runtime.turn(threadId, 'Finish bounded work', turnOptions());
  const pending = (await f.files.load(threadId))!;
  pending.workerStepChecks = {
    version: 1,
    revision: 'worker-step-checks-v1',
    maxFeedbackSteps: 2,
    feedbackSteps: 0,
    entries: [
      {
        id: 'C-prior',
        turnId: pending.workSegments!.anchor.turnId,
        scopeRevision: 1,
        requestedAtRequest: pending.requests,
        plan: structuredClone(plan),
        before: evidence(),
        status: 'pending',
      },
    ],
  };
  await f.files.save(pending);
  pending.workerStepChecks.entries[0].status = 'unknown';
  await f.files.save(pending);
  await runtime.release(threadId);
  const restored = f.make();
  const requests = f.requests.length;
  await assert.rejects(
    restored.resume({
      projectId: 'p',
      runId: 'R-owner',
      workspace: '/fixture',
      threadId,
      instructions: 'Continue strict work',
    }),
    { code: 'WORKER_CHECK_RECONCILIATION_REQUIRED' },
  );
  assert.equal(f.requests.length, requests);
  assert.equal(f.checkRuns, 0);
  assert.equal((await f.files.load(threadId))!.workerStepChecks!.entries[0].status, 'unknown');
});
