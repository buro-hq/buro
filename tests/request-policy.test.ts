import { fixtureToolEffect } from './fixtures/tool-broker.ts';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  configuredRequestPolicy,
  prepareManagedRequest,
  type ManagedRequestInput,
  type ManagedRequestPolicy,
} from '../core/request-policy.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import type { ManagedRuntimeOptions } from '../core/managed-runtime-options.ts';
import type { ManagedSession } from '../core/model-ports.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import { createRuntimeResources } from '../adapters/resources/runtime-resources.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import { ResourceConfigurationSchema } from '../adapters/files/resource-configuration.ts';

const input = (content = 'Inspect the assigned file.'): ManagedRequestInput => ({
  phase: 'work',
  messages: [{ role: 'user', content }],
  tools: [
    { name: 'read_file', description: 'Read an allowed file', parameters: { type: 'object' } },
  ],
  schema: undefined,
  limits: { contextTokens: 8192, maxOutputTokens: 4096 },
});

test('configured output survives large serialized requests and schemas without byte-based clipping', () => {
  for (const content of ['x'.repeat(64769), 'я'.repeat(40000)]) {
    const request = input(content);
    request.schema = { description: 's'.repeat(20000) };
    const before = structuredClone(request);
    assert.deepEqual(prepareManagedRequest(request), {
      maxOutputTokens: 4096,
      reason: 'configured-limit',
    });
    assert.deepEqual(request, before);
  }
});

test('explicit policies may choose a smaller positive output cap without a hidden minimum', () => {
  const request = input('x'.repeat(100000));
  assert.equal(
    prepareManagedRequest(request, {
      revision: 'explicit',
      prepare: () => ({ maxOutputTokens: 1, reason: 'policy-limit' }),
    }).maxOutputTokens,
    1,
  );
});

test('core rejects raised caps, invalid numbers and invalid policy decisions', () => {
  const request = input();
  for (const decision of [
    { maxOutputTokens: 4097, reason: 'policy-limit' },
    { maxOutputTokens: 0, reason: 'policy-limit' },
    { maxOutputTokens: -1, reason: 'policy-limit' },
    { maxOutputTokens: 128.5, reason: 'policy-limit' },
    { maxOutputTokens: NaN, reason: 'policy-limit' },
    { maxOutputTokens: 128, reason: 'unrecognized' },
    undefined,
  ])
    assert.throws(
      () =>
        prepareManagedRequest(request, {
          revision: 'invalid',
          prepare: () => decision,
        } as ManagedRequestPolicy),
      { code: 'INVALID_REQUEST_POLICY' },
    );
});

test('policy sees a clone and cannot remove evidence, tools or limits from the dispatched request', () => {
  const request = input();
  request.schema = { required: ['complete'] };
  const before = structuredClone(request);
  const decision = prepareManagedRequest(request, {
    revision: 'test',
    prepare(copy) {
      copy.messages[0].content = 'Removed task';
      copy.tools[0].parameters = {};
      (copy.schema as { required: string[] }).required.length = 0;
      copy.limits.contextTokens = 1000000;
      return { maxOutputTokens: 256, reason: 'policy-limit' };
    },
  });
  assert.equal(decision.maxOutputTokens, 256);
  assert.deepEqual(request, before);
});

type CapturedRequest = Pick<
  Parameters<ModelProvider['complete']>[0],
  'messages' | 'tools' | 'schema' | 'maxOutputTokens' | 'contextTokens'
>;
function runtimeFixture(
  options: {
    contextTokens?: number;
    maxOutputTokens?: number;
    separate?: boolean;
    requestPolicy?: ManagedRequestPolicy;
    failSave?: number;
  } = {},
) {
  const checkpoints = new Map<string, ManagedSession>();
  const requests: CapturedRequest[] = [];
  let saves = 0,
    ids = 0;
  const projects = {
    get() {
      return {
        snapshot() {
          return { project: { id: 'p', root: '/workspace' }, runs: [], contextMaterials: [] };
        },
      };
    },
  } as unknown as ProjectRegistry;
  const limits = {
    contextTokens: options.contextTokens || 4000,
    maxOutputTokens: options.maxOutputTokens || 1500,
    maxRequestsPerTurn: 4,
    maxToolCallsPerTurn: 4,
    maxSessionRequests: 8,
  };
  const settings: ManagedRuntimeOptions = {
    loopRunner: new PiAgentLoopRunner(),
    id: 'managed-test',
    model: 'model-test',
    provider: {
      id: 'test',
      revision: 'test-v1',
      local: true,
      ...(options.separate ? { structuredToolMode: 'separate-turn' as const } : {}),
      async complete(request) {
        requests.push(
          structuredClone({
            messages: request.messages,
            tools: request.tools,
            schema: request.schema,
            maxOutputTokens: request.maxOutputTokens,
            contextTokens: request.contextTokens,
          }),
        );
        return {
          model: 'model-test',
          finish: 'stop' as const,
          message: { role: 'assistant' as const, content: '{"ok":true}' },
        };
      },
    },
    sessions: {
      async load(id) {
        const saved = checkpoints.get(id);
        return saved && structuredClone(saved);
      },
      async save(session) {
        if (++saves === options.failSave)
          throw Object.assign(new Error('Checkpoint unavailable'), { code: 'TEST_SAVE_FAILED' });
        checkpoints.set(session.id, structuredClone(session));
      },
    },
    tools: {
      revision: 'fixture-tools-v1',
      effect: fixtureToolEffect,
      definitions() {
        return structuredClone([...input().tools]);
      },
      async execute() {
        throw Error('No tool should execute');
      },
    },
    projects,
    idGenerator: () => String(++ids),
    limits,
    requestPolicy: options.requestPolicy,
  };
  return { runtime: new ManagedAgentRuntime(settings), requests, checkpoints, limits };
}
const turn = (schema: unknown = { type: 'object' }) => ({
  schema,
  signal: new AbortController().signal,
  timeoutMs: 5000,
});
const start = (runtime: ManagedAgentRuntime) =>
  runtime.start({
    projectId: 'p',
    instructions: 'Complete the assigned task.',
    workspace: '/workspace',
  });

test('managed runtime preserves configured output and complete request evidence', async (t) => {
  const f = runtimeFixture();
  t.after(() => f.runtime.dispose());
  const session = await start(f.runtime);
  const text = 'Preserve this entire task. ' + 'x'.repeat(2200);
  await f.runtime.turn(session.threadId, text, turn());
  assert.equal(f.requests.length, 1);
  const sent = f.requests[0];
  assert.equal(sent.maxOutputTokens, f.limits.maxOutputTokens);
  assert.equal(sent.contextTokens, f.limits.contextTokens);
  assert.ok(sent.messages.some((message) => message.content.includes(text)));
  assert.deepEqual(sent.tools, input().tools);
  assert.equal(f.checkpoints.get(session.threadId)?.requests, 1);
});

test('separate tool phase does not reserve a final schema that is not sent', async (t) => {
  const f = runtimeFixture({ separate: true });
  t.after(() => f.runtime.dispose());
  const session = await start(f.runtime);
  const schema = { type: 'object', description: 's'.repeat(5000) };
  await f.runtime.turn(session.threadId, 'Inspect the task.', turn(schema));
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].schema, undefined);
  assert.equal(f.requests[0].tools.length, 1);
  assert.deepEqual(f.requests[1].schema, schema);
  assert.ok(f.requests.every((request) => request.maxOutputTokens === f.limits.maxOutputTokens));
});

test('invalid policy caps cannot reach the provider', async (t) => {
  const f = runtimeFixture({
    requestPolicy: {
      revision: 'invalid',
      prepare: () => ({ maxOutputTokens: 0, reason: 'policy-limit' }),
    },
  });
  t.after(() => f.runtime.dispose());
  const session = await start(f.runtime);
  await assert.rejects(f.runtime.turn(session.threadId, 'Task', turn()), {
    code: 'INVALID_REQUEST_POLICY',
  });
  assert.equal(f.requests.length, 0);
});

test('checkpoint failure before dispatch keeps provider calls at zero', async (t) => {
  const f = runtimeFixture({ failSave: 3 });
  t.after(() => f.runtime.dispose());
  const session = await start(f.runtime);
  await assert.rejects(f.runtime.turn(session.threadId, 'Do the task.', turn()), {
    code: 'TEST_SAVE_FAILED',
  });
  assert.equal(f.requests.length, 0);
});

test('resource composition injects the policy without inference and freezes its revision in routing identity', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-policy-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await new PrivateJSONFiles(path.join(root, 'local')).save(
    'resources',
    ResourceConfigurationSchema.parse({
      version: 1,
      defaultProfile: 'local',
      connections: [
        {
          id: 'ollama',
          provider: 'ollama',
          config: { endpoint: 'http://127.0.0.1:11434', capacity: 1, think: false },
        },
      ],
      runtimes: [
        {
          id: 'coder',
          backend: 'managed',
          config: {
            connectionId: 'ollama',
            model: 'fixture-model',
            limits: { contextTokens: 8192, maxOutputTokens: 4096 },
          },
        },
      ],
      profiles: [
        {
          id: 'local',
          name: 'Local',
          policy: 'local-only',
          coordinator: 'coder',
          worker: 'coder',
          reviewer: 'coder',
        },
      ],
    }),
  );
  let calls = 0;
  const create = (revision: string) =>
    createRuntimeResources({
      directory: root,
      projects: {} as ProjectRegistry,
      executors: new EnvironmentExecutors(),
      credentials: () => undefined,
      fetch: async () => {
        calls++;
        throw Error('No inference during composition');
      },
      requestPolicy: { ...configuredRequestPolicy, revision },
    });
  const first = await create('policy-v1'),
    second = await create('policy-v2');
  t.after(async () => {
    await first.dispose();
    await second.dispose();
    for (const runtime of [...first.runtimes, ...second.runtimes]) await runtime.dispose();
  });
  assert.notEqual(
    first.resources[0].configurationRevision,
    second.resources[0].configurationRevision,
  );
  assert.equal((await first.list()).runtimes[0].local, true);
  assert.equal(calls, 0);
  await assert.rejects(create(''), { code: 'INVALID_REQUEST_POLICY' });
  assert.equal(calls, 0);
});
