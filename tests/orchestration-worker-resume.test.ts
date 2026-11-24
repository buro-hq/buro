import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExecutionService } from '../core/execution.ts';
import { RuntimeRouter } from '../core/runtime-router.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { DomainError } from '../core/ports.ts';
import { GoalService } from '../core/services.ts';
import { executionPolicy } from '../core/project-settings.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import { ProjectRunBudgets } from '../adapters/files/project-run-budgets.ts';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import type { ModelMessage } from '../agent/contracts/model.ts';
import type { ProjectProfile } from '../protocol/domain.ts';

async function fixture(t: { after(action: () => Promise<void>): void }, loseSecondOutcome = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-worker-resume-')));
  const workspace = { path: path.join(root, 'workspace'), base: 'a'.repeat(40) };
  await fs.mkdir(workspace.path);
  const project = { id: 'p', name: 'Actual routed specialist', root, managed: true };
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: '',
    scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['AGENTS.md'] },
    checks: [{ id: 'test', title: 'Tests', command: 'must-not-run', timeoutMs: 1000 }],
    defaultCheckIds: ['test'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 2,
    turnTimeoutMs: 10000,
  };
  const store = await FileProjectStore.open({
    directory: path.join(root, 'state'),
    project,
    profile,
  });
  const projects = { get: () => store, list: () => [project] };
  const sessions = new FileManagedSessions(path.join(root, 'private-sessions'));
  const routes = new FileRuntimeRoutes(path.join(root, 'private-routes'));
  const histories: ModelMessage[][] = [];
  let serial = 0;
  const managedOptions: ConstructorParameters<typeof ManagedAgentRuntime>[0] = {
    id: 'managed',
    model: 'controlled-model',
    projects,
    sessions,
    idGenerator: () => String(++serial),
    loopRunner: new PiAgentLoopRunner(),
    budgets: new ProjectRunBudgets(projects),
    provider: {
      id: 'controlled-provider',
      revision: 'provider-v1',
      local: true,
      async complete(input) {
        histories.push(structuredClone(input.messages));
        if (loseSecondOutcome && histories.length === 2)
          throw new DomainError(
            'MODEL_CONNECTION_LOST',
            'The dispatched response outcome was lost.',
          );
        return {
          model: input.model,
          finish: 'stop',
          usage: { inputTokens: 20, outputTokens: 20 },
          message: {
            role: 'assistant',
            content: JSON.stringify({
              status: 'success',
              summary: 'pass-' + histories.length,
              artifacts: [],
              notesForNextAgent: '',
            }),
          },
        };
      },
    },
    tools: {
      revision: 'no-tools-v1',
      definitions: () => [],
      effect: () => 'read',
      async execute() {
        throw Error('No tools in this controlled session');
      },
    },
    limits: {
      contextTokens: 32768,
      maxOutputTokens: 1024,
      maxRequestsPerTurn: 8,
      maxToolCallsPerTurn: 8,
      maxSessionRequests: 16,
    },
  };
  const managed = new ManagedAgentRuntime(managedOptions);
  const alternate = new ManagedAgentRuntime({
    ...managedOptions,
    id: 'alternate',
    model: 'alternate-model',
  });
  const resource = {
    id: managed.id,
    backendId: 'managed' as const,
    providerId: 'controlled-provider',
    model: 'controlled-model',
    local: true,
    configurationRevision: 'configuration-v1',
    capabilities: managed.capabilities,
  };
  const alternateResource = { ...resource, id: alternate.id, model: 'alternate-model' };
  const resources = {
    profileId: 'controlled',
    policy: 'local-only' as const,
    coordinator: resource,
    worker: resource,
    reviewer: resource,
    workerPool: [resource, alternateResource],
  };
  const selection = { forProject: () => structuredClone(resources) };
  const registry = new RuntimeCatalog();
  registry.register(managed);
  registry.register(alternate);
  const router = new RuntimeRouter({
    registry,
    resources: [resource, alternateResource],
    routes,
    selection,
    projects,
    id: () => String(++serial),
  });
  const policy = executionPolicy(profile);
  const service = new ExecutionService({
    actions: createBuiltinExecutionActions(),
    projects,
    runtime: router,
    selection,
    workflowRoles: createBuiltinWorkflowRoles(),
    policies: { p: policy },
    now: () => new Date(Date.UTC(2026, 0, 1) + ++serial * 1000).toISOString(),
    id: () => String(++serial),
    workspaces: {
      async prepare() {
        return workspace;
      },
      async changes() {
        return [];
      },
      async captureRevision() {
        throw Error('No acceptance in this dispatch test');
      },
      async checkpoint() {
        throw Error('No acceptance in this dispatch test');
      },
    },
    checks: {
      async run() {
        throw Error('No checks in this dispatch test');
      },
    },
  });
  service.schedule = () => {};
  t.after(async () => {
    await service.dispose();
    await router.dispose();
    await registry.dispose();
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const goal = await new GoalService({
    projects,
    now: () => 'now',
    id: () => String(++serial),
  }).create('goal', 'goal', {
    projectId: 'p',
    title: 'Implement contract',
    body: 'Produce the requested result.',
    criteria: 'Handle the edge case.',
  });
  const { runId } = await service.start('run', 'run', { projectId: 'p', goalId: goal.id });
  await service.beginExecution('p', runId);
  await service.phase('p', runId, 'preparing', 'Prepare real bound workspace');
  await service.bindPreparedWorkspace('p', runId, workspace);
  const input = await store.runs.delegationContext(runId);
  let grant = await store.runs.transaction({ id: 'delegate', fingerprint: 'delegate' }, (tx) =>
    tx.delegateWorker({
      runId,
      assignmentId: 'A-worker',
      now: 'delegated',
      expectedAttemptId: service.get('p', runId).attemptId!,
      expectedInput: input,
      expectedRoleVersion: null,
      worker: {
        roleId: 'builder',
        action: 'create',
        title: 'Builder',
        description: 'Implements a scoped task',
        instructions: 'Use the current observations and finish the assignment.',
        kind: 'implementation',
        paths: ['src/value.ts'],
        runtimeId: null,
        runtimeReason: '',
        assignment: {
          objective: 'Implement the contract.',
          inputs: ['src/value.ts'],
          expectedResult: 'A complete result.',
          criteria: ['Handle the edge case.'],
        },
      },
    }),
  );
  await service.phase('p', runId, 'implementation', 'Run specialist');
  const dispatch = () =>
    service.dispatchWorkers(
      'p',
      runId,
      [grant.role],
      workspace,
      policy,
      new AbortController().signal,
      [],
      (thread, text, schema) =>
        service.completedTurn(
          'p',
          runId,
          thread,
          text + '\nNew service feedback: handle the observed edge case.',
          schema,
          new AbortController().signal,
          10000,
        ),
    );
  return {
    service,
    store,
    sessions,
    routes,
    runId,
    grant,
    histories,
    dispatch,
    async reassign(runtimeId: string, objective: string) {
      grant = await store.runs.transaction(
        { id: 'repair-' + ++serial, fingerprint: objective },
        (tx) =>
          tx.delegateWorker({
            runId,
            assignmentId: 'repair-assignment-' + serial,
            now: 'repair',
            expectedAttemptId: service.get('p', runId).attemptId!,
            expectedInput: tx.delegationContext(runId),
            expectedRoleVersion: grant.role.version,
            worker: {
              roleId: grant.role.id,
              action: 'reuse',
              title: '',
              description: '',
              kind: 'implementation',
              instructions: 'Repair exactly the reviewer finding: ' + objective,
              paths: grant.paths,
              runtimeId,
              runtimeReason: 'Selected for the next repair assignment.',
              assignment: { ...grant.task!, objective },
            },
          }),
      );
      return grant;
    },
  };
}

test('repeated settled delegation resumes the actual routed managed author with its history and same grant', async (t) => {
  const f = await fixture(t);
  await f.dispatch();
  const first = f.service
    .get('p', f.runId)
    .agents.find((agent) => agent.assignment?.grantId === f.grant.id)!;
  const route = await f.routes.load(first.threadId);
  assert.ok(route?.externalThreadId);
  await f.dispatch();
  const workers = f.service
    .get('p', f.runId)
    .agents.filter((agent) => agent.assignment?.grantId === f.grant.id);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].session!.id, first.session!.id);
  assert.equal(workers[0].threadId, first.threadId);
  assert.equal(workers[0].session!.result!.summary, 'pass-2');
  assert.equal(f.histories.length, 2);
  assert.ok(
    f.histories[1].some(
      (message) => message.role === 'assistant' && message.content.includes('pass-1'),
    ),
  );
  const checkpoint = await f.sessions.load(route!.externalThreadId!);
  assert.equal(checkpoint?.requests, 2);
  assert.equal(checkpoint?.scopeRevisions?.length, 2);
  assert.equal(f.service.get('p', f.runId).managedBudget?.used.requests, 2);
});

test('a lost resumed model reply permits a deliberate retry on the same worker without duplicating its assignment', async (t) => {
  const f = await fixture(t, true);
  await f.dispatch();
  await assert.rejects(f.dispatch(), { code: 'MODEL_RESPONSE_LOST' });
  assert.equal(f.service.get('p', f.runId).reconciliation, undefined);
  assert.equal(f.histories.length, 2, 'No automatic retry.');
  await f.dispatch();
  assert.equal(f.histories.length, 3);
  assert.equal(
    f.service.get('p', f.runId).agents.filter((agent) => agent.assignment?.grantId === f.grant.id)
      .length,
    1,
  );
});

test('review feedback and a new task reach the same managed worker; another model starts a fresh child session with handoff', async (t) => {
  const f = await fixture(t);
  await f.dispatch();
  const first = structuredClone(f.service.get('p', f.runId).agents.at(-1)!);
  const repair = await f.reassign('managed', 'Handle whitespace-only input reported by reviewer.');
  assert.equal(repair.previousAssignmentId, f.grant.id);
  await f.dispatch();
  const same = f.service.get('p', f.runId).agents.at(-1)!;
  assert.equal(same.threadId, first.threadId);
  assert.equal(same.assignment?.grantId, repair.id);
  const current = f.histories[1].filter((m) => m.role === 'user').at(-1)!.content;
  assert.match(current, /Handle whitespace-only input reported by reviewer/);
  assert.match(current, /Repair exactly the reviewer finding/);
  assert.ok(f.histories[1].some((m) => m.role === 'assistant' && m.content.includes('pass-1')));
  await f.reassign('alternate', 'Use the alternate model to repair the edge case.');
  await f.dispatch();
  const switched = f.service.get('p', f.runId).agents.at(-1)!;
  assert.notEqual(switched.threadId, first.threadId);
  assert.equal(switched.session?.runtimeId, 'alternate');
  assert.equal(switched.session?.parentId, same.session?.id);
  assert.match(f.histories[2].filter((m) => m.role === 'user').at(-1)!.content, /pass-2/);
  assert.equal(f.service.get('p', f.runId).agents.length, 2);
});
