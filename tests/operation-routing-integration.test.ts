import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { RuntimeRouter, type RuntimeRoute } from '../core/runtime-router.ts';
import { ResultService } from '../core/results.ts';
import { operationIds, serviceOperationContext } from '../core/operation-catalog.ts';
import { resolveRoleResource } from '../core/role-routing.ts';
import { effectiveRunPolicy } from '../core/autonomy-policy.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import type { ProjectProfile, Role, Run } from '../protocol/domain.ts';
import type { RuntimeResource, ResourceSnapshot } from '../protocol/resources.ts';
import { parseSnapshot } from '../protocol/schema.ts';

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-operation-routing-')),
  );
  const role: Role = {
    provenance: { origin: 'user' },
    id: 'coordinator',
    version: 1,
    title: 'Shared role',
    description: 'Coordinates and prepares staging',
    instructions: 'Use the actual service operation',
    kind: 'general',
    createdAt: '2026-11-22T00:00:00Z',
    updatedAt: '2026-11-22T00:00:00Z',
  };
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: 'Fixture',
    scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
    checks: [],
    defaultCheckIds: [],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    turnTimeoutMs: 10000,
    baseBranch: 'main',
    components: [],
    delivery: {
      remote: 'origin',
      pullRequests: true,
      environments: [
        {
          id: 'staging',
          name: 'Staging',
          enabled: true,
          command: 'never-run',
          url: '',
          requireConfirmation: false,
          roleId: 'coordinator',
        },
      ],
    },
  };
  const resource = (id: string, inspection: boolean): RuntimeResource => ({
    id,
    backendId: 'thirdparty',
    local: true,
    configurationRevision: id + '-v1',
    capabilities: fixtureCapabilities({
      structuredTurns: true,
      toolsFreeTurns: !inspection,
      readOnlySessions: inspection,
      immutableReview: inspection,
      strictPlannedWrites: !inspection,
      resumeSessions: true,
    }),
  });
  const writer = resource('writer', false),
    inspector = resource('inspector', true);
  const resources: ResourceSnapshot = {
    profileId: 'team',
    policy: 'local-only',
    coordinator: writer,
    worker: writer,
    reviewer: inspector,
    workerPool: [writer, inspector],
  };
  const run: Run = {
    id: 'R',
    key: 'G',
    goalId: 'G',
    title: 'Fixture',
    summary: 'Done',
    createdAt: role.createdAt,
    completedAt: role.createdAt,
    threadId: 'implementation',
    status: 'completed',
    phase: 'done',
    workspace: path.join(directory, 'writer'),
    baseCommit: 'a'.repeat(40),
    commit: 'b'.repeat(40),
    agents: [],
    events: [],
    commands: [],
    plan: [],
    changedFiles: [],
    baseline: { passed: 1, total: 1, results: [] },
    acceptance: { passed: 1, total: 1, results: [] },
    specsUnchanged: true,
    scopePreserved: true,
    independentReviewer: true,
    goalText: 'Fixture',
    result: 'Accepted',
    sourceHash: '',
    resources,
    roleSnapshots: [role],
    roleResources: {
      coordinator: resolveRoleResource(
        resources,
        role,
        serviceOperationContext(operationIds.coordination, profile),
      ),
    },
    executionPolicySnapshot: {
      scope: profile.scope,
      checks: [],
      defaultCheckIds: [],
      maxWorkers: 1,
      turnTimeoutMs: 10000,
      context: 'Fixture',
      profile,
    },
    delivery: {
      kind: 'deploy',
      environmentId: 'staging',
      status: 'running',
      commit: 'b'.repeat(40),
      summary: 'Preparing',
      updatedAt: role.createdAt,
      config: structuredClone(profile.delivery),
    },
  };
  const store = await FileProjectStore.open({
    directory: path.join(directory, 'data'),
    project: { id: 'p', name: 'Fixture', root: directory },
    profile,
    roles: [role],
  });
  await store.transact('seed', 'seed', (doc) => {
    doc.runs.push(run);
    const goal = {
      id: 'G',
      projectId: 'p',
      title: 'Fixture',
      body: 'Fixture',
      criteria: '',
      status: 'completed' as const,
      createdAt: role.createdAt,
    };
    doc.goals.push(goal);
    return { result: null, change: { type: 'run.changed', run, goal } };
  });
  const projects = new ProjectStoreRegistry([store]),
    registry = new RuntimeCatalog(),
    routes = new Map<string, RuntimeRoute>();
  const calls: {
    runtimeId: string;
    operationId?: string;
    readOnly?: boolean;
    kind: 'start' | 'turn';
  }[] = [];
  for (const item of [writer, inspector])
    registry.register({
      id: item.id,
      capabilities: item.capabilities,
      async start(input) {
        if (input.purpose === 'delivery')
          assert.ok(
            store.snapshot().runs[0].operationContexts?.[input.operationId!],
            'context must be durable before backend start',
          );
        calls.push({
          runtimeId: item.id,
          operationId: input.operationId,
          readOnly: input.readOnly,
          kind: 'start',
        });
        return { threadId: item.id + '-thread' };
      },
      async resume(input) {
        return { threadId: input.threadId };
      },
      async submit() {
        return { turnId: 'turn' };
      },
      async turn() {
        calls.push({ runtimeId: item.id, kind: 'turn' });
        return { turnId: 'turn', text: '{"ready":true,"summary":"Ready","blockers":[]}' };
      },
      async release() {},
      async interrupt() {},
      async dispose() {},
    });
  let next = 0;
  const router = new RuntimeRouter({
    projects,
    registry,
    resources: [writer, inspector],
    selection: { forProject: () => structuredClone(resources) },
    routes: {
      async load(id) {
        return structuredClone(routes.get(id));
      },
      async save(route) {
        routes.set(route.id, structuredClone(route));
      },
    },
    id: () => String(++next),
  });
  const results = new ResultService({
    workflowRoles: createBuiltinWorkflowRoles(),
    projects,
    runtime: router,
    operations: { async dispose() {} } as any,
  });
  t.after(async () => {
    await results.dispose();
    await router.dispose();
    await registry.dispose();
    await projects.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    router,
    results,
    calls,
    projects,
    routes,
    profile,
    run: () => store.snapshot().runs[0],
    async change(id: string, apply: (run: Run, doc: any) => void) {
      return store.transact(id, id, (doc) => {
        const run = doc.runs[0];
        apply(run, doc);
        return { result: null, change: { type: 'run.changed', run, goal: doc.goals[0] } };
      });
    },
  };
}

test('configured delivery reuses a coordinator role without overwriting its accepted workflow grant', async (t) => {
  const f = await fixture(t),
    original = structuredClone(f.run().roleResources);
  const coordination = await f.router.start({
    projectId: 'p',
    runId: 'R',
    workspace: f.run().workspace,
    purpose: 'coordination',
    operationId: operationIds.coordination,
    roleId: 'coordinator',
    instructions: 'Coordinate',
  });
  await f.results.prepare(
    'p',
    f.run(),
    operationIds.deploy('staging'),
    'coordinator',
    {},
    new AbortController().signal,
  );
  const saved = f.run();
  assert.deepEqual(saved.roleResources, original);
  assert.equal(
    saved.operationResources?.[operationIds.deploy('staging')].coordinator.resource.id,
    'inspector',
  );
  assert.deepEqual(
    f.calls
      .filter((call) => call.kind === 'start')
      .map(({ runtimeId, operationId, readOnly }) => ({ runtimeId, operationId, readOnly })),
    [
      { runtimeId: 'writer', operationId: operationIds.coordination, readOnly: undefined },
      { runtimeId: 'inspector', operationId: operationIds.deploy('staging'), readOnly: true },
    ],
  );
  await f.router.turn(coordination.threadId, 'Still coordinate', {
    schema: {},
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  assert.equal(f.calls.at(-1)!.runtimeId, 'writer');
  const assignments = effectiveRunPolicy(saved)!.routing.assignments.filter(
    (item) => item.roleId === 'coordinator',
  );
  assert.deepEqual(
    assignments.map((item) => [item.operationId, item.runtimeId]),
    [
      [operationIds.coordination, 'writer'],
      [operationIds.deploy('staging'), 'inspector'],
    ],
  );
});

test('captured operation context survives configuration removal and cannot be erased or retargeted through file storage', async (t) => {
  const f = await fixture(t);
  const id = operationIds.deploy('staging');
  await f.results.prepare('p', f.run(), id, 'coordinator', {}, new AbortController().signal);
  const captured = structuredClone(f.run().operationContexts![id]);
  await f.change('remove-config', (run, doc) => {
    doc.profile.delivery.environments = [];
    run.delivery!.config!.environments = [];
  });
  const projected = effectiveRunPolicy(f.run())!;
  assert.equal(
    projected.routing.assignments.find((item) => item.operationId === id)!.operationLabel,
    'Prepare deployment: Staging',
  );
  for (const [name, mutate] of [
    [
      'delete',
      (run: Run) => {
        delete run.operationContexts![id];
      },
    ],
    [
      'role',
      (run: Run) => {
        run.operationContexts![id].roles.roleId = 'another';
      },
    ],
    [
      'requirements',
      (run: Run) => {
        run.operationContexts![id].requirements.readOnlySessions = undefined;
      },
    ],
  ] as const) {
    await assert.rejects(
      f.change(name, (run) => mutate(run)),
      { code: 'OPERATION_CONTEXT_CHANGED' },
    );
    assert.deepEqual(f.run().operationContexts![id], captured);
  }
  const before = f.run();
  await assert.rejects(
    f.store.transact('remove-owner', 'remove-owner', (doc) => {
      doc.runs = [];
      return { result: null, change: { type: 'goal.updated', goal: doc.goals[0] } };
    }),
    { code: 'OPERATION_CONTEXT_CHANGED' },
  );
  assert.deepEqual(f.run(), before);
});

test('a new operation context must match a configured entrypoint before any backend dispatch', async (t) => {
  const f = await fixture(t),
    before = f.run();
  await assert.rejects(
    f.results.prepare(
      'p',
      before,
      operationIds.deploy('missing'),
      'coordinator',
      {},
      new AbortController().signal,
    ),
    { code: 'OPERATION_UNAVAILABLE' },
  );
  await assert.rejects(
    f.results.prepare(
      'p',
      before,
      operationIds.deploy('staging'),
      'unrelated',
      {},
      new AbortController().signal,
    ),
    { code: 'INVALID_ASSIGNMENT' },
  );
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.run(), before);
});

test('missing fixed service grants fail before persisting a route or starting a backend', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.router.start({
      projectId: 'p',
      runId: 'result-R',
      ownerRunId: 'R',
      workspace: f.run().workspace,
      purpose: 'delivery',
      operationId: operationIds.preview,
      readOnly: true,
      instructions: 'Missing explicit role',
    }),
    { code: 'INVALID_ASSIGNMENT' },
  );
  await f.change('missing-workflow-grant', (run) => {
    run.roleResources = undefined;
  });
  await assert.rejects(
    f.router.start({
      projectId: 'p',
      runId: 'R',
      workspace: f.run().workspace,
      purpose: 'coordination',
      operationId: operationIds.coordination,
      instructions: 'Missing saved role grant',
    }),
    { code: 'INVALID_ASSIGNMENT' },
  );
  assert.equal(f.routes.size, 0);
  assert.equal(f.calls.length, 0);
});

test('schema and runtime consumers reject an outer operation key bound to a different captured identity', async (t) => {
  const f = await fixture(t),
    id = operationIds.deploy('staging');
  await f.results.prepare('p', f.run(), id, 'coordinator', {}, new AbortController().signal);
  const tampered = f.store.snapshot();
  tampered.runs[0].operationContexts![id].id = operationIds.preview;
  assert.throws(() => parseSnapshot(tampered));
  const get = f.projects.get.bind(f.projects);
  f.projects.get = (projectId) => {
    const store = get(projectId);
    return { ...store, snapshot: () => structuredClone(tampered) } as any;
  };
  const calls = f.calls.length,
    routes = f.routes.size;
  await assert.rejects(
    f.router.start({
      projectId: 'p',
      runId: 'result-R',
      ownerRunId: 'R',
      workspace: f.run().workspace,
      purpose: 'delivery',
      operationId: id,
      roleId: 'coordinator',
      readOnly: true,
      instructions: 'Corrupt context',
    }),
    { code: 'INVALID_ASSIGNMENT' },
  );
  assert.equal(f.calls.length, calls);
  assert.equal(f.routes.size, routes);
});
