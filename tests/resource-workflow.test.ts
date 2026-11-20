import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHost } from '../plugins/host.ts';
import { resourcesPlugin } from '../plugins/resources.ts';
import { executionPlugin } from '../plugins/execution.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import { ResourceConfigurationSchema } from '../adapters/files/resource-configuration.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { ProjectEnvironments } from '../adapters/environments/project-environments.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { ProjectChecks } from '../adapters/checks/project-commands.ts';
import { ProjectResearchService } from '../core/project-research.ts';
import { ResultService, type ResultOperations } from '../core/results.ts';
import { operationalRoles } from '../core/operational-roles.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import type { ClientCommand } from '../protocol/schema.ts';
import type { Goal } from '../protocol/domain.ts';
import type { RuntimeEvent } from '../core/ports.ts';

const exec = promisify(execFile);
const privateState = 'PRIVATE_RESOURCE_WORKFLOW_REASONING';
const fixtureKey = 'resource-workflow-fake-key';
const checkCommand = 'node --test checks/value.test.mjs';
type Mode = 'ollama' | 'deepseek' | 'mixed';
type Call = { name: string; arguments: unknown };
type Phase =
  | 'planning'
  | 'worker'
  | 'integration'
  | 'review'
  | 'research'
  | 'environment'
  | 'delivery';
type Generation = { provider: 'ollama' | 'deepseek'; model: string; phase: Phase; tools: string[] };

function chunked(text: string, contentType: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 11)
          controller.enqueue(bytes.slice(index, index + 11));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': contentType } },
  );
}

function wire(provider: 'ollama' | 'deepseek', model: string, calls: Call[], content: string) {
  if (provider === 'ollama')
    return chunked(
      JSON.stringify({
        model: model + '-reported',
        message: {
          role: 'assistant',
          content,
          thinking: privateState,
          ...(calls.length
            ? {
                tool_calls: calls.map((call, index) => ({
                  function: { index, name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
        done: false,
      }) +
        '\n' +
        JSON.stringify({
          model: model + '-reported',
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 100,
          eval_count: 30,
        }) +
        '\n',
      'application/x-ndjson',
    );
  const chunks: unknown[] = [
    {
      model: model + '-reported',
      choices: [{ index: 0, delta: { reasoning_content: privateState } }],
    },
  ];
  if (calls.length) {
    const first: unknown[] = [],
      second: unknown[] = [];
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index],
        args = JSON.stringify(call.arguments),
        middle = Math.max(1, Math.floor(args.length / 2));
      first.push({
        index,
        id: 'fixture-call-' + randomUUID(),
        type: 'function',
        function: { name: call.name, arguments: args.slice(0, middle) },
      });
      second.push({ index, function: { arguments: args.slice(middle) } });
    }
    chunks.push(
      { choices: [{ index: 0, delta: { tool_calls: first } }] },
      {
        choices: [{ index: 0, delta: { tool_calls: second }, finish_reason: 'tool_calls' }],
      },
    );
  } else chunks.push({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] });
  chunks.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 30 } });
  return chunked(
    chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\r\n\r\n').join('') +
      'data: [DONE]\r\n\r\n',
    'text/event-stream',
  );
}

function scenario(body: any): { phase: Phase; calls: Call[]; content: string } {
  const messages = body.messages as { role: string; content: string; [key: string]: unknown }[];
  let userIndex = messages.map((message) => message.role).lastIndexOf('user');
  if (!body.tools?.length && userIndex > 0) {
    const taskIndex = messages
      .slice(0, userIndex)
      .map((message) => message.role)
      .lastIndexOf('user');
    if (taskIndex >= 0) userIndex = taskIndex;
  }
  const prompt = messages[userIndex].content;
  const outputs = messages.slice(userIndex + 1).filter((message) => message.role === 'tool');
  const answer = (phase: Phase, value: unknown) => ({
    phase,
    calls: [],
    content: JSON.stringify(value),
  });
  const tool = (phase: Phase, name: string, args: unknown) => ({
    phase,
    calls: [{ name, arguments: args }],
    content: '',
  });
  if (outputs.length)
    assert.ok(
      messages.some(
        (message) =>
          message.thinking === privateState || message.reasoning_content === privateState,
      ),
      'The provider-specific continuation must survive tool rounds',
    );
  if (prompt.startsWith('First,'))
    return answer('planning', {
      summary: 'Update the value and verify the actual change',
      steps: [
        { step: 'Set value to two', owner: 'builder' },
        { step: 'Inspect the diff', owner: 'reviewer' },
      ],
      team: [
        {
          roleId: 'builder',
          action: 'create',
          title: 'Builder',
          description: 'Implements the assigned module',
          instructions: 'Implement the assigned behavior and preserve the trusted checks.',
          kind: 'implementation',
          paths: ['src/value.mjs'],
        },
      ],
    });
  if (prompt.startsWith('Execute your assigned work')) {
    if (!outputs.length) return tool('worker', 'read_file', { path: 'src/value.mjs' });
    if (outputs.length === 1) {
      assert.match(outputs[0].content, /value=1/);
      return tool('worker', 'edit_file', {
        path: 'src/value.mjs',
        oldText: 'value=1',
        newText: 'value=2',
      });
    }
    if (outputs.length === 2) return tool('worker', 'run_command', { command: checkCommand });
    assert.match(outputs[2].content, /"exitCode":0/);
    return answer('worker', {
      status: 'success',
      summary: 'Changed value to two and ran the configured check',
      artifacts: ['src/value.mjs'],
      notesForNextAgent: '',
    });
  }
  if (prompt.startsWith('Review goal')) {
    const available = (body.tools || []).map((tool: any) => tool.function.name);
    assert.equal(available.includes('edit_file'), false, 'Fresh review must be read only');
    assert.equal(
      available.includes('run_command'),
      false,
      'Review must not acquire command write access',
    );
    if (!outputs.length) return tool('review', 'read_diff', {});
    assert.match(outputs[0].content, /value=2/);
    return answer('review', {
      verdict: 'approved',
      blockingFindings: [],
      summary: 'Inspected the actual integrated diff',
    });
  }
  if (prompt.startsWith('Plan accepted'))
    return answer('integration', {
      status: 'success',
      summary: 'Integrated the service-owned worker result',
      artifacts: ['src/value.mjs'],
      notesForNextAgent: '',
    });
  if (prompt.startsWith('Inspect the project and existing settings.')) {
    assert.equal(
      (body.tools || []).some((tool: any) =>
        ['edit_file', 'run_command'].includes(tool.function.name),
      ),
      false,
    );
    if (!outputs.length) return tool('research', 'read_file', { path: 'src/value.mjs' });
    return answer('research', {
      summary: 'Fixture library inspected',
      context: 'One independently checked module',
      components: [],
      checks: [{ id: 'test', title: 'Tests', command: checkCommand, timeoutMs: 10000 }],
      questions: [],
    });
  }
  if (prompt.startsWith('Determine the minimal preparation needed')) {
    assert.equal(
      (body.tools || []).some((tool: any) =>
        ['edit_file', 'run_command'].includes(tool.function.name),
      ),
      false,
    );
    if (!outputs.length) return tool('environment', 'read_file', { path: 'src/value.mjs' });
    return answer('environment', {
      summary: 'No dependency installation is needed',
      inputs: ['src/value.mjs'],
      variables: [],
      setup: [],
      ready: [{ id: 'node', title: 'Node', command: 'node --version', timeoutMs: 10000 }],
    });
  }
  if (prompt.startsWith('Prepare the result for role ')) {
    assert.equal(
      (body.tools || []).some((tool: any) =>
        ['edit_file', 'run_command'].includes(tool.function.name),
      ),
      false,
    );
    if (!outputs.length) return tool('delivery', 'read_diff', {});
    assert.match(outputs[0].content, /value=2/);
    return answer('delivery', {
      ready: true,
      summary: 'The accepted change is ready for inspection',
      blockers: [],
    });
  }
  throw Error('Unexpected synthetic workflow phase: ' + prompt.slice(0, 100));
}

async function fixture(t: any, mode: Mode, inheritDefault = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'resource-workflow-')));
  const directory = path.join(root, '.buro');
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
  const originalHead = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const host = await createHost({
    projects: [
      { directory, project: { id: 'p', name: 'HTTP fixture project', root, managed: true } },
    ],
  });
  const profile = ProjectProfileSchema.parse({
    version: 1,
    revision: 1,
    resourceProfile: inheritDefault ? undefined : mode,
    context: 'A synthetic checked module',
    allowedPaths: ['src/'],
    protectedPaths: ['checks/'],
    checks: [{ id: 'test', title: 'Tests', command: checkCommand, timeoutMs: 10000 }],
    defaultCheckIds: ['test'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    maxRepairs: 0,
    turnTimeoutMs: 10000,
    baseBranch: 'main',
  });
  const store = host.ctx.projects.registry.get('p');
  await store.transact('profile', 'profile', (doc) => {
    doc.profile = profile;
    return {
      result: null,
      change: {
        type: 'project.configured',
        profile,
        executionPolicy: {
          allowedPaths: profile.allowedPaths,
          protectedPaths: profile.protectedPaths,
          checks: profile.checks.map(({ id, title }) => ({ id, title })),
          defaultCheckIds: profile.defaultCheckIds,
          maxWorkers: 1,
          maxRepairs: 0,
        },
      },
    };
  });
  const limits = {
    contextTokens: 131072,
    maxOutputTokens: 2000,
    maxRequestsPerTurn: 12,
    maxToolCallsPerTurn: 20,
    maxSessionRequests: 100,
  };
  const config = ResourceConfigurationSchema.parse({
    version: 1,
    defaultProfile: mode,
    connections: [
      { id: 'ollama', kind: 'ollama', endpoint: 'http://127.0.0.1:11434' },
      {
        id: 'deepseek',
        kind: 'deepseek',
        endpoint: 'https://api.deepseek.fixture',
        apiKeyEnv: 'RESOURCE_WORKFLOW_API_KEY',
        thinking: 'enabled',
      },
    ],
    runtimes: [
      {
        id: 'local-worker',
        client: 'managed',
        connectionId: 'ollama',
        model: 'local-code',
        limits,
      },
      {
        id: 'local-reviewer',
        client: 'managed',
        connectionId: 'ollama',
        model: 'local-review',
        limits,
      },
      {
        id: 'cloud-coordinator',
        client: 'managed',
        connectionId: 'deepseek',
        model: 'cloud-code',
        limits,
      },
    ],
    profiles: [
      {
        id: 'ollama',
        name: 'Local models',
        policy: 'local-only',
        coordinator: 'local-worker',
        worker: 'local-worker',
        reviewer: 'local-reviewer',
      },
      {
        id: 'deepseek',
        name: 'DeepSeek API',
        policy: 'hybrid',
        coordinator: 'cloud-coordinator',
        worker: 'cloud-coordinator',
        reviewer: 'cloud-coordinator',
      },
      {
        id: 'mixed',
        name: 'Mixed team',
        policy: 'hybrid',
        coordinator: 'cloud-coordinator',
        worker: 'local-worker',
        reviewer: 'local-reviewer',
      },
    ],
  });
  await new PrivateJSONFiles(path.join(directory, 'local')).save('resources', config);
  const oldKey = process.env.RESOURCE_WORKFLOW_API_KEY;
  process.env.RESOURCE_WORKFLOW_API_KEY = fixtureKey;
  const generations: Generation[] = [];
  const failures: string[] = [];
  const respond: typeof fetch = async (url, init) => {
    const endpoint = new URL(String(url));
    const provider = endpoint.hostname === '127.0.0.1' ? 'ollama' : 'deepseek';
    assert.ok(['127.0.0.1', 'api.deepseek.fixture'].includes(endpoint.hostname));
    if (endpoint.pathname === '/api/show')
      return Response.json({
        capabilities: ['completion', 'tools', 'thinking'],
        model_info: { 'fixture.context_length': 262144 },
      });
    assert.ok(endpoint.pathname === '/api/chat' || endpoint.pathname === '/chat/completions');
    if (provider === 'deepseek')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + fixtureKey);
    const body = JSON.parse(String(init?.body)),
      next = scenario(body);
    generations.push({
      provider,
      model: body.model,
      phase: next.phase,
      tools: (body.tools || []).map((tool: any) => tool.function.name),
    });
    return wire(provider, body.model, next.calls, next.content);
  };
  const http: typeof fetch = async (...args) => {
    try {
      return await respond(...args);
    } catch (error) {
      failures.push(error instanceof Error ? error.stack || error.message : String(error));
      throw error;
    }
  };
  const executors = new EnvironmentExecutors();
  t.after(async () => {
    try {
      await host.dispose();
    } finally {
      if (oldKey === undefined) delete process.env.RESOURCE_WORKFLOW_API_KEY;
      else process.env.RESOURCE_WORKFLOW_API_KEY = oldKey;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  await host.ctx.plugin(resourcesPlugin, {
    directory,
    executors,
    fetch: http,
    codex: { executable: path.join(root, 'codex-is-not-installed') },
  });
  assert.equal(generations.length, 0, 'Loading resources must not start paid or local generation');
  assert.equal(host.ctx.agentRuntime.registry.list().includes('codex'), false);
  const workspaces = new GitWorkspaces(host.ctx.projects.registry);
  const prepare = workspaces.prepare.bind(workspaces);
  workspaces.prepare = async (...args) => {
    const workspace = await prepare(...args);
    await executors.register(
      workspace.path,
      root,
      { provider: 'native' },
      new AbortController().signal,
    );
    return workspace;
  };
  const checks = new ProjectChecks(
    host.ctx.projects.registry,
    {
      async run() {
        throw Error('Unexpected check fallback');
      },
    },
    executors,
  );
  const policy = {
    ...profile,
    profile,
    checks: profile.checks.map(({ id, title }) => ({ id, title })),
  };
  await host.ctx.plugin(executionPlugin, { policies: { p: policy }, workspaces, checks });
  let sequence = 0;
  const command = <T>(command: ClientCommand) =>
    host.ctx.commands.bus.execute(command, {
      id: 'workflow-' + ++sequence,
      fingerprint: JSON.stringify(command),
    }) as Promise<T>;
  return {
    root,
    directory,
    host,
    profile,
    config,
    store,
    generations,
    failures,
    git,
    originalHead,
    command,
    workspaces,
    executors,
  };
}

for (const mode of ['ollama', 'deepseek', 'mixed'] as const)
  test(`resource profile ${mode} executes a verified HTTP-backed coding goal without Codex`, async (t) => {
    const f = await fixture(t, mode);
    const events: RuntimeEvent[] = [];
    f.host.ctx.agentRuntime.adapter.subscribe?.((event) => events.push(event));
    const goal = await f.command<Goal>({
      method: 'goal.create',
      params: {
        projectId: 'p',
        title: 'Set the value to two',
        body: 'Update the module',
        criteria: 'The protected check passes',
      },
    });
    const { runId } = await f.command<{ runId: string }>({
      method: 'run.start',
      params: { projectId: 'p', goalId: goal.id },
    });
    await f.host.ctx.workflows.api.jobs.get(runId)?.promise;
    const run = f.host.ctx.workflows.api.get('p', runId);
    assert.equal(run.status, 'completed', [run.result, ...f.failures].join('\n'));
    assert.ok(run.commit);
    assert.equal(run.baseline.passed, 0, 'The trusted test must detect the initial bug');
    assert.equal(run.acceptance.passed, 1);
    assert.equal(run.independentReviewer, true);
    assert.equal(run.resources?.profileId, mode);
    const selected = f.config.profiles.find((profile) => profile.id === mode)!;
    assert.equal(run.coordinatorSession?.runtimeId, selected.coordinator);
    const worker = run.agents.find((agent) => agent.session?.roleId === 'builder')!;
    const reviewer = run.agents.find((agent) => agent.session?.roleId === 'reviewer')!;
    assert.equal(worker.session?.runtimeId, selected.worker);
    assert.equal(reviewer.session?.runtimeId, selected.reviewer);
    assert.equal(worker.session?.result?.status, 'success');
    assert.match(run.threadId, /^B-/);
    assert.match(worker.threadId, /^B-/);
    assert.match(reviewer.threadId, /^B-/);
    assert.notEqual(run.threadId, worker.threadId);
    assert.notEqual(worker.threadId, reviewer.threadId);
    const routes = new FileRuntimeRoutes(path.join(f.directory, 'local/runtime-routes'));
    const sessionFiles = new FileManagedSessions(path.join(f.directory, 'local/managed-sessions'));
    for (const [handle, runtimeId] of [
      [run.threadId, selected.coordinator],
      [worker.threadId, selected.worker],
      [reviewer.threadId, selected.reviewer],
    ]) {
      const route = await routes.load(handle);
      assert.equal(route?.resource.id, runtimeId);
      assert.match(route!.externalThreadId!, /^M-/);
      assert.notEqual(handle, route!.externalThreadId);
      const checkpoint = await sessionFiles.load(route!.externalThreadId!);
      assert.equal(checkpoint?.runtimeId, runtimeId);
      assert.equal(checkpoint?.reportedModel, checkpoint!.requestedModel + '-reported');
      assert.ok(checkpoint?.messages.some((message) => message.continuation));
      assert.equal(
        JSON.stringify(run).includes(route!.externalThreadId!),
        false,
        'Private native IDs must stay behind Buro handles',
      );
    }
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => /^B-/.test(event.threadId)));
    assert.doesNotMatch(
      JSON.stringify([f.store.snapshot(), events]),
      new RegExp(privateState + '|' + fixtureKey),
    );
    assert.equal(
      await fs.readFile(path.join(f.root, 'src/value.mjs'), 'utf8'),
      'export const value=1;\n',
    );
    assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.originalHead);
    assert.equal(
      await fs.readFile(path.join(run.workspace!, 'src/value.mjs'), 'utf8'),
      'export const value=2;\n',
    );
    const expected = (runtimeId: string) =>
      f.config.runtimes.find((runtime) => runtime.id === runtimeId)!;
    for (const [phase, runtimeId] of [
      ['planning', selected.coordinator],
      ['integration', selected.coordinator],
      ['worker', selected.worker],
      ['review', selected.reviewer],
    ] as const) {
      const calls = f.generations.filter((generation) => generation.phase === phase);
      assert.ok(calls.length > 0, phase);
      const runtime = expected(runtimeId);
      assert.equal(runtime.client, 'managed');
      if (runtime.client === 'managed')
        assert.ok(calls.every((generation) => generation.model === runtime.model));
    }
    if (mode === 'ollama')
      assert.ok(
        f.generations.every((generation) => generation.provider === 'ollama'),
        'Local-only workflow must never invoke DeepSeek',
      );
    if (mode === 'deepseek')
      assert.ok(f.generations.every((generation) => generation.provider === 'deepseek'));
    if (mode === 'mixed')
      assert.deepEqual(
        new Set(f.generations.map((generation) => generation.provider)),
        new Set(['ollama', 'deepseek']),
      );
  });

test('a DeepSeek goal with no credential preserves work and never falls back to another configured runtime', async (t) => {
  const f = await fixture(t, 'deepseek');
  delete process.env.RESOURCE_WORKFLOW_API_KEY;
  const goal = await f.command<Goal>({
    method: 'goal.create',
    params: {
      projectId: 'p',
      title: 'Require the selected DeepSeek connection',
      body: 'Set the value to two',
      criteria: 'The trusted check passes',
    },
  });
  const { runId } = await f.command<{ runId: string }>({
    method: 'run.start',
    params: { projectId: 'p', goalId: goal.id },
  });
  await f.host.ctx.workflows.api.jobs.get(runId)?.promise;
  const run = f.host.ctx.workflows.api.get('p', runId);
  assert.equal(run.status, 'failed');
  assert.match(run.result, /private DeepSeek API key/);
  assert.equal(run.resources?.coordinator.id, 'cloud-coordinator');
  assert.ok(run.workspace);
  assert.equal(run.commit, undefined);
  assert.equal(
    f.generations.length,
    0,
    'Missing credentials must not dispatch Ollama, Codex or paid API inference',
  );
  assert.equal(
    await fs.readFile(path.join(f.root, 'src/value.mjs'), 'utf8'),
    'export const value=1;\n',
  );
  assert.equal(
    await fs.readFile(path.join(run.workspace!, 'src/value.mjs'), 'utf8'),
    'export const value=1;\n',
  );
});

test('project research and environment discovery use the selected managed coordinator with read-only tools', async (t) => {
  const f = await fixture(t, 'mixed');
  const research = new ProjectResearchService({
    projects: f.host.ctx.projects.registry,
    runtime: f.host.ctx.agentRuntime.adapter,
    head: async () => f.originalHead,
  });
  t.after(() => research.dispose());
  await research.start('research', 'research', 'p');
  await research.jobs.get('p')?.promise;
  assert.equal(f.store.snapshot().research?.status, 'ready', f.store.snapshot().research?.error);
  assert.equal(f.store.snapshot().research?.summary, 'Fixture library inspected');
  const workspace = await f.workspaces.prepare('p', 'R-environment', 'main', {
    profile: f.profile,
  });
  const environments = new ProjectEnvironments(
    f.host.ctx.projects.registry,
    f.host.ctx.agentRuntime.adapter,
    f.executors,
  );
  const ready = await environments.prepare({
    projectId: 'p',
    runId: 'R-environment',
    workspace: workspace.path,
    base: workspace.base,
    profile: f.profile,
    signal: new AbortController().signal,
    report: async () => {},
  });
  assert.equal(ready.passed, true, ready.error);
  const requests = f.generations.filter((generation) =>
    ['research', 'environment'].includes(generation.phase),
  );
  assert.ok(requests.some((generation) => generation.phase === 'research'));
  assert.ok(requests.some((generation) => generation.phase === 'environment'));
  assert.ok(
    requests.every(
      (generation) => generation.provider === 'deepseek' && generation.model === 'cloud-code',
    ),
  );
  assert.ok(
    requests.every(
      (generation) =>
        !generation.tools.includes('edit_file') && !generation.tools.includes('run_command'),
    ),
  );
  assert.equal(
    await fs.readFile(path.join(f.root, 'src/value.mjs'), 'utf8'),
    'export const value=1;\n',
  );
  assert.doesNotMatch(
    JSON.stringify(f.store.snapshot()),
    new RegExp(privateState + '|' + fixtureKey),
  );
});

test('environment and result preparation keep the accepted local-only run route after a remote default is selected', async (t) => {
  const f = await fixture(t, 'ollama', true);
  const goal = await f.command<Goal>({
    method: 'goal.create',
    params: {
      projectId: 'p',
      title: 'Keep this attempt local',
      body: 'Set value to two',
      criteria: 'The trusted test passes',
    },
  });
  const { runId } = await f.command<{ runId: string }>({
    method: 'run.start',
    params: { projectId: 'p', goalId: goal.id },
  });
  await f.host.ctx.workflows.api.jobs.get(runId)?.promise;
  const run = f.host.ctx.workflows.api.get('p', runId);
  assert.equal(run.status, 'completed', [run.result, ...f.failures].join('\n'));
  assert.equal(run.resources?.policy, 'local-only');
  await f.command({ method: 'resources.use', params: { profileId: 'deepseek' } });
  const selected = await f.command<{
    defaultProfile: string;
    selected: { policy: string; profileId: string };
  }>({ method: 'resources.list', params: { projectId: 'p' } });
  assert.equal(selected.defaultProfile, 'deepseek');
  assert.equal(
    selected.selected.profileId,
    'deepseek',
    'Future work really must see the new default',
  );
  assert.equal(selected.selected.policy, 'hybrid');

  const environments = new ProjectEnvironments(
    f.host.ctx.projects.registry,
    f.host.ctx.agentRuntime.adapter,
    f.executors,
  );
  const ready = await environments.prepare({
    projectId: 'p',
    runId: run.id,
    workspace: run.workspace!,
    base: run.baseCommit!,
    profile: f.profile,
    signal: new AbortController().signal,
    report: async () => {},
  });
  assert.equal(ready.passed, true, ready.error);
  const environmentRequests = f.generations.filter(
    (generation) => generation.phase === 'environment',
  );
  assert.ok(environmentRequests.length > 0);
  assert.ok(
    environmentRequests.every(
      (generation) => generation.provider === 'ollama' && generation.model === 'local-code',
    ),
    'An environment helper belongs to the old local-only run, not the newly selected remote default',
  );

  const role = operationalRoles.find((item) => item.id === 'local_preview')!;
  await f.command({
    method: 'role.save',
    params: {
      projectId: 'p',
      id: role.id,
      title: role.title,
      description: role.description,
      instructions: role.instructions,
      kind: role.kind,
      expectedVersion: 0,
    },
  });
  const operations: ResultOperations = {
    async preview() {
      throw Error('Read-only preparation must not launch a process');
    },
    async stopPreview() {},
    async pullRequest() {
      throw Error('Read-only preparation must not publish a PR');
    },
    async deploy() {
      throw Error('Read-only preparation must not deploy');
    },
    async dispose() {},
  };
  const results = new ResultService({
    projects: f.host.ctx.projects.registry,
    runtime: f.host.ctx.agentRuntime.adapter,
    operations,
  });
  t.after(() => results.dispose());
  const prepared = await results.prepare(
    'p',
    run,
    'local_preview',
    { components: [] },
    new AbortController().signal,
  );
  assert.equal(prepared.summary, 'The accepted change is ready for inspection');
  const deliveryRequests = f.generations.filter((generation) => generation.phase === 'delivery');
  assert.ok(deliveryRequests.length > 0);
  assert.ok(
    deliveryRequests.every(
      (generation) => generation.provider === 'ollama' && generation.model === 'local-code',
    ),
    'Result preparation must inherit the accepted run policy and Git base',
  );
  assert.ok(
    [...environmentRequests, ...deliveryRequests].every(
      (generation) =>
        !generation.tools.includes('edit_file') && !generation.tools.includes('run_command'),
    ),
  );
  assert.equal(
    await fs.readFile(path.join(f.root, 'src/value.mjs'), 'utf8'),
    'export const value=1;\n',
  );
  assert.doesNotMatch(
    JSON.stringify(f.store.snapshot()),
    new RegExp(privateState + '|' + fixtureKey),
  );
});
