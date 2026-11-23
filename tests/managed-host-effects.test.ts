import { fixtureToolEffect } from './fixtures/tool-broker.ts';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { assertManagedReconciled } from '../core/managed-session-authority.ts';
import {
  generateManagedBatch,
  dispatchManagedAction,
  failManagedTurn,
} from '../core/managed-host-effects.ts';
import { DomainError, type ProjectRegistry } from '../core/ports.ts';
import {
  isKnownTurnRejection,
  recordTurnOutcome,
  UnresolvedEffectError,
} from '../core/run-reconciliation.ts';
import type { ManagedSession } from '../core/model-ports.ts';
import type {
  ManagedModelCompletion,
  ManagedPreparedRequest,
  ManagedTurnHost,
  ManagedTurnState,
  ManagedEventBody,
} from '../core/managed-turn-state.ts';

const limits = {
  contextTokens: 16384,
  maxOutputTokens: 512,
  maxRequestsPerTurn: 4,
  maxToolCallsPerTurn: 4,
  maxSessionRequests: 20,
};
function response(names = ['edit_file', 'edit_file']): ManagedModelCompletion {
  return {
    model: 'small-model',
    finish: names.length ? 'tools' : 'stop',
    usage: { inputTokens: 12, outputTokens: 8 },
    message: {
      role: 'assistant',
      content: 'Observed proposal',
      continuation: { reasoning: 'PRIVATE_HOST_EFFECT_REASONING' },
      ...(names.length
        ? {
            toolCalls: names.map((name, index) => ({
              id: 'call-' + index,
              name,
              arguments: { path: 'src/value.ts', value: index },
            })),
          }
        : {}),
    },
  };
}
async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'managed-host-effects-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessions = new FileManagedSessions(directory);
  const scope: ManagedSession['scope'] = {
    projectId: 'p',
    runId: 'R-owner',
    sessionId: 'M-fixture',
    workspace: directory,
    readOnly: false,
    writeScope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
    materials: [],
    commands: [],
  };
  const session: ManagedSession = {
    version: 1,
    id: 'M-fixture',
    runtimeId: 'host-fixture',
    limits,
    providerId: 'provider',
    providerRevision: 'v1',
    toolRevision: 'fixture-tools-v1',
    requestedModel: 'small-model',
    purpose: 'coordination',
    scope,
    scopeRevisions: [
      { revision: 1, scope: structuredClone(scope), instructions: 'Preserve the complete goal.' },
    ],
    turnAuthorities: [
      { turnId: 'T-fixture', toolPolicy: 'normal', startedAtRequest: 0, scopeRevision: 1 },
    ],
    messages: [
      { role: 'system', content: 'Preserve the complete goal.' },
      { role: 'user', content: 'Do the assigned work.' },
    ],
    status: 'running',
    requests: 0,
    usage: { requestsWithUsage: 0, inputTokens: 0, outputTokens: 0 },
    actions: [],
  };
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
  let providerCalls = 0,
    effects = 0;
  const events: ManagedEventBody[] = [];
  const controller = new AbortController();
  const host: ManagedTurnHost = {
    runtimeId: session.runtimeId,
    signal: controller.signal,
    budgetPhase: 'work',
    options: {
      id: session.runtimeId,
      model: session.requestedModel,
      limits,
      sessions,
      projects: {
        get: () => ({ snapshot: () => ({ project: { id: 'p', root: directory }, runs: [] }) }),
      } as unknown as ProjectRegistry,
      idGenerator: () => 'fixture',
      provider: {
        id: 'provider',
        revision: 'v1',
        local: true,
        async complete() {
          providerCalls++;
          return response();
        },
      },
      tools: {
        revision: 'fixture-tools-v1',
        effect: fixtureToolEffect,
        definitions: () => [
          { name: 'edit_file', description: 'Edit public source', parameters: { type: 'object' } },
        ],
        async execute() {
          effects++;
          await fs.appendFile(path.join(directory, 'effect-log'), 'effect\n');
          return { content: 'saved' };
        },
      },
    },
    check: () => controller.signal.throwIfAborted(),
    touch() {},
    emit: (event) => {
      events.push(structuredClone(event));
    },
    async commit(next) {
      await host.options.sessions.save(next);
      state.session = next;
    },
    toolDefinitions: () => host.options.tools.definitions(state.session.scope),
    assertReconciled: assertManagedReconciled,
  };
  const request: ManagedPreparedRequest = {
    messages: state.session.messages,
    definitions: host.toolDefinitions(scope),
    schema: {},
    budget: { maxOutputTokens: 512, reason: 'configured-limit' },
  };
  return {
    directory,
    sessions,
    state,
    host,
    request,
    events,
    providerCalls: () => providerCalls,
    effects: () => effects,
  };
}

test('an unadvertised second tool rejects the entire batch with durable feedback and no action intent', async (t) => {
  const f = await fixture(t);
  f.host.options.provider.complete = async () => response(['edit_file', 'hidden_command']);
  const batch = await generateManagedBatch(f.state, f.host, f.request);
  const durable = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
  assert.equal(durable.generation?.outcome, 'completed');
  assert.equal(durable.generation?.response?.message.toolCalls?.length, 2);
  assert.deepEqual(durable.actions, []);
  assert.equal(durable.rejectedToolBatches?.length, 1);
  assert.equal(durable.messages.at(-1)?.toolName, 'hidden_command');
  assert.equal(durable.messages.filter((message) => message.role === 'tool').length, 2);
  assert.equal(JSON.parse(durable.messages.at(-1)!.content).error, 'UNADVERTISED_TOOL');
  assert.equal(f.state.activeBatch?.disposition, 'tools-rejected');
  assert.deepEqual(batch.actionIds, []);
  assert.equal(f.effects(), 0);
  assertManagedReconciled(durable);
  assert.equal(
    f.events.some((event) => event.type === 'tool.started'),
    false,
  );
});

test('provider, scheduler and broker mutations cannot change canonical journaled calls or receipts', async (t) => {
  const f = await fixture(t),
    observed = response();
  f.host.options.provider.complete = async (packet) => {
    const pending = (await f.sessions.load(f.state.session.id))!;
    assert.equal(pending.generation?.outcome, 'pending');
    assert.deepEqual(pending.actions, []);
    packet.messages[0].content = 'Provider changed its request projection';
    packet.tools[0].name = 'hidden_command';
    return observed;
  };
  const batch = await generateManagedBatch(f.state, f.host, f.request);
  observed.message.content = 'Provider rewrote its response';
  (observed.message.toolCalls![0].arguments as { path: string }).path = 'provider-secret';
  batch.response.message.content = 'Scheduler rewrote the view';
  (batch.response.message.toolCalls![0].arguments as { path: string }).path = 'scheduler-secret';
  assert.equal(f.request.definitions[0].name, 'edit_file');
  assert.equal(f.state.session.messages[0].content, 'Preserve the complete goal.');
  const result = { content: 'saved' };
  let executed = 0;
  f.host.options.tools.execute = async (call, scope) => {
    executed++;
    const durable = (await f.sessions.load(f.state.session.id))!;
    assert.equal(durable.actions.length, 2, 'All intents must exist before the first effect');
    assert.equal(durable.generation?.outcome, 'completed');
    assert.equal((call.arguments as { path: string }).path, 'src/value.ts');
    (call.arguments as { path: string }).path = 'broker-mutated';
    scope.workspace = '/broker-mutated-workspace';
    scope.writeScope.protectedPaths.length = 0;
    return result;
  };
  await dispatchManagedAction(f.state, f.host, batch.actionIds[0]);
  result.content = 'Broker changed its returned object';
  const durable = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
  assert.equal(executed, 1);
  assert.equal((durable.actions[0].call.arguments as { path: string }).path, 'src/value.ts');
  assert.equal(
    (durable.generation!.response!.message.toolCalls![0].arguments as { path: string }).path,
    'src/value.ts',
  );
  assert.equal(
    durable.messages.find((message) => message.role === 'assistant')?.content,
    'Observed proposal',
  );
  assert.equal(durable.actions[0].result?.content, 'saved');
  assert.equal(durable.scope.workspace, f.directory);
  assert.deepEqual(durable.scope.writeScope.protectedPaths, ['checks/']);
  assert.deepEqual(f.state.session.scope.writeScope.protectedPaths, ['checks/']);
  assert.doesNotMatch(
    JSON.stringify(f.events),
    /PRIVATE_HOST_EFFECT_REASONING|provider-secret|scheduler-secret/,
  );
});

test('batch order and in-flight receipt persistence prevent parallel tools and premature provider requests', async (t) => {
  const f = await fixture(t);
  const complete = f.host.options.provider.complete;
  f.host.options.provider.complete = async (packet) => {
    const result = await complete(packet);
    for (const call of result.message.toolCalls || []) call.id += ':round-' + f.state.round;
    return result;
  };
  const batch = await generateManagedBatch(f.state, f.host, f.request);
  const [first, second] = batch.actionIds;
  batch.actionIds.reverse();
  await assert.rejects(dispatchManagedAction(f.state, f.host, batch.actionIds[0]), {
    code: 'INVALID_TOOL_ACTION',
  });
  assert.equal(f.effects(), 0, 'Returned ID arrays cannot rewrite canonical dispatch order');
  let enterReceipt!: () => void, allowReceipt!: () => void;
  const entered = new Promise<void>((resolve) => {
    enterReceipt = resolve;
  });
  const released = new Promise<void>((resolve) => {
    allowReceipt = resolve;
  });
  f.host.options.sessions = {
    load: (id) => f.sessions.load(id),
    save: async (next) => {
      if (
        next.actions.find((action) => action.id === first)?.status === 'completed' &&
        f.state.activeBatch?.nextAction === 0
      ) {
        enterReceipt();
        await released;
      }
      await f.sessions.save(next);
    },
  };
  const dispatch = dispatchManagedAction(f.state, f.host, first);
  await entered;
  assert.equal(f.effects(), 1);
  assert.equal(f.state.activeBatch?.inFlight, first);
  assert.equal(f.state.activeBatch?.nextAction, 0);
  await assert.rejects(dispatchManagedAction(f.state, f.host, second), {
    code: 'INVALID_TOOL_ACTION',
  });
  await assert.rejects(generateManagedBatch(f.state, f.host, f.request), {
    code: 'INCOMPLETE_ACTION_BATCH',
  });
  assert.equal(f.providerCalls(), 1);
  assert.equal(f.effects(), 1);
  assert.deepEqual(
    (await f.sessions.load(f.state.session.id))!.actions.map((action) => action.status),
    ['pending', 'pending'],
  );
  allowReceipt();
  await dispatch;
  assert.equal(f.state.activeBatch?.nextAction, 1);
  assert.equal(f.state.activeBatch?.inFlight, undefined);
  await dispatchManagedAction(f.state, f.host, second);
  assert.equal(f.state.activeBatch?.nextAction, 2);
  await assert.rejects(generateManagedBatch(f.state, f.host, f.request), {
    code: 'INVALID_GENERATION_REQUEST',
  });
  assert.equal(f.providerCalls(), 1);
  f.state.round++;
  await generateManagedBatch(f.state, f.host, f.request);
  assert.equal(f.providerCalls(), 2);
  assert.equal(f.effects(), 2);
});

for (const boundary of ['generation', 'action'] as const)
  test(`failure of a new helper turn cannot settle a foreign pending ${boundary} or mark its error safe`, async (t) => {
    const f = await fixture(t),
      failure = Error('New turn preflight failed before dispatch');
    f.state.session.requests = 1;
    f.state.session.generation = {
      requestId: 'T-fixture:0',
      outcome: boundary === 'generation' ? 'pending' : 'completed',
    };
    if (boundary === 'action') {
      const observed = response(['edit_file']);
      f.state.session.generation.response = structuredClone(observed);
      f.state.session.messages.push(structuredClone(observed.message));
      f.state.session.actions.push({
        id: 'A-prior',
        turnId: 'T-fixture',
        call: structuredClone(observed.message.toolCalls![0]),
        status: 'pending',
      });
    }
    await f.sessions.save(f.state.session);
    const before = (await f.sessions.load(f.state.session.id))!;
    f.state.turnId = 'T-new-turn';
    await assert.rejects(failManagedTurn(f.state, f.host, failure), {
      code:
        boundary === 'generation'
          ? 'GENERATION_RECONCILIATION_REQUIRED'
          : 'ACTION_RECONCILIATION_REQUIRED',
      cause: failure,
    });
    const reopened = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
    assert.deepEqual(reopened.generation, before.generation);
    assert.deepEqual(reopened.actions, before.actions);
    assert.throws(() => assertManagedReconciled(reopened), {
      code:
        boundary === 'generation'
          ? 'GENERATION_RECONCILIATION_REQUIRED'
          : 'ACTION_RECONCILIATION_REQUIRED',
    });
    assert.equal(isKnownTurnRejection(failure), false);
    assert.equal(f.providerCalls(), 0);
    assert.equal(f.effects(), 0);
  });

test('confirmed undispatched own intent does not fabricate unknown effects when storage is unavailable', async (t) => {
  const f = await fixture(t),
    failure = Error('Preflight failed before provider dispatch');
  f.state.session.requests = 1;
  f.state.session.generation = {
    requestId: `${f.state.turnId}:${f.state.round}`,
    outcome: 'pending',
  };
  await f.sessions.save(f.state.session);
  let reads = 0;
  f.host.options.sessions = {
    save: async () => {
      throw Error('Storage offline');
    },
    load: async () => {
      reads++;
      throw Error('Storage offline');
    },
  };
  await assert.rejects(failManagedTurn(f.state, f.host, failure), (error) => error === failure);
  assert.equal(isKnownTurnRejection(failure), true);
  assert.equal(reads, 0);
  assert.equal(f.providerCalls(), 0);
  assert.equal(f.effects(), 0);
});

test('forged, repeated, foreign-turn and already-dispatched action IDs never reach the broker', async (t) => {
  const f = await fixture(t);
  const batch = await generateManagedBatch(f.state, f.host, f.request);
  await assert.rejects(dispatchManagedAction(f.state, f.host, 'forged-id'), {
    code: 'INVALID_TOOL_ACTION',
  });
  f.state.session.actions.push({
    id: 'foreign-action',
    turnId: 'another-turn',
    call: { id: 'foreign-call', name: 'edit_file', arguments: {} },
    status: 'pending',
  });
  await assert.rejects(dispatchManagedAction(f.state, f.host, 'foreign-action'), {
    code: 'INVALID_TOOL_ACTION',
  });
  f.state.session.actions.pop();
  assert.equal(f.effects(), 0);
  await dispatchManagedAction(f.state, f.host, batch.actionIds[0]);
  await assert.rejects(dispatchManagedAction(f.state, f.host, batch.actionIds[0]), {
    code: 'INVALID_TOOL_ACTION',
  });
  f.state.dispatchedActions.add(batch.actionIds[1]);
  await assert.rejects(dispatchManagedAction(f.state, f.host, batch.actionIds[1]), {
    code: 'INVALID_TOOL_ACTION',
  });
  assert.equal(f.effects(), 1);
});

test('a response survives usage settlement failure without tools or fabricated unknown generation', async (t) => {
  const f = await fixture(t),
    rejection = new DomainError('INVALID_RUN_BUDGET', 'Usage ledger rejected the observation');
  f.host.budgetOwner = { projectId: 'p', ownerRunId: 'R-owner' };
  let toolsReserved = 0;
  f.host.options.budgets = {
    reserveGeneration: async (input) => ({
      operationId: input.operationId,
      maxOutputTokens: input.requestedOutputTokens,
    }),
    reserveTools: async () => {
      toolsReserved++;
    },
    recordUsage: async () => {
      const durable = (await f.sessions.load(f.state.session.id))!;
      assert.equal(durable.generation?.outcome, 'completed');
      assert.equal(durable.generation?.response?.message.content, 'Observed proposal');
      throw rejection;
    },
  };
  await assert.rejects(
    generateManagedBatch(f.state, f.host, f.request),
    (error) => error === rejection,
  );
  await assert.rejects(failManagedTurn(f.state, f.host, rejection), (error) => error === rejection);
  assert.equal(isKnownTurnRejection(rejection), true);
  const durable = (await f.sessions.load(f.state.session.id))!;
  assert.equal(durable.generation?.outcome, 'completed');
  assert.equal(durable.generation?.response?.message.continuation !== undefined, true);
  assert.deepEqual(durable.actions, []);
  assert.equal(f.effects(), 0);
  assert.equal(toolsReserved, 0);
});

test('a permanently lost receipt leaves a real effect unresolved and public resume cannot replay it', async (t) => {
  const f = await fixture(t),
    failure = Error('Receipt storage unavailable');
  const batch = await generateManagedBatch(f.state, f.host, f.request);
  f.host.options.sessions = {
    load: (id) => f.sessions.load(id),
    save: async (next) => {
      if (
        next.actions.some(
          (action) => action.status === 'completed' && action.result?.content === 'saved',
        )
      )
        throw failure;
      await f.sessions.save(next);
    },
  };
  await assert.rejects(
    dispatchManagedAction(f.state, f.host, batch.actionIds[0]),
    (error) => error === failure,
  );
  await assert.rejects(failManagedTurn(f.state, f.host, failure), {
    code: 'ACTION_RECONCILIATION_REQUIRED',
    cause: failure,
  });
  assert.equal(await fs.readFile(path.join(f.directory, 'effect-log'), 'utf8'), 'effect\n');
  assert.equal(
    f.events.some((event) => event.type === 'tool.completed'),
    false,
  );
  const reopened = new FileManagedSessions(f.directory),
    durable = (await reopened.load(f.state.session.id))!;
  assert.deepEqual(
    durable.actions.map((action) => action.status),
    ['pending', 'pending'],
  );
  const runtime = new ManagedAgentRuntime({
    loopRunner: new PiAgentLoopRunner(),
    ...f.host.options,
    sessions: reopened,
  });
  t.after(() => runtime.dispose());
  await assert.rejects(
    runtime.resume({
      projectId: 'p',
      runId: 'R-owner',
      threadId: durable.id,
      workspace: f.directory,
      instructions: 'Continue',
    }),
    { code: 'ACTION_RECONCILIATION_REQUIRED' },
  );
  assert.equal(f.effects(), 1);
});

test('packet construction and unreconciled prior work fail before reservation, journal intent or provider dispatch', async (t) => {
  const f = await fixture(t);
  let reservations = 0;
  f.host.budgetOwner = { projectId: 'p', ownerRunId: 'R-owner' };
  f.host.options.budgets = {
    reserveGeneration: async (input) => {
      reservations++;
      return { operationId: input.operationId, maxOutputTokens: 512 };
    },
    recordUsage: async () => {},
    reserveTools: async () => {},
  };
  const unserializable = { ...f.request, schema: () => 'not a cloneable schema' };
  await assert.rejects(generateManagedBatch(f.state, f.host, unserializable));
  assert.equal(reservations, 0);
  assert.equal(f.providerCalls(), 0);
  assert.equal(f.state.generationDispatched, false);
  assert.equal((await f.sessions.load(f.state.session.id))!.generation, undefined);
  const unresolved = new DomainError('ACTION_RECONCILIATION_REQUIRED', 'Prior action must settle');
  f.host.assertReconciled = () => {
    throw unresolved;
  };
  await assert.rejects(
    generateManagedBatch(f.state, f.host, f.request),
    (error) => error === unresolved,
  );
  assert.equal(reservations, 0);
  assert.equal(f.providerCalls(), 0);
});

for (const known of [false, true])
  test(`provider failure settlement preserves ${known ? 'known no-dispatch' : 'unknown'} despite the same exception code`, async (t) => {
    const f = await fixture(t);
    const failure = recordTurnOutcome(
      new DomainError('MODEL_AUTH_FAILED', 'Provider observation'),
      known ? 'not-dispatched' : 'unknown',
    );
    f.host.options.provider.complete = async () => {
      throw failure;
    };
    await assert.rejects(
      generateManagedBatch(f.state, f.host, f.request),
      (error) => error === failure,
    );
    await assert.rejects(failManagedTurn(f.state, f.host, failure), (error: unknown) => {
      if (known) assert.equal(error, failure);
      else {
        assert.ok(error instanceof UnresolvedEffectError);
        assert.equal(error.code, 'GENERATION_RECONCILIATION_REQUIRED');
        assert.equal(error.cause, failure);
      }
      return true;
    });
    const durable = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
    assert.equal(durable.generation?.outcome, known ? 'completed' : 'unknown');
    assert.equal(durable.generation?.rejectionCode, known ? 'MODEL_AUTH_FAILED' : undefined);
    assert.equal(f.effects(), 0);
    if (!known) {
      const runtime = new ManagedAgentRuntime({
        loopRunner: new PiAgentLoopRunner(),
        ...f.host.options,
        sessions: new FileManagedSessions(f.directory),
      });
      t.after(() => runtime.dispose());
      await assert.rejects(
        runtime.resume({
          projectId: 'p',
          runId: 'R-owner',
          threadId: durable.id,
          workspace: f.directory,
          instructions: 'Continue',
        }),
        { code: 'GENERATION_RECONCILIATION_REQUIRED' },
      );
    }
  });
