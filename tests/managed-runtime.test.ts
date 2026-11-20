import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ManagedAgentRuntime, type ManagedRuntimeOptions } from '../core/managed-runtime.ts';
import type {
  ManagedSessionStore,
  ModelProvider,
  ModelToolCall,
  ToolBroker,
  ToolScope,
} from '../core/model-ports.ts';
import type { RuntimeEvent } from '../core/ports.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
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
    await assert.rejects(runtime.turn(threadId, 'Edit', turnOptions()), /disk failed/);
    assert.equal(effects, failure === 'intent' ? 0 : 1);
    await runtime.dispose();
    const restored = f.make(p);
    await assert.rejects(
      restored.resume({
        projectId: 'p',
        threadId,
        workspace: f.root,
        runId: 'R-fixture',
        instructions: 'Continue',
      }),
      { code: 'ACTION_RECONCILIATION_REQUIRED' },
    );
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
  const rejected = assert.rejects(turn, { name: 'AbortError' });
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
