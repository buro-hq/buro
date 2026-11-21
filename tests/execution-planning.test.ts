import {
  virtualWorkspaceRevision,
  virtualVerificationViews,
  VIRTUAL_BASE_COMMIT,
} from './fixtures/virtual-workspace.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionService } from '../core/execution.ts';
import { DomainError } from '../core/ports.ts';
import { GoalService } from '../core/services.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import type { AgentRuntime } from '../core/ports.ts';
import type { ResourceSnapshot } from '../protocol/resources.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import type { ModelProvider } from '../core/model-ports.ts';

async function fixture(
  t: any,
  options: {
    client?: 'managed' | 'codex';
    mode?: 'bounded' | 'legacy';
    invalidPlans?: number;
    managed16K?: boolean;
    malformedPlans?: number;
    planningFailure?: string;
  } = {},
) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-planning-')));
  const store = await FileProjectStore.open({
    directory,
    project: { id: 'p', name: 'Planning fixture', root: directory },
  });
  const projects = new FileProjectRegistry([store]);
  let sequence = 0,
    plans = 0,
    malformedPlans = 0;
  const turns: { text: string; toolPolicy?: 'none'; threadId: string; schema?: unknown }[] = [];
  const providerCalls: Parameters<ModelProvider['complete']>[0][] = [];
  const sessions = new FileManagedSessions(path.join(directory, 'private-sessions'));
  const resource = {
    id: options.client === 'codex' ? 'codex' : 'local-qwen',
    client: options.client || 'managed',
    configurationRevision: 'frozen-resource',
    local: true,
  };
  const resources: ResourceSnapshot = {
    profileId: 'local',
    policy: 'local-only',
    coordinator: resource,
    worker: resource,
    reviewer: resource,
  };
  const fakeRuntime: AgentRuntime = {
    id: 'fake',
    async start() {
      return { threadId: 'thread-' + ++sequence };
    },
    async resume(input) {
      return { threadId: input.threadId };
    },
    async submit() {
      return { turnId: 't' };
    },
    async interrupt() {},
    async dispose() {},
    async turn(threadId, text, turnOptions) {
      turns.push({
        threadId,
        text,
        toolPolicy: turnOptions?.toolPolicy,
        schema: turnOptions?.schema,
      });
      if (text.startsWith('First,')) {
        if (options.planningFailure)
          throw new DomainError(options.planningFailure, 'Planning request did not complete.');
        if (malformedPlans++ < (options.malformedPlans || 0))
          return { turnId: 'malformed', text: '{"summary":' };
      }
      const answer = text.startsWith('First,')
        ? {
            summary: 'One coherent edit',
            steps: [
              {
                step: 'Implement and inspect as needed',
                owner: ++plans <= (options.invalidPlans || 0) ? 'missing-role' : 'coordinator',
              },
              { step: 'Verify the outcome', owner: 'reviewer' },
            ],
            team: [],
          }
        : text.startsWith('Review goal')
          ? { verdict: 'approved', blockingFindings: [], summary: 'Verified' }
          : {
              status: 'success',
              summary: 'Done',
              artifacts: ['src/value.ts'],
              notesForNextAgent: '',
            };
      return { turnId: 't', text: JSON.stringify(answer) };
    },
  };
  const runtime: AgentRuntime = options.managed16K
    ? new ManagedAgentRuntime({
        id: 'local-qwen',
        model: 'fixture-qwen',
        projects,
        sessions,
        idGenerator: () => crypto.randomUUID(),
        limits: {
          contextTokens: 16384,
          maxOutputTokens: 2048,
          maxRequestsPerTurn: 4,
          maxToolCallsPerTurn: 4,
          maxSessionRequests: 12,
        },
        tools: {
          definitions: () => [
            {
              name: 'read_file',
              description: 'Inspect public fixture input',
              parameters: { type: 'object' },
            },
          ],
          async execute() {
            throw Error('This fixture never requests tool effects');
          },
        },
        provider: {
          id: 'ollama',
          revision: 'fixture-16k',
          local: true,
          structuredToolMode: 'separate-turn',
          async complete(input) {
            providerCalls.push({
              ...input,
              messages: structuredClone(input.messages),
              tools: structuredClone(input.tools),
            });
            const task =
              [...input.messages].reverse().find((message) => message.role === 'user')?.content ||
              '';
            let answer: unknown;
            if (task.startsWith('First,')) {
              const invalid = ++plans === 1;
              assert.deepEqual(input.tools, []);
              assert.ok(
                input.schema,
                'Tools-free Ollama planning must request structured output directly',
              );
              assert.equal((input.schema as any).properties.team.maxItems, 1);
              answer = {
                summary: invalid
                  ? 'Prior planning detail. '.repeat(150)
                  : 'One coherent assignment.',
                steps: [
                  {
                    step: 'Implement the value change',
                    owner: invalid ? 'missing-role' : 'builder',
                  },
                  { step: 'Verify result', owner: 'reviewer' },
                ],
                team: [
                  {
                    roleId: 'builder',
                    action: 'create',
                    title: 'Builder',
                    description: 'Implements scoped code',
                    instructions: 'Preserve the assigned public API.',
                    kind: 'implementation',
                    paths: ['src/value.ts'],
                    runtimeId: null,
                    runtimeReason: '',
                    assignment: null,
                  },
                ],
              };
            } else if (
              input.messages.some(
                (message) => message.role === 'user' && message.content.startsWith('Review goal'),
              )
            ) {
              answer = { verdict: 'approved', blockingFindings: [], summary: 'Verified' };
            } else {
              answer = {
                status: 'success',
                summary: 'Done',
                artifacts: ['src/value.ts'],
                notesForNextAgent: '',
              };
            }
            return {
              model: input.model,
              finish: 'stop',
              usage: { inputTokens: 40, outputTokens: 20 },
              message: {
                role: 'assistant',
                content: input.schema ? JSON.stringify(answer) : 'Work complete.',
              },
            };
          },
        },
      })
    : fakeRuntime;
  const environment = {
    projects,
    runtime,
    planningMode: options.mode,
    selection: {
      forProject() {
        return resources;
      },
    },
    now: () => new Date().toISOString(),
    id: () => crypto.randomUUID(),
    policies: {
      p: {
        allowedPaths: ['src/'],
        protectedPaths: ['checks/'],
        context: options.managed16K
          ? 'Preserve the public API. '.repeat(60)
          : 'Preserve the public API.',
        checks: [{ id: 'suite', title: 'Suite' }],
        defaultCheckIds: ['suite'],
        maxWorkers: options.managed16K ? 1 : 2,
        maxRepairs: 0,
        turnTimeoutMs: 1000,
      },
    },
    workspaces: {
      ...virtualVerificationViews,
      async prepare() {
        return { path: directory, base: VIRTUAL_BASE_COMMIT };
      },
      async changes() {
        return [{ path: 'src/value.ts', before: 'one', after: 'two' }];
      },
      async captureRevision(workspace: string, base: string) {
        return virtualWorkspaceRevision(await this.changes(workspace, base), base);
      },
      async checkpoint() {
        return 'a'.repeat(40);
      },
    },
    checks: {
      async run() {
        return { passed: 1, total: 1, results: [{ name: 'Suite', passed: true }] };
      },
    },
  };
  const engine = new ExecutionService(environment);
  t.after(async () => {
    await engine.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const goal = await new GoalService(environment).create('goal', 'goal', {
    projectId: 'p',
    title: 'Update value',
    body: 'Set value to two.',
    criteria: 'Preserve exports.',
  });
  async function run() {
    const result = await engine.start('start', 'start', { projectId: 'p', goalId: goal.id });
    await engine.jobs.get(result.runId)?.promise;
    return engine.get('p', result.runId);
  }
  return {
    engine,
    store,
    environment,
    turns,
    run,
    directory,
    providerCalls,
    sessions,
    resetPlanningCount: () => {
      plans = 0;
    },
  };
}

test('new managed planning saves bounded policy and only planning turns disable tools', async (t) => {
  const f = await fixture(t, { invalidPlans: 1 });
  const run = await f.run();
  assert.equal(run.status, 'completed', run.result);
  assert.equal(run.planningPolicy?.mode, 'bounded');
  assert.equal(run.planningPolicy?.revision, 'bounded-planning-v3');
  const planning = f.turns.filter(({ text }) => text.startsWith('First,'));
  assert.equal(planning.length, 2);
  assert.ok(planning.every(({ toolPolicy }) => toolPolicy === 'none'));
  assert.match(planning[1].text, /steps.owner must exactly match/);
  assert.doesNotMatch(planning[1].text, /Brief: /);
  const integration = f.turns.find(({ text }) => text.startsWith('Plan accepted.'))!;
  assert.equal(integration.toolPolicy, undefined);
  assert.equal(integration.threadId, planning[0].threadId);
  assert.equal(f.turns.find(({ text }) => text.startsWith('Review goal'))?.toolPolicy, undefined);
  assert.equal(run.independentReviewer, true);
});

test('managed Ollama 16K corrects an invalid plan without repeating the brief or resetting its journal', async (t) => {
  const f = await fixture(t, { managed16K: true });
  const run = await f.run();
  assert.equal(run.status, 'completed', run.result);
  assert.equal(run.planningPolicy?.revision, 'bounded-planning-v3');
  assert.ok(
    run.agents.some((agent) => agent.session?.roleId === 'builder' && agent.status === 'completed'),
  );
  const planning = f.providerCalls.filter((call) =>
    [...call.messages]
      .reverse()
      .find((message) => message.role === 'user')
      ?.content.startsWith('First,'),
  );
  assert.equal(planning.length, 2);
  assert.equal(planning[0].contextTokens, 16384);
  assert.equal(planning[1].contextTokens, 16384);
  const users = planning[1].messages.filter((message) => message.role === 'user');
  assert.match(users[0].content, /Brief: /);
  assert.doesNotMatch(users[1].content, /Brief: /);
  assert.match(users[1].content, /steps.owner must exactly match/);
  assert.ok(
    planning[1].messages.some(
      (message) =>
        message.role === 'assistant' && message.content.includes('Prior planning detail.'),
    ),
  );
  const saved = (await f.sessions.load(run.threadId))!;
  assert.deepEqual(
    saved.turnAuthorities?.slice(0, 2).map((entry) => [entry.toolPolicy, entry.startedAtRequest]),
    [
      ['none', 0],
      ['none', 1],
    ],
  );
  assert.equal(
    saved.requests,
    4,
    'Two planning generations and normal two-phase integration share the original counter',
  );
  assert.equal(saved.actions.length, 0);
  assert.equal(run.events.filter((event) => event.type === 'plan.rejected').length, 1);
});

test('legacy comparison mode and native Codex retain existing planning authority', async (t) => {
  for (const options of [{ mode: 'legacy' as const }, { client: 'codex' as const }]) {
    const f = await fixture(t, options);
    const run = await f.run();
    assert.equal(run.status, 'completed', run.result);
    assert.equal(run.planningPolicy?.mode, 'legacy');
    const planning = f.turns.find(({ text }) => text.startsWith('First,'))!;
    assert.equal(planning.toolPolicy, undefined);
    assert.match(planning.text, /only inspect the project/);
  }
});

test('invalid bounded planning still stops after the existing two attempts', async (t) => {
  const f = await fixture(t, { invalidPlans: 2 });
  const run = await f.run();
  assert.equal(run.status, 'failed');
  assert.equal(f.turns.length, 2);
  assert.ok(f.turns.every(({ toolPolicy }) => toolPolicy === 'none'));
  assert.equal(run.planSavedAt, undefined);
  assert.equal(run.commit, undefined);
});

test('an observed malformed planning response is corrected in the same session', async (t) => {
  const f = await fixture(t, { malformedPlans: 1 });
  const run = await f.run();
  assert.equal(run.status, 'completed', run.result);
  const plans = f.turns.filter((turn) => turn.text.startsWith('First,'));
  assert.equal(plans.length, 2);
  assert.equal(plans[0].threadId, plans[1].threadId);
  assert.ok(plans.every((turn) => turn.toolPolicy === 'none'));
  assert.match(plans[1].text, /not valid JSON/);
  assert.equal(run.events.filter((event) => event.type === 'plan.rejected').length, 1);
  assert.equal(run.independentReviewer, true);
});

test('planning transport and admission failures never become JSON correction retries', async (t) => {
  for (const code of ['PROVIDER_UNAVAILABLE', 'RUN_BUDGET_REQUESTS_EXCEEDED']) {
    const f = await fixture(t, { planningFailure: code });
    const run = await f.run();
    assert.notEqual(run.status, 'completed');
    assert.equal(f.turns.length, 1);
    assert.equal(run.events.filter((event) => event.type === 'plan.rejected').length, 0);
    assert.equal(run.commit, undefined);
  }
});

test('historical missing planning policy remains legacy even when current environment enables bounded', async (t) => {
  const f = await fixture(t);
  const original = await f.run();
  await f.store.transact('historical', 'historical', (doc) => {
    const historical = {
      ...structuredClone(original),
      id: 'R-historical',
      status: 'running' as const,
      commit: undefined,
      planningPolicy: undefined,
      managedBudget: undefined,
    };
    doc.runs.push(historical);
    return { result: null, change: { type: 'run.changed', run: historical, goal: doc.goals[0] } };
  });
  f.turns.length = 0;
  await f.engine.planAndImplement(
    'p',
    'R-historical',
    { path: f.directory, base: VIRTUAL_BASE_COMMIT },
    f.environment.policies.p,
    new AbortController().signal,
    [],
    true,
  );
  const planning = f.turns.find(({ text }) => text.startsWith('First,'))!;
  assert.equal(planning.toolPolicy, undefined);
  assert.match(planning.text, /only inspect the project/);
});

for (const revision of ['bounded-planning-v1', 'bounded-planning-v2'] as const)
  test(`a resumed saved ${revision} run retains its original prompts and generic grammar`, async (t) => {
    const f = await fixture(t, { invalidPlans: 1 });
    f.environment.policies.p.maxWorkers = 1;
    const original = await f.run();
    await f.store.transact('historical-v1', 'historical-v1', (doc) => {
      const historical = {
        ...structuredClone(original),
        id: 'R-historical-v1',
        status: 'running' as const,
        commit: undefined,
        planningPolicy: {
          version: 1 as const,
          mode: 'bounded' as const,
          revision,
        },
        managedBudget: undefined,
      };
      doc.runs.push(historical);
      return { result: null, change: { type: 'run.changed', run: historical, goal: doc.goals[0] } };
    });
    f.turns.length = 0;
    f.resetPlanningCount();
    await f.engine.planAndImplement(
      'p',
      'R-historical-v1',
      { path: f.directory, base: VIRTUAL_BASE_COMMIT },
      f.environment.policies.p,
      new AbortController().signal,
      [],
      true,
    );
    const planning = f.turns.filter(({ text }) => text.startsWith('First,'));
    assert.equal(planning.length, 2);
    assert.ok(
      planning.every(
        ({ toolPolicy, schema }) =>
          toolPolicy === 'none' && (schema as any).properties.team.maxItems === 2,
      ),
    );
    assert.match(planning[0].text, /Brief: /);
    assert.equal(planning[1].text.includes('Brief: '), revision === 'bounded-planning-v1');
    assert.equal(f.engine.get('p', 'R-historical-v1').planningPolicy?.revision, revision);
  });
