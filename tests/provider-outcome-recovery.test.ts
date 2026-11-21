import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { OllamaProvider } from '../adapters/models/ollama.ts';
import { DeepSeekProvider } from '../adapters/models/deepseek.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { recordableRuntimeEvent } from '../core/runtime-events.ts';
import type { RuntimeEvent } from '../core/ports.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';

async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'provider-outcomes-')));
  const store = await FileProjectStore.open({
    directory: path.join(root, 'state'),
    project: { id: 'p', name: 'Provider outcome fixture', root },
  });
  const projects = new FileProjectRegistry([store]);
  const directory = path.join(root, 'private-sessions');
  const runtimes: ManagedAgentRuntime[] = [];
  let toolCalls = 0;
  const make = (provider: ModelProvider) => {
    const sessions = new FileManagedSessions(directory);
    const runtime = new ManagedAgentRuntime({
      loopRunner: new PiAgentLoopRunner(),
      id: 'managed-fixture',
      model: 'fixture-model',
      projects,
      sessions,
      provider,
      limits: {
        contextTokens: 32768,
        maxOutputTokens: 1024,
        maxRequestsPerTurn: 8,
        maxToolCallsPerTurn: 8,
        maxSessionRequests: 16,
      },
      tools: {
        definitions: () => [
          { name: 'read_file', description: 'Read fixture input', parameters: { type: 'object' } },
        ],
        async execute() {
          toolCalls++;
          throw Error('An incomplete provider response cannot dispatch tools.');
        },
      },
      idGenerator: () => crypto.randomUUID(),
    });
    runtimes.push(runtime);
    return { runtime, sessions };
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, make, toolCalls: () => toolCalls };
}
const options = () => ({
  schema: { type: 'object' },
  signal: new AbortController().signal,
  timeoutMs: 2000,
});

test('Ollama metadata failure settles the private generation as not dispatched and permits an explicit retry after reopening', async (t) => {
  const f = await fixture(t);
  const firstRoutes: string[] = [];
  const first = f.make(
    new OllamaProvider({
      id: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      fetch: async (url) => {
        firstRoutes.push(new URL(String(url)).pathname);
        return new Response('', { status: 503 });
      },
    }),
  );
  const started = await first.runtime.start({
    projectId: 'p',
    runId: 'R-fixture',
    workspace: f.root,
    instructions: 'Fixture only.',
  });
  await assert.rejects(first.runtime.turn(started.threadId, 'Respond as JSON.', options()), {
    code: 'MODEL_UNAVAILABLE',
  });
  assert.deepEqual(firstRoutes, ['/api/show']);
  const checkpoint = await first.sessions.load(started.threadId);
  assert.equal(checkpoint!.generation!.outcome, 'completed');
  assert.equal(checkpoint!.generation!.rejectionCode, 'MODEL_UNAVAILABLE');
  assert.equal(checkpoint!.generation!.response, undefined);
  assert.deepEqual(checkpoint!.actions, []);
  await first.runtime.dispose();

  const nextRoutes: string[] = [];
  const reopened = f.make(
    new OllamaProvider({
      id: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      fetch: async (url) => {
        const route = new URL(String(url)).pathname;
        nextRoutes.push(route);
        if (route === '/api/show')
          return Response.json({
            capabilities: ['completion', 'tools'],
            model_info: { 'fixture.context_length': 32768 },
          });
        assert.equal(route, '/api/chat');
        return new Response(
          JSON.stringify({
            model: 'fixture-model',
            message: { role: 'assistant', content: '{"ok":true}' },
            done: true,
            done_reason: 'stop',
          }) + '\n',
        );
      },
    }),
  );
  assert.deepEqual(await reopened.sessions.load(started.threadId), checkpoint);
  assert.equal(
    nextRoutes.length,
    0,
    'Loading a settled checkpoint cannot automatically retry the metadata or generation.',
  );
  await reopened.runtime.resume({
    projectId: 'p',
    runId: 'R-fixture',
    workspace: f.root,
    threadId: started.threadId,
    instructions: 'Explicitly try again.',
  });
  assert.equal(
    nextRoutes.length,
    0,
    'Resuming prepares the session without dispatching a generation.',
  );
  const result = await reopened.runtime.turn(started.threadId, 'Respond as JSON.', options());
  assert.deepEqual(JSON.parse(result.text), { ok: true });
  assert.deepEqual(nextRoutes, ['/api/show', '/api/chat', '/api/show', '/api/chat']);
  assert.equal(
    nextRoutes.filter((route) => route === '/api/chat').length,
    2,
    'Only the explicit work request and its required structured final response generate output.',
  );
  assert.equal(f.toolCalls(), 0);
});

test('a known-looking DeepSeek stream error remains durably unknown after a visible delta and cannot replay after reopening', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const create = () =>
    new DeepSeekProvider({
      id: 'deepseek',
      endpoint: 'https://provider.invalid',
      apiKey: () => 'SYNTHETIC_KEY',
      fetch: async () => {
        requests++;
        return new Response(
          'data: ' +
            JSON.stringify({
              model: 'fixture-model',
              choices: [
                {
                  index: 0,
                  delta: {
                    content: '{"ok":',
                    reasoning_content: 'PRIVATE_REASONING',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'uncommitted-call',
                        type: 'function',
                        function: { name: 'read_file', arguments: '{"path":"src/value.ts"}' },
                      },
                    ],
                  },
                },
              ],
            }) +
            '\n\n' +
            'data: {"error":{"message":"PRIVATE_PROVIDER_ERROR"}}\n\n',
        );
      },
    });
  const first = f.make(create());
  const events: RuntimeEvent[] = [];
  first.runtime.subscribe((event) => events.push(event));
  const started = await first.runtime.start({
    projectId: 'p',
    runId: 'R-fixture',
    workspace: f.root,
    instructions: 'Fixture only.',
  });
  await assert.rejects(
    first.runtime.turn(started.threadId, 'Respond as JSON.', options()),
    (error: any) => {
      assert.equal(error.code, 'GENERATION_RECONCILIATION_REQUIRED');
      assert.equal(error.cause.code, 'MODEL_REQUEST_REJECTED');
      assert.equal(error.cause.cause.outcome, 'unknown');
      return true;
    },
  );
  const checkpoint = await first.sessions.load(started.threadId);
  assert.equal(checkpoint!.generation!.outcome, 'unknown');
  assert.equal(checkpoint!.generation!.response, undefined);
  assert.deepEqual(checkpoint!.actions, []);
  assert.equal(
    checkpoint!.messages.some((message) => message.role === 'assistant'),
    false,
  );
  assert.equal(requests, 1);
  const delta = events.find((event) => event.type === 'message.delta');
  assert.ok(delta && delta.type === 'message.delta');
  assert.equal(delta.text, '{"ok":');
  assert.equal(delta.requestId, `${delta.turnId}:0`);
  assert.equal(recordableRuntimeEvent({ ...delta, runId: 'R-fixture' }), false);
  assert.equal(
    events.some((event) => event.type === 'message.completed'),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /PRIVATE_REASONING|PRIVATE_PROVIDER_ERROR|SYNTHETIC_KEY/,
  );
  await first.runtime.dispose();

  const reopened = f.make(create());
  assert.deepEqual(await reopened.sessions.load(started.threadId), checkpoint);
  await assert.rejects(
    reopened.runtime.resume({
      projectId: 'p',
      runId: 'R-fixture',
      workspace: f.root,
      threadId: started.threadId,
      instructions: 'Must not repeat unknown work.',
    }),
    { code: 'GENERATION_RECONCILIATION_REQUIRED' },
  );
  await assert.rejects(reopened.runtime.turn(started.threadId, 'Must not replay.', options()), {
    code: 'GENERATION_RECONCILIATION_REQUIRED',
  });
  assert.equal(requests, 1);
  assert.equal(f.toolCalls(), 0);
  assert.deepEqual(await reopened.sessions.load(started.threadId), checkpoint);
});
