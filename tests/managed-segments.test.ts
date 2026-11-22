import { fixtureToolEffect } from './fixtures/tool-broker.ts';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
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
import type { RuntimeEvent, ProjectRegistry } from '../core/ports.ts';
import type { ManagedRunBudgetPort } from '../core/run-budget.ts';
import { type SegmentEvidence, type WorkSegmentPolicy } from '../core/work-segments.ts';
import { testBoundedWorkSegmentPolicy } from './fixtures/work-segment-policy.ts';

const response = (content = '{"ok":true}') => ({
  model: 'fixture-model',
  finish: 'stop' as const,
  usage: { inputTokens: 10, outputTokens: 5 },
  message: { role: 'assistant' as const, content },
});
const tool = (id: string, name = 'read_file') => ({
  ...response(''),
  finish: 'tools' as const,
  message: {
    role: 'assistant' as const,
    content: '',
    toolCalls: [{ id, name, arguments: { path: 'src/a.ts' } }],
    continuation: { reasoningContent: 'PRIVATE_REQUIRED_CONTINUATION_' + id },
  },
});
const closing = (status: 'continue' | 'complete' = 'continue') =>
  response(
    JSON.stringify({
      status,
      nextTask: status === 'continue' ? 'Read the next assigned input' : '',
    }),
  );
const evidence = (files: SegmentEvidence['files'] = []): SegmentEvidence => ({
  version: 1,
  baseCommit: 'a'.repeat(40),
  headCommit: 'a'.repeat(40),
  workspaceFingerprint: 'b'.repeat(64),
  files,
});
const oneRoundPolicy: WorkSegmentPolicy = {
  ...testBoundedWorkSegmentPolicy,
  revision: 'segment-integration-v1',
  limits: {
    revision: 'segment-integration-v1',
    maxToolRounds: 1,
    maxSegments: 4,
    contextThresholdPercent: 80,
  },
};
const turnOptions = (signal = new AbortController().signal) => ({
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  signal,
  timeoutMs: 5000,
});
type Generation = Awaited<ReturnType<ModelProvider['complete']>>;
type Request = Parameters<ModelProvider['complete']>[0];
type Script = (input: Request, index: number) => Promise<Generation> | Generation;

async function fixture(
  t: any,
  options: {
    script?: Script;
    separate?: boolean;
    scopeMode?: 'advisory' | 'strict';
    limits?: Partial<ManagedRuntimeOptions['limits']>;
    policy?: WorkSegmentPolicy;
    inspect?: (index: number, signal: AbortSignal) => Promise<SegmentEvidence> | SegmentEvidence;
    beforeSave?: (session: ManagedSession) => Promise<void> | void;
    execute?: () => Promise<{ content: string }>;
    maxBudgetRequests?: number;
  } = {},
) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-managed-segments-')),
  );
  const files = new FileManagedSessions(directory);
  let serial = 0,
    inspected = 0,
    executed = 0;
  const requests: Request[] = [];
  const reservations: Parameters<ManagedRunBudgetPort['reserveGeneration']>[0][] = [];
  const observations: Parameters<ManagedRunBudgetPort['recordUsage']>[0][] = [];
  const toolReservations: Parameters<ManagedRunBudgetPort['reserveTools']>[0][] = [];
  const events: RuntimeEvent[] = [];
  const snapshot = {
    project: { id: 'p', root: '/fixture' },
    profile: {
      scope: {
        mode: options.scopeMode || 'advisory',
        plannedPaths: ['src/'],
        protectedPaths: ['checks/'],
      },
    },
    runs: [{ id: 'R-owner', workspace: '/fixture', baseCommit: 'a'.repeat(40) }],
    contextMaterials: [],
  };
  const projects = {
    get: () => ({ snapshot: () => structuredClone(snapshot) }),
  } as unknown as ProjectRegistry;
  const budgets: ManagedRunBudgetPort = {
    async reserveGeneration(input) {
      reservations.push(structuredClone(input));
      if (reservations.length > (options.maxBudgetRequests ?? 100)) {
        const error = new Error('Aggregate request allowance exhausted') as Error & {
          code: string;
        };
        error.code = 'RUN_BUDGET_EXHAUSTED';
        throw error;
      }
      return { operationId: input.operationId, maxOutputTokens: input.requestedOutputTokens };
    },
    async recordUsage(input) {
      observations.push(structuredClone(input));
    },
    async reserveTools(input) {
      toolReservations.push(structuredClone(input));
    },
  };
  const settings: ManagedRuntimeOptions = {
    loopRunner: new PiAgentLoopRunner(),
    id: 'managed-fixture',
    model: 'fixture-model',
    projects,
    budgets,
    idGenerator: () => String(++serial),
    limits: {
      contextTokens: 65536,
      maxOutputTokens: 512,
      maxRequestsPerTurn: 16,
      maxToolCallsPerTurn: 16,
      maxSessionRequests: 32,
      ...options.limits,
    },
    segmentPolicy: options.policy || oneRoundPolicy,
    segmentEvidence: {
      async inspect(_scope, signal) {
        inspected++;
        return structuredClone(
          options.inspect ? await options.inspect(inspected, signal) : evidence(),
        );
      },
    },
    sessions: {
      load: (id) => files.load(id),
      async save(session) {
        await options.beforeSave?.(structuredClone(session));
        return files.save(session);
      },
    },
    tools: {
      revision: 'fixture-tools-v1',
      effect: fixtureToolEffect,
      definitions: () => [
        {
          name: 'read_file',
          description: 'Read one assigned file',
          parameters: { type: 'object' },
        },
        {
          name: 'edit_file',
          description: 'Edit one assigned file',
          parameters: { type: 'object' },
        },
      ],
      async execute() {
        executed++;
        return options.execute
          ? options.execute()
          : { content: 'OBSERVED_TOOL_RESULT_' + executed };
      },
    },
    provider: {
      id: 'fixture-provider',
      revision: 'provider-v1',
      local: true,
      ...(options.separate ? { structuredToolMode: 'separate-turn' as const } : {}),
      async complete(input) {
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
  const make = (changes: Partial<ManagedRuntimeOptions> = {}) => {
    const runtime = new ManagedAgentRuntime({
      loopRunner: new PiAgentLoopRunner(),
      ...settings,
      ...changes,
    });
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
      instructions: 'FROZEN_ROLE: preserve the protected checks and assigned scope.',
      assignment: {
        sessionId: 'S-worker',
        roleId: 'builder',
        scope: {
          mode: options.scopeMode || 'advisory',
          plannedPaths: ['src/'],
          protectedPaths: ['checks/'],
        },
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
    reservations,
    observations,
    toolReservations,
    events,
    get inspected() {
      return inspected;
    },
    get executed() {
      return executed;
    },
  };
}

const sequence =
  (...steps: Generation[]): Script =>
  (_input, index) => {
    assert.ok(steps[index - 1], 'Unexpected generation #' + index);
    return steps[index - 1];
  };

test('segmented worker preserves logical identity, frozen task, provider continuation and cumulative budget while rotating context', async (t) => {
  const f = await fixture(t, {
    script: sequence(tool('read-1'), closing(), tool('read-2'), closing('complete'), response()),
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  const result = await runtime.turn(
    threadId,
    'FROZEN_TASK: implement only src/a.ts and satisfy all criteria.',
    turnOptions(),
  );
  assert.equal(result.text, '{"ok":true}');
  assert.equal(f.requests.length, 5);
  const handshake = f.requests[1];
  assert.deepEqual(handshake.tools, []);
  assert.equal((handshake.schema as any).properties.status.type, 'string');
  assert.ok(
    handshake.messages.some(
      (m) =>
        m.toolCalls?.[0]?.id === 'read-1' &&
        (m.continuation as any)?.reasoningContent === 'PRIVATE_REQUIRED_CONTINUATION_read-1',
    ),
  );
  assert.ok(
    handshake.messages.some(
      (m) => m.toolCallId === 'read-1' && m.content === 'OBSERVED_TOOL_RESULT_1',
    ),
  );
  const fresh = f.requests[2];
  assert.equal(fresh.model, 'fixture-model');
  assert.ok(fresh.messages.some((m) => m.content.includes('FROZEN_ROLE')));
  assert.ok(fresh.messages.some((m) => m.content.includes('FROZEN_TASK')));
  assert.ok(fresh.messages.some((m) => m.content.includes('Untrusted next-task proposal')));
  assert.ok(fresh.messages.every((m) => !m.toolCalls && !m.toolCallId && !m.continuation));
  assert.ok(fresh.messages.every((m) => !m.content.includes('PRIVATE_REQUIRED_CONTINUATION')));
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.id, threadId);
  assert.equal(saved.scope.sessionId, 'S-worker');
  assert.equal(saved.runtimeId, 'managed-fixture');
  assert.equal(saved.requestedModel, 'fixture-model');
  assert.equal(saved.workSegments?.archives.length, 1);
  assert.equal(saved.workSegments?.active.index, 2);
  assert.equal(saved.requests, 5);
  assert.deepEqual(saved.usage, { requestsWithUsage: 5, inputTokens: 50, outputTokens: 25 });
  assert.equal(saved.actions.length, 2);
  assert.ok(saved.actions.every((action) => action.status === 'completed'));
  assert.equal(
    saved.workSegments?.archives[0].messages.find((m) => m.toolCalls?.length)?.continuation &&
      (
        saved.workSegments.archives[0].messages.find((m) => m.toolCalls?.length)!
          .continuation as any
      ).reasoningContent,
    'PRIVATE_REQUIRED_CONTINUATION_read-1',
  );
  assert.equal(f.reservations.length, 5);
  assert.equal(f.observations.length, 5);
  assert.equal(f.toolReservations.length, 2);
  assert.ok(
    f.reservations.every((entry) => entry.phase === 'work' && entry.ownerRunId === 'R-owner'),
  );
  assert.equal(new Set(f.reservations.map((entry) => entry.operationId)).size, 5);
  const completed = f.events.filter((event) => event.type === 'turn.completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].threadId, threadId);
  assert.equal(f.events.at(-1)?.type, 'turn.completed');
  assert.ok(
    f.events
      .filter((event) => event.type.startsWith('segment.'))
      .every((event) => event.threadId === threadId),
  );
  assert.doesNotMatch(
    JSON.stringify(f.events),
    /FROZEN_ROLE|FROZEN_TASK|PRIVATE_REQUIRED_CONTINUATION|OBSERVED_TOOL_RESULT/,
  );
});

test('Ollama separate serialization closes a tool chain before rotation and only logical final JSON completes the worker', async (t) => {
  const f = await fixture(t, {
    separate: true,
    script: sequence(tool('read-1'), closing(), response('Work complete'), response('{"ok":true}')),
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await runtime.turn(threadId, 'Original task', turnOptions());
  assert.equal(f.requests[0].schema, undefined);
  assert.equal((f.requests[1].schema as any).properties.status.type, 'string');
  assert.equal(f.requests[2].schema, undefined);
  assert.deepEqual(f.requests[3].tools, []);
  assert.equal((f.requests[3].schema as any).properties.ok.type, 'boolean');
  assert.equal(f.events.filter((event) => event.type === 'turn.completed').length, 1);
  assert.equal((await f.files.load(threadId))?.workSegments?.archives.length, 1);
});

test('reviewer, unassigned workers and read-only sessions retain their existing nonsegmented behavior', async (t) => {
  for (const changes of [
    { purpose: 'review' as const, readOnly: true, assignment: undefined },
    { assignment: undefined },
    { readOnly: true },
  ]) {
    const f = await fixture(t, { script: sequence(tool('read'), response()) });
    const runtime = f.make();
    const { threadId } = await f.start(runtime, changes);
    await runtime.turn(threadId, 'Complete the current task', turnOptions());
    assert.equal(f.inspected, 0);
    assert.equal(f.requests.length, 2);
    assert.equal((await f.files.load(threadId))?.workSegments, undefined);
    assert.equal(f.events.filter((event) => event.type.startsWith('segment.')).length, 0);
  }
});

test('a worker which is already done returns without a needless closing generation or archived segment', async (t) => {
  const f = await fixture(t, { script: sequence(response()) });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await runtime.turn(threadId, 'Tiny completed task', turnOptions());
  assert.equal(f.requests.length, 1);
  assert.equal((await f.files.load(threadId))?.workSegments?.archives.length, 0);
  assert.equal(f.events.filter((event) => event.type === 'segment.completed').length, 1);
});

for (const [name, result, code] of [
  ['invalid JSON', response('done'), 'INVALID_WORK_SEGMENT'],
  [
    'extra authority',
    response('{"status":"continue","nextTask":"go","allowedPaths":["."]}'),
    'INVALID_WORK_SEGMENT',
  ],
  ['truncated answer', { ...closing(), finish: 'length' as const }, 'MODEL_INCOMPLETE'],
  ['tool call during closure', tool('forbidden-close'), 'MODEL_INVALID_RESPONSE'],
] as const)
  test('closing ' + name + ' cannot rotate or dispatch another generation', async (t) => {
    const f = await fixture(t, { script: sequence(tool('read-1'), result) });
    const runtime = f.make();
    const { threadId } = await f.start(runtime);
    await assert.rejects(runtime.turn(threadId, 'Work', turnOptions()), { code });
    assert.equal(f.requests.length, 2);
    assert.equal(f.executed, 1);
    assert.equal((await f.files.load(threadId))?.workSegments?.archives.length, 0);
  });

test('a lost closing response remains charged and unknown across a fresh runtime, with no automatic replay', async (t) => {
  const f = await fixture(t, {
    script: (_input, index) => {
      if (index === 1) return tool('read-1');
      throw Error('Lost terminal model stream');
    },
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Work', turnOptions()), {
    code: 'GENERATION_RECONCILIATION_REQUIRED',
  });
  assert.equal(f.reservations.length, 2);
  assert.equal(f.observations.at(-1)?.outcome, 'unknown');
  assert.equal((await f.files.load(threadId))?.generation?.outcome, 'unknown');
  await runtime.release(threadId);
  const reopened = f.make();
  await assert.rejects(reopened.turn(threadId, 'Continue', turnOptions()), {
    code: 'GENERATION_RECONCILIATION_REQUIRED',
  });
  await assert.rejects(
    reopened.resume({
      projectId: 'p',
      runId: 'R-owner',
      workspace: '/fixture',
      threadId,
      instructions: 'Continue',
    }),
    { code: 'GENERATION_RECONCILIATION_REQUIRED' },
  );
  assert.equal(f.requests.length, 2);
});

test('a pending generation checkpoint survives process replacement and cannot be replayed', async (t) => {
  let rejectPendingSave = true;
  const f = await fixture(t, {
    script: sequence(tool('read-1'), closing()),
    beforeSave(session) {
      if (session.generation?.outcome === 'completed' && rejectPendingSave) {
        rejectPendingSave = false;
        throw Error('Crash before terminal response checkpoint');
      }
      if (session.status === 'failed') throw Error('Crash prevents catch checkpoint');
    },
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Work', turnOptions()), {
    code: 'GENERATION_RECONCILIATION_REQUIRED',
  });
  assert.equal(f.executed, 0, 'A terminal reply must be checkpointed before its requested tool');
  assert.equal((await f.files.load(threadId))?.generation?.outcome, 'pending');
  await runtime.release(threadId);
  await assert.rejects(f.make().turn(threadId, 'Continue', turnOptions()), {
    code: 'GENERATION_RECONCILIATION_REQUIRED',
  });
  assert.equal(f.requests.length, 1);
});

test('an ambiguous tool outcome prevents closing, rollover and replay after reopening', async (t) => {
  const f = await fixture(t, {
    script: sequence(tool('edit-unknown', 'edit_file')),
    execute: async () => {
      throw Error('Process ended after an external effect without a result');
    },
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Work', turnOptions()), {
    code: 'ACTION_RECONCILIATION_REQUIRED',
  });
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.generation?.outcome, 'completed');
  assert.equal(saved.actions[0].status, 'unknown');
  assert.equal(saved.workSegments?.archives.length, 0);
  assert.equal(f.executed, 1);
  await runtime.release(threadId);
  await assert.rejects(f.make().turn(threadId, 'Continue', turnOptions()), {
    code: 'ACTION_RECONCILIATION_REQUIRED',
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.executed, 1);
});

test('failed budget observation stops before tool dispatch or a work-step transition', async (t) => {
  const f = await fixture(t, { script: sequence(tool('read-1')) });
  const runtime = f.make({
    budgets: {
      ...f.settings.budgets!,
      async recordUsage() {
        throw Error('Run usage transaction unavailable');
      },
    },
  });
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Work', turnOptions()), /usage transaction/);
  assert.equal(f.executed, 0);
  assert.equal(f.requests.length, 1);
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.generation?.outcome, 'completed');
  assert.equal(saved.generation?.response?.finish, 'tools');
  assert.equal(saved.actions.length, 0);
  assert.equal(saved.workSegments?.archives.length, 0);
});

test('failed atomic rollover persistence never activates a fresh window or dispatches its request', async (t) => {
  const f = await fixture(t, {
    script: sequence(tool('read-1'), closing()),
    beforeSave(session) {
      if (session.workSegments?.archives.length) throw Error('Archive checkpoint unavailable');
    },
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(
    runtime.turn(threadId, 'Work', turnOptions()),
    /Archive checkpoint unavailable/,
  );
  assert.equal(f.requests.length, 2);
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.workSegments?.archives.length, 0);
  assert.ok(saved.messages.some((message) => message.toolCallId === 'read-1'));
  assert.equal(f.events.filter((event) => event.type === 'segment.started').length, 1);
});

test('cancellation after service evidence forbids rollover and the next HTTP request', async (t) => {
  const abort = new AbortController();
  const f = await fixture(t, {
    script: sequence(tool('read-1'), closing()),
    inspect(index) {
      if (index === 2) abort.abort();
      return evidence();
    },
  });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Work', turnOptions(abort.signal)), {
    name: 'AbortError',
  });
  assert.equal(f.requests.length, 2);
  assert.equal((await f.files.load(threadId))?.workSegments?.archives.length, 0);
  assert.equal((await f.files.load(threadId))?.status, 'interrupted');
});

test('cancellation immediately after durable rollover retains its archive but prevents further generation', async (t) => {
  const abort = new AbortController();
  const f = await fixture(t, { script: sequence(tool('read-1'), closing()) });
  const runtime = f.make();
  runtime.subscribe((event) => {
    if (event.type === 'segment.completed' && event.reason === 'continue') abort.abort();
  });
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Work', turnOptions(abort.signal)), {
    name: 'AbortError',
  });
  assert.equal(f.requests.length, 2);
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.workSegments?.archives.length, 1);
  assert.equal(saved.workSegments?.active.index, 2);
  assert.equal(saved.status, 'interrupted');
});

test('scope validation rejects an unassigned edit or a reversion of a previous worker before any new window', async (t) => {
  for (const revert of [false, true]) {
    const previous = { path: 'other.ts', fingerprint: 'c'.repeat(64) };
    const f = await fixture(t, {
      scopeMode: 'strict',
      script: sequence(tool('read-1'), closing()),
      inspect(index) {
        return evidence(index === 1 ? (revert ? [previous] : []) : revert ? [] : [previous]);
      },
    });
    const runtime = f.make();
    const { threadId } = await f.start(runtime);
    await assert.rejects(runtime.turn(threadId, 'Work', turnOptions()), {
      code: 'SEGMENT_SCOPE_CHANGED',
    });
    assert.equal(f.requests.length, 2);
    assert.equal((await f.files.load(threadId))?.workSegments?.archives.length, 0);
  }
});

test('archived action IDs cannot be reused for another effect in the fresh window', async (t) => {
  const f = await fixture(t, { script: sequence(tool('same-call'), closing(), tool('same-call')) });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Work', turnOptions()), {
    code: 'DUPLICATE_TOOL_CALL',
  });
  assert.equal(f.executed, 1);
  assert.equal((await f.files.load(threadId))?.actions.length, 1);
  assert.equal((await f.files.load(threadId))?.workSegments?.archives.length, 1);
});

test('rotation cannot reset per-turn, lifetime-session, tool or aggregate generation ceilings', async (t) => {
  for (const ceiling of ['turn', 'session', 'tools', 'aggregate']) {
    const f = await fixture(t, {
      limits:
        ceiling === 'turn'
          ? { maxRequestsPerTurn: 3 }
          : ceiling === 'session'
            ? { maxSessionRequests: 3 }
            : ceiling === 'tools'
              ? { maxToolCallsPerTurn: 1 }
              : {},
      maxBudgetRequests: ceiling === 'aggregate' ? 3 : undefined,
      script: sequence(tool('read-1'), closing(), tool('read-2'), closing()),
    });
    const runtime = f.make();
    const { threadId } = await f.start(runtime);
    await assert.rejects(runtime.turn(threadId, 'Work', turnOptions()), {
      code:
        ceiling === 'tools'
          ? 'TOOL_BUDGET_EXHAUSTED'
          : ceiling === 'aggregate'
            ? 'RUN_BUDGET_EXHAUSTED'
            : 'MODEL_BUDGET_EXHAUSTED',
    });
    assert.equal(f.requests.length, 3);
    const saved = (await f.files.load(threadId))!;
    assert.equal(saved.requests, 3);
    assert.equal(saved.workSegments?.archives.length, 1);
    assert.equal(f.executed, ceiling === 'tools' ? 1 : 2);
  }
});

test('the segment lifetime ceiling stops another continuation without resetting requests or opening a new worker', async (t) => {
  const policy = { ...oneRoundPolicy, limits: { ...oneRoundPolicy.limits, maxSegments: 1 } };
  const f = await fixture(t, { policy, script: sequence(tool('read-1'), closing()) });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Work', turnOptions()), {
    code: 'WORK_SEGMENT_LIMIT',
  });
  assert.equal(f.requests.length, 2);
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.requests, 2);
  assert.equal(saved.workSegments?.active.index, 1);
  assert.equal(saved.workSegments?.archives.length, 0);
});

test('fresh runtime preserves archived history and saved limits and rejects changed or removed segment policy', async (t) => {
  const f = await fixture(t, { script: sequence(tool('read-1'), closing(), response()) });
  const runtime = f.make();
  const { threadId } = await f.start(runtime);
  await runtime.turn(threadId, 'Original criteria', turnOptions());
  await runtime.release(threadId);
  for (const segmentPolicy of [
    undefined,
    { ...oneRoundPolicy, limits: { ...oneRoundPolicy.limits, maxSegments: 5 } },
  ]) {
    const changed = f.make({ segmentPolicy });
    await assert.rejects(changed.turn(threadId, 'Continue', turnOptions()), {
      code: 'SEGMENT_POLICY_CHANGED',
    });
  }
  const reopened = f.make({
    provider: { ...f.settings.provider, complete: async () => response() },
  });
  await reopened.resume({
    projectId: 'p',
    runId: 'R-owner',
    threadId,
    workspace: '/fixture',
    instructions: 'Updated explicit continuation',
  });
  await reopened.turn(threadId, 'New explicit turn', turnOptions());
  const saved = (await f.files.load(threadId))!;
  assert.equal(saved.workSegments?.archives.length, 1);
  assert.equal(saved.workSegments?.anchor.instructions, 'Updated explicit continuation');
  assert.equal(saved.workSegments?.anchor.scopeRevision, 2);
  assert.equal(saved.requests, 4);
  assert.deepEqual(saved.limits, f.settings.limits);
  assert.deepEqual(saved.workSegments?.limits, oneRoundPolicy.limits);
});
