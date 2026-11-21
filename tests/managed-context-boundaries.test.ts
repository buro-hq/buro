import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import {
  afterManagedResponse,
  prepareManagedCodingRequest,
} from '../core/managed-coding-context.ts';
import { generateManagedBatch, dispatchManagedAction } from '../core/managed-host-effects.ts';
import {
  prepareManagedSession,
  assertManagedReconciled,
} from '../core/managed-session-authority.ts';
import type { ManagedRuntimeOptions } from '../core/managed-runtime-options.ts';
import type { ManagedSession } from '../core/model-ports.ts';
import type {
  ManagedTurnHost,
  ManagedTurnState,
  ManagedModelCompletion,
} from '../core/managed-turn-state.ts';
import type { ProjectRegistry, RuntimeEvent } from '../core/ports.ts';

const limits = {
  contextTokens: 16384,
  maxOutputTokens: 512,
  maxRequestsPerTurn: 4,
  maxToolCallsPerTurn: 4,
  maxSessionRequests: 16,
};
const projects = (root: string) =>
  ({
    get: () => ({ snapshot: () => ({ project: { id: 'p', root }, runs: [] }) }),
  }) as unknown as ProjectRegistry;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function completion(withTools = false): ManagedModelCompletion {
  return {
    model: 'observed-model',
    finish: withTools ? 'tools' : 'stop',
    message: {
      role: 'assistant',
      content: '{"accepted":false}',
      ...(withTools
        ? {
            toolCalls: [0, 1].map((index) => ({
              id: 'call-' + index,
              name: 'read_file',
              arguments: { path: 'src/value-' + index + '.ts' },
            })),
          }
        : {}),
    },
  };
}
async function contextFixture(t: any, response: ManagedModelCompletion) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'context-boundary-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessions = new FileManagedSessions(directory);
  let providerCalls = 0,
    toolCalls = 0;
  const options: ManagedRuntimeOptions = {
    loopRunner: new PiAgentLoopRunner(),
    id: 'managed-fixture',
    model: 'fixture-model',
    projects: projects(directory),
    sessions,
    limits,
    idGenerator: () => crypto.randomUUID(),
    provider: {
      id: 'provider',
      revision: 'fixture-v1',
      local: true,
      async complete() {
        providerCalls++;
        return response;
      },
    },
    tools: {
      definitions: () => [
        { name: 'read_file', description: 'Read fixture input', parameters: { type: 'object' } },
      ],
      async execute() {
        toolCalls++;
        return { content: 'Observed source bytes.' };
      },
    },
  };
  const session = prepareManagedSession(
    options,
    { projectId: 'p', instructions: 'Retain the complete assignment.' },
    'M-fixture',
  );
  session.status = 'running';
  session.messages.push({ role: 'user', content: 'Inspect source and report actual evidence.' });
  session.turnAuthorities = [
    { turnId: 'T-fixture', toolPolicy: 'normal', startedAtRequest: 0, scopeRevision: 1 },
  ];
  await sessions.save(session);
  const state: ManagedTurnState = {
    session,
    threadId: session.id,
    turnId: 'T-fixture',
    schema: {},
    noTools: false,
    separate: false,
    finalizing: false,
    closing: false,
    segmentCompleteEmitted: false,
    responseSettled: false,
    effectDispatched: false,
    generationDispatched: false,
    dispatchedActions: new Set(),
    round: 0,
    calls: 0,
  };
  const controller = new AbortController();
  const host: ManagedTurnHost = {
    runtimeId: options.id,
    options,
    signal: controller.signal,
    budgetPhase: 'work',
    check: () => controller.signal.throwIfAborted(),
    touch() {},
    emit() {},
    async commit(next) {
      await sessions.save(next);
      state.session = next;
    },
    toolDefinitions: (scope) => options.tools.definitions(scope),
    assertReconciled: assertManagedReconciled,
  };
  return {
    directory,
    sessions,
    state,
    host,
    providerCalls: () => providerCalls,
    toolCalls: () => toolCalls,
  };
}

test('context cannot complete or advance before the generated batch and every tool receipt settle', async (t) => {
  const f = await contextFixture(t, completion(true));
  const beforeGeneration = await f.sessions.load(f.state.session.id);
  await assert.rejects(afterManagedResponse(f.state, f.host), { code: 'INCOMPLETE_ACTION_BATCH' });
  assert.deepEqual(await f.sessions.load(f.state.session.id), beforeGeneration);
  const batch = await generateManagedBatch(
    f.state,
    f.host,
    await prepareManagedCodingRequest(f.state, f.host),
  );
  const pending = await f.sessions.load(f.state.session.id);
  assert.equal(pending!.generation!.outcome, 'completed');
  assert.equal(pending!.actions.length, 2);
  assert.equal(
    pending!.actions.every((action) => action.status === 'pending'),
    true,
  );
  await assert.rejects(afterManagedResponse(f.state, f.host), { code: 'INCOMPLETE_ACTION_BATCH' });
  assert.deepEqual(await f.sessions.load(f.state.session.id), pending);
  await dispatchManagedAction(f.state, f.host, batch.actionIds[0]);
  const partial = await f.sessions.load(f.state.session.id);
  await assert.rejects(afterManagedResponse(f.state, f.host), { code: 'INCOMPLETE_ACTION_BATCH' });
  assert.deepEqual(await f.sessions.load(f.state.session.id), partial);
  f.state.activeBatch!.inFlight = batch.actionIds[1];
  await assert.rejects(afterManagedResponse(f.state, f.host), { code: 'INCOMPLETE_ACTION_BATCH' });
  delete f.state.activeBatch!.inFlight;
  await dispatchManagedAction(f.state, f.host, batch.actionIds[1]);
  assert.deepEqual(await afterManagedResponse(f.state, f.host), { kind: 'continue' });
  const reopened = await new FileManagedSessions(f.directory).load(f.state.session.id);
  assert.equal(
    reopened!.actions.every((action) => action.status === 'completed' && !!action.result),
    true,
  );
  assert.equal(f.providerCalls(), 1);
  assert.equal(f.toolCalls(), 2);
});

test('mutating detached generation views cannot fabricate completion or replace the canonical final answer', async (t) => {
  const observed = completion(true);
  const f = await contextFixture(t, observed);
  const batch = await generateManagedBatch(
    f.state,
    f.host,
    await prepareManagedCodingRequest(f.state, f.host),
  );
  const actionIds = [...batch.actionIds];
  observed.message.toolCalls = [];
  observed.message.content = 'Provider changed its old reference.';
  batch.response.message.toolCalls = [];
  batch.response.message.content = 'Scheduler fabricated a completion.';
  batch.actionIds.length = 0;
  await assert.rejects(afterManagedResponse(f.state, f.host), { code: 'INCOMPLETE_ACTION_BATCH' });
  for (const id of actionIds) await dispatchManagedAction(f.state, f.host, id);
  assert.deepEqual(await afterManagedResponse(f.state, f.host), { kind: 'continue' });
  assert.equal(f.state.session.generation!.response!.message.toolCalls!.length, 2);
  assert.equal(f.state.session.generation!.response!.message.content, '{"accepted":false}');

  const final = await contextFixture(t, completion());
  const detached = await generateManagedBatch(
    final.state,
    final.host,
    await prepareManagedCodingRequest(final.state, final.host),
  );
  detached.response.message.content = '{"accepted":true}';
  detached.response.finish = 'failed';
  detached.actionIds.push('forged-action');
  const decision = await afterManagedResponse(final.state, final.host);
  assert.deepEqual(decision, {
    kind: 'complete',
    result: {
      turnId: final.state.turnId,
      text: '{"accepted":false}',
      model: 'observed-model',
    },
  });
  const durable = await new FileManagedSessions(final.directory).load(final.state.session.id);
  assert.equal(durable!.generation!.response!.message.content, '{"accepted":false}');
  assert.deepEqual(durable!.actions, []);
});

test(
  'cancellation while a detached context replacement is committing survives adoption and the final checkpoint',
  { timeout: 5000 },
  async (t) => {
    const committing = deferred(),
      release = deferred();
    const records = new Map<string, ManagedSession>();
    let held = false,
      providerCalls = 0,
      turnId = '';
    const runtime = new ManagedAgentRuntime({
      loopRunner: new PiAgentLoopRunner(),
      id: 'managed-fixture',
      model: 'fixture-model',
      limits,
      projects: projects('/fixture'),
      idGenerator: () => crypto.randomUUID(),
      sessions: {
        async load(id) {
          const saved = records.get(id);
          return saved ? structuredClone(saved) : undefined;
        },
        async save(next) {
          if (!held && next.intermediateNotes?.length && !next.cancelRequested) {
            held = true;
            committing.resolve();
            await release.promise;
          }
          records.set(next.id, structuredClone(next));
        },
      },
      provider: {
        id: 'provider',
        revision: 'v1',
        local: true,
        structuredToolMode: 'separate-turn',
        async complete() {
          providerCalls++;
          return completion();
        },
      },
      tools: {
        definitions: () => [],
        async execute() {
          throw Error('No tool dispatch.');
        },
      },
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => {
      events.push(event);
      if (event.type === 'turn.started') turnId = event.turnId;
    });
    t.after(async () => {
      release.resolve();
      await runtime.dispose();
    });
    const started = await runtime.start({ projectId: 'p', instructions: 'Fixture only.' });
    const turn = runtime.turn(started.threadId, 'Report JSON.', {
      schema: {},
      signal: new AbortController().signal,
      timeoutMs: 3000,
    });
    const stopped = assert.rejects(
      turn,
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
    try {
      await committing.promise;
      await runtime.interrupt(started.threadId, turnId);
      assert.equal(records.get(started.threadId)!.cancelRequested, true);
    } finally {
      release.resolve();
    }
    await stopped;
    const saved = records.get(started.threadId)!;
    assert.equal(
      saved.cancelRequested,
      true,
      'Adopting an earlier clone cannot erase an observed cancellation.',
    );
    assert.equal(saved.status, 'interrupted');
    assert.equal(saved.generation!.outcome, 'completed');
    assert.equal(providerCalls, 1, 'No final generation may follow the cancelled context commit.');
    assert.equal(
      events.some((event) => event.type === 'message.completed'),
      false,
    );
    assert.deepEqual(saved.actions, []);
  },
);
