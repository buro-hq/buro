import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedLimitsSchema } from '../protocol/resource-builtins.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { prepareManagedResume } from '../core/managed-session-authority.ts';
import type { ManagedRuntimeOptions } from '../core/managed-runtime-options.ts';
import type { ManagedSession } from '../core/model-ports.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';

type Completion = Awaited<ReturnType<ModelProvider['complete']>>;
const response = (index: number, tools = 0): Completion => ({
  model: 'controlled-model',
  finish: tools ? 'tools' : 'stop',
  usage: { inputTokens: 10, outputTokens: 2 },
  message: {
    role: 'assistant',
    content: tools ? '' : '{"ok":true}',
    ...(tools
      ? {
          toolCalls: Array.from({ length: tools }, (_, call) => ({
            id: 'read-' + index + '-' + call,
            name: 'read_file',
            arguments: { path: 'src/a.ts' },
          })),
        }
      : {}),
  },
});

async function fixture(
  t: any,
  limits: Partial<ManagedRuntimeOptions['limits']> = {},
  complete: (index: number) => Completion = (index) => response(index),
) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-managed-none-')),
  );
  const sessions = new FileManagedSessions(directory);
  let serial = 0,
    generations = 0,
    executed = 0;
  let firstTurnIntent: ManagedSession | undefined;
  const settings: ManagedRuntimeOptions = {
    id: 'none-runtime',
    model: 'controlled-model',
    loopRunner: new PiAgentLoopRunner(),
    idGenerator: () => String(++serial),
    sessions: {
      load: (id) => sessions.load(id),
      async save(next) {
        await sessions.save(next);
        if (
          !firstTurnIntent &&
          next.requests === 0 &&
          next.turnAuthorities?.length &&
          next.messages.some((message) => message.role !== 'system')
        )
          firstTurnIntent = structuredClone(next);
      },
    },
    limits: ManagedLimitsSchema.parse({ contextTokens: 262144, maxOutputTokens: 128, ...limits }),
    projects: {
      get: () => ({
        snapshot: () => ({
          project: { id: 'p', root: directory },
          profile: {
            scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
          },
          runs: [{ id: 'R-none', workspace: directory }],
        }),
      }),
    } as unknown as ProjectRegistry,
    tools: {
      revision: 'none-tools-v1',
      effect: () => 'read',
      definitions: () => [
        {
          name: 'read_file',
          description: 'Read scoped source',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
      async execute() {
        executed++;
        return { content: 'Read receipt ' + executed };
      },
    },
    provider: {
      id: 'none-provider',
      revision: 'v1',
      local: true,
      async complete() {
        generations++;
        return complete(generations);
      },
    },
  };
  const runtimes: ManagedAgentRuntime[] = [];
  const make = () => {
    const runtime = new ManagedAgentRuntime(settings);
    runtimes.push(runtime);
    return runtime;
  };
  const start = {
    projectId: 'p',
    runId: 'R-none',
    purpose: 'coordination' as const,
    workspace: directory,
    instructions: 'Complete the current scoped task using actual tool evidence.',
  };
  const runtime = make();
  const { threadId } = await runtime.start(start);
  const turn = (active = runtime) =>
    active.turn(threadId, 'Inspect current source and return a result.', {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      signal: new AbortController().signal,
      timeoutMs: 30000,
    });
  t.after(async () => {
    await Promise.all(runtimes.map((active) => active.dispose()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    sessions,
    settings,
    runtime,
    make,
    start,
    threadId,
    turn,
    generations: () => generations,
    executed: () => executed,
    firstTurnIntent: () => structuredClone(firstTurnIntent),
  };
}

test('managed configuration defaults retain only physical context/output and accept explicit positive quotas without arbitrary ceilings', () => {
  assert.deepEqual(ManagedLimitsSchema.parse({}), { contextTokens: 32768, maxOutputTokens: 4096 });
  const explicit = {
    maxRequestsPerTurn: 2000,
    maxToolCallsPerTurn: 2000,
    maxSessionRequests: 2000,
    maxFeedbackSteps: 2000,
  };
  assert.deepEqual(ManagedLimitsSchema.parse(explicit), {
    contextTokens: 32768,
    maxOutputTokens: 4096,
    ...explicit,
  });
  for (const key of Object.keys(explicit))
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => ManagedLimitsSchema.parse({ [key]: value }));
  assert.throws(() => ManagedLimitsSchema.parse({ contextTokens: 1024, maxOutputTokens: 1024 }));
});

test('real managed Pi/File execution passes former per-turn, tool and lifetime defaults with exact accounting and no quota reset on reopen', async (t) => {
  const f = await fixture(t, {}, (index) => response(index, index === 131 || index >= 262 ? 0 : 1));
  for (let turn = 0; turn < 2; turn++)
    assert.deepEqual(JSON.parse((await f.turn()).text), { ok: true });
  const saved = (await f.sessions.load(f.threadId))!;
  assert.deepEqual(saved.limits, { contextTokens: 262144, maxOutputTokens: 128 });
  assert.equal(saved.requests, 262);
  assert.equal(saved.actions.length, 260);
  assert.equal(f.executed(), 260);
  assert.ok(saved.actions.every((action) => action.status === 'completed' && action.result));
  assert.equal(new Set(saved.actions.map((action) => action.id)).size, 260);
  assert.deepEqual(saved.usage, { requestsWithUsage: 262, inputTokens: 2620, outputTokens: 524 });
  await f.runtime.release(f.threadId);
  const resumed = f.make();
  await resumed.resume({ ...f.start, threadId: f.threadId });
  await f.turn(resumed);
  const restored = (await new FileManagedSessions(f.directory).load(f.threadId))!;
  assert.equal(restored.requests, 263);
  assert.deepEqual(restored.actions, saved.actions);
  assert.deepEqual(restored.usage, {
    requestsWithUsage: 263,
    inputTokens: 2630,
    outputTokens: 526,
  });
});

test('explicit managed request, session and whole-batch tool quotas still stop before excess dispatch', async (t) => {
  const requests = await fixture(t, { maxRequestsPerTurn: 2 }, (index) => response(index, 1));
  await assert.rejects(requests.turn(), { code: 'MODEL_BUDGET_EXHAUSTED' });
  assert.equal(requests.generations(), 2);
  assert.equal(requests.executed(), 2);
  const lifetime = await fixture(t, { maxSessionRequests: 2 });
  await lifetime.turn();
  await lifetime.turn();
  await assert.rejects(lifetime.turn(), { code: 'MODEL_BUDGET_EXHAUSTED' });
  assert.equal(lifetime.generations(), 2);
  const tools = await fixture(t, { maxToolCallsPerTurn: 2 }, (index) => response(index, 3));
  await assert.rejects(tools.turn(), { code: 'TOOL_BUDGET_EXHAUSTED' });
  assert.equal(tools.generations(), 1);
  assert.equal(tools.executed(), 0, 'Reject the entire over-quota batch before any tool executes.');
});

test('File checkpoints cannot silently add or remove explicit quotas or rewind unlimited usage', async (t) => {
  for (const limits of [{}, { maxSessionRequests: 2, maxFeedbackSteps: 2 }]) {
    const f = await fixture(t, limits);
    await f.turn();
    const before = (await f.sessions.load(f.threadId))!;
    for (const mutate of [
      (next: ManagedSession) => {
        if (next.limits.maxSessionRequests === undefined) next.limits.maxSessionRequests = 10;
        else delete next.limits.maxSessionRequests;
      },
      (next: ManagedSession) => {
        if (next.limits.maxFeedbackSteps === undefined) next.limits.maxFeedbackSteps = 10;
        else delete next.limits.maxFeedbackSteps;
      },
      (next: ManagedSession) => {
        next.requests--;
      },
      (next: ManagedSession) => {
        next.usage.inputTokens--;
      },
    ]) {
      const next = structuredClone(before);
      mutate(next);
      await assert.rejects(f.sessions.save(next));
      assert.deepEqual(await f.sessions.load(f.threadId), before);
    }
  }
});

test('issued scope and used turn history are required on save, reopen and resume without guessing from messages', async (t) => {
  const f = await fixture(t);
  const original = (await f.sessions.load(f.threadId))!;
  assert.equal(original.scopeRevisions.length, 1);
  assert.equal(original.scopeRevisions[0].revision, 1);
  assert.equal(original.scopeRevisions[0].instructions, f.start.instructions);
  assert.equal(
    original.turnAuthorities,
    undefined,
    'A pristine system-only start has not issued a turn.',
  );
  const filename = path.join(f.directory, f.threadId + '.json');
  const rejectMalformed = async (malformed: ManagedSession) => {
    const before = (await f.sessions.load(f.threadId))!;
    const beforeBytes = await fs.readFile(filename);
    await assert.rejects(async () => f.sessions.save(malformed));
    assert.deepEqual(await fs.readFile(filename), beforeBytes);
    assert.throws(
      () => prepareManagedResume(f.settings, malformed, { ...f.start, threadId: f.threadId }),
      { code: 'INVALID_CHECKPOINT' },
    );
    let writes = 0;
    const injected = new ManagedAgentRuntime({
      ...f.settings,
      sessions: {
        load: async () => structuredClone(malformed),
        async save() {
          writes++;
          throw Error('No guessed replacement checkpoint may be saved.');
        },
      },
    });
    try {
      await assert.rejects(injected.resume({ ...f.start, threadId: f.threadId }), {
        code: 'INVALID_CHECKPOINT',
      });
      assert.equal(writes, 0);
    } finally {
      await injected.dispose();
    }
    const freshDirectory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'buro-missing-provenance-')),
    );
    try {
      await assert.rejects(async () => new FileManagedSessions(freshDirectory).save(malformed));
    } finally {
      await fs.rm(freshDirectory, { recursive: true, force: true });
    }
    try {
      await fs.writeFile(filename, JSON.stringify(malformed));
      await assert.rejects(new FileManagedSessions(f.directory).load(f.threadId));
    } finally {
      await fs.writeFile(filename, beforeBytes);
    }
    assert.deepEqual(await new FileManagedSessions(f.directory).load(f.threadId), before);
  };
  for (const revisions of [undefined, [], [{ ...original.scopeRevisions[0], revision: 2 }]]) {
    const malformed = structuredClone(original);
    if (revisions === undefined) delete (malformed as Partial<ManagedSession>).scopeRevisions;
    else malformed.scopeRevisions = revisions;
    await rejectMalformed(malformed);
  }
  const mismatched = structuredClone(original);
  mismatched.scopeRevisions[0].scope.writeScope.plannedPaths = ['different/'];
  await rejectMalformed(mismatched);
  assert.equal(f.generations(), 0);
  await f.turn();
  const used = (await f.sessions.load(f.threadId))!;
  const started = f.firstTurnIntent()!;
  assert.equal(started.requests, 0);
  assert.equal(started.generation, undefined);
  assert.ok(started.messages.some((message) => message.role !== 'system'));
  for (const issued of [used, started])
    for (const authorities of [undefined, []]) {
      const malformed = structuredClone(issued);
      if (authorities === undefined) delete malformed.turnAuthorities;
      else malformed.turnAuthorities = authorities;
      await rejectMalformed(malformed);
    }
  assert.equal(f.generations(), 1, 'No invalid history dispatched a replacement generation.');
  assert.equal(f.executed(), 0);
});

test('a generic start without a purpose still issues its first scope revision explicitly', async (t) => {
  const f = await fixture(t);
  const { threadId } = await f.runtime.start({ ...f.start, purpose: undefined });
  const session = (await f.sessions.load(threadId))!;
  assert.equal(session.purpose, undefined);
  assert.deepEqual(session.scopeRevisions, [
    { revision: 1, scope: session.scope, instructions: f.start.instructions },
  ]);
});
