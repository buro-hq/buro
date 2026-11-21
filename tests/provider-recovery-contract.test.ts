import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { RuntimeRouter } from '../core/runtime-router.ts';
import type { ToolBroker } from '../core/model-ports.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import type { RuntimeEvent } from '../core/ports.ts';
import type { Run } from '../protocol/domain.ts';
import type { RuntimeResource } from '../protocol/resources.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import { OllamaProvider } from '../adapters/models/ollama.ts';
import { DeepSeekProvider } from '../adapters/models/deepseek.ts';
import { RequestGate } from '../adapters/models/http.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';

type Provider = 'ollama' | 'deepseek';
const privateContinuation = 'PRIVATE_COMPLETED_TOOL_REASONING';
const privateKey = 'PRIVATE_FAKE_RECOVERY_KEY';
const edit = { path: 'src/value.mjs', oldText: 'value=1', newText: 'value=2' };
const limits = {
  contextTokens: 32768,
  maxOutputTokens: 1024,
  maxRequestsPerTurn: 8,
  maxToolCallsPerTurn: 8,
  maxSessionRequests: 32,
};
const turnOptions = () => ({
  schema: { type: 'object' },
  signal: new AbortController().signal,
  timeoutMs: 5000,
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

/** Native envelopes deliberately allow a full tool call without its terminal marker. */
function wire(kind: Provider, options: { call?: 'partial' | 'full'; terminal?: boolean } = {}) {
  const { call, terminal = true } = options;
  const args = call === 'partial' ? '{"path":"src/value.mjs","oldText":' : JSON.stringify(edit);
  if (kind === 'ollama') {
    const message = {
      role: 'assistant',
      thinking: privateContinuation,
      ...(call
        ? {
            content: '',
            tool_calls: [{ function: { index: 0, name: 'edit_file', arguments: args } }],
          }
        : { content: terminal ? '{"ok":true}' : '{"ok":' }),
    };
    return (
      JSON.stringify({ model: 'fixture-model', message, done: false }) +
      '\n' +
      (terminal
        ? JSON.stringify({
            model: 'fixture-model',
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 12,
            eval_count: 8,
          }) + '\n'
        : '')
    );
  }
  const delta = {
    reasoning_content: privateContinuation,
    ...(call
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'edit-call',
              type: 'function',
              function: { name: 'edit_file', arguments: args },
            },
          ],
        }
      : { content: terminal ? '{"ok":true}' : '{"ok":' }),
  };
  return (
    'data: ' +
    JSON.stringify({
      model: 'fixture-model',
      choices: [
        {
          index: 0,
          delta,
          ...(call === 'full' || terminal ? { finish_reason: call ? 'tool_calls' : 'stop' } : {}),
        },
      ],
    }) +
    '\n\n' +
    (terminal ? 'data: [DONE]\n\n' : '')
  );
}
function response(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 13)
          controller.enqueue(bytes.slice(index, index + 13));
        controller.close();
      },
    }),
  );
}
function openResponse(
  text: string,
  signal: AbortSignal,
  opened: ReturnType<typeof deferred>,
  aborted: ReturnType<typeof deferred>,
) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        const abort = () => {
          controller.error(new DOMException('Fixture stream aborted', 'AbortError'));
          aborted.resolve();
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        opened.resolve();
      },
    }),
  );
}

async function fixture(t: any, kind: Provider) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'provider-recovery-')));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=1;\n');
  const profile = ProjectProfileSchema.parse({
    version: 1,
    revision: 1,
    context: '',
    scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: [] },
    checks: [],
    defaultCheckIds: [],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    maxRepairs: 0,
    turnTimeoutMs: 10000,
  });
  const store = await FileProjectStore.open({
    directory: path.join(root, '.buro'),
    project: { id: 'p', name: 'Recovery fixture', root },
    profile,
  });
  const run: Run = {
    id: 'R-fixture',
    key: 'G-fixture',
    goalId: 'G-fixture',
    title: 'Recover a provider turn',
    summary: '',
    createdAt: new Date().toISOString(),
    completedAt: '',
    threadId: '',
    status: 'running',
    phase: 'implementation',
    agents: [],
    events: [],
    commands: [],
    plan: [],
    changedFiles: [],
    baseline: { passed: 0, total: 0, results: [] },
    acceptance: { passed: 0, total: 0, results: [] },
    specsUnchanged: false,
    scopePreserved: false,
    independentReviewer: false,
    goalText: 'Exercise provider recovery without claiming acceptance.',
    result: '',
    sourceHash: '',
    workspace: root,
  };
  await store.transact('fixture-run', 'fixture-run', (doc) => {
    const goal = {
      id: run.goalId,
      projectId: 'p',
      title: run.title,
      body: run.goalText,
      criteria: '',
      createdAt: run.createdAt,
      status: 'running' as const,
      runId: run.id,
    };
    doc.goals.push(goal);
    doc.runs.push(run);
    return { result: null, change: { type: 'run.changed', run, goal } };
  });
  const projects = new FileProjectRegistry([store]);
  const directory = path.join(root, '.buro/local');
  const nativeByAssignment = new Map<string, string>();
  const rigs: { close: () => Promise<void> }[] = [];
  let edits = 0,
    selections = 0,
    denySelection = false;
  const make = (
    handle: (body: any, signal: AbortSignal, index: number) => Response | Promise<Response>,
    invoked: (body: any) => void = () => {},
  ) => {
    const requests: any[] = [];
    const http: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/api/show'))
        return Response.json({
          capabilities: ['completion', 'tools', 'thinking'],
          model_info: { 'fixture.context_length': 32768 },
        });
      assert.ok(String(url).endsWith(kind === 'ollama' ? '/api/chat' : '/chat/completions'));
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return handle(body, init!.signal!, requests.length - 1);
    };
    const gate = new RequestGate(1);
    const provider: ModelProvider =
      kind === 'ollama'
        ? new OllamaProvider({
            id: kind,
            endpoint: 'http://127.0.0.1:11434',
            think: true,
            gate,
            fetch: http,
          })
        : new DeepSeekProvider({
            id: kind,
            endpoint: 'https://api.deepseek.fixture',
            apiKey: () => privateKey,
            thinking: 'enabled',
            gate,
            fetch: http,
          });
    const complete = provider.complete.bind(provider);
    provider.complete = (input) => {
      const pending = complete(input);
      invoked(input);
      return pending;
    };
    const sessions = new FileManagedSessions(path.join(directory, 'sessions'));
    const routes = new FileRuntimeRoutes(path.join(directory, 'routes'));
    const actualTools = new RepositoryTools(new EnvironmentExecutors());
    const tools: ToolBroker = {
      definitions: (scope) => actualTools.definitions(scope),
      execute: async (...args) => {
        const [call, scope, options] = args;
        if (call.name === 'edit_file') {
          const checkpoint = await sessions.load(nativeByAssignment.get(scope.sessionId)!);
          assert.equal(
            checkpoint?.actions.find((action) => action.id === options.actionId)?.status,
            'pending',
            'A real tool must have a durable dispatch intent first',
          );
          edits++;
        }
        return actualTools.execute(...args);
      },
    };
    const managed = new ManagedAgentRuntime({
      id: 'managed',
      model: 'fixture-model',
      provider,
      projects,
      sessions,
      tools,
      limits,
      idGenerator: randomUUID,
    });
    const registry = new RuntimeCatalog();
    registry.register(managed);
    const resource: RuntimeResource = {
      capabilities: structuredClone(managed.capabilities),
      id: 'managed',
      client: 'managed',
      providerId: kind,
      model: 'fixture-model',
      local: provider.local,
      configurationRevision: provider.revision,
    };
    const selection = {
      forProject() {
        selections++;
        if (denySelection) throw Error('Saved sessions must not consult a newly selected default');
        return {
          profileId: 'fixture',
          policy: kind === 'ollama' ? ('local-only' as const) : ('hybrid' as const),
          coordinator: resource,
          worker: resource,
          reviewer: resource,
        };
      },
    };
    const router = new RuntimeRouter({
      registry,
      projects,
      selection,
      resources: [resource],
      routes,
      id: randomUUID,
    });
    const events: RuntimeEvent[] = [];
    router.subscribe((event) => events.push(event));
    const start = async () => {
      const sessionId = 'S-' + randomUUID();
      const started = await router.start({
        projectId: 'p',
        runId: 'R-fixture',
        workspace: root,
        purpose: 'implementation',
        instructions: 'Perform only the requested fixture edit.',
        assignment: { sessionId, roleId: 'builder', scope: structuredClone(profile.scope) },
      });
      const route = await routes.load(started.threadId);
      nativeByAssignment.set(sessionId, route!.externalThreadId!);
      return { threadId: started.threadId, nativeId: route!.externalThreadId! };
    };
    const close = async () => {
      await router.dispose();
      await registry.dispose();
    };
    rigs.push({ close });
    return { router, managed, sessions, routes, requests, events, resource, start, close };
  };
  t.after(async () => {
    try {
      for (const rig of rigs) await rig.close();
    } finally {
      await store.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    make,
    edits: () => edits,
    selections: () => selections,
    pinSavedRoutes: () => {
      denySelection = true;
    },
    read: () => fs.readFile(path.join(root, 'src/value.mjs'), 'utf8'),
  };
}
function assertPrivate(events: RuntimeEvent[]) {
  assert.doesNotMatch(JSON.stringify(events), new RegExp(privateContinuation + '|' + privateKey));
}
function assertInterrupted(events: RuntimeEvent[], status: 'failed' | 'interrupted') {
  const ended = events.filter((event) => event.type === 'turn.completed');
  assert.ok(ended.length > 0);
  assert.ok(ended.every((event) => event.type === 'turn.completed' && event.status === status));
  assert.equal(
    events.some((event) => event.type === 'message.completed'),
    false,
  );
  assertPrivate(events);
}
function unknownGenerationCause(expected: { code?: string; name?: string }) {
  return (error: any) => {
    assert.equal(error.code, 'GENERATION_RECONCILIATION_REQUIRED');
    assert.ok(error.cause, 'Keep the original observed transport cause');
    if (expected.code) assert.equal(error.cause.code, expected.code);
    if (expected.name) assert.equal(error.cause.name, expected.name);
    return true;
  };
}

for (const kind of ['ollama', 'deepseek'] as const) {
  test(`${kind}: partial and complete tool frames without a terminal marker never dispatch an edit`, async (t) => {
    for (const call of ['partial', 'full'] as const) {
      const f = await fixture(t, kind);
      const rig = f.make(() => response(wire(kind, { call, terminal: false })));
      const started = await rig.start();
      await assert.rejects(
        rig.router.turn(started.threadId, 'Edit the fixture', turnOptions()),
        unknownGenerationCause({ code: 'MODEL_STREAM_INTERRUPTED' }),
      );
      const saved = await rig.sessions.load(started.nativeId);
      assert.equal(saved?.status, 'failed');
      assert.deepEqual(saved?.actions, []);
      assert.equal(
        saved?.messages.some((message) => message.role === 'assistant'),
        false,
      );
      assert.equal(
        rig.requests.length,
        1,
        'An incomplete response must not trigger hidden retries',
      );
      assert.equal(f.edits(), 0);
      assert.equal(await f.read(), 'export const value=1;\n');
      assertInterrupted(rig.events, 'failed');
      await assert.rejects(rig.router.turn(started.threadId, 'Do not replay', turnOptions()), {
        code: 'GENERATION_RECONCILIATION_REQUIRED',
      });
      assert.equal(rig.requests.length, 1);
    }
  });

  test(`${kind}: restart retains the exact edit result, private continuation and saved Buro route after a known follow-up rejection`, async (t) => {
    const f = await fixture(t, kind);
    const first = f.make((_body, _signal, index) =>
      index === 0 ? response(wire(kind, { call: 'full' })) : new Response(null, { status: 429 }),
    );
    const started = await first.start();
    await assert.rejects(first.router.turn(started.threadId, 'Edit the fixture', turnOptions()), {
      code: 'MODEL_RATE_LIMITED',
    });
    const checkpoint = await first.sessions.load(started.nativeId),
      route = await first.routes.load(started.threadId);
    assert.equal(checkpoint?.status, 'failed');
    assert.equal(checkpoint?.actions.length, 1);
    assert.equal(checkpoint?.actions[0].status, 'completed');
    assert.match(checkpoint!.actions[0].result!.content, /Edited src\/value.mjs/);
    assert.equal(f.edits(), 1);
    assert.equal(first.requests.length, 2, 'A known rejection must not start a hidden retry');
    assert.equal(checkpoint?.generation?.outcome, 'completed');
    assert.equal(await f.read(), 'export const value=2;\n');
    assertInterrupted(first.events, 'failed');
    await first.close();

    f.pinSavedRoutes();
    const resumed = f.make(() => response(wire(kind)));
    assert.deepEqual(
      await resumed.routes.load(started.threadId),
      route,
      'Read the route from a new file-store instance',
    );
    assert.deepEqual(
      await resumed.router.resume({
        projectId: 'p',
        threadId: started.threadId,
        runId: 'R-fixture',
        workspace: f.root,
        instructions: 'Continue from the durable result without editing again.',
      }),
      { threadId: started.threadId },
    );
    const final = await resumed.router.turn(
      started.threadId,
      'Report the saved result as JSON',
      turnOptions(),
    );
    assert.deepEqual(JSON.parse(final.text), { ok: true });
    assert.equal(
      resumed.requests.length,
      kind === 'ollama' ? 2 : 1,
      'Only the explicit continuation and required final serialization may request generation',
    );
    assert.equal(
      f.selections(),
      1,
      'Resuming and turning a saved handle must not reselect its route',
    );
    assert.equal(f.edits(), 1);
    assert.equal((await resumed.routes.load(started.threadId))?.externalThreadId, started.nativeId);
    for (const body of resumed.requests) {
      const assistant = body.messages.find((message: any) => message.tool_calls?.length);
      const result = body.messages.find((message: any) => message.role === 'tool');
      assert.ok(assistant && result);
      assert.equal(
        kind === 'ollama' ? assistant.thinking : assistant.reasoning_content,
        privateContinuation,
      );
      assert.deepEqual(
        kind === 'ollama'
          ? assistant.tool_calls[0].function.arguments
          : JSON.parse(assistant.tool_calls[0].function.arguments),
        edit,
      );
      assert.match(result.content, /Edited src\/value.mjs/);
      if (kind === 'deepseek') assert.equal(result.tool_call_id, assistant.tool_calls[0].id);
    }
    const recovered = await resumed.sessions.load(started.nativeId);
    assert.equal(recovered?.actions.length, 1);
    assert.equal(recovered?.actions[0].status, 'completed');
    assert.equal(recovered?.scopeRevisions?.length, 2);
    assert.equal(
      (await fs.stat(path.join(f.root, '.buro/local/sessions', started.nativeId + '.json'))).mode &
        0o777,
      0o600,
    );
    assertPrivate(resumed.events);
  });

  test(`${kind}: a lost follow-up stream retains the completed edit but blocks generation replay after reopening`, async (t) => {
    const f = await fixture(t, kind);
    const first = f.make((_body, _signal, index) =>
      response(wire(kind, index === 0 ? { call: 'full' } : { terminal: false })),
    );
    const started = await first.start();
    await assert.rejects(
      first.router.turn(started.threadId, 'Edit the fixture', turnOptions()),
      unknownGenerationCause({ code: 'MODEL_STREAM_INTERRUPTED' }),
    );
    const checkpoint = await first.sessions.load(started.nativeId);
    const route = await first.routes.load(started.threadId);
    assert.equal(checkpoint?.generation?.outcome, 'unknown');
    assert.equal(checkpoint?.actions.length, 1);
    assert.equal(checkpoint?.actions[0].status, 'completed');
    assert.match(checkpoint!.actions[0].result!.content, /Edited src\/value.mjs/);
    assert.equal(f.edits(), 1);
    assert.equal(first.requests.length, 2);
    assert.equal(await f.read(), 'export const value=2;\n');
    await first.close();
    f.pinSavedRoutes();
    const reopened = f.make(() => {
      throw Error('Unknown requests must not reach HTTP');
    });
    assert.deepEqual(await reopened.routes.load(started.threadId), route);
    await assert.rejects(
      reopened.router.resume({
        projectId: 'p',
        threadId: started.threadId,
        runId: 'R-fixture',
        workspace: f.root,
        instructions: 'A new session must not hide an unknown outcome.',
      }),
      { code: 'GENERATION_RECONCILIATION_REQUIRED' },
    );
    await assert.rejects(reopened.router.turn(started.threadId, 'Do not replay', turnOptions()), {
      code: 'THREAD_NOT_FOUND',
    });
    assert.equal((await reopened.sessions.load(started.nativeId))?.generation?.outcome, 'unknown');
    assert.equal(reopened.requests.length, 0);
    assert.equal(f.edits(), 1);
    assert.equal(f.selections(), 1);
    assert.equal(await f.read(), 'export const value=2;\n');
    assertPrivate(first.events);
    assertPrivate(reopened.events);
  });

  for (const afterEdit of [false, true])
    test(`${kind}: cancelling active and queued streams ${afterEdit ? 'after a durable edit' : 'before a terminal tool call'} releases endpoint capacity`, async (t) => {
      const f = await fixture(t, kind);
      const opened = deferred(),
        aborted = deferred(),
        queued = deferred();
      let activeSignal: AbortSignal | undefined, queuedSignal: AbortSignal | undefined;
      let streaming = false;
      const rig = f.make(
        (body, signal, index) => {
          if (afterEdit && index === 0) return response(wire(kind, { call: 'full' }));
          if (!streaming) {
            streaming = true;
            return openResponse(
              wire(kind, afterEdit ? { terminal: false } : { call: 'full', terminal: false }),
              signal,
              opened,
              aborted,
            );
          }
          return response(wire(kind));
        },
        (input) => {
          if (
            input.messages.some(
              (message: any) =>
                message.role === 'user' && message.content.includes('queued-capacity'),
            )
          ) {
            queuedSignal = input.signal;
            queued.resolve();
          } else if (
            input.messages.some(
              (message: any) =>
                message.role === 'user' && message.content.includes('active-capacity'),
            )
          )
            activeSignal = input.signal;
        },
      );
      const active = await rig.start(),
        waiting = await rig.start();
      const activeWork = rig.router.turn(active.threadId, 'active-capacity', turnOptions());
      const activeRejected = assert.rejects(
        activeWork,
        unknownGenerationCause({ name: 'AbortError' }),
      );
      await opened.promise;
      const waitingWork = rig.router.turn(waiting.threadId, 'queued-capacity', turnOptions());
      const waitingRejected = assert.rejects(waitingWork, { name: 'AbortError' });
      await queued.promise;
      const startedTurn = (id: string) =>
        rig.events.find(
          (event) => event.threadId === id && event.type === 'turn.started',
        ) as Extract<RuntimeEvent, { type: 'turn.started' }>;
      await rig.router.interrupt(waiting.threadId, startedTurn(waiting.threadId).turnId!);
      assert.equal(
        queuedSignal?.aborted,
        true,
        'Interrupt must abort the waiting provider signal before returning',
      );
      await waitingRejected;
      await rig.router.interrupt(active.threadId, startedTurn(active.threadId).turnId!);
      assert.equal(
        activeSignal?.aborted,
        true,
        'Interrupt must abort the active provider signal before the inactivity timer',
      );
      await Promise.all([activeRejected, aborted.promise]);
      const activeSaved = await rig.sessions.load(active.nativeId),
        queuedSaved = await rig.sessions.load(waiting.nativeId);
      for (const saved of [activeSaved, queuedSaved]) {
        assert.equal(saved?.status, 'interrupted');
        assert.equal(saved?.cancelRequested, true);
      }
      assert.equal(activeSaved?.generation?.outcome, 'unknown');
      assert.equal(
        queuedSaved?.generation?.outcome,
        'completed',
        'Cancellation before HTTP dispatch is a known no-effect outcome, not a poisoned session',
      );
      assert.equal(activeSaved?.actions.length, afterEdit ? 1 : 0);
      if (afterEdit) assert.equal(activeSaved?.actions[0].status, 'completed');
      assert.deepEqual(queuedSaved?.actions, []);
      assert.equal(f.edits(), afterEdit ? 1 : 0);
      assert.equal(
        await f.read(),
        afterEdit ? 'export const value=2;\n' : 'export const value=1;\n',
      );
      assertInterrupted(rig.events, 'interrupted');
      assert.equal(
        rig.requests.length,
        afterEdit ? 2 : 1,
        'Only the active stream (and preceding edit round) may reach generation before cancellation',
      );

      const fresh = await rig.start();
      await rig.router.turn(fresh.threadId, 'fresh-capacity', turnOptions());
      assert.ok(
        rig.requests.some((body) =>
          body.messages.some((message: any) => message.content.includes('fresh-capacity')),
        ),
        'A later request must acquire the released endpoint slot',
      );
      assert.equal(
        rig.requests.some((body) =>
          body.messages.some((message: any) => message.content.includes('queued-capacity')),
        ),
        false,
        'A cancelled queue entry must never reach HTTP generation',
      );
      assert.equal(f.edits(), afterEdit ? 1 : 0);
      assertPrivate(rig.events);
      await rig.router.resume({
        projectId: 'p',
        threadId: waiting.threadId,
        runId: 'R-fixture',
        workspace: f.root,
        instructions: 'Continue after the queue cancellation was confirmed.',
      });
      await rig.router.turn(
        waiting.threadId,
        'Explicit continuation after queue cancellation',
        turnOptions(),
      );
      const continued = await rig.sessions.load(waiting.nativeId);
      assert.equal(continued?.generation?.outcome, 'completed');
      assert.equal(continued?.cancelRequested, false);
      assert.equal(f.edits(), afterEdit ? 1 : 0);
      assertPrivate(rig.events);
    });
}
