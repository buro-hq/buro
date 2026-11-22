import { createBuiltinProjectAnalyses } from '../adapters/analysis/project-setup.ts';
import { readAuthorizedMaterialText } from '../adapters/files/context-material-text.ts';
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
import { executionPolicy } from '../adapters/files/project-manager.ts';
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
type ScenarioResponse = { phase: Phase; calls: Call[]; content: string };

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

function taskContext(body: any) {
  const messages = body.messages as { role: string; content: string; [key: string]: unknown }[];
  let userIndex = messages.map((message) => message.role).lastIndexOf('user');
  if (
    !body.tools?.length &&
    userIndex > 0 &&
    /^Return only the final JSON for (the preceding task|the original assignment)\./.test(
      messages[userIndex].content,
    )
  ) {
    const taskIndex = messages
      .slice(0, userIndex)
      .map((message) => message.role)
      .lastIndexOf('user');
    if (taskIndex >= 0) userIndex = taskIndex;
  }
  const prompt = messages[userIndex].content;
  const outputs = messages.slice(userIndex + 1).filter((message) => message.role === 'tool');
  return { messages, prompt, outputs };
}
function scenario(body: any): ScenarioResponse {
  const { messages, prompt, outputs } = taskContext(body);
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
          runtimeId: null,
          runtimeReason: '',
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

async function fixture(
  t: any,
  mode: Mode,
  inheritDefault = false,
  options: {
    twoWorkers?: boolean;
    workerPool?: string[];
    scenario?: (body: any) => ScenarioResponse | Promise<ScenarioResponse>;
  } = {},
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'resource-workflow-')));
  const directory = path.join(root, '.buro');
  const git = (args: string[]) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'checks'));
  await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=1;\n');
  if (options.twoWorkers)
    await fs.writeFile(path.join(root, 'src/other.mjs'), 'export const other=1;\n');
  await fs.writeFile(
    path.join(root, 'checks/value.test.mjs'),
    "import assert from 'node:assert/strict';import {value} from '../src/value.mjs';assert.equal(value,2);\n" +
      (options.twoWorkers ? "import {other} from '../src/other.mjs';assert.equal(other,2);\n" : ''),
  );
  await fs.writeFile(path.join(root, '.gitignore'), '.buro/\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture']);
  const originalHead = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const host = await createHost({
    projects: [
      {
        storageAddress: directory,
        project: { id: 'p', name: 'HTTP fixture project', root, managed: true },
      },
    ],
  });
  const profile = ProjectProfileSchema.parse({
    version: 1,
    revision: 1,
    resourceProfile: inheritDefault ? undefined : mode,
    context: 'A synthetic checked module',
    scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
    checks: [{ id: 'test', title: 'Tests', command: checkCommand, timeoutMs: 10000 }],
    defaultCheckIds: ['test'],
    setup: [],
    dependencies: 'none',
    maxWorkers: options.twoWorkers ? 2 : 1,
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
          scope: structuredClone(profile.scope),
          checks: profile.checks.map(({ id, title }) => ({ id, title })),
          defaultCheckIds: profile.defaultCheckIds,
          maxWorkers: profile.maxWorkers,
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
      { id: 'ollama', provider: 'ollama', config: { endpoint: 'http://127.0.0.1:11434' } },
      {
        id: 'deepseek',
        provider: 'deepseek',
        config: {
          endpoint: 'https://api.deepseek.fixture',
          apiKeyEnv: 'RESOURCE_WORKFLOW_API_KEY',
          thinking: 'enabled',
        },
      },
    ],
    runtimes: [
      {
        id: 'local-worker',
        backend: 'managed',
        config: { connectionId: 'ollama', model: 'local-code', limits },
      },
      {
        id: 'local-reviewer',
        backend: 'managed',
        config: { connectionId: 'ollama', model: 'local-review', limits },
      },
      {
        id: 'cloud-coordinator',
        backend: 'managed',
        config: { connectionId: 'deepseek', model: 'cloud-code', limits },
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
        ...(mode === 'ollama' && options.workerPool ? { workerPool: options.workerPool } : {}),
      },
      {
        id: 'deepseek',
        name: 'DeepSeek API',
        policy: 'hybrid',
        coordinator: 'cloud-coordinator',
        worker: 'cloud-coordinator',
        reviewer: 'cloud-coordinator',
        ...(mode === 'deepseek' && options.workerPool ? { workerPool: options.workerPool } : {}),
      },
      {
        id: 'mixed',
        name: 'Mixed team',
        policy: 'hybrid',
        coordinator: 'cloud-coordinator',
        worker: 'local-worker',
        reviewer: 'local-reviewer',
        ...(mode === 'mixed' && options.workerPool ? { workerPool: options.workerPool } : {}),
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
      next = await (options.scenario || scenario)(body);
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
      { privateDataIsolation: true },
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
  const policy = executionPolicy(profile);
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

function selectedScenario(options: {
  twoWorkers?: boolean;
  reuse?: boolean;
  runtimeId?: string;
  correctedRuntimeId?: string | null;
  onCorrection?: () => void;
}) {
  return (body: any): ScenarioResponse => {
    const { prompt, outputs } = taskContext(body);
    if (prompt.startsWith('First,')) {
      const response = scenario(body),
        plan = JSON.parse(response.content),
        corrected = prompt.includes('Correct the previous plan:');
      if (corrected) options.onCorrection?.();
      plan.team[0].action = options.reuse ? 'reuse' : 'create';
      plan.team[0].runtimeId = corrected
        ? (options.correctedRuntimeId ?? null)
        : (options.runtimeId ?? null);
      plan.team[0].runtimeReason = plan.team[0].runtimeId
        ? 'Use this model for the assigned module.'
        : '';
      if (options.twoWorkers) {
        plan.team.push({
          ...plan.team[0],
          roleId: 'other_builder',
          title: 'Other builder',
          description: 'Implements a separate module',
          paths: ['src/other.mjs'],
          runtimeId: 'local-reviewer',
          runtimeReason: 'Use the second permitted model for the independent module.',
        });
        plan.steps.splice(1, 0, { step: 'Set other to two', owner: 'other_builder' });
      }
      return { ...response, content: JSON.stringify(plan) };
    }
    if (options.twoWorkers && prompt.startsWith('Execute your assigned work')) {
      const name = prompt.includes('Role: other_builder.') ? 'other' : 'value',
        file = `src/${name}.mjs`;
      if (!outputs.length)
        return {
          phase: 'worker',
          calls: [{ name: 'read_file', arguments: { path: file } }],
          content: '',
        };
      if (outputs.length === 1) {
        assert.match(outputs[0].content, new RegExp(name + '=1'));
        return {
          phase: 'worker',
          calls: [
            {
              name: 'edit_file',
              arguments: { path: file, oldText: name + '=1', newText: name + '=2' },
            },
          ],
          content: '',
        };
      }
      assert.equal(outputs.length, 2);
      return {
        phase: 'worker',
        calls: [],
        content: JSON.stringify({
          status: 'success',
          summary: 'Updated the assigned module; service-owned checks verify both modules',
          artifacts: [file],
          notesForNextAgent: '',
        }),
      };
    }
    if (options.twoWorkers && prompt.startsWith('Review goal') && outputs.length)
      assert.match(outputs[0].content, /other=2/, 'Fresh review must see both real changes');
    return scenario(body);
  };
}

async function startGoal(f: Awaited<ReturnType<typeof fixture>>) {
  const goal = await f.command<Goal>({
    method: 'goal.create',
    params: {
      projectId: 'p',
      title: 'Update the assigned modules',
      body: 'Set each assigned value to two',
      criteria: 'The protected checks pass and an independent reviewer inspects the diff',
    },
  });
  const { runId } = await f.command<{ runId: string }>({
    method: 'run.start',
    params: { projectId: 'p', goalId: goal.id },
  });
  await f.host.ctx.workflows.api.jobs.get(runId)?.promise;
  return f.host.ctx.workflows.api.get('p', runId);
}
async function executeGoal(f: Awaited<ReturnType<typeof fixture>>) {
  const run = await startGoal(f);
  assert.equal(run.status, 'completed', [run.result, ...f.failures].join('\n'));
  assert.ok(run.commit);
  assert.equal(run.baseline.passed, 0);
  assert.equal(run.acceptance.passed, 1);
  assert.equal(run.independentReviewer, true);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.originalHead);
  return run;
}

test('a cloud coordinator assigns two real workers to different frozen local runtimes without pinning reusable roles', async (t) => {
  const f = await fixture(t, 'mixed', false, {
    twoWorkers: true,
    workerPool: ['local-worker', 'local-reviewer'],
    scenario: selectedScenario({ twoWorkers: true }),
  });
  const run = await executeGoal(f);
  assert.equal(run.coordinatorSession?.runtimeId, 'cloud-coordinator');
  assert.deepEqual(
    run.resources?.workerPool?.map((resource) => resource.id),
    ['local-worker', 'local-reviewer'],
  );
  const workers = ['builder', 'other_builder'].map(
    (id) => run.agents.find((agent) => agent.session?.roleId === id)!,
  );
  for (const [index, agent] of workers.entries()) {
    const id = index ? 'other_builder' : 'builder',
      runtimeId = index ? 'local-reviewer' : 'local-worker',
      source = index ? 'coordinator' : 'profile',
      name = index ? 'other' : 'value',
      saved = run.assignmentResources![id];
    assert.equal(saved.resource.id, runtimeId);
    assert.equal(saved.source, source);
    assert.deepEqual(saved.preference, { mode: 'auto' });
    assert.equal(agent.session?.runtimeId, runtimeId);
    assert.equal(agent.session?.result?.status, 'success');
    assert.deepEqual(agent.session?.selection, { source, reason: saved.reason });
    assert.equal(agent.session?.roleVersion, saved.roleVersion);
    assert.equal(
      await fs.readFile(path.join(run.workspace!, `src/${name}.mjs`), 'utf8'),
      `export const ${name}=2;\n`,
    );
    assert.equal(
      await fs.readFile(path.join(f.root, `src/${name}.mjs`), 'utf8'),
      `export const ${name}=1;\n`,
    );
    const libraryRole = f.store.snapshot().roles.find((role) => role.id === id)!;
    assert.equal(libraryRole.runtimePreference?.mode ?? 'auto', 'auto');
    assert.equal(libraryRole.model, undefined);
    assert.doesNotMatch(libraryRole.instructions, /local-worker|local-reviewer/);
  }
  const reviewer = run.agents.find((agent) => agent.session?.roleId === 'reviewer')!;
  assert.equal(reviewer.session?.runtimeId, 'local-reviewer');
  assert.equal(
    new Set([run.threadId, ...workers.map((agent) => agent.threadId), reviewer.threadId]).size,
    4,
  );
  assert.deepEqual(
    new Set(
      f.generations.filter((request) => request.phase === 'worker').map((request) => request.model),
    ),
    new Set(['local-code', 'local-review']),
  );
  const reviewRequests = f.generations.filter((request) => request.phase === 'review');
  assert.ok(reviewRequests.length > 0);
  assert.ok(reviewRequests.some((request) => request.tools.includes('read_diff')));
  assert.ok(reviewRequests.every((request) => !request.tools.includes('edit_file')));
  assert.doesNotMatch(
    JSON.stringify(f.store.snapshot()),
    new RegExp(privateState + '|' + fixtureKey),
  );
});

test('a conflicting coordinator proposal is corrected before dispatch and a user fixed model remains pinned', async (t) => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let corrected = false;
  f = await fixture(t, 'mixed', false, {
    workerPool: ['local-worker', 'local-reviewer'],
    scenario: selectedScenario({
      reuse: true,
      runtimeId: 'local-worker',
      onCorrection() {
        corrected = true;
        assert.equal(f.generations.filter((request) => request.phase === 'worker').length, 0);
      },
    }),
  });
  await f.command({
    method: 'role.save',
    params: {
      projectId: 'p',
      id: 'builder',
      title: 'Builder',
      description: 'Implements modules',
      instructions: 'Change only the assigned module.',
      kind: 'implementation',
      model: 'legacy-metadata-is-not-a-runtime',
      runtimePreference: { mode: 'fixed', runtimeId: 'local-reviewer' },
      expectedVersion: 0,
    },
  });
  const roleBefore = structuredClone(
    f.store.snapshot().roles.find((role) => role.id === 'builder'),
  );
  const run = await executeGoal(f);
  assert.equal(corrected, true);
  assert.equal(run.events.filter((event) => event.type === 'plan.rejected').length, 1);
  assert.equal(run.assignmentResources?.builder.source, 'fixed');
  assert.equal(run.assignmentResources?.builder.resource.id, 'local-reviewer');
  assert.equal(
    run.agents.find((agent) => agent.session?.roleId === 'builder')?.session?.selection?.source,
    'fixed',
  );
  assert.ok(
    f.generations
      .filter((request) => request.phase === 'worker')
      .every((request) => request.model === 'local-review'),
  );
  assert.deepEqual(
    f.store.snapshot().roles.find((role) => role.id === 'builder'),
    roleBefore,
  );
});

test('an eligible runtime used by another role is available to a worker without an explicit worker pool', async (t) => {
  const f = await fixture(t, 'ollama', false, {
    scenario: selectedScenario({ runtimeId: 'local-reviewer' }),
  });
  const run = await executeGoal(f);
  assert.equal(run.resources?.workerPool, undefined);
  assert.equal(run.assignmentResources?.builder.resource.id, 'local-reviewer');
  assert.equal(run.assignmentResources?.builder.source, 'coordinator');
  assert.ok(
    f.generations
      .filter((request) => request.phase === 'worker')
      .every((request) => request.model === 'local-review'),
  );
  assert.equal(run.events.filter((event) => event.type === 'plan.rejected').length, 0);
});

test('an unavailable user fixed runtime requires attention after one plan without dispatch or fallback', async (t) => {
  const f = await fixture(t, 'mixed', false, {
    scenario: selectedScenario({ reuse: true }),
  });
  await f.command({
    method: 'role.save',
    params: {
      projectId: 'p',
      id: 'builder',
      title: 'Builder',
      description: 'Implements modules',
      instructions: 'Change only the assigned module.',
      kind: 'implementation',
      runtimePreference: { mode: 'fixed', runtimeId: 'not-configured' },
      expectedVersion: 0,
    },
  });
  const run = await startGoal(f);
  assert.equal(run.status, 'needs-attention', [run.result, ...f.failures].join('\n'));
  assert.match(run.result, /fixed runtime.*not-configured.*outside the saved profile pool/i);
  assert.equal(run.commit, undefined);
  assert.equal(run.assignmentResources, undefined);
  assert.equal(run.agents.length, 0);
  assert.equal(run.acceptance.passed, 0);
  assert.equal(
    f.generations.length,
    1,
    'A fixed user choice cannot be repaired by another model plan',
  );
  assert.equal(f.generations[0].phase, 'planning');
  assert.equal(f.generations[0].provider, 'deepseek');
  assert.equal(
    await fs.readFile(path.join(run.workspace!, 'src/value.mjs'), 'utf8'),
    'export const value=1;\n',
  );
});

for (const [label, runtimeId, pool] of [
  ['unknown', 'not-configured', ['local-worker', 'local-reviewer']],
  ['remote in a local-only run', 'cloud-coordinator', ['local-worker', 'local-reviewer']],
] as const)
  test(`model proposal (${label}) is corrected without widening the frozen worker pool or dispatching it`, async (t) => {
    let f: Awaited<ReturnType<typeof fixture>>;
    let corrected = false;
    f = await fixture(t, 'ollama', false, {
      workerPool: pool ? [...pool] : undefined,
      scenario: selectedScenario({
        runtimeId,
        onCorrection() {
          corrected = true;
          assert.equal(f.generations.filter((request) => request.phase === 'worker').length, 0);
        },
      }),
    });
    const run = await executeGoal(f);
    assert.equal(corrected, true);
    assert.equal(run.events.filter((event) => event.type === 'plan.rejected').length, 1);
    assert.deepEqual(
      run.resources?.workerPool?.map((resource) => resource.id),
      pool,
    );
    assert.deepEqual(
      (run.resources?.workerPool || [run.resources!.worker]).map((resource) => resource.id),
      pool || ['local-worker'],
    );
    assert.equal(run.assignmentResources?.builder.resource.id, 'local-worker');
    assert.equal(run.assignmentResources?.builder.source, 'profile');
    assert.deepEqual(run.assignmentResources?.builder.preference, { mode: 'auto' });
    assert.ok(f.generations.every((request) => request.provider === 'ollama'));
    assert.ok(
      f.generations
        .filter((request) => request.phase === 'worker')
        .every((request) => request.model === 'local-code'),
    );
    assert.equal(
      f.store.snapshot().roles.find((role) => role.id === 'builder')?.runtimePreference?.mode ??
        'auto',
      'auto',
    );
  });

test('role pin changes during planning reject the stale plan, while a later pin cannot reroute an accepted worker', async (t) => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let planningUpdated = false,
    workerUpdated = false,
    corrections = 0;
  const save = (expectedVersion: number, runtimeId: string) =>
    f.command({
      method: 'role.save',
      params: {
        projectId: 'p',
        id: 'builder',
        title: 'Builder',
        description: 'Implements modules',
        instructions: 'Change only the assigned module.',
        kind: 'implementation',
        runtimePreference: { mode: 'fixed', runtimeId },
        expectedVersion,
      },
    });
  const base = selectedScenario({ reuse: true });
  f = await fixture(t, 'mixed', false, {
    workerPool: ['local-worker', 'local-reviewer'],
    async scenario(body) {
      const { prompt } = taskContext(body);
      if (prompt.startsWith('First,')) {
        if (!planningUpdated) {
          assert.match(prompt, /"id":"builder","version":1/);
          assert.match(prompt, /"runtimePreference":\{"mode":"fixed","runtimeId":"local-worker"\}/);
          assert.equal(f.generations.filter((request) => request.phase === 'worker').length, 0);
          await save(1, 'local-reviewer');
          planningUpdated = true;
        } else {
          assert.match(prompt, /Correct the previous plan:/);
          assert.match(prompt, /Role builder changed during planning/);
          assert.match(prompt, /"id":"builder","version":2/);
          assert.match(
            prompt,
            /"runtimePreference":\{"mode":"fixed","runtimeId":"local-reviewer"\}/,
          );
          assert.equal(f.generations.filter((request) => request.phase === 'worker').length, 0);
          corrections++;
        }
      }
      if (prompt.startsWith('Execute your assigned work') && !workerUpdated) {
        const run = f.store.snapshot().runs.find((candidate) => candidate.status === 'running')!,
          agent = run.agents.find((candidate) => candidate.session?.roleId === 'builder')!;
        assert.equal(run.roleSnapshots?.find((role) => role.id === 'builder')?.version, 2);
        assert.equal(run.assignmentResources?.builder.roleVersion, 2);
        assert.equal(run.assignmentResources?.builder.resource.id, 'local-reviewer');
        assert.equal(agent.session?.roleVersion, 2);
        assert.equal(agent.session?.runtimeId, 'local-reviewer');
        assert.equal(agent.session?.selection?.source, 'fixed');
        await save(2, 'local-worker');
        workerUpdated = true;
      }
      return base(body);
    },
  });
  await save(0, 'local-worker');
  const run = await executeGoal(f);
  assert.equal(planningUpdated, true);
  assert.equal(workerUpdated, true);
  assert.equal(corrections, 1);
  assert.equal(run.events.filter((event) => event.type === 'plan.rejected').length, 1);
  assert.equal(run.assignmentResources?.builder.roleVersion, 2);
  assert.equal(run.assignmentResources?.builder.resource.id, 'local-reviewer');
  assert.deepEqual(run.assignmentResources?.builder.preference, {
    mode: 'fixed',
    runtimeId: 'local-reviewer',
  });
  const role = f.store.snapshot().roles.find((candidate) => candidate.id === 'builder')!;
  assert.equal(role.version, 3);
  assert.deepEqual(role.runtimePreference, { mode: 'fixed', runtimeId: 'local-worker' });
  assert.equal(
    run.agents.find((agent) => agent.session?.roleId === 'builder')?.session?.roleVersion,
    2,
  );
  assert.ok(
    f.generations
      .filter((request) => request.phase === 'worker')
      .every((request) => request.model === 'local-review'),
  );
});

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
      assert.equal(runtime.backend, 'managed');
      if (runtime.backend === 'managed')
        assert.ok(calls.every((generation) => generation.model === runtime.config.model));
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
    selection: f.host.ctx.agentRuntime.selection!,
    analysis: createBuiltinProjectAnalyses().get('project-setup'),
    materials: (projectId, selected, signal) =>
      readAuthorizedMaterialText(f.host.ctx.projects.registry, projectId, selected, signal),
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
    'result.preview',
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
