import { fixtureToolEffect } from './fixtures/tool-broker.ts';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertRunReconciled,
  isKnownTurnRejection,
  observedTurnFailure,
  recordTurnOutcome,
  reconciliationForError,
  reconciliationForPendingTurn,
  reconciliationIssue,
  retainRunReconciliation,
  UnresolvedEffectError,
} from '../core/run-reconciliation.ts';
import { DomainError, type ProjectRegistry } from '../core/ports.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import type { ManagedSession, ManagedSessionStore } from '../core/model-ports.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { parseDomainEvent, parseSnapshot } from '../protocol/schema.ts';
import { sampleRun } from './fixtures/sample-run.ts';
import { recordableRuntimeEvent, type RuntimeEvent } from '../core/runtime-events.ts';

const detectedAt = '2026-11-21T12:00:00.000Z';

test('owning-run reconciliation retains canonical and backend effect references without raw error data', () => {
  const error = new UnresolvedEffectError(
    'ACTION_RECONCILIATION_REQUIRED',
    { backendSessionId: 'native-session', runtimeId: 'worker', operationId: 'tool-17' },
    Error('SECRET raw native payload'),
  );
  const marker = reconciliationForError(error, { detectedAt, threadId: 'buro-session' })!;
  assert.deepEqual(marker, {
    version: 1,
    status: 'required',
    code: 'ACTION_RECONCILIATION_REQUIRED',
    detectedAt,
    threadId: 'buro-session',
    backendSessionId: 'native-session',
    runtimeId: 'worker',
    operationId: 'tool-17',
  });
  assert.doesNotMatch(JSON.stringify([marker, reconciliationIssue(marker)]), /SECRET/);
  assert.throws(() => assertRunReconciled({ reconciliation: marker }), {
    code: 'RUN_RECONCILIATION_REQUIRED',
  });
  assert.equal(retainRunReconciliation(marker, undefined), marker);
  assert.equal(
    retainRunReconciliation(marker, { ...marker, threadId: 'replacement-session' }),
    marker,
  );
});

test('unobserved turn survives a crash boundary while known failures do not become unknown by message', () => {
  const pending = {
    version: 1 as const,
    id: 'turn-operation',
    threadId: 'buro-session',
    runtimeId: 'local-worker',
    startedAt: detectedAt,
  };
  assert.deepEqual(reconciliationForPendingTurn(pending, detectedAt), {
    version: 1,
    status: 'required',
    code: 'SESSION_RECONCILIATION_REQUIRED',
    detectedAt,
    threadId: pending.threadId,
    runtimeId: pending.runtimeId,
    operationId: pending.id,
  });
  assert.throws(() => assertRunReconciled({ pendingTurn: pending }), {
    code: 'RUN_RECONCILIATION_REQUIRED',
  });
  for (const error of [Error('timed out'), new DOMException('Stopped', 'AbortError')]) {
    assert.equal(reconciliationForError(error, { detectedAt }), undefined);
    assert.equal(isKnownTurnRejection(error), false);
    assert.equal(isKnownTurnRejection(observedTurnFailure(error)), true);
  }
  assert.equal(isKnownTurnRejection(new DomainError('MODEL_RATE_LIMITED', 'HTTP 429')), true);
  assert.equal(
    isKnownTurnRejection(new DomainError('MODEL_UNAVAILABLE', 'HTTP 500/network')),
    false,
  );
});

test('transport uncertainty overrides a familiar rejection code and cannot be cleared by generic observation', () => {
  const error = new DomainError('MODEL_REQUEST_REJECTED', 'The stream failed after dispatch.');
  assert.equal(isKnownTurnRejection(error), true);
  recordTurnOutcome(error, 'unknown');
  assert.equal(isKnownTurnRejection(error), false);
  observedTurnFailure(error);
  recordTurnOutcome(error, 'rejected');
  assert.equal(isKnownTurnRejection(error), false);
  for (const outcome of ['not-dispatched', 'rejected'] as const) {
    const unavailable = recordTurnOutcome(
      new DomainError('MODEL_UNAVAILABLE', 'Observed'),
      outcome,
    );
    assert.equal(isKnownTurnRejection(unavailable), true);
  }
  assert.equal(isKnownTurnRejection({ code: 'MODEL_RATE_LIMITED', outcome: 'rejected' }), false);
});

test('reconciliation marker and issue survive store restart and both public transport projections', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'run-reconciliation-'));
  const run = sampleRun();
  run.status = 'failed';
  run.reconciliation = reconciliationForError(
    new DomainError('ACTION_RECONCILIATION_REQUIRED', 'Opaque'),
    { detectedAt, threadId: 'worker-old', runtimeId: 'local' },
  );
  run.issue = reconciliationIssue(run.reconciliation!);
  let store = await FileProjectStore.open({
    directory,
    project: { id: 'p', name: 'Project', root: directory },
    runs: [run],
  });
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const snapshot = parseSnapshot(store.snapshot());
  assert.deepEqual(snapshot.runs[0].reconciliation, run.reconciliation);
  const parsed = parseDomainEvent({
    version: 1,
    id: 'e',
    projectId: 'p',
    seq: 1,
    at: detectedAt,
    change: {
      type: 'run.changed',
      run,
      goal: {
        id: run.goalId,
        projectId: 'p',
        title: 'Goal',
        body: 'Goal',
        criteria: '',
        status: 'failed',
        createdAt: detectedAt,
      },
    },
  });
  assert.equal(parsed.change.type, 'run.changed');
  await store.close();
  store = await FileProjectStore.open({ directory, project: snapshot.project });
  assert.deepEqual(store.snapshot().runs[0].reconciliation, run.reconciliation);
  assert.throws(() => assertRunReconciled(store.snapshot().runs[0]), {
    code: 'RUN_RECONCILIATION_REQUIRED',
  });
  assert.throws(() => parseSnapshot({ ...snapshot, runs: [{ ...run, status: 'completed' }] }));
  assert.throws(() =>
    parseSnapshot({ ...snapshot, runs: [{ ...run, reconciliation: undefined }] }),
  );
});

function managedFixture(
  complete: ModelProvider['complete'],
  options: { beforeSave?: (session: ManagedSession) => void; separateTurn?: boolean } = {},
) {
  const records = new Map<string, ManagedSession>();
  const sessions: ManagedSessionStore = {
    async load(id) {
      return records.has(id) ? structuredClone(records.get(id)!) : undefined;
    },
    async save(session) {
      options.beforeSave?.(session);
      records.set(session.id, structuredClone(session));
    },
  };
  let id = 0;
  const runtime = new ManagedAgentRuntime({
    loopRunner: new PiAgentLoopRunner(),
    id: 'local',
    model: 'fixture',
    provider: {
      id: 'fake',
      revision: '1',
      local: true,
      complete,
      ...(options.separateTurn ? { structuredToolMode: 'separate-turn' as const } : {}),
    },
    sessions,
    projects: {
      get: () => ({ snapshot: () => ({ project: { id: 'p', root: '/workspace' }, runs: [] }) }),
    } as unknown as ProjectRegistry,
    tools: {
      revision: 'fixture-tools-v1',
      effect: fixtureToolEffect,
      definitions: () => [],
      async execute() {
        throw Error('Unexpected tool');
      },
    },
    idGenerator: () => String(++id),
    limits: {
      contextTokens: 32768,
      maxOutputTokens: 512,
      maxRequestsPerTurn: 3,
      maxToolCallsPerTurn: 3,
      maxSessionRequests: 10,
    },
  });
  return { runtime, records };
}

test('first ambiguous request is typed and durable for nonsegmented coordination and critic sessions', async (t) => {
  for (const purpose of ['planning', 'review'] as const) {
    let requests = 0;
    const f = managedFixture(async () => {
      requests++;
      throw Error('Lost response');
    });
    t.after(() => f.runtime.dispose());
    const { threadId } = await f.runtime.start({
      projectId: 'p',
      instructions: 'Fixture',
      purpose,
      readOnly: purpose === 'review',
    });
    await assert.rejects(
      f.runtime.turn(threadId, 'Work', {
        schema: {},
        signal: new AbortController().signal,
        timeoutMs: 1000,
      }),
      (error: unknown) =>
        error instanceof UnresolvedEffectError &&
        error.code === 'GENERATION_RECONCILIATION_REQUIRED' &&
        error.reference.backendSessionId === threadId,
    );
    assert.equal(f.records.get(threadId)?.generation?.outcome, 'unknown');
    await assert.rejects(
      f.runtime.turn(threadId, 'Do not replay', {
        schema: {},
        signal: new AbortController().signal,
        timeoutMs: 1000,
      }),
      { code: 'GENERATION_RECONCILIATION_REQUIRED' },
    );
    assert.equal(requests, 1);
  }
});

test('cancellation before the current generation dispatch settles its intent, including later rounds', async (t) => {
  for (const targetRequest of [1, 2]) {
    const controller = new AbortController();
    let calls = 0;
    const f = managedFixture(
      async () => {
        calls++;
        return { model: 'fixture', message: { role: 'assistant', content: '{}' }, finish: 'stop' };
      },
      {
        separateTurn: targetRequest === 2,
        beforeSave(session) {
          if (session.requests === targetRequest && session.generation?.outcome === 'pending')
            controller.abort();
        },
      },
    );
    t.after(() => f.runtime.dispose());
    const { threadId } = await f.runtime.start({ projectId: 'p', instructions: 'Fixture' });
    await assert.rejects(
      f.runtime.turn(threadId, 'Work', { schema: {}, signal: controller.signal, timeoutMs: 1000 }),
      (error: unknown) =>
        error instanceof DOMException && error.name === 'AbortError' && isKnownTurnRejection(error),
    );
    assert.equal(calls, targetRequest - 1);
    assert.equal(f.records.get(threadId)?.generation?.outcome, 'completed');
    assert.equal(f.records.get(threadId)?.generation?.rejectionCode, 'TURN_NOT_DISPATCHED');
  }
});

test('an observed model rejection settles the request and permits a later deliberate attempt', async (t) => {
  let requests = 0;
  const f = managedFixture(async () => {
    requests++;
    if (requests === 1) throw new DomainError('MODEL_RATE_LIMITED', 'HTTP 429');
    return { model: 'fixture', message: { role: 'assistant', content: '{}' }, finish: 'stop' };
  });
  t.after(() => f.runtime.dispose());
  const { threadId } = await f.runtime.start({ projectId: 'p', instructions: 'Fixture' });
  const options = { schema: {}, signal: new AbortController().signal, timeoutMs: 1000 };
  await assert.rejects(f.runtime.turn(threadId, 'Work', options), { code: 'MODEL_RATE_LIMITED' });
  assert.equal(f.records.get(threadId)?.generation?.outcome, 'completed');
  assert.equal((await f.runtime.turn(threadId, 'Try after known rejection', options)).text, '{}');
  assert.equal(requests, 2);
});

test('an explicitly unknown streamed rejection retains the generation boundary and never permits replay', async (t) => {
  let requests = 0;
  const f = managedFixture(async () => {
    requests++;
    throw recordTurnOutcome(new DomainError('MODEL_REQUEST_REJECTED', 'Partial stream'), 'unknown');
  });
  t.after(() => f.runtime.dispose());
  const { threadId } = await f.runtime.start({ projectId: 'p', instructions: 'Fixture' });
  const options = { schema: {}, signal: new AbortController().signal, timeoutMs: 1000 };
  await assert.rejects(f.runtime.turn(threadId, 'Work', options), {
    code: 'GENERATION_RECONCILIATION_REQUIRED',
  });
  assert.equal(f.records.get(threadId)?.generation?.outcome, 'unknown');
  await assert.rejects(f.runtime.turn(threadId, 'Do not replay', options), {
    code: 'GENERATION_RECONCILIATION_REQUIRED',
  });
  assert.equal(requests, 1);
});

test('confirmed model preflight failures settle the generation without blocking a later explicit attempt', async (t) => {
  let requests = 0;
  const f = managedFixture(async () => {
    requests++;
    if (requests === 1)
      throw recordTurnOutcome(
        new DomainError('MODEL_UNSUPPORTED', 'No chat was dispatched'),
        'not-dispatched',
      );
    return { model: 'fixture', message: { role: 'assistant', content: '{}' }, finish: 'stop' };
  });
  t.after(() => f.runtime.dispose());
  const { threadId } = await f.runtime.start({ projectId: 'p', instructions: 'Fixture' });
  const options = { schema: {}, signal: new AbortController().signal, timeoutMs: 1000 };
  await assert.rejects(f.runtime.turn(threadId, 'Work', options), { code: 'MODEL_UNSUPPORTED' });
  assert.equal(f.records.get(threadId)?.generation?.outcome, 'completed');
  assert.equal(f.records.get(threadId)?.generation?.rejectionCode, 'MODEL_UNSUPPORTED');
  assert.equal(
    (await f.runtime.turn(threadId, 'Try the configured model again', options)).text,
    '{}',
  );
  assert.equal(requests, 2);
});

test('streamed text remains transient until the complete response is durably observed', async (t) => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const delta = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const f = managedFixture(async (input) => {
    input.onEvent?.({ type: 'text.delta', text: '{"ok":' });
    await wait;
    input.onEvent?.({ type: 'text.delta', text: 'true}' });
    return {
      model: 'fixture',
      message: { role: 'assistant', content: '{"ok":true}' },
      finish: 'stop',
    };
  });
  t.after(() => f.runtime.dispose());
  const events: RuntimeEvent[] = [];
  f.runtime.subscribe((event) => {
    events.push(event);
    if (event.type === 'message.delta') observed();
  });
  const { threadId } = await f.runtime.start({ projectId: 'p', instructions: 'Fixture' });
  const turn = f.runtime.turn(threadId, 'Work', {
    schema: {},
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  try {
    await delta;
    assert.equal(f.records.get(threadId)?.generation?.outcome, 'pending');
    assert.equal(f.records.get(threadId)?.generation?.response, undefined);
    assert.equal(
      f.records.get(threadId)?.messages.filter((message) => message.role === 'assistant').length,
      0,
    );
    assert.equal(
      events.some((event) => event.type === 'message.completed'),
      false,
    );
    const first = events.find((event) => event.type === 'message.delta')!;
    assert.equal(first.type, 'message.delta');
    if (first.type === 'message.delta') assert.equal(first.requestId, `${first.turnId}:0`);
    assert.equal(recordableRuntimeEvent({ ...first, runId: 'R-fixture' }), false);
  } finally {
    release();
  }
  assert.equal((await turn).text, '{"ok":true}');
  assert.equal(f.records.get(threadId)?.generation?.response?.message.content, '{"ok":true}');
  assert.deepEqual(
    events.filter((event) => event.type === 'message.delta').map((event) => event.text),
    ['{"ok":', 'true}'],
  );
  assert.equal(events.filter((event) => event.type === 'message.completed').length, 1);
});
