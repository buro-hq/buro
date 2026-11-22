import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { RuntimeRouter } from '../core/runtime-router.ts';
import { ResultService } from '../core/results.ts';
import { operationIds, serviceOperationContext } from '../core/operation-catalog.ts';
import { resolveRoleResource, validateRoleResource } from '../core/role-routing.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import { sampleRun } from './fixtures/sample-run.ts';
import type { Role, Run, ProjectProfile } from '../protocol/domain.ts';
import type { ResourceSnapshot, RuntimeResource } from '../protocol/resources.ts';

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'stage4b2-frozen-operation-')),
  );
  const role: Role = {
    id: 'release_manager',
    version: 1,
    title: 'Shared specialist',
    description: 'Implements and prepares releases.',
    instructions: 'Retain these frozen role instructions.',
    kind: 'implementation',
    runtimePreference: { mode: 'auto' },
    createdAt: '2026-11-22T00:00:00Z',
    updatedAt: '2026-11-22T00:00:00Z',
  };
  const resource = (id: string, inspection: boolean): RuntimeResource => ({
    id,
    backendId: 'fixture',
    local: true,
    configurationRevision: id + '-v1',
    capabilities: fixtureCapabilities({
      structuredTurns: true,
      toolsFreeTurns: true,
      readOnlySessions: inspection,
      immutableReview: inspection,
      resumeSessions: true,
    }),
  });
  const writer = resource('writer', false),
    first = resource('inspector-one', true),
    second = resource('inspector-two', true);
  const resources: ResourceSnapshot = {
    profileId: 'team',
    policy: 'local-only',
    coordinator: writer,
    worker: writer,
    reviewer: first,
    workerPool: [writer, first, second],
  };
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: '',
    scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
    checks: [],
    defaultCheckIds: [],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    maxRepairs: 0,
    turnTimeoutMs: 10000,
    delivery: {
      remote: 'origin',
      pullRequests: false,
      environments: [
        {
          id: 'staging',
          name: 'Staging',
          enabled: true,
          command: 'never-executed',
          url: '',
          requireConfirmation: true,
          roleId: role.id,
        },
      ],
    },
  };
  const workerDecision = resolveRoleResource(
    resources,
    role,
    serviceOperationContext(operationIds.implementation, profile),
  );
  const run: Run = {
    ...sampleRun(),
    id: 'R',
    goalId: 'G',
    workspace: path.join(directory, 'writer'),
    baseCommit: 'a'.repeat(40),
    commit: 'b'.repeat(40),
    resources,
    roleSnapshots: [role],
    assignmentResources: { [role.id]: workerDecision },
    roleAssignments: { [role.id]: ['src/'] },
    executionPolicySnapshot: {
      scope: profile.scope,
      checks: [],
      defaultCheckIds: [],
      maxWorkers: 1,
      maxRepairs: 0,
      turnTimeoutMs: 10000,
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
  const state = path.join(directory, 'state');
  const store = await FileProjectStore.open({
    directory: state,
    project: { id: 'p', name: 'Fixture', root: directory },
    profile,
    roles: [role],
  });
  await store.transact('seed', 'seed', (doc) => {
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
    doc.runs.push(run);
    return { result: null, change: { type: 'run.changed', run, goal } };
  });
  const projects = new ProjectStoreRegistry([store]),
    registry = new RuntimeCatalog();
  const starts: { runtimeId: string; operationId?: string; instructions: string }[] = [];
  for (const runtime of [writer, first, second])
    registry.register({
      id: runtime.id,
      capabilities: runtime.capabilities,
      async start(input) {
        assert.ok(
          store.snapshot().runs[0].operationResources?.[input.operationId!]?.[role.id],
          'A saved grant must precede backend dispatch.',
        );
        starts.push({
          runtimeId: runtime.id,
          operationId: input.operationId,
          instructions: input.instructions,
        });
        return { threadId: runtime.id + '-thread-' + starts.length };
      },
      async resume(input) {
        return { threadId: input.threadId };
      },
      async submit() {
        return { turnId: 'turn' };
      },
      async turn() {
        return { turnId: 'turn', text: '{"ready":true,"summary":"Ready","blockers":[]}' };
      },
      async interrupt() {},
      async release() {},
      async dispose() {},
    });
  const router = new RuntimeRouter({
    projects,
    registry,
    resources: [writer, first, second],
    selection: { forProject: () => structuredClone(resources) },
    routes: new FileRuntimeRoutes(path.join(directory, 'routes')),
    id: () => crypto.randomUUID(),
  });
  const results = new ResultService({
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
  const operationId = operationIds.deploy('staging');
  const savedRun = () => store.snapshot().runs[0];
  const prepare = () =>
    results.prepare('p', savedRun(), operationId, role.id, {}, new AbortController().signal);
  const change = (id: string, mutate: (run: Run) => void) =>
    store.transact(id, id, (doc) => {
      const current = doc.runs[0];
      mutate(current);
      return { result: null, change: { type: 'run.changed', run: current, goal: doc.goals[0] } };
    });
  return {
    store,
    state,
    directory,
    starts,
    role,
    resources,
    operationId,
    prepare,
    change,
    run: savedRun,
  };
}

test('a shared worker role gets a separate frozen operation grant without overwriting its accepted assignment', async (t) => {
  const f = await fixture(t),
    accepted = structuredClone(f.run().assignmentResources);
  await f.prepare();
  assert.deepEqual(f.run().assignmentResources, accepted);
  assert.equal(f.run().operationResources![f.operationId][f.role.id].resource.id, 'inspector-one');
  assert.equal(f.run().operationContexts![f.operationId].roles.roleId, f.role.id);
  assert.equal(f.starts[0].runtimeId, 'inspector-one');
  assert.equal(f.starts[0].operationId, f.operationId);
  assert.ok(f.starts[0].instructions.includes(f.role.instructions));
});

test('even another semantically valid coordinator proposal cannot retarget a captured operation grant or write a receipt', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const before = f.store.snapshot();
  const context = f.run().operationContexts![f.operationId];
  const replacement = resolveRoleResource(f.resources, f.role, {
    ...context,
    proposal: {
      runtimeId: 'inspector-two',
      runtimeReason: 'A different eligible model proposed later.',
    },
  });
  assert.equal(replacement.resource.id, 'inspector-two');
  assert.equal(replacement.source, 'coordinator');
  assert.deepEqual(
    validateRoleResource(f.resources, f.role, replacement, context),
    replacement,
    'The replacement is valid on its own; only frozen history prevents its adoption.',
  );
  const bytes = await fs.readFile(path.join(f.state, 'control-state.json'), 'utf8');
  await assert.rejects(
    f.change('retarget-captured-operation', (run) => {
      run.operationResources![f.operationId][f.role.id] = replacement;
    }),
    { code: 'OPERATION_CONTEXT_CHANGED' },
  );
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(await fs.readFile(path.join(f.state, 'control-state.json'), 'utf8'), bytes);
  assert.equal(
    f.store.receipt('retarget-captured-operation', 'retarget-captured-operation'),
    undefined,
  );
  assert.equal(f.starts.length, 1);
});

test('captured operation instructions, preferences and role identity cannot be rewritten, removed or duplicated', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const before = f.store.snapshot(),
    bytes = await fs.readFile(path.join(f.state, 'control-state.json'), 'utf8');
  for (const [id, mutate] of [
    [
      'instructions',
      (run: Run) => {
        run.roleSnapshots![0].instructions = 'Changed historical authority.';
      },
    ],
    [
      'preference',
      (run: Run) => {
        run.roleSnapshots![0].runtimePreference = { mode: 'fixed', runtimeId: 'inspector-two' };
      },
    ],
    [
      'model',
      (run: Run) => {
        run.roleSnapshots![0].model = 'Different historical model';
      },
    ],
    [
      'duplicate',
      (run: Run) => {
        run.roleSnapshots!.push(structuredClone(run.roleSnapshots![0]));
      },
    ],
    [
      'remove',
      (run: Run) => {
        run.roleSnapshots = [];
      },
    ],
    [
      'erase-grant',
      (run: Run) => {
        delete run.operationResources![f.operationId][f.role.id];
      },
    ],
  ] as const) {
    await assert.rejects(f.change(id, mutate), { code: 'OPERATION_CONTEXT_CHANGED' });
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(await fs.readFile(path.join(f.state, 'control-state.json'), 'utf8'), bytes);
    assert.equal(f.store.receipt(id, id), undefined);
  }
  assert.equal(f.starts.length, 1);
});

test('changing only an explanation preserves the captured authority and cannot reopen model selection', async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const before = structuredClone(f.run().operationResources![f.operationId][f.role.id]);
  await f.change('explanation-only', (run) => {
    run.operationResources![f.operationId][f.role.id].reason = 'Clarified display text.';
  });
  await f.prepare();
  const saved = f.run().operationResources![f.operationId][f.role.id];
  assert.deepEqual({ ...saved, reason: before.reason }, before);
  assert.equal(saved.reason, 'Clarified display text.');
  assert.deepEqual(
    f.starts.map((start) => start.runtimeId),
    ['inspector-one', 'inspector-one'],
  );
  assert.equal(f.run().assignmentResources![f.role.id].resource.id, 'writer');
});
