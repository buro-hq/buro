import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ManagedAgentRuntime, type ManagedRuntimeOptions } from '../core/managed-runtime.ts';
import type { ManagedSessionStore, ToolBroker, ToolScope } from '../core/model-ports.ts';
import type {
  ModelContext,
  ModelMessage,
  ModelProvider,
  ModelToolCall,
} from '../agent/contracts/model.ts';
import type { RuntimeEvent } from '../core/ports.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import { OllamaProvider } from '../adapters/models/ollama.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { ProjectChecks } from '../adapters/checks/project-commands.ts';
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
const exec = promisify(execFile);
const limits = {
  contextTokens: 100000,
  maxOutputTokens: 2000,
  maxRequestsPerTurn: 12,
  maxToolCallsPerTurn: 20,
  maxSessionRequests: 100,
};
const response = (calls: ModelToolCall[] = [], content = '{"ok":true}') => ({
  model: 'fixture-model',
  finish: calls.length ? ('tools' as const) : ('stop' as const),
  message: {
    role: 'assistant' as const,
    content: calls.length ? '' : content,
    ...(calls.length ? { toolCalls: calls } : {}),
    continuation: { private: 'PRIVATE_PROVIDER_STATE' },
  },
});
function provider(complete: ModelProvider['complete']): ModelProvider {
  return { id: 'fake', revision: '1', local: true, complete };
}
async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-managed-')));
  const git = (args: string[]) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'checks'));
  await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=1;\n');
  await fs.writeFile(
    path.join(root, 'checks/value.test.mjs'),
    "import assert from 'node:assert/strict';import {value} from '../src/value.mjs';assert.equal(value,2);\n",
  );
  await fs.writeFile(path.join(root, '.gitignore'), '.buro/\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture']);
  const profile = ProjectProfileSchema.parse({
    version: 1,
    revision: 1,
    context: 'Fixture project',
    allowedPaths: ['src/'],
    protectedPaths: ['checks/'],
    checks: [
      {
        id: 'test',
        title: 'Tests',
        command: 'node --test checks/value.test.mjs',
        timeoutMs: 10000,
      },
    ],
    defaultCheckIds: ['test'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    maxRepairs: 0,
    turnTimeoutMs: 10000,
    baseBranch: 'main',
  });
  const store = await FileProjectStore.open({
    directory: path.join(root, '.buro'),
    project: { id: 'p', name: 'Fixture', root },
    profile,
  });
  const projects = new FileProjectRegistry([store]);
  const executors = new EnvironmentExecutors();
  const tools = new RepositoryTools(executors);
  const sessions = new FileManagedSessions(path.join(root, '.buro/local/managed'));
  const runtimes: ManagedAgentRuntime[] = [];
  const make = (p: ModelProvider, overrides: Partial<ManagedRuntimeOptions> = {}) => {
    const runtime = new ManagedAgentRuntime({
      id: 'managed-fixture',
      model: 'fixture-model',
      provider: p,
      sessions,
      tools,
      projects,
      idGenerator: randomUUID,
      limits,
      ...overrides,
    });
    runtimes.push(runtime);
    return runtime;
  };
  const start = (runtime: ManagedAgentRuntime, readOnly = false) =>
    runtime.start({
      projectId: 'p',
      runId: 'R-fixture',
      workspace: root,
      instructions: 'Fixture instructions',
      readOnly,
      assignment: {
        sessionId: 'S-fixture',
        roleId: 'builder',
        allowedPaths: ['src/'],
        protectedPaths: ['checks/'],
      },
    });
  t.after(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, git, profile, store, projects, tools, executors, sessions, make, start };
}
const turnOptions = () => ({
  schema: { type: 'object' },
  signal: new AbortController().signal,
  timeoutMs: 10000,
});

test('managed execution reads, edits and checks a real worktree, then independently accepts without Codex', async (t) => {
  const f = await fixture(t);
  const model = provider(async (input) => {
    const lastUser = input.messages.map((m) => m.role).lastIndexOf('user');
    const prompt = input.messages[lastUser].content;
    const toolMessages = input.messages.slice(lastUser + 1).filter((m) => m.role === 'tool');
    if (prompt.startsWith('First,'))
      return response(
        [],
        JSON.stringify({
          summary: 'Update value',
          steps: [
            { step: 'Implement value', owner: 'builder' },
            { step: 'Review', owner: 'reviewer' },
          ],
          team: [
            {
              roleId: 'builder',
              action: 'create',
              title: 'Builder',
              description: 'Implementation',
              instructions: 'Implement the assigned change.',
              kind: 'implementation',
              paths: ['src/value.mjs'],
            },
          ],
        }),
      );
    if (prompt.startsWith('Execute your assigned work')) {
      const calls: ModelToolCall[] = [
        { id: 'read', name: 'read_file', arguments: { path: 'src/value.mjs' } },
        {
          id: 'edit',
          name: 'edit_file',
          arguments: { path: 'src/value.mjs', oldText: 'value=1', newText: 'value=2' },
        },
        { id: 'check', name: 'run_command', arguments: { command: f.profile.checks[0].command } },
      ];
      if (toolMessages.length) {
        assert.ok(input.messages.some((message) => message.continuation));
        const ids = (await fs.readdir(path.join(f.root, '.buro/local/managed'))).filter((name) =>
          name.endsWith('.json'),
        );
        const saved = await Promise.all(ids.map((name) => f.sessions.load(name.slice(0, -5))));
        const checkpoint = saved.find(
          (session) => session?.messages.at(-1)?.toolCallId === toolMessages.at(-1)?.toolCallId,
        )!;
        assert.equal(checkpoint.actions.at(-1)?.status, 'completed');
        assert.equal(checkpoint.messages.at(-1)?.content, toolMessages.at(-1)?.content);
      }
      if (toolMessages.length < calls.length) return response([calls[toolMessages.length]]);
      assert.match(toolMessages[2].content, /"exitCode":0/);
      return response(
        [],
        JSON.stringify({
          status: 'success',
          summary: 'Changed value to two',
          artifacts: ['src/value.mjs'],
          notesForNextAgent: '',
        }),
      );
    }
    if (prompt.startsWith('Review goal')) {
      if (!toolMessages.length) return response([{ id: 'diff', name: 'read_diff', arguments: {} }]);
      assert.match(toolMessages[0].content, /value=2/);
      return response(
        [],
        JSON.stringify({
          verdict: 'approved',
          blockingFindings: [],
          summary: 'Actual diff inspected',
        }),
      );
    }
    return response(
      [],
      JSON.stringify({
        status: 'success',
        summary: 'Integrated worker result',
        artifacts: ['src/value.mjs'],
        notesForNextAgent: '',
      }),
    );
  });
  const runtime = f.make(model);
  const workspaces = new GitWorkspaces(f.projects);
  const prepare = workspaces.prepare.bind(workspaces);
  workspaces.prepare = async (...args) => {
    const workspace = await prepare(...args);
    await f.executors.register(
      workspace.path,
      f.root,
      { provider: 'native' },
      new AbortController().signal,
    );
    return workspace;
  };
  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  const policy = {
    ...f.profile,
    profile: f.profile,
    checks: f.profile.checks.map(({ id, title }) => ({ id, title })),
  };
  const checks = new ProjectChecks(
    f.projects,
    {
      async run() {
        throw Error('Unexpected check fallback');
      },
    },
    f.executors,
  );
  const env = { projects: f.projects, now: () => new Date().toISOString(), id: randomUUID };
  const engine = new ExecutionService({
    ...env,
    runtime,
    workspaces,
    checks,
    policies: { p: policy },
  });
  t.after(() => engine.dispose());
  const goal = await new GoalService(env).create('goal', 'goal', {
    projectId: 'p',
    title: 'Change value',
    body: 'Set value to two',
    criteria: 'The trusted test passes',
  });
  const started = await engine.start('start', 'start', { projectId: 'p', goalId: goal.id });
  await engine.jobs.get(started.runId)?.promise;
  const run = engine.get('p', started.runId);
  assert.equal(run.status, 'completed', run.result);
  assert.ok(run.commit);
  assert.equal(run.independentReviewer, true);
  assert.equal(run.acceptance.passed, 1);
  assert.equal(
    await fs.readFile(path.join(f.root, 'src/value.mjs'), 'utf8'),
    'export const value=1;\n',
  );
  assert.equal(
    await fs.readFile(path.join(run.workspace!, 'src/value.mjs'), 'utf8'),
    'export const value=2;\n',
  );
  assert.doesNotMatch(JSON.stringify([events, f.store.snapshot()]), /PRIVATE_PROVIDER_STATE/);
  const worker = run.agents.find((agent) => agent.session?.roleId === 'builder')!;
  const checkpoint = await f.sessions.load(worker.threadId);
  assert.equal(checkpoint?.actions.length, 3);
  assert.ok(checkpoint?.actions.every((action) => action.status === 'completed'));
  assert.match(JSON.stringify(checkpoint), /PRIVATE_PROVIDER_STATE/);
  assert.equal(
    (await fs.stat(path.join(f.root, '.buro/local/managed', worker.threadId + '.json'))).mode &
      0o777,
    0o600,
  );
});

test('tool intent and result persistence failures never repeat a possibly completed edit', async (t) => {
  for (const failure of ['intent', 'result']) {
    const f = await fixture(t);
    let effects = 0,
      requests = 0;
    const p = provider(async () => {
      requests++;
      return response([
        {
          id: 'edit',
          name: 'edit_file',
          arguments: { path: 'src/value.mjs', oldText: 'value=1', newText: 'value=2' },
        },
      ]);
    });
    const sessions: ManagedSessionStore = {
      load: (id) => f.sessions.load(id),
      save: async (session) => {
        if (
          session.actions.some((action) =>
            failure === 'intent' ? action.status === 'pending' : action.status === 'completed',
          )
        )
          throw Error('disk failed');
        return f.sessions.save(session);
      },
    };
    const tools: ToolBroker = {
      definitions: (scope) => f.tools.definitions(scope),
      execute: async (...args) => {
        effects++;
        return f.tools.execute(...args);
      },
    };
    const runtime = f.make(p, { sessions, tools });
    const { threadId } = await f.start(runtime);
    await assert.rejects(
      runtime.turn(threadId, 'Edit', turnOptions()),
      failure === 'intent' ? /disk failed/ : { code: 'ACTION_RECONCILIATION_REQUIRED' },
    );
    assert.equal(effects, failure === 'intent' ? 0 : 1);
    await runtime.dispose();
    const restored = f.make(p);
    const restore = () =>
      restored.resume({
        projectId: 'p',
        threadId,
        workspace: f.root,
        runId: 'R-fixture',
        instructions: 'Continue',
      });
    if (failure === 'intent') await restore();
    else await assert.rejects(restore(), { code: 'ACTION_RECONCILIATION_REQUIRED' });
    assert.equal(requests, 1);
    assert.equal(effects, failure === 'intent' ? 0 : 1);
  }
});

test('duplicate tool IDs and exhausted token budgets stop before dispatch', async (t) => {
  const f = await fixture(t);
  let effects = 0,
    requests = 0;
  const p = provider(async () => {
    requests++;
    return response([
      { id: 'same', name: 'x', arguments: {} },
      { id: 'same', name: 'x', arguments: {} },
    ]);
  });
  const tools: ToolBroker = {
    definitions: () => [],
    execute: async () => {
      effects++;
      return { content: 'done' };
    },
  };
  const runtime = f.make(p, { tools });
  const { threadId } = await f.start(runtime);
  await assert.rejects(runtime.turn(threadId, 'Work', turnOptions()), {
    code: 'DUPLICATE_TOOL_CALL',
  });
  assert.equal(effects, 0);
  const small = f.make(p, {
    tools,
    limits: { ...limits, contextTokens: 1000, maxOutputTokens: 100 },
  });
  const second = await f.start(small);
  await assert.rejects(small.turn(second.threadId, 'x'.repeat(2000), turnOptions()), {
    code: 'MODEL_CONTEXT_EXHAUSTED',
  });
  assert.equal(requests, 1);
});

test('separate structured output keeps the final schema out of tool requests and publishes only the final answer', async (t) => {
  const f = await fixture(t);
  const schema = {
    type: 'object',
    properties: { final_schema_only_marker: { type: 'string' } },
    required: ['final_schema_only_marker'],
    additionalProperties: false,
  };
  const candidate = 'PRIVATE_INTERMEDIATE_CANDIDATE';
  const final = '{"final_schema_only_marker":"verified"}';
  const events: RuntimeEvent[] = [];
  let requests = 0;
  const p: ModelProvider = {
    ...provider(async (input) => {
      requests++;
      if (requests < 3) {
        assert.equal(
          input.schema,
          undefined,
          'The tools phase must not request final structured output',
        );
        assert.ok(input.tools.length > 0);
        assert.doesNotMatch(JSON.stringify(input.messages), /final_schema_only_marker/);
      }
      if (requests === 1)
        return response([
          {
            id: 'read',
            name: 'read_file',
            arguments: { path: 'src/value.mjs' },
          },
        ]);
      if (requests === 2) return response([], candidate);
      assert.deepEqual(input.tools, []);
      assert.deepEqual(input.schema, schema);
      assert.equal(input.messages.at(-1)?.role, 'user');
      assert.ok(input.messages.at(-1)!.content.includes(JSON.stringify(schema)));
      return response([], final);
    }),
    structuredToolMode: 'separate-turn',
  };
  const runtime = f.make(p),
    started = await f.start(runtime);
  runtime.subscribe((event) => events.push(event));
  const answer = await runtime.turn(started.threadId, 'Inspect and report', {
    ...turnOptions(),
    schema,
  });
  assert.equal(answer.text, final);
  assert.equal(requests, 3);
  const saved = await f.sessions.load(started.threadId);
  assert.equal(saved?.requests, 3, 'Final serialization still consumes a request');
  assert.deepEqual(saved?.limits, limits);
  assert.equal(saved?.actions.length, 1);
  assert.equal(saved?.actions[0].status, 'completed');
  assert.ok(saved?.messages.some((message) => message.content === candidate));
  assert.deepEqual(
    events.filter((event) => event.type === 'message.completed').map((event) => event.text),
    [final],
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /PRIVATE_INTERMEDIATE_CANDIDATE|PRIVATE_PROVIDER_STATE/,
  );
});

test('combined structured tools keep the original single-phase schema instruction', async (t) => {
  const f = await fixture(t);
  const schema = {
    type: 'object',
    properties: { combined_marker: { type: 'boolean' } },
  };
  let requests = 0;
  const runtime = f.make(
    provider(async (input) => {
      requests++;
      assert.deepEqual(input.schema, schema);
      assert.ok(
        input.messages
          .at(-1)!
          .content.includes(
            'Return your final answer as JSON matching this schema: ' + JSON.stringify(schema),
          ),
      );
      return response([], '{"combined_marker":true}');
    }),
  );
  const started = await f.start(runtime);
  assert.equal(
    (
      await runtime.turn(started.threadId, 'Inspect', {
        ...turnOptions(),
        schema,
      })
    ).text,
    '{"combined_marker":true}',
  );
  assert.equal(requests, 1);
});

test('separate final serialization never accepts a truncated answer or publishes its intermediate candidate', async (t) => {
  const f = await fixture(t);
  for (const finish of ['length', 'failed'] as const) {
    let requests = 0;
    const events: RuntimeEvent[] = [];
    const runtime = f.make({
      ...provider(async () => {
        requests++;
        return requests === 1
          ? response([], 'PRIVATE_INTERMEDIATE_CANDIDATE')
          : { ...response([], '{"ok":'), finish };
      }),
      structuredToolMode: 'separate-turn',
    });
    const started = await f.start(runtime);
    runtime.subscribe((event) => events.push(event));
    await assert.rejects(runtime.turn(started.threadId, 'Inspect', turnOptions()), {
      code: 'MODEL_INCOMPLETE',
    });
    const saved = await f.sessions.load(started.threadId);
    assert.equal(saved?.status, 'failed');
    assert.equal(saved?.requests, 2);
    assert.equal(requests, 2);
    assert.equal(saved?.actions.length, 0);
    assert.equal(
      events.some((event) => event.type === 'message.completed'),
      false,
    );
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_INTERMEDIATE_CANDIDATE/);
  }
});

test('final serialization cannot dispatch tools and still consumes the request budget', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const p: ModelProvider = {
    ...provider(async () => {
      requests++;
      return requests === 1
        ? response([], 'Candidate')
        : response([{ id: 'unexpected', name: 'edit_file', arguments: {} }]);
    }),
    structuredToolMode: 'separate-turn',
  };
  const runtime = f.make(p),
    started = await f.start(runtime);
  await assert.rejects(runtime.turn(started.threadId, 'Inspect', turnOptions()), {
    code: 'MODEL_INVALID_RESPONSE',
  });
  assert.equal((await f.sessions.load(started.threadId))?.actions.length, 0);
  const bounded = f.make(
    { ...p, complete: async () => response([], 'Candidate') },
    { limits: { ...limits, maxRequestsPerTurn: 1 } },
  );
  const second = await f.start(bounded);
  await assert.rejects(bounded.turn(second.threadId, 'Inspect', turnOptions()), {
    code: 'MODEL_BUDGET_EXHAUSTED',
  });
});

test('context projection uses a cloned request view for both the guard and inference while preserving full private evidence', async (t) => {
  const f = await fixture(t);
  const commentary = 'PRIVATE_COMPLETED_COMMENTARY '.repeat(1000);
  const candidate = 'PRIVATE_COMPLETION_NOTE '.repeat(1000);
  const continuation = { private: 'PRIVATE_CORE_CONTINUATION' };
  const call = {
    id: 'edit-once',
    name: 'edit_file',
    arguments: { path: 'src/value.mjs', oldText: 'value=1', newText: 'value=2' },
  };
  const views: ModelMessage[][] = [];
  const contexts: ModelContext[] = [];
  const events: RuntimeEvent[] = [];
  let requests = 0;
  const bounded = { ...limits, contextTokens: 16000, maxOutputTokens: 1000 };
  const p: ModelProvider = {
    ...provider(async (input) => {
      requests++;
      assert.equal(input.messages, views.at(-1), 'Send the exact view whose size passed the guard');
      if (requests === 1)
        return {
          ...response([call]),
          message: { role: 'assistant', content: commentary, toolCalls: [call], continuation },
        };
      const assistant = input.messages.find((message) => message.toolCalls?.length)!;
      const result = input.messages.find((message) => message.role === 'tool')!;
      assert.equal(assistant.content, '');
      assert.deepEqual(assistant.toolCalls, [call]);
      assert.deepEqual(assistant.continuation, continuation);
      assert.match(result.content, /Edited src\/value.mjs/);
      const saved = await f.sessions.load(started.threadId);
      assert.equal(
        saved?.messages.find((message) => message.toolCalls?.length)?.content,
        commentary,
      );
      assert.ok(
        new TextEncoder().encode(JSON.stringify(saved?.messages)).length > bounded.contextTokens,
        'The unprojected checkpoint cannot fit this guard',
      );
      if (requests === 3) {
        assert.equal(input.messages.at(-2)?.content, '');
        assert.deepEqual(input.messages.at(-2)?.continuation, {
          private: 'PRIVATE_PROVIDER_STATE',
        });
        assert.match(
          input.messages.at(-1)!.content,
          /Reconstruct it from the original task and recorded tool results/,
        );
      }
      return response([], requests === 2 ? candidate : '{"ok":true}');
    }),
    structuredToolMode: 'separate-turn',
    contextMessages(messages, context) {
      // This fake provider deliberately mutates its input to exercise the core clone boundary.
      const view = messages as ModelMessage[];
      for (const message of view)
        if (message.role === 'assistant' && message.toolCalls?.length) message.content = '';
      assert.ok(context);
      contexts.push(structuredClone(context));
      if (context.phase === 'final') {
        assert.equal(context.intermediateMessageIndexes?.at(-1), view.length - 2);
        const intermediate = view[context.intermediateMessageIndexes?.at(-1)!];
        assert.equal(intermediate.role, 'assistant');
        assert.equal(intermediate.content, candidate);
        assert.equal(intermediate.toolCalls?.length || 0, 0);
        intermediate.content = '';
      } else assert.equal(context.intermediateMessageIndexes?.at(-1), undefined);
      views.push(view);
      return view;
    },
  };
  const runtime = f.make(p, { limits: bounded });
  const started = await f.start(runtime);
  runtime.subscribe((event) => events.push(event));
  assert.equal(
    (await runtime.turn(started.threadId, 'Update the value once and report', turnOptions())).text,
    '{"ok":true}',
  );
  assert.equal(requests, 3);
  assert.equal(views.length, 3, 'Project every request, including final serialization');
  assert.deepEqual(
    contexts.map((context) => context.phase),
    ['work', 'work', 'final'],
  );
  assert.notEqual(views[0], views[1]);
  const saved = (await f.sessions.load(started.threadId))!;
  assert.equal(saved.requests, 3);
  assert.deepEqual(saved.limits, bounded);
  assert.equal(saved.actions.length, 1);
  assert.equal(saved.actions[0].status, 'completed');
  assert.deepEqual(saved.actions[0].call, call);
  assert.equal(saved.messages.find((message) => message.toolCalls?.length)?.content, commentary);
  assert.deepEqual(
    saved.messages.find((message) => message.toolCalls?.length)?.continuation,
    continuation,
  );
  assert.ok(saved.messages.some((message) => message.content === candidate));
  assert.equal(
    await fs.readFile(path.join(f.root, 'src/value.mjs'), 'utf8'),
    'export const value=2;\n',
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /PRIVATE_COMPLETED_COMMENTARY|PRIVATE_CORE_CONTINUATION|PRIVATE_COMPLETION_NOTE/,
  );
});

test('core-owned intermediate tags survive private reload and omit only marked notes on successive turns', async (t) => {
  const f = await fixture(t);
  const contexts: ModelContext[] = [];
  const actualViews: ModelMessage[][] = [];
  const events: RuntimeEvent[] = [];
  const notes = ['PRIVATE_NOTE_ONE '.repeat(1500), 'PRIVATE_NOTE_TWO '.repeat(1500)];
  const projector = new OllamaProvider({
    id: 'local',
    endpoint: 'http://127.0.0.1:11434',
    think: false,
  });
  let requests = 0;
  const p: ModelProvider = {
    ...provider(async (input) => {
      actualViews.push(structuredClone(input.messages));
      requests++;
      return response(
        [],
        requests % 2 ? notes[(requests - 1) / 2] : JSON.stringify({ result: requests }),
      );
    }),
    structuredToolMode: 'separate-turn',
    contextMessages(messages, context) {
      assert.ok(context);
      contexts.push(structuredClone(context));
      return projector.contextMessages(messages, context);
    },
  };
  const bounded = { ...limits, contextTokens: 16000, maxOutputTokens: 1000 };
  const runtime = f.make(p, { limits: bounded });
  runtime.subscribe((event) => events.push(event));
  const started = await f.start(runtime);
  assert.equal(
    (await runtime.turn(started.threadId, 'First task', turnOptions())).text,
    '{"result":2}',
  );
  const first = (await f.sessions.load(started.threadId))!;
  assert.equal(first.intermediateNotes?.length, 1);
  assert.equal(first.messages[first.intermediateNotes![0]].content, notes[0]);
  await runtime.release(started.threadId);
  const freshStore = new FileManagedSessions(path.join(f.root, '.buro/local/managed'));
  assert.deepEqual(
    (await freshStore.load(started.threadId))?.intermediateNotes,
    first.intermediateNotes,
  );
  const restored = f.make(p, { limits: bounded, sessions: freshStore });
  restored.subscribe((event) => events.push(event));
  await restored.resume({
    projectId: 'p',
    threadId: started.threadId,
    workspace: f.root,
    runId: 'R-fixture',
    instructions: 'Continue from the saved evidence.',
  });
  assert.equal(
    (await restored.turn(started.threadId, 'Second task', turnOptions())).text,
    '{"result":4}',
  );
  assert.deepEqual(
    contexts.map((context) => context.phase),
    ['work', 'final', 'work', 'final'],
  );
  assert.equal(contexts[2].intermediateMessageIndexes?.length, 1);
  assert.equal(contexts[3].intermediateMessageIndexes?.length, 2);
  assert.equal(actualViews[2][first.intermediateNotes![0]].content, '');
  assert.ok(actualViews[2].some((message) => message.content === '{"result":2}'));
  assert.equal(actualViews[3].at(-2)?.content, '');
  const saved = (await freshStore.load(started.threadId))!;
  assert.equal(saved.requests, 4);
  assert.deepEqual(saved.limits, bounded);
  assert.equal(saved.intermediateNotes?.length, 2);
  for (let index = 0; index < notes.length; index++) {
    assert.equal(saved.messages[saved.intermediateNotes![index]].content, notes[index]);
    assert.deepEqual(saved.messages[saved.intermediateNotes![index]].continuation, {
      private: 'PRIVATE_PROVIDER_STATE',
    });
  }
  assert.ok(saved.messages.some((message) => message.content === '{"result":2}'));
  assert.equal(saved.actions.length, 0);
  assert.doesNotMatch(
    JSON.stringify(events),
    /PRIVATE_NOTE_|intermediateNotes|intermediateMessageIndexes/,
  );
});

test('intermediate provenance and its final instruction are durable together; failed save leaves the note unmarked', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const candidate = 'PRIVATE_UNCOMMITTED_NOTE '.repeat(1000);
  const store: ManagedSessionStore = {
    load: (id) => f.sessions.load(id),
    save(session) {
      if (session.intermediateNotes?.length) throw Error('final instruction persistence failed');
      return f.sessions.save(session);
    },
  };
  const runtime = f.make(
    {
      ...provider(async () => {
        requests++;
        return response([], candidate);
      }),
      structuredToolMode: 'separate-turn',
    },
    { sessions: store },
  );
  const started = await f.start(runtime);
  await assert.rejects(
    runtime.turn(started.threadId, 'Inspect', turnOptions()),
    /final instruction persistence failed/,
  );
  const saved = (await f.sessions.load(started.threadId))!;
  assert.equal(requests, 1);
  assert.equal(saved.requests, 1);
  assert.equal(saved.intermediateNotes, undefined);
  assert.equal(saved.messages.at(-1)?.role, 'assistant');
  assert.equal(saved.messages.at(-1)?.content, candidate);
  assert.equal(saved.status, 'failed');
  const projector = new OllamaProvider({
    id: 'local',
    endpoint: 'http://127.0.0.1:11434',
    think: false,
  });
  assert.equal(
    projector.contextMessages(saved.messages, { phase: 'work' }).at(-1)?.content,
    candidate,
  );
});

test('private checkpoint schema rejects invalid, duplicate, unordered or pending intermediate provenance without replacing evidence', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const runtime = f.make({
    ...provider(async () => response([], ++requests % 2 ? 'PRIVATE_NOTE' : '{"ok":true}')),
    structuredToolMode: 'separate-turn',
  });
  const started = await f.start(runtime);
  await runtime.turn(started.threadId, 'Inspect', turnOptions());
  const saved = (await f.sessions.load(started.threadId))!;
  const note = saved.intermediateNotes![0];
  for (const intermediateNotes of [
    [-1],
    [0.5],
    [999],
    [note, note],
    [note, 0],
    [0],
    [saved.messages.length - 1],
  ]) {
    await assert.rejects(async () => f.sessions.save({ ...saved, intermediateNotes }));
    assert.deepEqual(await f.sessions.load(started.threadId), saved);
  }
  const pending = structuredClone(saved);
  pending.messages.push({ role: 'assistant', content: 'Uncommitted completion note.' });
  pending.intermediateNotes!.push(pending.messages.length - 1);
  await assert.rejects(async () => f.sessions.save(pending));
  const tool = structuredClone(saved);
  tool.messages[note].toolCalls = [{ id: 'pending', name: 'read_file', arguments: {} }];
  await assert.rejects(async () => f.sessions.save(tool));
  assert.deepEqual(await f.sessions.load(started.threadId), saved);
});

test('omitting the current intermediate content cannot bypass a large private continuation on the final request', async (t) => {
  const f = await fixture(t);
  const candidate = 'PRIVATE_CURRENT_NOTE '.repeat(1000);
  const continuation = { private: 'REQUIRED_FINAL_CONTINUATION '.repeat(1000) };
  let requests = 0;
  const phases: string[] = [];
  const runtime = f.make(
    {
      ...provider(async () => {
        requests++;
        return {
          ...response([], candidate),
          message: { role: 'assistant', content: candidate, continuation },
        };
      }),
      structuredToolMode: 'separate-turn',
      contextMessages(messages, context) {
        phases.push(context!.phase);
        const view = messages as ModelMessage[];
        if (context?.phase === 'final')
          view[context.intermediateMessageIndexes?.at(-1)!].content = '';
        return view;
      },
    },
    { limits: { ...limits, contextTokens: 16000, maxOutputTokens: 1000 } },
  );
  const started = await f.start(runtime);
  await assert.rejects(runtime.turn(started.threadId, 'Inspect', turnOptions()), {
    code: 'MODEL_CONTEXT_EXHAUSTED',
  });
  assert.equal(requests, 1);
  assert.deepEqual(phases, ['work', 'final']);
  const saved = (await f.sessions.load(started.threadId))!;
  assert.equal(saved.requests, 1);
  const intermediate = saved.messages.at(-2)!;
  assert.equal(intermediate.content, candidate);
  assert.deepEqual(intermediate.continuation, continuation);
  assert.equal(saved.actions.length, 0);
});

test('essential tool results and private continuation still exhaust projected context before another model request', async (t) => {
  const f = await fixture(t);
  for (const essential of ['tool-result', 'continuation']) {
    let requests = 0,
      projections = 0,
      actions = 0;
    const oversized = 'ESSENTIAL_PRIVATE_EVIDENCE '.repeat(1000);
    const continuation = { private: essential === 'continuation' ? oversized : 'kept' };
    const result = essential === 'tool-result' ? oversized : 'Read completed';
    const p: ModelProvider = {
      ...provider(async () => {
        requests++;
        return {
          ...response([
            { id: 'read-once', name: 'read_file', arguments: { path: 'src/value.mjs' } },
          ]),
          message: {
            ...response([
              { id: 'read-once', name: 'read_file', arguments: { path: 'src/value.mjs' } },
            ]).message,
            content: 'OMITTABLE_COMMENTARY '.repeat(1000),
            continuation,
          },
        };
      }),
      contextMessages(messages) {
        projections++;
        const view = messages as ModelMessage[];
        for (const message of view) if (message.toolCalls?.length) message.content = '';
        return view;
      },
    };
    const runtime = f.make(p, {
      limits: { ...limits, contextTokens: 16000, maxOutputTokens: 1000 },
      tools: {
        definitions: () => [
          { name: 'read_file', description: 'Read assigned input', parameters: { type: 'object' } },
        ],
        execute: async () => {
          actions++;
          return { content: result };
        },
      },
    });
    const started = await f.start(runtime);
    await assert.rejects(runtime.turn(started.threadId, 'Inspect', turnOptions()), {
      code: 'MODEL_CONTEXT_EXHAUSTED',
    });
    const saved = (await f.sessions.load(started.threadId))!;
    assert.equal(requests, 1);
    assert.equal(projections, 2);
    assert.equal(actions, 1);
    assert.equal(saved.requests, 1);
    assert.equal(saved.actions[0].status, 'completed');
    assert.equal(saved.actions[0].result?.content, result);
    assert.deepEqual(
      saved.messages.find((message) => message.toolCalls?.length)?.continuation,
      continuation,
    );
    assert.match(
      saved.messages.find((message) => message.toolCalls?.length)!.content,
      /OMITTABLE_COMMENTARY/,
    );
  }
});

test('providers without context projection retain the full-history guard and never silently omit commentary', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const commentary = 'REQUIRED_ORIGINAL_COMMENTARY '.repeat(1000);
  const runtime = f.make(
    provider(async () => {
      requests++;
      return {
        ...response([{ id: 'read', name: 'read_file', arguments: { path: 'src/value.mjs' } }]),
        message: {
          ...response([{ id: 'read', name: 'read_file', arguments: { path: 'src/value.mjs' } }])
            .message,
          content: commentary,
        },
      };
    }),
    { limits: { ...limits, contextTokens: 16000, maxOutputTokens: 1000 } },
  );
  const started = await f.start(runtime);
  await assert.rejects(runtime.turn(started.threadId, 'Inspect', turnOptions()), {
    code: 'MODEL_CONTEXT_EXHAUSTED',
  });
  const saved = (await f.sessions.load(started.threadId))!;
  assert.equal(requests, 1);
  assert.equal(saved.requests, 1);
  assert.equal(saved.actions.length, 1);
  assert.equal(saved.messages.find((message) => message.toolCalls?.length)?.content, commentary);
});

test('context projection cannot reset request budgets before separate final serialization', async (t) => {
  const f = await fixture(t);
  let requests = 0,
    projections = 0;
  const p: ModelProvider = {
    ...provider(async () => {
      requests++;
      return requests === 1
        ? {
            ...response([
              { id: 'read-once', name: 'read_file', arguments: { path: 'src/value.mjs' } },
            ]),
            message: {
              ...response([
                { id: 'read-once', name: 'read_file', arguments: { path: 'src/value.mjs' } },
              ]).message,
              content: 'PRIVATE_COMPLETED_COMMENTARY '.repeat(1000),
            },
          }
        : response([], 'PRIVATE_COMPLETION_NOTE');
    }),
    structuredToolMode: 'separate-turn',
    contextMessages(messages) {
      projections++;
      const view = messages as ModelMessage[];
      for (const message of view) if (message.toolCalls?.length) message.content = '';
      return view;
    },
  };
  const bounded = { ...limits, contextTokens: 16000, maxOutputTokens: 1000, maxRequestsPerTurn: 2 };
  const runtime = f.make(p, { limits: bounded }),
    started = await f.start(runtime);
  await assert.rejects(runtime.turn(started.threadId, 'Inspect', turnOptions()), {
    code: 'MODEL_BUDGET_EXHAUSTED',
  });
  const saved = (await f.sessions.load(started.threadId))!;
  assert.equal(requests, 2);
  assert.equal(projections, 2);
  assert.equal(saved.requests, 2);
  assert.deepEqual(saved.limits, bounded);
  assert.equal(saved.actions.length, 1);
  assert.equal(saved.actions[0].status, 'completed');
});

test('interrupt intent survives cancellation and concurrent turns cannot share a session', async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const p = provider(async ({ signal }) => {
    entered();
    await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), {
        once: true,
      }),
    );
    throw Error('Unreachable');
  });
  const runtime = f.make(p);
  let turnId = '';
  runtime.subscribe((event) => {
    if (event.type === 'turn.started') turnId = event.turnId || '';
  });
  const { threadId } = await f.start(runtime);
  const turn = runtime.turn(threadId, 'Wait', turnOptions());
  const rejected = assert.rejects(turn, { code: 'GENERATION_RECONCILIATION_REQUIRED' });
  await ready;
  await assert.rejects(runtime.turn(threadId, 'Other', turnOptions()), { code: 'SESSION_BUSY' });
  await runtime.interrupt(threadId, turnId);
  await rejected;
  const saved = await f.sessions.load(threadId);
  assert.equal(saved?.cancelRequested, true);
  assert.equal(saved?.status, 'interrupted');
});

test('repository tools reject secret paths, symlinks, arbitrary commands and writes outside the assignment', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '.env'), 'SECRET=private');
  await fs.symlink(path.join(f.root, '.env'), path.join(f.root, 'src/link'));
  const scope: ToolScope = {
    projectId: 'p',
    sessionId: 's',
    workspace: f.root,
    readOnly: false,
    allowedPaths: ['src/'],
    protectedPaths: ['checks/'],
    materials: [],
    commands: f.profile.checks,
  };
  const call = (name: string, args: unknown) =>
    f.tools.execute({ id: 'c', name, arguments: args }, scope, {
      actionId: 'a',
      signal: new AbortController().signal,
    });
  for (const relative of ['.env', 'src/link', '../outside', '.buro/control-state.json'])
    assert.equal((await call('read_file', { path: relative })).isError, true);
  assert.equal(
    (
      await call('edit_file', {
        path: 'checks/value.test.mjs',
        oldText: 'value,2',
        newText: 'value,1',
      })
    ).isError,
    true,
  );
  assert.equal((await call('run_command', { command: 'touch unexpected' })).isError, true);
  await assert.rejects(fs.stat(path.join(f.root, 'unexpected')), { code: 'ENOENT' });
  scope.readOnly = true;
  assert.equal(
    (await call('edit_file', { path: 'src/value.mjs', oldText: 'value=1', newText: 'value=2' }))
      .isError,
    true,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, 'src/value.mjs'), 'utf8'),
    'export const value=1;\n',
  );
  await fs.writeFile(path.join(f.root, 'src/new.mjs'), 'export const added=true;');
  const diff = await call('read_diff', {});
  assert.match(diff.content, /src\/new.mjs/);
  assert.match(diff.content, /added=true/);
  assert.doesNotMatch(diff.content, /SECRET=private/);
});
