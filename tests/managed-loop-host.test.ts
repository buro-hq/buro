import { fixtureToolEffect } from './fixtures/tool-broker.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { ManagedLoopHost } from '../core/managed-loop-host.ts';
import { failManagedTurn } from '../core/managed-host-effects.ts';
import { assertManagedReconciled } from '../core/managed-session-authority.ts';
import { initializeManagedCodingContext } from '../core/managed-coding-context.ts';
import { testBoundedWorkSegmentPolicy as boundedWorkSegmentPolicy } from './fixtures/work-segment-policy.ts';
import { DomainError, type ProjectRegistry } from '../core/ports.ts';
import { recordTurnOutcome } from '../core/run-reconciliation.ts';
import type { ManagedSession } from '../core/model-ports.ts';
import type {
  ManagedModelCompletion,
  ManagedTurnHost,
  ManagedTurnState,
} from '../core/managed-turn-state.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const answer = (content: string, tools = 0): ManagedModelCompletion => ({
  model: 'small-model',
  finish: tools ? 'tools' : 'stop',
  usage: { inputTokens: 12, outputTokens: 8 },
  message: {
    role: 'assistant',
    content,
    ...(tools
      ? {
          toolCalls: Array.from({ length: tools }, (_, index) => ({
            id: 'call-' + index,
            name: 'edit_file',
            arguments: { path: 'src/value.ts', value: index },
          })),
        }
      : {}),
  },
});
async function fixture(
  t: any,
  options: {
    separate?: boolean;
    segmented?: boolean;
    maxTurn?: number;
    maxSession?: number;
    readOnly?: boolean;
  } = {},
) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'managed-loop-host-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessions = new FileManagedSessions(directory);
  const limits = {
    contextTokens: 16384,
    maxOutputTokens: 512,
    maxRequestsPerTurn: options.maxTurn || 8,
    maxToolCallsPerTurn: 4,
    maxSessionRequests: options.maxSession || 20,
  };
  const scope: ManagedSession['scope'] = {
    projectId: 'p',
    runId: 'R-owner',
    sessionId: 'M-fixture',
    workspace: directory,
    readOnly: !!options.readOnly,
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
    purpose: options.segmented ? 'implementation' : 'coordination',
    scope,
    ...(options.segmented
      ? { assignment: { roleId: 'builder', scope: structuredClone(scope.writeScope) } }
      : {}),
    scopeRevisions: [
      { revision: 1, scope: structuredClone(scope), instructions: 'Preserve the complete goal.' },
    ],
    turnAuthorities: [
      { turnId: 'T-fixture', toolPolicy: 'normal', startedAtRequest: 0, scopeRevision: 1 },
    ],
    messages: [
      { role: 'system', content: 'Preserve the complete goal.' },
      { role: 'user', content: 'ORIGINAL_COMPLETE_GOAL' },
    ],
    status: 'running',
    requests: 0,
    usage: { requestsWithUsage: 0, inputTokens: 0, outputTokens: 0 },
    actions: [],
  };
  const state: ManagedTurnState = {
    session,
    threadId: session.id,
    turnId: 'T-fixture',
    schema: { type: 'object' },
    noTools: false,
    separate: !!options.separate,
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
  let effects = 0,
    requests = 0,
    commits = 0;
  const controller = new AbortController();
  const packets: Parameters<ManagedTurnHost['options']['provider']['complete']>[0][] = [];
  const host: ManagedTurnHost = {
    runtimeId: session.runtimeId,
    signal: controller.signal,
    budgetPhase: 'work',
    options: {
      id: session.runtimeId,
      model: session.requestedModel,
      limits,
      sessions,
      projects: {} as ProjectRegistry,
      idGenerator: () => 'fixture',
      provider: {
        id: 'provider',
        revision: 'v1',
        local: true,
        async complete(packet) {
          requests++;
          packets.push(
            structuredClone({
              ...packet,
              signal: undefined,
              onProgress: undefined,
              onEvent: undefined,
            }) as typeof packet,
          );
          const response = requests === 1 ? answer('Proposed work', 1) : answer('{"done":true}');
          for (const call of response.message.toolCalls || []) call.id += ':round-' + state.round;
          return response;
        },
      },
      loopRunner: new PiAgentLoopRunner(),
      tools: {
        revision: 'fixture-tools-v1',
        effect: fixtureToolEffect,
        definitions: () => [
          { name: 'edit_file', description: 'Edit public source', parameters: { type: 'object' } },
        ],
        async execute() {
          effects++;
          return { content: 'recorded effect' };
        },
      },
    },
    check: () => controller.signal.throwIfAborted(),
    touch() {},
    emit() {},
    async commit(next) {
      await host.options.sessions.save(next);
      state.session = next;
      commits++;
    },
    toolDefinitions: (given) => host.options.tools.definitions(structuredClone(given)),
    assertReconciled: assertManagedReconciled,
  };
  if (options.segmented) {
    host.options.segmentPolicy = {
      ...boundedWorkSegmentPolicy,
      revision: 'bridge-segments-v1',
      limits: {
        revision: 'bridge-segments-v1',
        maxToolRounds: 1,
        maxSegments: 4,
        contextThresholdPercent: 80,
      },
    };
    host.options.segmentEvidence = {
      inspect: async () => ({
        version: 1,
        baseCommit: 'a'.repeat(40),
        headCommit: 'a'.repeat(40),
        workspaceFingerprint: 'b'.repeat(64),
        files: [],
      }),
    };
    await initializeManagedCodingContext(state, host, 'ORIGINAL_COMPLETE_GOAL');
    const complete = host.options.provider.complete;
    host.options.provider.complete = async (packet) =>
      state.closing
        ? (requests++,
          packets.push(
            structuredClone({
              ...packet,
              signal: undefined,
              onProgress: undefined,
              onEvent: undefined,
            }) as typeof packet,
          ),
          answer('{"status":"continue","nextTask":"Finish the existing assignment"}'))
        : complete(packet);
  }
  await sessions.save(session);
  return {
    directory,
    sessions,
    state,
    host,
    controller,
    bridge: new ManagedLoopHost(state, host),
    packets,
    requests: () => requests,
    effects: () => effects,
    commits: () => commits,
  };
}

test('scheduler copies cannot replace request, batch arguments, receipts or the final canonical result', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(Reflect.ownKeys(f.bridge), []);
  assert.equal(JSON.stringify(f.bridge), '{}');
  assert.equal('state' in f.bridge || 'options' in f.bridge || 'host' in f.bridge, false);
  const packet = await f.bridge.prepare(),
    requestId = packet.id;
  assert.deepEqual(Object.keys(packet).sort(), ['id', 'messages', 'model', 'tools']);
  packet.id = 'scheduler-forged-request';
  packet.model.id = 'scheduler-model';
  packet.messages[0].content = 'Discard the goal';
  packet.tools[0].name = 'hidden_command';
  const batch = await f.bridge.generate(requestId),
    actionId = batch.actions[0].id;
  assert.equal(f.packets[0].model, 'small-model');
  assert.equal(f.packets[0].messages[0].content, 'Preserve the complete goal.');
  assert.equal(f.packets[0].tools[0].name, 'edit_file');
  batch.response.message.content = 'False final result';
  delete batch.response.message.toolCalls;
  batch.actions[0].id = 'forged-action';
  (batch.actions[0].call.arguments as { path: string }).path = 'outside-scheduler-path';
  f.host.options.tools.execute = async (call) => {
    assert.equal((call.arguments as { path: string }).path, 'src/value.ts');
    return { content: 'actual saved receipt' };
  };
  const result = await f.bridge.execute(batch.id, actionId);
  result.content = 'Scheduler changed receipt';
  assert.equal(
    (await f.sessions.load(f.state.session.id))!.actions[0].result?.content,
    'actual saved receipt',
  );
  assert.deepEqual(await f.bridge.advance(batch.id), { kind: 'continue' });
  const next = await f.bridge.prepare(),
    final = await f.bridge.generate(next.id);
  final.response.message.content = 'Scheduler claimed success';
  assert.deepEqual(await f.bridge.advance(final.id), { kind: 'complete' });
  assert.equal(f.bridge.result?.text, '{"done":true}');
  const exposed = f.bridge.result!;
  exposed.text = 'Changed result getter';
  assert.equal(f.bridge.result?.text, '{"done":true}');
});

for (const violation of [
  'generate-before-prepare',
  'wrong-request',
  'advance-before-tools',
  'wrong-batch',
  'wrong-action',
  'skip-advance',
] as const)
  test(`invalid scheduler phase (${violation}) closes the adapter before any extra request or action`, async (t) => {
    const f = await fixture(t);
    if (violation === 'generate-before-prepare') {
      await assert.rejects(f.bridge.generate('forged'), { code: 'INVALID_LOOP_PHASE' });
      assert.equal(f.requests(), 0);
    } else {
      const packet = await f.bridge.prepare();
      if (violation === 'wrong-request') {
        await assert.rejects(f.bridge.generate('PRIVATE_RAW_REQUEST_VALUE'), {
          code: 'INVALID_LOOP_PHASE',
        });
        assert.equal(f.requests(), 0);
      } else {
        const batch = await f.bridge.generate(packet.id);
        const bad =
          violation === 'advance-before-tools'
            ? f.bridge.advance(batch.id)
            : violation === 'wrong-batch'
              ? f.bridge.execute('forged-batch', batch.actions[0].id)
              : violation === 'wrong-action'
                ? f.bridge.execute(batch.id, 'forged-action')
                : f.bridge.prepare();
        await assert.rejects(bad, { code: 'INVALID_LOOP_PHASE' });
        assert.equal(f.requests(), 1);
      }
    }
    await assert.rejects(f.bridge.prepare(), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, 'INVALID_LOOP_PHASE');
      assert.doesNotMatch(error.message, /PRIVATE_RAW_REQUEST_VALUE|ORIGINAL_COMPLETE_GOAL/);
      return true;
    });
    assert.equal(f.effects(), 0);
    assert.equal(f.bridge.result, undefined);
  });

test('context advances once; replaying advance cannot append another finalization instruction', async (t) => {
  const f = await fixture(t, { separate: true });
  f.host.options.provider.complete = async () => answer('Work completion note');
  const packet = await f.bridge.prepare(),
    batch = await f.bridge.generate(packet.id);
  const before = f.commits();
  assert.deepEqual(await f.bridge.advance(batch.id), { kind: 'continue' });
  const checkpoint = (await f.sessions.load(f.state.session.id))!;
  assert.equal(f.commits(), before + 1);
  assert.equal(checkpoint.intermediateNotes?.length, 1);
  assert.equal(
    checkpoint.messages.filter((message) =>
      message.content.startsWith('Return one registered service action as the formal decision'),
    ).length,
    1,
  );
  await assert.rejects(f.bridge.advance(batch.id), { code: 'INVALID_LOOP_PHASE' });
  assert.deepEqual(await f.sessions.load(f.state.session.id), checkpoint);
});

test('a concurrent callback drains its existing receipt but cannot open another phase or abort the parent signal', async (t) => {
  const f = await fixture(t),
    entered = deferred(),
    release = deferred();
  let effects = 0,
    generations = 0;
  f.host.options.provider.complete = async () => {
    generations++;
    return answer('Two writes', 2);
  };
  f.host.options.tools.execute = async () => {
    effects++;
    entered.resolve();
    await release.promise;
    return { content: 'committed after drain' };
  };
  const packet = await f.bridge.prepare(),
    batch = await f.bridge.generate(packet.id);
  const first = f.bridge.execute(batch.id, batch.actions[0].id);
  const observed = assert.rejects(first, { code: 'INVALID_LOOP_PHASE' });
  await entered.promise;
  await assert.rejects(f.bridge.execute(batch.id, batch.actions[1].id), {
    code: 'INVALID_LOOP_PHASE',
  });
  release.resolve();
  await observed;
  const durable = (await f.sessions.load(f.state.session.id))!;
  assert.equal(durable.actions[0].status, 'completed');
  assert.equal(durable.actions[1].status, 'pending');
  assert.equal(effects, 1);
  assert.equal(f.controller.signal.aborted, false);
  await assert.rejects(f.bridge.prepare(), { code: 'INVALID_LOOP_PHASE' });
  assert.equal(generations, 1);
  assert.equal(f.bridge.result, undefined);
});

test('context compaction yields only after its checkpoint commits and retains logical turn counters', async (t) => {
  const f = await fixture(t, { segmented: true, maxTurn: 2 });
  let packet = await f.bridge.prepare(),
    batch = await f.bridge.generate(packet.id);
  await f.bridge.execute(batch.id, batch.actions[0].id);
  assert.deepEqual(await f.bridge.advance(batch.id), { kind: 'continue' });
  packet = await f.bridge.prepare();
  batch = await f.bridge.generate(packet.id);
  assert.deepEqual(await f.bridge.advance(batch.id), { kind: 'yield' });
  const durable = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
  assert.equal(durable.workSegments?.active.index, 2);
  assert.equal(durable.workSegments?.archives.length, 1);
  assert.equal(durable.requests, 2);
  assert.equal(f.state.round, 2);
  assert.equal(f.state.calls, 1);
  assert.equal(durable.actions.length, 1);
  assert.equal(durable.usage.requestsWithUsage, 2);
  await assert.rejects(f.bridge.prepare(), { code: 'MODEL_BUDGET_EXHAUSTED' });
  assert.equal(f.requests(), 2);
});

test('the actual SDK runner resumes from a committed host yield without resetting receipts, counters or goal', async (t) => {
  const f = await fixture(t, { segmented: true });
  assert.deepEqual(await f.host.options.loopRunner.run(f.bridge, f.controller.signal), {
    kind: 'yield',
  });
  assert.equal(f.state.round, 2);
  assert.equal(f.state.calls, 1);
  assert.equal(f.state.session.requests, 2);
  assert.equal(f.state.session.workSegments?.active.index, 2);
  assert.equal(f.bridge.result, undefined);
  assert.deepEqual(await f.host.options.loopRunner.run(f.bridge, f.controller.signal), {
    kind: 'complete',
  });
  assert.equal(f.bridge.result?.text, '{"done":true}');
  const durable = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
  assert.equal(durable.requests, 3);
  assert.equal(durable.actions.length, 1);
  assert.equal(durable.actions[0].status, 'completed');
  assert.equal(durable.usage.requestsWithUsage, 3);
  assert.equal(f.effects(), 1);
  assert.equal(f.packets[2].messages[1].content, 'ORIGINAL_COMPLETE_GOAL');
  assert.equal(
    f.packets[2].messages.some((message) => message.role === 'tool'),
    false,
  );
});

test('starting another SDK window cannot renew the saved session request allowance', async (t) => {
  const f = await fixture(t, { segmented: true, maxSession: 2 });
  assert.deepEqual(await f.host.options.loopRunner.run(f.bridge, f.controller.signal), {
    kind: 'yield',
  });
  await assert.rejects(
    f.host.options.loopRunner.run(f.bridge, f.controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, 'MODEL_BUDGET_EXHAUSTED');
      assert.match(error.message, /session request budget/);
      return true;
    },
  );
  assert.equal(f.requests(), 2);
  assert.equal(f.state.session.requests, 2);
  assert.equal(f.state.round, 2);
  assert.equal(f.state.calls, 1);
  assert.equal(f.bridge.result, undefined);
});

test('a rejected compaction checkpoint cannot yield or reuse a shortened request context', async (t) => {
  const f = await fixture(t, { segmented: true }),
    failure = Error('Compaction persistence unavailable');
  let packet = await f.bridge.prepare(),
    batch = await f.bridge.generate(packet.id);
  await f.bridge.execute(batch.id, batch.actions[0].id);
  await f.bridge.advance(batch.id);
  packet = await f.bridge.prepare();
  batch = await f.bridge.generate(packet.id);
  f.host.options.sessions = {
    load: (id) => f.sessions.load(id),
    save: async (next) => {
      if (next.workSegments?.archives.length) throw failure;
      await f.sessions.save(next);
    },
  };
  await assert.rejects(f.bridge.advance(batch.id), (error) => error === failure);
  const durable = (await f.sessions.load(f.state.session.id))!;
  assert.equal(durable.workSegments?.active.index, 1);
  assert.equal(durable.workSegments?.archives.length, 0);
  assert.ok(durable.messages.some((message) => message.content === 'ORIGINAL_COMPLETE_GOAL'));
  assert.equal(f.state.round, 1);
  await assert.rejects(f.bridge.prepare(), { code: 'INVALID_LOOP_PHASE' });
  assert.equal(f.requests(), 2);
  assert.equal(f.bridge.result, undefined);
});

test('an unknown generation is rethrown unchanged and cannot be retried by the scheduler', async (t) => {
  const f = await fixture(t),
    failure = recordTurnOutcome(
      new DomainError('MODEL_AUTH_FAILED', 'Unknown after dispatch'),
      'unknown',
    );
  let calls = 0;
  f.host.options.provider.complete = async () => {
    calls++;
    throw failure;
  };
  const packet = await f.bridge.prepare();
  await assert.rejects(f.bridge.generate(packet.id), (error) => error === failure);
  await assert.rejects(f.bridge.generate(packet.id), { code: 'INVALID_LOOP_PHASE' });
  await assert.rejects(failManagedTurn(f.state, f.host, failure), {
    code: 'GENERATION_RECONCILIATION_REQUIRED',
    cause: failure,
  });
  assert.equal(calls, 1);
  assert.equal(
    (await new FileManagedSessions(f.directory).load(f.state.session.id))!.generation?.outcome,
    'unknown',
  );
  assert.equal(f.bridge.result, undefined);
});

test('Pi continues after a rejected mixed batch using durable feedback and the same frozen tools and final schema', async (t) => {
  const f = await fixture(t);
  const first = answer('Request a service decision', 2);
  first.message.continuation = { private: 'preserve rejected provider continuation' };
  first.message.toolCalls![1].name = 'delegate';
  first.message.toolCalls![1].arguments = { worker: {} };
  let requests = 0;
  f.host.options.provider.complete = async (packet) => {
    requests++;
    assert.deepEqual(
      packet.tools.map((tool) => tool.name),
      ['edit_file'],
    );
    assert.deepEqual(packet.schema, f.state.schema);
    if (requests === 1) return first;
    const saved = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
    assert.equal(saved.rejectedToolBatches?.length, 1);
    assert.deepEqual(saved.rejectedToolBatches![0].response, first);
    assert.deepEqual(saved.actions, []);
    assert.equal(saved.usage.requestsWithUsage, 1);
    assert.equal(saved.messages.filter((message) => message.role === 'tool').length, 2);
    assert.deepEqual(
      packet.messages.find((message) => message.toolCalls?.length),
      first.message,
    );
    assert.equal(JSON.parse(packet.messages.at(-1)!.content).error, 'UNADVERTISED_TOOL');
    return answer('{"decision":{"action":"delegate","input":{"worker":{}}}}');
  };
  assert.deepEqual(await new PiAgentLoopRunner().run(f.bridge, f.controller.signal), {
    kind: 'complete',
  });
  assert.equal(JSON.parse(f.bridge.result!.text).decision.action, 'delegate');
  assert.equal(requests, 2);
  assert.equal(f.effects(), 0, 'Even the valid first edit in the rejected batch must not execute');
  const saved = (await f.sessions.load(f.state.session.id))!;
  assert.equal(saved.requests, 2);
  assert.deepEqual(saved.usage, { requestsWithUsage: 2, inputTokens: 24, outputTokens: 16 });
  assert.equal(saved.rejectedToolBatches?.length, 1);
  assert.deepEqual(saved.actions, []);
});

test('feedback permits a newly identified allowed tool but cannot reuse any rejected call identity', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  f.host.options.provider.complete = async () => {
    requests++;
    const result = answer('', 1);
    if (requests === 1) result.message.toolCalls![0].name = 'not_offered';
    else result.message.toolCalls![0].id = 'fresh-allowed-call';
    if (requests === 3) return answer('{"done":true}');
    return result;
  };
  assert.deepEqual(await new PiAgentLoopRunner().run(f.bridge, f.controller.signal), {
    kind: 'complete',
  });
  assert.equal(requests, 3);
  assert.equal(f.effects(), 1);
  const saved = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
  assertManagedReconciled(saved);
  assert.equal(saved.rejectedToolBatches?.length, 1);
  assert.equal(saved.actions.length, 1);
  assert.equal(saved.actions[0].call.id, 'fresh-allowed-call');
  assert.deepEqual(saved.usage, { requestsWithUsage: 3, inputTokens: 36, outputTokens: 24 });
  const forged = structuredClone(saved);
  forged.rejectedToolBatches!.push(structuredClone(forged.rejectedToolBatches![0]));
  await assert.rejects(async () => f.sessions.save(forged), { code: 'INVALID_CHECKPOINT' });
});

test('a crash before feedback commit preserves the actual response and blocks replay on reopen', async (t) => {
  const f = await fixture(t);
  f.host.options.provider.complete = async () => {
    const result = answer('', 1);
    result.message.toolCalls![0].name = 'not_offered';
    return result;
  };
  const save = f.host.options.sessions.save.bind(f.host.options.sessions);
  f.host.options.sessions.save = async (next) => {
    if (next.rejectedToolBatches?.length) throw new Error('Injected feedback commit failure');
    await save(next);
  };
  const packet = await f.bridge.prepare();
  await assert.rejects(f.bridge.generate(packet.id), /Injected feedback commit failure/);
  const durable = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
  assert.equal(durable.generation?.outcome, 'completed');
  assert.equal(durable.generation?.response?.message.toolCalls?.[0].name, 'not_offered');
  assert.equal(durable.generation?.response?.usage?.inputTokens, 12);
  assert.equal(durable.rejectedToolBatches, undefined);
  assert.deepEqual(durable.actions, []);
  assert.throws(() => assertManagedReconciled(durable), {
    code: 'GENERATION_RECONCILIATION_REQUIRED',
  });
  const reopened = new ManagedLoopHost(
    { ...f.state, session: durable, activeBatch: undefined },
    f.host,
  );
  await assert.rejects(reopened.prepare(), { code: 'GENERATION_RECONCILIATION_REQUIRED' });
  assert.equal(f.effects(), 0);
});

test('committed feedback survives reopen without dispatch or a repeated completed generation', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  f.host.options.provider.complete = async () => {
    requests++;
    const result = answer('', 1);
    result.message.toolCalls![0].name = 'not_offered';
    return result;
  };
  const packet = await f.bridge.prepare(),
    batch = await f.bridge.generate(packet.id);
  const durable = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
  assertManagedReconciled(durable);
  const reopened = new ManagedLoopHost(
    { ...f.state, session: durable, activeBatch: undefined },
    f.host,
  );
  const repeated = await reopened.prepare();
  await assert.rejects(reopened.generate(repeated.id), { code: 'INVALID_GENERATION_REQUEST' });
  assert.equal(requests, 1);
  assert.equal(f.effects(), 0);
  assert.deepEqual(batch.actions, []);
  const saved = (await f.sessions.load(f.state.session.id))!;
  assert.equal(saved.rejectedToolBatches?.length, 1);
  assert.equal(saved.messages.filter((message) => message.role === 'tool').length, 1);
});

for (const boundary of [
  'cancelled',
  'unknown-generation',
  'duplicate-call',
  'tools-free',
  'read-only-write',
  'closing',
  'forbidden-effect',
] as const)
  test(`unadvertised-tool feedback cannot bypass ${boundary}`, async (t) => {
    const f = await fixture(t, { readOnly: boundary === 'read-only-write' });
    let requests = 0;
    f.host.options.provider.complete = async () => {
      requests++;
      if (boundary === 'unknown-generation') throw new Error('lost provider outcome');
      const result = answer('', boundary === 'duplicate-call' ? 2 : 1);
      result.message.toolCalls![0].name =
        boundary === 'read-only-write' ? 'edit_file' : 'not_offered';
      if (boundary === 'duplicate-call')
        result.message.toolCalls![1].id = result.message.toolCalls![0].id;
      if (boundary === 'cancelled') f.controller.abort();
      return result;
    };
    if (boundary === 'tools-free') f.state.noTools = true;
    if (boundary === 'closing') f.state.closing = true;
    if (boundary === 'forbidden-effect') f.host.options.tools.effect = () => 'command';
    await assert.rejects(new PiAgentLoopRunner().run(f.bridge, f.controller.signal));
    assert.equal(requests, 1);
    const saved = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
    assert.equal(saved.rejectedToolBatches, undefined);
    assert.deepEqual(saved.actions, []);
    assert.equal(f.effects(), 0);
  });

test('a rejected call ID remains consumed when a later allowed proposal reuses it', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  f.host.options.provider.complete = async () => {
    const result = answer('', 1);
    if (++requests === 1) result.message.toolCalls![0].name = 'not_offered';
    return result;
  };
  await assert.rejects(new PiAgentLoopRunner().run(f.bridge, f.controller.signal), {
    code: 'DUPLICATE_TOOL_CALL',
  });
  assert.equal(requests, 2);
  assert.equal(f.effects(), 0);
  const saved = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
  assert.equal(saved.rejectedToolBatches?.length, 1);
  assert.deepEqual(saved.actions, []);
});

test('a rejected tool chain is archived with its own rejection receipt across real context rotation', async (t) => {
  const f = await fixture(t, { segmented: true });
  let requests = 0;
  f.host.options.provider.complete = async () => {
    requests++;
    if (f.state.closing)
      return answer('{"status":"continue","nextTask":"Finish the original assignment"}');
    if (requests > 2) return answer('{"done":true}');
    const result = answer('', 1);
    if (requests === 1) result.message.toolCalls![0].name = 'not_offered';
    else result.message.toolCalls![0].id = 'allowed-after-rejection';
    return result;
  };
  const runner = new PiAgentLoopRunner();
  assert.deepEqual(await runner.run(f.bridge, f.controller.signal), { kind: 'yield' });
  const archived = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
  assert.equal(archived.workSegments?.archives.length, 1);
  assert.equal(archived.rejectedToolBatches?.length, 1);
  const messages = archived.workSegments!.archives[0].messages;
  assert.equal(messages.filter((message) => message.toolCallId === 'call-0').length, 1);
  assert.equal(
    messages.filter((message) => message.toolCallId === 'allowed-after-rejection').length,
    1,
  );
  assert.equal(f.effects(), 1);
  assert.deepEqual(await runner.run(f.bridge, f.controller.signal), { kind: 'complete' });
  const complete = (await f.sessions.load(f.state.session.id))!;
  assert.equal(complete.requests, 4);
  assert.equal(complete.rejectedToolBatches?.length, 1);
  assert.equal(complete.actions.length, 1);
  assertManagedReconciled(complete);
  const corrupted = structuredClone(complete);
  corrupted.workSegments!.archives[0].messages.find(
    (message) => message.toolCallId === 'call-0',
  )!.content = 'invented tool success';
  await fs.writeFile(path.join(f.directory, complete.id + '.json'), JSON.stringify(corrupted));
  await assert.rejects(new FileManagedSessions(f.directory).load(complete.id), {
    code: 'INVALID_CHECKPOINT',
  });
});

test('read-only normal work can correct an unknown function without gaining write permissions', async (t) => {
  const f = await fixture(t, { readOnly: true });
  const file = path.join(f.directory, 'source.txt');
  await fs.writeFile(file, 'unchanged');
  f.host.options.tools.definitions = () => [
    { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
  ];
  let requests = 0,
    reads = 0;
  f.host.options.tools.execute = async (call, scope) => {
    assert.equal(scope.readOnly, true);
    assert.equal(call.name, 'read_file');
    reads++;
    return { content: await fs.readFile(file, 'utf8') };
  };
  f.host.options.provider.complete = async (packet) => {
    requests++;
    assert.deepEqual(
      packet.tools.map((tool) => tool.name),
      ['read_file'],
    );
    if (requests === 3) return answer('{"verdict":"approved"}');
    const result = answer('', 1);
    result.message.toolCalls![0].name = requests === 1 ? 'not_offered' : 'read_file';
    result.message.toolCalls![0].id = 'read-only-call-' + requests;
    return result;
  };
  assert.deepEqual(await new PiAgentLoopRunner().run(f.bridge, f.controller.signal), {
    kind: 'complete',
  });
  assert.equal(requests, 3);
  assert.equal(reads, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'unchanged');
  const saved = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
  assert.equal(saved.scope.readOnly, true);
  assert.equal(saved.rejectedToolBatches?.length, 1);
  assert.equal(saved.actions.length, 1);
});

test('a completed unadmitted generation cannot borrow an older action with identical call bytes', async (t) => {
  const f = await fixture(t);
  const packet = await f.bridge.prepare(),
    batch = await f.bridge.generate(packet.id);
  await f.bridge.execute(batch.id, batch.actions[0].id);
  const durable = (await new FileManagedSessions(f.directory).load(f.state.session.id))!;
  assertManagedReconciled(durable);
  for (const requestId of ['another-turn:0', 'T-fixture:1']) {
    const unadmitted = structuredClone(durable);
    unadmitted.requests++;
    unadmitted.generation!.requestId = requestId;
    delete unadmitted.generation!.admittedActionIds;
    assert.throws(() => assertManagedReconciled(unadmitted), {
      code: 'GENERATION_RECONCILIATION_REQUIRED',
    });
  }
  const forged = structuredClone(durable);
  forged.generation!.admittedActionIds = ['historical-action'];
  await assert.rejects(async () => f.sessions.save(forged), { code: 'INVALID_CHECKPOINT' });
});
