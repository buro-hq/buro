import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import { DeepSeekProvider } from '../adapters/models/deepseek.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import type { ManagedSessionStore, ToolBroker } from '../core/model-ports.ts';
import type { RuntimeEvent } from '../core/ports.ts';

const reasoning = 'PRIVATE_CANONICAL_SDK_CONTINUATION';
const receiptFailure = () => Error('Synthetic receipt storage failure');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function wire(labels: string[] = []) {
  return new Response(
    'data: ' +
      JSON.stringify({
        model: 'fixture-model',
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: reasoning,
              ...(labels.length
                ? {
                    tool_calls: labels.map((label, index) => ({
                      index,
                      id: 'provider-call-' + index,
                      type: 'function',
                      function: { name: 'append_fixture', arguments: JSON.stringify({ label }) },
                    })),
                  }
                : { content: '{"ok":true}' }),
            },
            finish_reason: labels.length ? 'tool_calls' : 'stop',
          },
        ],
      }) +
      '\n\ndata: [DONE]\n\n',
  );
}
async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-managed-recovery-')));
  const effects = path.join(root, 'effects.log');
  await fs.writeFile(effects, '');
  const store = await FileProjectStore.open({
    directory: path.join(root, 'state'),
    project: { id: 'p', name: 'SDK recovery fixture', root },
  });
  const projects = new FileProjectRegistry([store]);
  const directory = path.join(root, 'private-sessions');
  const sessions = new FileManagedSessions(directory);
  const runtimes: ManagedAgentRuntime[] = [];
  const requests: any[] = [];
  const events: RuntimeEvent[] = [];
  let brokerCalls = 0,
    ambientRequests = 0;
  const ambient = globalThis.fetch;
  globalThis.fetch = async () => {
    ambientRequests++;
    throw Error('The SDK may not perform ambient networking.');
  };
  const make = (
    options: {
      sessions?: ManagedSessionStore;
      respond?: (index: number, body: any) => Response;
      execute?: ToolBroker['execute'];
    } = {},
  ) => {
    const provider = new DeepSeekProvider({
      id: 'deepseek',
      endpoint: 'https://provider.invalid',
      apiKey: () => 'SYNTHETIC_SDK_KEY',
      fetch: async (url, init) => {
        assert.equal(new URL(String(url)).pathname, '/chat/completions');
        const body = JSON.parse(String(init!.body));
        requests.push(structuredClone(body));
        return options.respond?.(requests.length - 1, body) || wire(['first', 'second']);
      },
    });
    const runtime = new ManagedAgentRuntime({
      id: 'managed-fixture',
      model: 'fixture-model',
      provider,
      loopRunner: new PiAgentLoopRunner(),
      projects,
      sessions: options.sessions || sessions,
      idGenerator: () => crypto.randomUUID(),
      limits: {
        contextTokens: 32768,
        maxOutputTokens: 1024,
        maxRequestsPerTurn: 8,
        maxToolCallsPerTurn: 8,
        maxSessionRequests: 32,
      },
      tools: {
        definitions: () => [
          {
            name: 'append_fixture',
            description: 'Append an isolated fixture observation.',
            parameters: {
              type: 'object',
              properties: { label: { type: 'string' } },
              required: ['label'],
              additionalProperties: false,
            },
          },
        ],
        async execute(...args) {
          brokerCalls++;
          if (options.execute) return options.execute(...args);
          const label = (args[0].arguments as { label: string }).label;
          await fs.appendFile(effects, label + '\n');
          return { content: 'Recorded ' + label };
        },
      },
    });
    runtime.subscribe((event) => events.push(event));
    runtimes.push(runtime);
    return runtime;
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    globalThis.fetch = ambient;
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    directory,
    sessions,
    effects,
    requests,
    events,
    make,
    brokerCalls: () => brokerCalls,
    ambientRequests: () => ambientRequests,
  };
}

for (const cancelParent of [false, true])
  test(
    `actual SDK receipt failure preserves the first file effect and blocks replay${cancelParent ? ' even when parent cancellation races' : ' without aborting the parent'}`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t),
        failure = receiptFailure(),
        entered = deferred(),
        release = deferred();
      const parent = new AbortController();
      let settled = false;
      const runtime = f.make({
        sessions: {
          load: (id) => f.sessions.load(id),
          async save(next) {
            if (next.actions.some((action) => action.result?.content === 'Recorded first')) {
              entered.resolve();
              if (cancelParent) await release.promise;
              throw failure;
            }
            await f.sessions.save(next);
          },
        },
      });
      const { threadId } = await runtime.start({
        projectId: 'p',
        runId: 'R-fixture',
        workspace: f.root,
        instructions: 'Append only isolated fixture observations.',
      });
      const pending = runtime
        .turn(threadId, 'Append both observations.', {
          schema: {},
          signal: parent.signal,
          timeoutMs: 3000,
        })
        .finally(() => {
          settled = true;
        });
      let marker: any;
      const rejected = assert.rejects(pending, (error: any) => {
        marker = error;
        assert.equal(error.code, 'ACTION_RECONCILIATION_REQUIRED');
        assert.equal(
          error.cause,
          failure,
          'The SDK must retain the original host receipt failure.',
        );
        return true;
      });
      try {
        await entered.promise;
        if (cancelParent) {
          parent.abort();
          await Promise.resolve();
          assert.equal(settled, false, 'Cancellation must drain the admitted host callback.');
        }
      } finally {
        release.resolve();
      }
      await rejected;
      assert.equal(parent.signal.aborted, cancelParent);
      assert.equal(await fs.readFile(f.effects, 'utf8'), 'first\n');
      assert.equal(f.brokerCalls(), 1);
      assert.equal(f.requests.length, 1);
      assert.equal(f.ambientRequests(), 0);
      assert.equal(
        f.events.some((event) => event.type === 'message.completed'),
        false,
      );
      assert.equal(
        f.events.some((event) => event.type === 'turn.completed' && event.status === 'completed'),
        false,
      );
      assert.ok(
        f.events.some(
          (event) =>
            event.type === 'turn.completed' &&
            event.status === (cancelParent ? 'interrupted' : 'failed'),
        ),
      );
      const reopened = new FileManagedSessions(f.directory);
      const saved = (await reopened.load(threadId))!;
      assert.equal(saved.generation!.outcome, 'completed');
      assert.deepEqual(saved.generation!.response!.message.continuation, {
        reasoningContent: reasoning,
      });
      assert.deepEqual(
        saved.actions.map((action) => action.status),
        ['pending', 'pending'],
      );
      assert.equal(marker.reference.operationId, saved.actions[0].id);
      await runtime.dispose();
      const restarted = f.make({
        sessions: reopened,
        respond() {
          throw Error('Unknown effects cannot dispatch another HTTP request.');
        },
      });
      await assert.rejects(
        restarted.resume({
          projectId: 'p',
          runId: 'R-fixture',
          workspace: f.root,
          threadId,
          instructions: 'Do not repeat an unresolved effect.',
        }),
        { code: 'ACTION_RECONCILIATION_REQUIRED' },
      );
      await assert.rejects(
        restarted.turn(threadId, 'Do not replay.', {
          schema: {},
          signal: new AbortController().signal,
          timeoutMs: 3000,
        }),
        { code: 'ACTION_RECONCILIATION_REQUIRED' },
      );
      assert.deepEqual(await reopened.load(threadId), saved);
      assert.equal(f.requests.length, 1);
      assert.equal(f.brokerCalls(), 1);
      assert.doesNotMatch(
        JSON.stringify(f.events),
        /PRIVATE_CANONICAL_SDK_CONTINUATION|SYNTHETIC_SDK_KEY/,
      );
    },
  );

test('an ordinary broker error remains model feedback through the actual SDK while private continuation stays canonical', async (t) => {
  const f = await fixture(t),
    parent = new AbortController();
  const runtime = f.make({
    respond(index, body) {
      if (index === 0) return wire(['first']);
      assert.equal(index, 1, 'A normal tool error requires only the next explicit model response.');
      const assistant = body.messages.find((message: any) => message.tool_calls?.length);
      const tool = body.messages.find((message: any) => message.role === 'tool');
      assert.equal(assistant.reasoning_content, reasoning);
      assert.equal(tool.tool_call_id, assistant.tool_calls[0].id);
      assert.equal(tool.content, 'Expected fixture validation failure.');
      return wire();
    },
    async execute() {
      return { content: 'Expected fixture validation failure.', isError: true };
    },
  });
  const { threadId } = await runtime.start({
    projectId: 'p',
    runId: 'R-fixture',
    workspace: f.root,
    instructions: 'Use model feedback for ordinary tool errors.',
  });
  const answer = await runtime.turn(threadId, 'Inspect the fixture.', {
    schema: {},
    signal: parent.signal,
    timeoutMs: 3000,
  });
  assert.deepEqual(JSON.parse(answer.text), { ok: true });
  assert.equal(parent.signal.aborted, false);
  assert.equal(f.requests.length, 2);
  assert.equal(f.brokerCalls(), 1);
  assert.equal(f.ambientRequests(), 0);
  const saved = (await new FileManagedSessions(f.directory).load(threadId))!;
  assert.equal(saved.status, 'ready');
  assert.equal(saved.actions[0].status, 'completed');
  assert.equal(saved.actions[0].result!.isError, true);
  assert.equal(saved.generation!.outcome, 'completed');
  assert.equal(
    saved.generation!.response!.usage,
    undefined,
    'SDK placeholder usage must not become observed model usage.',
  );
  assert.equal(saved.usage.requestsWithUsage, 0);
  assert.deepEqual(saved.messages.find((message) => message.toolCalls?.length)!.continuation, {
    reasoningContent: reasoning,
  });
  assert.equal(f.events.filter((event) => event.type === 'message.completed').length, 1);
  assert.doesNotMatch(
    JSON.stringify(f.events),
    /PRIVATE_CANONICAL_SDK_CONTINUATION|SYNTHETIC_SDK_KEY/,
  );
});
