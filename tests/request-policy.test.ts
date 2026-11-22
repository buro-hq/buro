import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  conservativeRequestPolicy,
  estimateManagedRequest,
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

test('default request policy lowers only output reservation to fit actual context', () => {
  const request = input('x'.repeat(6500));
  const before = structuredClone(request);
  const decision = prepareManagedRequest(request);
  assert.equal(decision.estimatedInput, estimateManagedRequest(request));
  assert.equal(decision.maxOutputTokens, request.limits.contextTokens - decision.estimatedInput);
  assert.ok(decision.maxOutputTokens >= 128 && decision.maxOutputTokens < 4096);
  assert.equal(decision.reason, 'context-headroom');
  assert.deepEqual(request, before);
  const roomy = prepareManagedRequest(input());
  assert.equal(roomy.maxOutputTokens, 4096);
  assert.equal(roomy.reason, 'configured-limit');
});

test('request estimate counts UTF-8 and only the schema supplied to this phase', () => {
  const ascii = input('a'.repeat(100));
  const unicode = input('я'.repeat(100));
  assert.equal(estimateManagedRequest(unicode) - estimateManagedRequest(ascii), 100);
  const final = {
    ...ascii,
    phase: 'final' as const,
    tools: [],
    schema: { description: 's'.repeat(3000) },
  };
  assert.ok(estimateManagedRequest(final) > estimateManagedRequest(ascii) + 2800);
  const actualPayload: unknown[] = [unicode.messages, unicode.tools];
  assert.equal(
    estimateManagedRequest(unicode),
    Buffer.byteLength(JSON.stringify(actualPayload)) + 16,
  );
});

test('insufficient headroom stops before consulting a plugin and legacy low caps remain bounded', () => {
  const request = input('Important constraints must remain present.');
  const estimatedInput = estimateManagedRequest(request);
  request.limits = { contextTokens: estimatedInput + 127, maxOutputTokens: 512 };
  let calls = 0;
  assert.throws(
    () =>
      prepareManagedRequest(request, {
        revision: 'unreached',
        prepare() {
          calls++;
          throw Error('must not run');
        },
      }),
    { code: 'MODEL_CONTEXT_EXHAUSTED' },
  );
  assert.equal(calls, 0);
  request.limits = { contextTokens: estimatedInput + 100, maxOutputTokens: 100 };
  assert.equal(prepareManagedRequest(request).maxOutputTokens, 100);
  request.limits.contextTokens--;
  assert.throws(() => prepareManagedRequest(request), { code: 'MODEL_CONTEXT_EXHAUSTED' });
});

test('core rejects understated input, raised caps, fractional or unusable policy decisions', () => {
  const request = input('x'.repeat(6500));
  const actual = estimateManagedRequest(request);
  for (const decision of [
    { estimatedInput: actual - 1, maxOutputTokens: 128, reason: 'policy-limit' },
    { estimatedInput: actual, maxOutputTokens: 4097, reason: 'policy-limit' },
    {
      estimatedInput: actual,
      maxOutputTokens: request.limits.contextTokens - actual + 1,
      reason: 'policy-limit',
    },
    { estimatedInput: actual, maxOutputTokens: 127, reason: 'policy-limit' },
    { estimatedInput: actual, maxOutputTokens: 128.5, reason: 'policy-limit' },
    { estimatedInput: actual, maxOutputTokens: NaN, reason: 'policy-limit' },
    { estimatedInput: actual, maxOutputTokens: 128, reason: 'unrecognized' },
    undefined,
  ]) {
    assert.throws(
      () =>
        prepareManagedRequest(request, {
          revision: 'test',
          prepare: () => decision,
        } as ManagedRequestPolicy),
      { code: 'INVALID_REQUEST_POLICY' },
    );
  }
});

test('policy sees a clone and cannot remove evidence, tools or limits from the dispatched request', () => {
  const request = input();
  request.schema = { required: ['complete'] };
  const before = structuredClone(request);
  const estimate = estimateManagedRequest(request);
  const decision = prepareManagedRequest(request, {
    revision: 'test',
    prepare(copy) {
      copy.messages[0].content = 'Removed task';
      copy.tools[0].parameters = {};
      (copy.schema as { required: string[] }).required.length = 0;
      copy.limits.contextTokens = 1000000;
      return { estimatedInput: estimate, maxOutputTokens: 256, reason: 'policy-limit' };
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

test('managed runtime sends the reduced cap with unchanged context and request evidence', async (t) => {
  const f = runtimeFixture();
  t.after(() => f.runtime.dispose());
  const session = await start(f.runtime);
  const text = 'Preserve this entire task. ' + 'x'.repeat(2200);
  await f.runtime.turn(session.threadId, text, turn());
  assert.equal(f.requests.length, 1);
  const sent = f.requests[0];
  assert.ok(sent.maxOutputTokens >= 128 && sent.maxOutputTokens < f.limits.maxOutputTokens);
  assert.equal(sent.contextTokens, f.limits.contextTokens);
  assert.equal(sent.maxOutputTokens, f.limits.contextTokens - estimateManagedRequest(sent));
  assert.ok(sent.messages.some((message) => message.content.includes(text)));
  assert.deepEqual(sent.tools, input().tools);
  assert.equal(f.checkpoints.get(session.threadId)?.requests, 1);
});

test('separate tool phase does not reserve a final schema that is not sent', async (t) => {
  const f = runtimeFixture({ separate: true });
  t.after(() => f.runtime.dispose());
  const session = await start(f.runtime);
  const schema = { type: 'object', description: 's'.repeat(5000) };
  await assert.rejects(f.runtime.turn(session.threadId, 'Inspect the task.', turn(schema)), {
    code: 'MODEL_CONTEXT_EXHAUSTED',
  });
  assert.equal(
    f.requests.length,
    1,
    'Work request fits; only the later actual final request is blocked',
  );
  assert.equal(f.requests[0].schema, undefined);
  assert.equal(f.requests[0].tools.length, 1);
  assert.equal(f.checkpoints.get(session.threadId)?.requests, 1);
});

test('invalid policy or impossible context cannot reach a provider', async (t) => {
  for (const configuration of [
    {
      requestPolicy: {
        revision: 'lie',
        prepare: () => ({
          estimatedInput: 0,
          maxOutputTokens: 256,
          reason: 'policy-limit' as const,
        }),
      },
    },
    { contextTokens: 1600, maxOutputTokens: 1500 },
  ]) {
    const f = runtimeFixture(configuration);
    t.after(() => f.runtime.dispose());
    const session = await start(f.runtime);
    await assert.rejects(f.runtime.turn(session.threadId, 'x'.repeat(2000), turn()), {
      code: configuration.requestPolicy ? 'INVALID_REQUEST_POLICY' : 'MODEL_CONTEXT_EXHAUSTED',
    });
    assert.equal(f.requests.length, 0);
    assert.equal(f.checkpoints.get(session.threadId)?.requests, 0);
  }
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
      requestPolicy: { ...conservativeRequestPolicy, revision },
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
