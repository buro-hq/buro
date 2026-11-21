import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeRouter,
  type RuntimeRoute,
  type RuntimeRouteStore,
} from '../core/runtime-router.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { ResourceSelection } from '../core/resource-selection.ts';
import type { AgentRuntime, RegisteredRuntime, ProjectRegistry } from '../core/ports.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import type { Role, Run } from '../protocol/domain.ts';
import type {
  AssignmentResource,
  ResourceProfile,
  RuntimeResource,
} from '../protocol/resources.ts';

const declaredCapabilities = fixtureCapabilities({ structuredTurns: true, resumeSessions: true });

function client(id: string) {
  const starts: Parameters<AgentRuntime['start']>[0][] = [],
    resumes: string[] = [];
  const runtime: RegisteredRuntime = {
    id,
    capabilities: declaredCapabilities,
    async start(input) {
      starts.push(structuredClone(input));
      return { threadId: 'native-' + id };
    },
    async resume(input) {
      resumes.push(input.threadId);
      return { threadId: input.threadId };
    },
    async submit() {
      return { turnId: 'turn' };
    },
    async turn() {
      return { turnId: 'turn', text: JSON.stringify({ runtimeId: id }) };
    },
    async interrupt() {},
    async release() {},
    async dispose() {},
  };
  return { runtime, starts, resumes };
}
function fixture(t: any) {
  const resources: RuntimeResource[] = [
    {
      id: 'local-a',
      client: 'managed',
      providerId: 'ollama',
      model: 'small-a',
      configurationRevision: 'a1',
      capabilities: declaredCapabilities,
      local: true,
    },
    {
      id: 'local-b',
      client: 'managed',
      providerId: 'ollama',
      model: 'small-b',
      configurationRevision: 'b1',
      capabilities: declaredCapabilities,
      local: true,
    },
    {
      id: 'cloud',
      client: 'managed',
      providerId: 'deepseek',
      model: 'remote',
      configurationRevision: 'c1',
      capabilities: declaredCapabilities,
      local: false,
    },
  ];
  const profiles: ResourceProfile[] = [
    {
      id: 'local',
      name: 'Local',
      policy: 'local-only',
      coordinator: 'local-a',
      worker: 'local-a',
      reviewer: 'local-b',
      workerPool: ['local-a', 'local-b'],
    },
    {
      id: 'remote',
      name: 'Remote',
      policy: 'hybrid',
      coordinator: 'cloud',
      worker: 'cloud',
      reviewer: 'cloud',
      workerPool: ['cloud'],
    },
  ];
  let defaultProfile = 'local',
    sequence = 0;
  const role: Role = {
    id: 'builder',
    version: 3,
    title: 'Builder',
    description: 'Builds modules',
    instructions: 'Work only on assigned files.',
    kind: 'implementation',
    runtimePreference: { mode: 'auto' },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const state = {
    project: { id: 'p', root: '/workspace' },
    profile: {} as { resourceProfile?: string },
    roles: [structuredClone(role)],
    runs: [] as Run[],
  };
  const projects = {
    get: () => ({ snapshot: () => structuredClone(state) }),
  } as unknown as ProjectRegistry;
  const selection = new ResourceSelection({
    projects,
    profiles,
    runtimes: resources,
    defaultProfile: () => defaultProfile,
  });
  const decision: AssignmentResource = {
    resource: structuredClone(resources[1]),
    roleVersion: 3,
    preference: { mode: 'auto' },
    source: 'coordinator',
    reason: 'Use the second local model for this assignment.',
  };
  const run = {
    id: 'R-saved',
    status: 'running',
    cancelRequested: false,
    threadId: '',
    workspace: '/workspace',
    delegation: 'buro',
    resources: selection.forProject('p'),
    executionPolicySnapshot: {
      scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: [] },
      checks: [],
      defaultCheckIds: [],
      maxWorkers: 1,
      maxRepairs: 0,
      turnTimeoutMs: 1000,
    },
    roleSnapshots: [structuredClone(role)],
    assignmentResources: { builder: structuredClone(decision) },
    roleAssignments: { builder: ['src/module.ts'] },
    agents: [
      {
        threadId: 'S-worker',
        name: 'builder',
        agentPath: '/root/builder',
        startedAt: '',
        completedAt: '',
        messages: [],
        commands: 0,
        status: 'starting',
        assignment: { paths: ['src/module.ts'] },
        session: {
          id: 'S-worker',
          roleId: 'builder',
          roleVersion: 3,
          runtimeId: 'local-b',
          providerId: 'ollama',
          model: 'small-b',
          configurationRevision: 'b1',
          selection: { source: decision.source, reason: decision.reason },
        },
      },
    ],
  } as Run;
  state.runs.push(run);
  const localA = client('local-a'),
    localB = client('local-b'),
    cloud = client('cloud');
  const registry = new RuntimeCatalog();
  for (const instance of [localA, localB, cloud]) registry.register(instance.runtime);
  const records = new Map<string, RuntimeRoute>();
  const routes: RuntimeRouteStore = {
    async load(id) {
      return structuredClone(records.get(id));
    },
    async save(route) {
      records.set(route.id, structuredClone(route));
    },
  };
  const routers: RuntimeRouter[] = [];
  const create = () => {
    const router = new RuntimeRouter({
      projects,
      selection,
      resources,
      registry,
      routes,
      id: () => String(++sequence),
    });
    routers.push(router);
    return router;
  };
  const input: Parameters<AgentRuntime['start']>[0] = {
    projectId: 'p',
    runId: run.id,
    workspace: '/workspace',
    purpose: 'implementation',
    instructions: role.instructions,
    assignment: {
      sessionId: 'S-worker',
      roleId: 'builder',
      scope: { mode: 'advisory', plannedPaths: ['src/module.ts'], protectedPaths: [] },
    },
  };
  t.after(async () => {
    for (const router of routers) await router.dispose();
    await registry.dispose();
  });
  return {
    state,
    run,
    resources,
    localA,
    localB,
    cloud,
    records,
    create,
    input,
    setDefault: (value: string) => {
      defaultProfile = value;
    },
    starts: () => localA.starts.length + localB.starts.length + cloud.starts.length,
  };
}

test('worker routing follows the saved assignment rather than a caller-supplied runtime or changed role/default', async (t) => {
  const f = fixture(t),
    router = f.create();
  f.setDefault('remote');
  f.state.roles[0] = {
    ...f.state.roles[0],
    version: 4,
    runtimePreference: { mode: 'fixed', runtimeId: 'cloud' },
  };
  const started = await router.start({
    ...f.input,
    runtimeId: 'cloud',
    assignment: { ...f.input.assignment!, runtimeId: 'cloud' },
  } as any);
  assert.equal(f.localB.starts.length, 1);
  assert.equal(f.localA.starts.length + f.cloud.starts.length, 0);
  assert.equal(f.records.get(started.threadId)?.resource.id, 'local-b');
  assert.equal(f.run.assignmentResources?.builder.roleVersion, 3);
  assert.equal(f.run.agents[0].session?.roleVersion, 3);
  assert.deepEqual(f.run.agents[0].session?.selection, {
    source: 'coordinator',
    reason: f.run.assignmentResources!.builder.reason,
  });
});

test('missing or tampered saved assignments fail before any worker client starts', async (t) => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.state.runs = [];
    },
    (f) => {
      f.run.status = 'completed';
    },
    (f) => {
      f.run.cancelRequested = true;
    },
    (f) => {
      f.run.assignmentResources = {};
    },
    (f) => {
      delete f.run.executionPolicySnapshot;
    },
    (f) => {
      f.run.executionPolicySnapshot!.scope.mode = 'strict';
    },
    (f) => {
      f.run.executionPolicySnapshot!.scope.protectedPaths = ['AGENTS.md'];
    },
    (f) => {
      f.run.roleAssignments!.builder = ['src/unassigned.ts'];
    },
    (f) => {
      f.run.agents = [];
    },
    (f) => {
      f.run.agents[0].status = 'running';
    },
    (f) => {
      f.run.agents[0].threadId = 'another-intent';
    },
    (f) => {
      f.run.agents[0].assignment!.paths = ['src/unassigned.ts'];
    },
    (f) => {
      f.run.agents[0].session!.roleId = 'other';
    },
    (f) => {
      f.run.agents[0].session!.roleVersion = 2;
    },
    (f) => {
      f.run.agents[0].session!.runtimeId = 'local-a';
    },
    (f) => {
      f.run.agents[0].session!.configurationRevision = 'b2';
    },
    (f) => {
      f.run.agents[0].session!.selection!.source = 'profile';
    },
    (f) => {
      f.run.agents[0].session!.selection!.reason = 'Different decision';
    },
    (f) => {
      f.run.assignmentResources!.builder.resource = structuredClone(f.resources[2]);
      Object.assign(f.run.agents[0].session!, {
        runtimeId: 'cloud',
        providerId: 'deepseek',
        model: 'remote',
        configurationRevision: 'c1',
      });
    },
  ];
  for (const tamper of changes) {
    const f = fixture(t);
    tamper(f);
    await assert.rejects(f.create().start(f.input));
    assert.equal(f.starts(), 0);
  }
});

test('a saved worker choice must still match the configured revision; another pool member is not a fallback', async (t) => {
  const f = fixture(t);
  f.resources[1].configurationRevision = 'b2';
  await assert.rejects(f.create().start(f.input), { code: 'RUNTIME_CONFIG_CHANGED' });
  assert.equal(f.starts(), 0);
});

test('worker restart restores its original Buro/native handles despite later defaults, role pins and allowed pools', async (t) => {
  const f = fixture(t),
    original = f.create();
  const started = await original.start(f.input),
    record = structuredClone(f.records.get(started.threadId));
  await original.dispose();
  f.setDefault('remote');
  f.state.roles[0] = {
    ...f.state.roles[0],
    version: 4,
    runtimePreference: { mode: 'fixed', runtimeId: 'local-a' },
  };
  const resumed = f.create();
  assert.deepEqual(
    await resumed.resume({
      projectId: 'p',
      runId: f.run.id,
      workspace: '/workspace',
      threadId: started.threadId,
      instructions: 'Continue the saved assignment',
    }),
    started,
  );
  assert.deepEqual(
    JSON.parse(
      (
        await resumed.turn(started.threadId, 'Continue', {
          schema: {},
          signal: new AbortController().signal,
          timeoutMs: 1000,
        })
      ).text,
    ),
    { runtimeId: 'local-b' },
  );
  assert.deepEqual(f.records.get(started.threadId), record);
  assert.deepEqual(f.localB.resumes, ['native-local-b']);
  assert.equal(f.localB.starts.length, 1);
  assert.equal(f.localA.starts.length + f.cloud.starts.length, 0);
});

test('historical runs with no assignment resource map keep their frozen default worker', async (t) => {
  const f = fixture(t);
  delete f.run.assignmentResources;
  delete f.run.resources!.workerPool;
  delete f.run.agents[0].session!.selection;
  Object.assign(f.run.agents[0].session!, {
    runtimeId: 'local-a',
    model: 'small-a',
    configurationRevision: 'a1',
  });
  f.setDefault('remote');
  await f.create().start(f.input);
  assert.equal(f.localA.starts.length, 1);
  assert.equal(f.localB.starts.length + f.cloud.starts.length, 0);
});
