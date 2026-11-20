import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHost } from '../plugins/host.ts';
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { ProjectRunBudgets } from '../adapters/files/project-run-budgets.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import { parseDomainEvent, parseSnapshot } from '../protocol/schema.ts';
import type { ModelProvider, ToolBroker } from '../core/model-ports.ts';
import type { ResourceSnapshot } from '../protocol/resources.ts';
import type { ManagedRunBudgetPolicy } from '../protocol/run-budget.ts';

const envelope = {
  status: 'success',
  summary: 'Updated the fixture module.',
  artifacts: ['src/value.mjs'],
  notesForNextAgent: '',
};
const policyFor = (requests = 5): ManagedRunBudgetPolicy => ({
  version: 1,
  maxRequests: requests,
  maxReservedOutputTokens: requests * 512,
  maxToolCalls: 2,
  reviewReserve: { requests: 1, outputTokens: 512, toolCalls: 1 },
});

async function fixture(
  t: any,
  options: {
    requests?: number;
    incompleteWorkerOnce?: boolean;
    poisonAfterReview?: boolean;
    poisonAtCheckpoint?: boolean;
  } = {},
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-budget-workflow-')));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=1;\n');
  const profile = ProjectProfileSchema.parse({
    version: 1,
    revision: 1,
    context: '',
    allowedPaths: ['src/'],
    protectedPaths: [],
    checks: [
      {
        id: 'value',
        title: 'Value contract',
        command: 'service-owned fixture check',
        timeoutMs: 1000,
      },
    ],
    defaultCheckIds: ['value'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    maxRepairs: 0,
    turnTimeoutMs: 10000,
    managedBudget: policyFor(options.requests),
  });
  const host = await createHost({
    projects: [
      {
        directory: path.join(root, '.buro'),
        project: { id: 'p', name: 'Budget workflow', root, managed: true },
        profile,
      },
    ],
  });
  const projects = host.ctx.projects.registry;
  const store = projects.get('p');
  const budgets = new ProjectRunBudgets(projects);
  const sessions = new FileManagedSessions(path.join(root, 'private-sessions'));
  const calls: { phase: string; cap: number }[] = [];
  let incompleteUsed = false,
    poisonUsed = false,
    checkpoints = 0,
    tools = 0;
  let runId = '';
  const provider: ModelProvider = {
    id: 'fixture-model',
    revision: 'budget-workflow-v1',
    local: true,
    async complete(input) {
      const task =
        [...input.messages].reverse().find((message) => message.role === 'user')?.content || '';
      let content: string, phase: string;
      if (task.startsWith('First,')) {
        phase = 'planning';
        content = JSON.stringify({
          summary: 'One coherent assignment.',
          steps: [
            { step: 'Update the module.', owner: 'builder' },
            { step: 'Review the result.', owner: 'reviewer' },
          ],
          team: [
            {
              roleId: 'builder',
              action: 'create',
              title: 'Builder',
              description: 'Implements a bounded edit.',
              instructions: 'Use the assigned path and preserve checks.',
              kind: 'implementation',
              paths: ['src/value.mjs'],
              assignment: {
                objective: 'Set the exported value to two.',
                inputs: ['src/value.mjs'],
                expectedResult: 'The module exports value 2.',
                criteria: ['Change only the assigned module.'],
              },
            },
          ],
        });
      } else if (task.startsWith('Refine the failed worker assignment')) {
        phase = 'refinement';
        content = JSON.stringify({
          objective: 'Read current state and finish the value-two edit.',
          inputs: ['src/value.mjs'],
        });
      } else if (task.startsWith('Review goal')) {
        phase = 'review';
        content = JSON.stringify({
          verdict: 'approved',
          blockingFindings: [],
          summary: 'The fixture contract is satisfied.',
        });
      } else if (task.startsWith('Execute your assigned work')) {
        phase = 'worker';
        if (options.incompleteWorkerOnce && !incompleteUsed) {
          incompleteUsed = true;
          calls.push({ phase, cap: input.maxOutputTokens });
          return {
            model: input.model,
            finish: 'length',
            usage: { inputTokens: 12, outputTokens: 20 },
            message: { role: 'assistant', content: 'Interrupted before any tools.' },
          };
        }
        if (!input.messages.some((message) => message.role === 'tool')) {
          calls.push({ phase, cap: input.maxOutputTokens });
          return {
            model: input.model,
            finish: 'tools',
            usage: { inputTokens: 12, outputTokens: 20 },
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'edit-' + randomUUID(), name: 'edit_value', arguments: {} }],
            },
          };
        }
        content = JSON.stringify(envelope);
      } else {
        phase = 'integration';
        content = JSON.stringify(envelope);
      }
      calls.push({ phase, cap: input.maxOutputTokens });
      return {
        model: input.model,
        finish: 'stop',
        usage: { inputTokens: 12, outputTokens: 20 },
        message: { role: 'assistant', content },
      };
    },
  };
  const broker: ToolBroker = {
    definitions: (scope) =>
      scope.readOnly
        ? []
        : [
            {
              name: 'edit_value',
              description: 'Apply the fixed fixture edit.',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
          ],
    async execute(_call, scope) {
      assert.equal(scope.readOnly, false);
      assert.deepEqual(scope.allowedPaths, ['src/value.mjs']);
      tools++;
      await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=2;\n');
      return { content: 'Updated the fixture module.' };
    },
  };
  const runtime = new ManagedAgentRuntime({
    id: 'managed',
    model: 'fixture-model',
    provider,
    sessions,
    tools: broker,
    projects,
    budgets,
    idGenerator: randomUUID,
    limits: {
      contextTokens: 65536,
      maxOutputTokens: 512,
      maxRequestsPerTurn: 8,
      maxToolCallsPerTurn: 4,
      maxSessionRequests: 24,
    },
  });
  const resource = {
    id: 'managed',
    client: 'managed' as const,
    providerId: provider.id,
    model: 'fixture-model',
    configurationRevision: 'fixture-v1',
    local: true,
  };
  const selection: ResourceSnapshot = {
    profileId: 'fixture',
    policy: 'local-only',
    coordinator: resource,
    worker: resource,
    reviewer: resource,
  };
  const poison = async () => {
    if (poisonUsed) return;
    poisonUsed = true;
    const reservation = await budgets.reserveGeneration({
      projectId: 'p',
      ownerRunId: runId,
      operationId: 'late-inflight',
      phase: 'review',
      requestedOutputTokens: 512,
      minimumOutputTokens: 128,
    });
    await assert.rejects(
      budgets.recordUsage({
        projectId: 'p',
        ownerRunId: runId,
        operationId: reservation.operationId,
        outcome: 'observed',
        usage: { inputTokens: 1, outputTokens: reservation.maxOutputTokens + 1 },
      }),
      { code: 'RUN_BUDGET_USAGE_EXCEEDED' },
    );
  };
  const release = runtime.release.bind(runtime);
  runtime.release = async (threadId) => {
    const session = await sessions.load(threadId);
    await release(threadId);
    if (options.poisonAfterReview && session?.purpose === 'review') await poison();
  };
  const engine = new ExecutionService({
    projects,
    runtime,
    selection: { forProject: () => structuredClone(selection) },
    policies: { p: { ...profile, profile, checks: [{ id: 'value', title: 'Value contract' }] } },
    now: () => new Date().toISOString(),
    id: randomUUID,
    workspaces: {
      async prepare() {
        return { path: root, base: 'fixture-base' };
      },
      async restore() {
        return { path: root, base: 'fixture-base' };
      },
      async changes() {
        const actual = await fs.readFile(path.join(root, 'src/value.mjs'), 'utf8');
        return actual === 'export const value=1;\n'
          ? []
          : [{ path: 'src/value.mjs', before: 'export const value=1;\n', after: actual }];
      },
      async checkpoint() {
        checkpoints++;
        if (options.poisonAtCheckpoint) await poison();
        return 'a'.repeat(40);
      },
    },
    checks: {
      async run() {
        const passed =
          (await fs.readFile(path.join(root, 'src/value.mjs'), 'utf8')) ===
          'export const value=2;\n';
        return { passed: passed ? 1 : 0, total: 1, results: [{ name: 'Value contract', passed }] };
      },
    },
  });
  const goals = new GoalService({ projects, now: () => new Date().toISOString(), id: randomUUID });
  const goal = await goals.create('fixture-goal', 'fixture-goal', {
    projectId: 'p',
    title: 'Value contract',
    body: 'Set the value to two.',
    criteria: 'Only the module changes.',
  });
  t.after(async () => {
    await engine.dispose();
    await runtime.dispose();
    await host.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    engine,
    host,
    store,
    projects,
    runtime,
    selection,
    profile,
    goal,
    calls,
    get checkpoints() {
      return checkpoints;
    },
    get tools() {
      return tools;
    },
    async start() {
      const result = await engine.start('fixture-start', 'fixture-start', {
        projectId: 'p',
        goalId: goal.id,
      });
      runId = result.runId;
      await engine.jobs.get(runId)?.promise;
      return engine.get('p', runId);
    },
    async raw() {
      return JSON.parse(await fs.readFile(path.join(root, '.buro/control-state.json'), 'utf8'));
    },
  };
}

test('managed workflow freezes its ledger at creation and leaves final review capacity after all work calls', async (t) => {
  const f = await fixture(t);
  const events: unknown[] = [];
  f.store.subscribe(f.store.snapshot().sequence, (event) => events.push(parseDomainEvent(event)));
  const run = await f.start();
  assert.equal(run.status, 'completed', run.result);
  assert.equal(run.managedBudget?.coverage, 'managed-api');
  assert.equal(run.managedBudget?.workUsed.requests, 4);
  assert.equal(run.managedBudget?.reviewUsed.requests, 1);
  assert.equal(run.managedBudget?.used.requests, 5);
  assert.equal(f.calls.length, 5);
  assert.equal(f.tools, 1);
  assert.equal(run.independentReviewer, true);
  const raw = await f.raw();
  assert.ok(raw.managedRunBudgets[run.id]);
  assert.equal(
    raw.events.find((event: any) => event.change.type === 'run.changed').change.run.managedBudget
      .used.requests,
    0,
  );
  const publicSnapshot = parseSnapshot(f.store.snapshot());
  assert.equal(JSON.stringify(publicSnapshot).includes('operations'), false);
  assert.equal(JSON.stringify(events).includes('G-T-'), false);
  assert.ok(events.length > 5);
});

test('aggregate exhaustion is needs-attention and never starts a hidden replacement or final review', async (t) => {
  const f = await fixture(t, { requests: 4 });
  const run = await f.start();
  assert.equal(run.status, 'needs-attention', run.result);
  assert.equal(run.issue?.code, 'MANAGED_BUDGET_BLOCKED');
  assert.equal(run.issue?.budgetCode, 'RUN_BUDGET_EXHAUSTED');
  assert.equal(run.managedBudget?.used.requests, 3);
  assert.equal(f.calls.length, 3);
  assert.equal(run.workerReplan, undefined);
  assert.equal(run.independentReviewer, false);
  assert.equal(f.checkpoints, 0);
  assert.equal(
    f.store.snapshot().roles.some((role) => role.id === 'builder'),
    false,
  );
});

test('manual continuation with a larger current profile cannot reset the frozen budget', async (t) => {
  const f = await fixture(t, { requests: 4 });
  const before = await f.start();
  f.engine.env.policies.p = {
    ...f.engine.env.policies.p,
    profile: { ...f.profile, revision: 2, managedBudget: policyFor(20) },
  };
  await f.engine.resume('continue', 'continue', {
    projectId: 'p',
    runId: before.id,
    mode: 'repair',
    instructions: 'Continue the current work.',
    useCurrentProfile: true,
  });
  await f.engine.jobs.get(before.id)?.promise;
  const after = f.engine.get('p', before.id);
  assert.equal(after.status, 'needs-attention', after.result);
  assert.deepEqual(after.managedBudget, before.managedBudget);
  assert.equal(after.managedBudget?.policy.maxRequests, 4);
  assert.equal(f.calls.length, 3);
});

test('a replacement worker shares all prior charges and cannot restart the allowance', async (t) => {
  const f = await fixture(t, { requests: 7, incompleteWorkerOnce: true });
  const run = await f.start();
  assert.equal(run.status, 'completed', run.result);
  assert.equal(run.workerReplan?.status, 'completed');
  assert.equal(run.managedBudget?.used.requests, 7);
  assert.equal(run.managedBudget?.workUsed.requests, 6);
  assert.equal(run.agents.filter((agent) => agent.session?.roleId === 'builder').length, 2);
  assert.equal(f.calls.filter((call) => call.phase === 'refinement').length, 1);
});

test('poison observed after reviewer approval prevents checkpoint and accepted commit', async (t) => {
  const f = await fixture(t, { requests: 8, poisonAfterReview: true });
  const run = await f.start();
  assert.equal(run.status, 'needs-attention', run.result);
  assert.equal(run.managedBudget?.status, 'exceeded');
  assert.equal(run.issue?.budgetCode, 'RUN_BUDGET_USAGE_EXCEEDED');
  assert.equal(run.review?.verdict, 'approved');
  assert.equal(run.commit, undefined);
  assert.equal(f.checkpoints, 0);
  const sequence = f.store.snapshot().sequence;
  const calls = f.calls.length;
  for (const mode of ['repair', 'recheck'] as const) {
    await assert.rejects(
      f.engine.resume('blocked-' + mode, 'blocked-' + mode, {
        projectId: 'p',
        runId: run.id,
        mode,
        instructions: 'Try continuing',
        useCurrentProfile: true,
      }),
      { code: 'RUN_BUDGET_USAGE_EXCEEDED' },
    );
  }
  assert.equal(f.store.snapshot().sequence, sequence, 'A poisoned run must not be queued again');
  assert.equal(f.calls.length, calls);
});

test('the final acceptance transaction rejects a budget poisoned during checkpoint', async (t) => {
  const f = await fixture(t, { requests: 8, poisonAtCheckpoint: true });
  const run = await f.start();
  assert.equal(run.status, 'needs-attention', run.result);
  assert.equal(run.managedBudget?.status, 'exceeded');
  assert.equal(
    parseSnapshot(f.store.snapshot()).runs[0].issue?.budgetCode,
    'RUN_BUDGET_USAGE_EXCEEDED',
  );
  assert.equal(run.commit, undefined);
  assert.equal(f.checkpoints, 1);
  assert.equal((await f.raw()).executionHead, undefined);
  assert.equal(
    f.store.snapshot().roles.some((role) => role.id === 'builder'),
    false,
  );
});

test('a failed atomic run creation dispatches nothing and leaves no orphan ledger', async (t) => {
  const f = await fixture(t);
  const store = f.store as any;
  const original = store.replace;
  store.replace = async () => {
    throw Error('Fixture atomic replacement unavailable');
  };
  await assert.rejects(f.start(), /atomic replacement unavailable/);
  store.replace = original;
  assert.equal(f.calls.length, 0);
  assert.equal(f.engine.jobs.size, 0);
  assert.equal(f.store.snapshot().runs.length, 0);
  assert.equal((await f.raw()).managedRunBudgets, undefined);
});

test('native-only selection does not fabricate managed model accounting', async (t) => {
  const f = await fixture(t);
  const native = {
    ...f.selection.coordinator,
    id: 'codex',
    client: 'codex' as const,
    local: false,
  };
  f.engine.env.selection = {
    forProject: () => ({
      profileId: 'native',
      policy: 'hybrid',
      coordinator: native,
      worker: native,
      reviewer: native,
    }),
  };
  f.engine.schedule = () => {};
  const run = await f.start();
  assert.equal(run.status, 'queued');
  assert.equal(run.managedBudget, undefined);
  assert.equal((await f.raw()).managedRunBudgets, undefined);
  assert.equal(f.calls.length, 0);
});
