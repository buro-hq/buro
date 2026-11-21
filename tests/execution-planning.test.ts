import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import { fixtureExecutionCapabilities } from './fixtures/execution-resources.ts';
import { observedTurnFailure, UnresolvedEffectError } from '../core/run-reconciliation.ts';
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
import type { ModelProvider } from '../agent/contracts/model.ts';

async function fixture(
  t: any,
  options: {
    client?: 'managed' | 'codex';
    strategy?: 'tools-free-structured' | 'read-only-inspection';
    failPlannerRelease?: boolean;
    unknownWriterStart?: boolean;
    invalidPlans?: number;
    managed16K?: boolean;
    malformedPlans?: number;
    planningFailure?: string;
    resumeSupported?: boolean;
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
  const starts: { threadId: string; readOnly?: boolean; purpose?: string; instructions: string }[] =
    [];
  const resumeCalls: string[] = [];
  const releases: string[] = [];
  const resource = {
    capabilities: fixtureExecutionCapabilities({
      toolsFreeTurns: options.strategy !== 'read-only-inspection',
      resumeSessions: options.resumeSupported ?? false,
    }),
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
    async start(input) {
      const threadId = 'thread-' + ++sequence;
      starts.push({
        threadId,
        readOnly: input.readOnly,
        purpose: input.purpose,
        instructions: input.instructions,
      });
      if (options.unknownWriterStart && input.readOnly === false)
        throw new UnresolvedEffectError('SESSION_RECONCILIATION_REQUIRED', {
          runtimeId: resource.id,
          backendSessionId: 'lost-writer',
          operationId: 'writer-start',
        });
      return { threadId };
    },
    async resume(input) {
      resumeCalls.push(input.threadId);
      if (!resource.capabilities.resumeSessions)
        throw observedTurnFailure(
          new DomainError('RESUME_UNSUPPORTED', 'The fixture has no backend session resumption.'),
        );
      return { threadId: input.threadId };
    },
    async submit() {
      return { turnId: 't' };
    },
    async interrupt() {},
    async dispose() {},
    async release(threadId) {
      releases.push(threadId);
      if (
        options.failPlannerRelease &&
        starts.find((start) => start.threadId === threadId)?.readOnly
      ) {
        options.failPlannerRelease = false;
        throw observedTurnFailure(
          new DomainError('RUNTIME_CLOSED', 'Pause after accepted plan before writer dispatch'),
        );
      }
    },
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
        loopRunner: new PiAgentLoopRunner(),
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
    selection: {
      forProject() {
        return resources;
      },
    },
    now: () => new Date().toISOString(),
    id: () => crypto.randomUUID(),
    policies: {
      p: {
        scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
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
      async restore(_projectId: string, _runId: string, workspace: string, base: string) {
        return { path: workspace, base };
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
    starts,
    resumeCalls,
    releases,
    goal,
    run,
    directory,
    providerCalls,
    sessions,
    resetPlanningCount: () => {
      plans = 0;
    },
  };
}

test('new tools-free planning saves its bound strategy and only planning turns disable tools', async (t) => {
  const f = await fixture(t, { invalidPlans: 1 });
  const run = await f.run();
  assert.equal(run.status, 'completed', run.result);
  assert.equal(run.planningPolicy?.strategy, 'tools-free-structured');
  assert.equal(run.planningPolicy?.revision, 'capability-planning-v1');
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
  assert.equal(
    run.status,
    'completed',
    run.result +
      JSON.stringify({
        phase: run.phase,
        calls: f.providerCalls.map((call) => ({
          schema: !!call.schema,
          messages: call.messages.map((message) => [message.role, message.content.length]),
          tools: call.tools.length,
        })),
      }),
  );
  assert.equal(run.planningPolicy?.revision, 'capability-planning-v1');
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

test('read-only inspection is selected independently of client labels and uses a fresh writable implementation session', async (t) => {
  for (const client of ['managed', 'codex'] as const) {
    const f = await fixture(t, { client, strategy: 'read-only-inspection' });
    const run = await f.run();
    assert.equal(run.status, 'completed', run.result);
    assert.equal(run.planningPolicy?.strategy, 'read-only-inspection');
    const planning = f.turns.find(({ text }) => text.startsWith('First,'))!;
    const implementation = f.turns.find(({ text }) => text.startsWith('Plan accepted.'))!;
    assert.equal(planning.toolPolicy, undefined);
    assert.match(planning.text, /inspect the repository read-only/);
    assert.equal(f.starts.find((start) => start.threadId === planning.threadId)?.readOnly, true);
    assert.equal(
      f.starts.find((start) => start.threadId === implementation.threadId)?.readOnly,
      false,
    );
    assert.notEqual(implementation.threadId, planning.threadId);
    assert.ok(f.releases.includes(planning.threadId));
    assert.notEqual(run.planningSession?.id, run.coordinatorSession?.id);
    assert.equal(run.coordinatorSession?.parentId, run.planningSession?.id);
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

test('historical missing planning policy cannot silently acquire a new strategy', async (t) => {
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
  await assert.rejects(
    f.engine.planAndImplement(
      'p',
      'R-historical',
      { path: f.directory, base: VIRTUAL_BASE_COMMIT },
      f.environment.policies.p,
      new AbortController().signal,
      [],
      true,
    ),
    { code: 'INVALID_PLANNING_POLICY' },
  );
  assert.equal(f.turns.length, 0);
});

test('an accepted read-only plan survives a stop before writer dispatch and resumes without replaying the planner', async (t) => {
  const f = await fixture(t, { strategy: 'read-only-inspection', failPlannerRelease: true });
  const original = await f.run();
  assert.equal(original.status, 'failed');
  assert.ok(original.planSavedAt);
  assert.equal(original.threadId, '');
  assert.ok(original.planningSession);
  assert.equal(f.starts.length, 1);
  await f.engine.resume('continue', 'continue', {
    projectId: 'p',
    runId: original.id,
    mode: 'repair',
    instructions: 'Continue implementation',
    useCurrentProfile: false,
  });
  await f.engine.jobs.get(original.id)?.promise;
  const resumed = f.engine.get('p', original.id);
  assert.equal(resumed.status, 'completed', resumed.result);
  assert.equal(f.turns.filter((turn) => turn.text.startsWith('First,')).length, 1);
  assert.equal(
    f.starts.filter((start) => start.readOnly && start.purpose === 'coordination').length,
    1,
  );
  assert.equal(resumed.coordinatorSession?.parentId, resumed.planningSession?.id);
});

test('an unknown writer start cannot repeat planning, continue or launch another attempt of the same goal', async (t) => {
  const f = await fixture(t, { strategy: 'read-only-inspection', unknownWriterStart: true });
  const run = await f.run();
  assert.notEqual(run.status, 'completed');
  assert.ok(run.planSavedAt);
  assert.equal(run.threadId, '');
  assert.equal(run.reconciliation?.code, 'SESSION_RECONCILIATION_REQUIRED');
  assert.equal(f.starts.length, 2);
  assert.equal(f.turns.length, 1);
  await assert.rejects(
    f.engine.resume('continue', 'continue', {
      projectId: 'p',
      runId: run.id,
      mode: 'repair',
      instructions: 'Continue',
      useCurrentProfile: false,
    }),
    { code: 'RUN_RECONCILIATION_REQUIRED' },
  );
  await assert.rejects(
    f.engine.start('new-attempt', 'new-attempt', { projectId: 'p', goalId: f.goal.id }),
    { code: 'RUN_RECONCILIATION_REQUIRED' },
  );
  assert.equal(f.starts.length, 2);
});

test('repair starts a new session with the frozen role and saved work when the selected backend cannot resume', async (t) => {
  const f = await fixture(t, { resumeSupported: false });
  const original = await f.run();
  assert.equal(original.status, 'completed', original.result);
  const savedRole = original.roleSnapshots!.find((role) => role.id === 'coordinator')!;
  const previousSession = original.coordinatorSession!.id;
  await f.store.transact('stopped', 'stopped', (doc) => {
    const run = doc.runs.find((item) => item.id === original.id)!;
    run.status = 'interrupted';
    run.result = 'Stopped after implementation';
    run.completedAt = undefined;
    doc.goals[0].status = 'failed';
    return { result: null, change: { type: 'run.changed', run, goal: doc.goals[0] } };
  });
  const startsBefore = f.starts.length;
  const turnsBefore = f.turns.length;
  await f.engine.resume('resume-without-native-resume', 'resume-without-native-resume', {
    projectId: 'p',
    runId: original.id,
    mode: 'repair',
    instructions: '',
    useCurrentProfile: false,
  });
  await f.engine.jobs.get(original.id)?.promise;
  const resumed = f.engine.get('p', original.id);
  assert.equal(resumed.status, 'completed', resumed.result);
  assert.equal(
    f.resumeCalls.length,
    0,
    'A facade resume method cannot override the frozen capability.',
  );
  const writer = f.starts.slice(startsBefore).find((start) => start.purpose === 'coordination')!;
  assert.ok(writer, 'A nonresumable backend receives an explicit new writer session.');
  assert.notEqual(writer.threadId, original.threadId);
  assert.ok(writer.instructions.includes(savedRole.instructions));
  assert.equal(resumed.threadId, writer.threadId);
  assert.notEqual(resumed.coordinatorSession!.id, previousSession);
  assert.equal(
    resumed.coordinatorSession!.runtimeId,
    original.roleResources!.coordinator.resource.id,
  );
  const repair = f.turns.slice(turnsBefore).find((turn) => turn.threadId === writer.threadId)!;
  assert.ok(repair.text.includes(original.goalText));
  assert.ok(
    repair.text.includes(JSON.stringify(original.plan)),
    'A new session receives the accepted plan.',
  );
  assert.equal(
    f.turns.filter((turn) => turn.text.startsWith('First,')).length,
    1,
    'Repair does not replay planning.',
  );
  assert.equal(resumed.independentReviewer, true);
});

test('a settled older run cannot bypass another unresolved run of the same goal through repair', async (t) => {
  const f = await fixture(t, { resumeSupported: false });
  const original = await f.run();
  await f.store.transact('two-stopped-runs', 'two-stopped-runs', (doc) => {
    const run = doc.runs.find((item) => item.id === original.id)!;
    run.status = 'interrupted';
    run.completedAt = undefined;
    const unknown = {
      ...structuredClone(run),
      id: 'R-unresolved-other',
      status: 'needs-attention' as const,
      commit: undefined,
      workspace: path.join(f.directory, 'other-workspace'),
      reconciliation: {
        version: 1 as const,
        status: 'required' as const,
        code: 'SESSION_RECONCILIATION_REQUIRED' as const,
        detectedAt: 'now',
        operationId: 'unknown-start',
      },
    };
    doc.runs.push(unknown);
    doc.goals[0].status = 'failed';
    return { result: null, change: { type: 'run.changed', run: unknown, goal: doc.goals[0] } };
  });
  const before = f.store.snapshot();
  const startsBefore = f.starts.length;
  const turnsBefore = f.turns.length;
  await assert.rejects(
    f.engine.resume('older-repair', 'older-repair', {
      projectId: 'p',
      runId: original.id,
      mode: 'repair',
      instructions: '',
      useCurrentProfile: false,
    }),
    { code: 'RUN_RECONCILIATION_REQUIRED' },
  );
  assert.deepEqual(
    f.store.snapshot(),
    before,
    'Rejected repair must not enqueue an attempt or alter saved work.',
  );
  assert.equal(f.starts.length, startsBefore);
  assert.equal(f.turns.length, turnsBefore);
  assert.equal(f.resumeCalls.length, 0, 'The unknown guard runs before the new-session fallback.');
});

test('an unfinished plan restarts with a complete brief when the selected backend cannot resume its planner', async (t) => {
  const options = { invalidPlans: 2, resumeSupported: false };
  const f = await fixture(t, options);
  const original = await f.run();
  assert.equal(original.status, 'failed');
  assert.equal(original.planSavedAt, undefined);
  assert.ok(original.threadId);
  const oldSession = original.coordinatorSession!.id;
  const turnsBefore = f.turns.length;
  options.invalidPlans = 0;
  await f.engine.resume('restart-planner', 'restart-planner', {
    projectId: 'p',
    runId: original.id,
    mode: 'repair',
    instructions: '',
    useCurrentProfile: false,
  });
  await f.engine.jobs.get(original.id)?.promise;
  const resumed = f.engine.get('p', original.id);
  assert.equal(resumed.status, 'completed', resumed.result);
  assert.equal(f.resumeCalls.length, 0);
  const planner = f.turns.slice(turnsBefore).find((turn) => turn.text.startsWith('First,'))!;
  assert.notEqual(planner.threadId, original.threadId);
  assert.ok(planner.text.includes('Brief: '));
  assert.ok(planner.text.includes('Set value to two.'));
  assert.ok(planner.text.includes('Preserve exports.'));
  assert.notEqual(resumed.coordinatorSession!.id, oldSession);
  assert.equal(resumed.independentReviewer, true);
});
