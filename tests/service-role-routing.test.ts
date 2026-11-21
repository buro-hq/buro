import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectRegistry, RegisteredRuntime, RuntimeEvent } from '../core/ports.ts';
import type { Role, Run } from '../protocol/domain.ts';
import type { ResourceSnapshot, RuntimeResource } from '../protocol/resources.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { RuntimeRouter, type RuntimeRoute } from '../core/runtime-router.ts';
import { resolveRoleResource, roleResourceContext } from '../core/role-routing.ts';
import { ResultService } from '../core/results.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';

const resource = (id: string): RuntimeResource => ({
  id,
  client: 'codex',
  local: true,
  configurationRevision: id + '-v1',
  capabilities: fixtureCapabilities({
    structuredTurns: true,
    readOnlySessions: true,
    immutableReview: true,
    strictPlannedWrites: true,
    resumeSessions: true,
    cancellation: 'settled-or-unknown',
  }),
});
const role = (id: string, runtimeId = 'second', version = 1): Role => ({
  id,
  version,
  title: id,
  description: 'Role',
  instructions: 'Saved ' + id + ' v' + version,
  kind: 'general',
  runtimePreference: { mode: 'fixed', runtimeId },
  createdAt: 'now',
  updatedAt: 'now',
});
function fixture(t: any) {
  const first = resource('first'),
    second = resource('second');
  const resources: ResourceSnapshot = {
    profileId: 'team',
    policy: 'local-only',
    coordinator: first,
    worker: first,
    reviewer: first,
    workerPool: [first, second],
  };
  const run = {
    id: 'R',
    goalId: 'G',
    workspace: '/writer',
    baseCommit: 'a'.repeat(40),
    commit: 'b'.repeat(40),
    status: 'completed',
    goalText: 'Goal',
    result: 'Done',
    resources,
    roleSnapshots: [],
    agents: [],
    events: [],
    executionPolicySnapshot: {
      defaultCheckIds: [],
      checks: [],
      maxWorkers: 1,
      maxRepairs: 0,
      turnTimeoutMs: 1000,
      scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
    },
  } as unknown as Run;
  const state = {
    project: { id: 'p', root: '/source' },
    profile: { scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] } },
    roles: [
      role('coordinator'),
      role('reviewer', 'first'),
      role('local_preview'),
      role('delivery_pr'),
      role('production_delivery'),
    ],
    runs: [run],
    goals: [{ id: 'G' }],
  };
  const projects = {
    get: () => ({
      snapshot: () => structuredClone(state),
      async transact(_id: string, _fingerprint: string, apply: (doc: any) => any) {
        const draft = { ...structuredClone(state), roleVersions: structuredClone(state.roles) };
        const result = apply(draft);
        Object.assign(state, draft);
        return result.result;
      },
    }),
  } as unknown as ProjectRegistry;
  const calls = new Map<
    string,
    { starts: Parameters<RegisteredRuntime['start']>[0][]; turns: number; releases: string[] }
  >();
  const registry = new RuntimeCatalog();
  for (const item of [first, second]) {
    const counter = {
      starts: [] as Parameters<RegisteredRuntime['start']>[0][],
      turns: 0,
      releases: [] as string[],
    };
    calls.set(item.id, counter);
    const backend: RegisteredRuntime = {
      id: item.id,
      capabilities: item.capabilities,
      async start(input) {
        if (input.roleId)
          assert.ok(
            state.runs[0].roleResources?.[input.roleId],
            'Role choice must persist before dispatch',
          );
        counter.starts.push(structuredClone(input));
        return { threadId: 'same-wire' };
      },
      async resume(input) {
        return { threadId: input.threadId };
      },
      async turn() {
        counter.turns++;
        return { turnId: 'turn', text: '{"ready":true,"summary":"Prepared","blockers":[]}' };
      },
      async submit() {
        return { turnId: 'turn' };
      },
      async interrupt() {},
      async release(id) {
        counter.releases.push(id);
      },
      async dispose() {},
    };
    registry.register(backend);
  }
  const routes = new Map<string, RuntimeRoute>();
  let sequence = 0;
  const router = new RuntimeRouter({
    projects,
    registry,
    resources: [first, second],
    selection: { forProject: () => structuredClone(resources) },
    routes: {
      async load(id) {
        return structuredClone(routes.get(id));
      },
      async save(value) {
        routes.set(value.id, structuredClone(value));
      },
    },
    id: () => String(++sequence),
  });
  const results = new ResultService({ projects, runtime: router, operations: {} as any });
  t.after(async () => {
    await router.dispose();
    await registry.dispose();
  });
  return {
    state,
    projects,
    resources,
    router,
    routes,
    calls,
    results,
    run: () => structuredClone(state.runs[0]),
  };
}

test('service coordinator and fresh reviewer use frozen role choices rather than profile defaults', async (t) => {
  const f = fixture(t),
    run = f.state.runs[0];
  run.status = 'running';
  run.roleSnapshots = f.state.roles.filter((item) => ['coordinator', 'reviewer'].includes(item.id));
  run.roleResources = {
    coordinator: resolveRoleResource(
      f.resources,
      run.roleSnapshots[0],
      roleResourceContext('coordinator', false),
    ),
    reviewer: resolveRoleResource(
      f.resources,
      run.roleSnapshots[1],
      roleResourceContext('reviewer', false),
    ),
  };
  const coordinator = await f.router.start({
    projectId: 'p',
    runId: 'R',
    workspace: '/writer',
    purpose: 'coordination',
    roleId: 'coordinator',
    instructions: 'Coordinate',
  });
  run.verificationView = {
    version: 1,
    id: 'issued',
    projectId: 'p',
    runId: 'R',
    sourceWorkspace: '/writer',
    readRoot: '/frozen',
    outputRoot: '/outputs',
    base: run.baseCommit!,
    tree: 'c'.repeat(40),
    outputPaths: [],
  };
  const reviewer = await f.router.start({
    projectId: 'p',
    runId: 'R',
    workspace: '/frozen',
    purpose: 'review',
    roleId: 'reviewer',
    readOnly: true,
    instructions: 'Review',
  });
  assert.notEqual(coordinator.threadId, reviewer.threadId);
  assert.equal(f.calls.get('second')!.starts[0].roleId, 'coordinator');
  assert.equal(f.calls.get('first')!.starts[0].roleId, 'reviewer');
  assert.equal(f.calls.get('first')!.starts[0].readOnly, true);
  assert.equal(f.routes.get(coordinator.threadId)!.roleDecision!.resource.id, 'second');
  assert.equal(f.resources.coordinator.id, 'first');
});

test('a changed frozen role grant blocks new dispatch but descriptive reason changes do not revoke a session', async (t) => {
  const f = fixture(t),
    run = f.state.runs[0];
  run.status = 'running';
  const selected = f.state.roles[0];
  run.roleSnapshots = [selected];
  run.roleResources = {
    coordinator: resolveRoleResource(
      f.resources,
      selected,
      roleResourceContext('coordinator', false),
    ),
  };
  const session = await f.router.start({
    projectId: 'p',
    runId: 'R',
    workspace: '/writer',
    purpose: 'coordination',
    instructions: 'Coordinate',
  });
  run.roleResources.coordinator.reason = 'Human-readable explanation changed';
  await f.router.turn(session.threadId, 'Continue', {
    schema: {},
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  const updated = role('coordinator', 'second', 2);
  run.roleSnapshots.push(updated);
  run.roleResources.coordinator = resolveRoleResource(
    f.resources,
    updated,
    roleResourceContext('coordinator', false),
  );
  await assert.rejects(
    f.router.turn(session.threadId, 'Continue', {
      schema: {},
      signal: new AbortController().signal,
      timeoutMs: 1000,
    }),
    { code: 'INVALID_ASSIGNMENT' },
  );
  assert.equal(f.calls.get('second')!.turns, 1);
  await f.router.release(session.threadId);
  assert.deepEqual(f.calls.get('second')!.releases, ['same-wire']);
});

test('operational preparation persists its actual role and choice before start and reports selected metadata', async (t) => {
  const f = fixture(t);
  const original = structuredClone(f.resources);
  await f.results.prepare('p', f.run(), 'delivery_pr', {}, new AbortController().signal);
  assert.equal(f.calls.get('second')!.starts.length, 1);
  assert.equal(f.calls.get('first')!.starts.length, 0);
  assert.equal(f.calls.get('second')!.starts[0].roleId, 'delivery_pr');
  const saved = f.run();
  assert.equal(saved.roleResources?.delivery_pr.resource.id, 'second');
  assert.equal(saved.roleSnapshots?.find((item) => item.id === 'delivery_pr')?.version, 1);
  assert.equal(saved.resultAgents?.[0].session?.runtimeId, 'second');
  assert.equal(saved.resultAgents?.[0].session?.selection?.source, 'fixed');
  assert.equal(
    saved.effectivePolicy?.routing.assignments.find((item) => item.roleId === 'delivery_pr')
      ?.runtimeId,
    'second',
  );
  assert.deepEqual(saved.resources, original);
  f.state.roles = f.state.roles.map((item) =>
    item.id === 'delivery_pr' ? role('delivery_pr', 'first', 2) : item,
  );
  await f.results.prepare('p', f.run(), 'delivery_pr', {}, new AbortController().signal);
  assert.equal(f.calls.get('second')!.starts.length, 2);
  assert.equal(f.run().roleResources!.delivery_pr.roleVersion, 1);
});

test('an unavailable fixed operational choice never starts the profile default or writes a partial decision', async (t) => {
  const f = fixture(t);
  f.state.roles = f.state.roles.map((item) =>
    item.id === 'local_preview' ? role('local_preview', 'outside') : item,
  );
  await assert.rejects(
    f.results.prepare('p', f.run(), 'local_preview', {}, new AbortController().signal),
    { code: 'FIXED_RUNTIME_UNAVAILABLE' },
  );
  assert.equal(f.calls.get('first')!.starts.length + f.calls.get('second')!.starts.length, 0);
  assert.equal(f.run().roleResources?.local_preview, undefined);
  await assert.rejects(
    f.router.start({
      projectId: 'p',
      runId: 'result-R',
      ownerRunId: 'R',
      workspace: '/writer',
      purpose: 'delivery',
      readOnly: true,
      instructions: 'Missing role',
    }),
    { code: 'INVALID_ASSIGNMENT' },
  );
});

test('a failed result session metadata write releases the already started backend without a model turn', async (t) => {
  const f = fixture(t);
  const original = f.projects.get.bind(f.projects);
  let writes = 0;
  f.projects.get = (id) => {
    const store = original(id);
    return {
      ...store,
      async transact(...args: any[]) {
        writes++;
        if (writes === 2) throw Error('Metadata storage failed');
        return (store.transact as any)(...args);
      },
    };
  };
  await assert.rejects(
    f.results.prepare('p', f.run(), 'delivery_pr', {}, new AbortController().signal),
    /Metadata storage failed/,
  );
  assert.equal(f.calls.get('second')!.starts.length, 1);
  assert.equal(f.calls.get('second')!.turns, 0);
  assert.deepEqual(f.calls.get('second')!.releases, ['same-wire']);
});
