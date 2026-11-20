import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RuntimeRouter,
  type RuntimeRoute,
  type RuntimeRouteStore,
} from '../core/runtime-router.ts';
import { ResourceSelection } from '../core/resource-selection.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import type { AgentRuntime, ProjectRegistry, RuntimeEvent } from '../core/ports.ts';
import type { ResourceProfile, ResourceSnapshot, RuntimeResource } from '../protocol/resources.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';

class MemoryRoutes implements RuntimeRouteStore {
  readonly saved = new Map<string, RuntimeRoute>();
  async load(id: string) {
    return structuredClone(this.saved.get(id));
  }
  async save(route: RuntimeRoute) {
    this.saved.set(route.id, structuredClone(route));
  }
}

function adapter(id: string) {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const calls = {
    starts: [] as Parameters<AgentRuntime['start']>[0][],
    resumes: [] as Parameters<NonNullable<AgentRuntime['resume']>>[0][],
    turns: [] as string[],
    releases: [] as string[],
  };
  const runtime: AgentRuntime = {
    id,
    async start(input) {
      calls.starts.push(input);
      return { threadId: 'same-native-thread' };
    },
    async resume(input) {
      calls.resumes.push(input);
      return { threadId: input.threadId };
    },
    async submit(threadId) {
      calls.turns.push(threadId);
      return { turnId: id + '-turn' };
    },
    async turn(threadId) {
      calls.turns.push(threadId);
      return { turnId: id + '-turn', text: JSON.stringify({ runtime: id }) };
    },
    async interrupt() {},
    async release(threadId) {
      calls.releases.push(threadId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {},
  };
  return {
    runtime,
    calls,
    emit: (event: RuntimeEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function fixture(t: any) {
  const resources: RuntimeResource[] = [
    {
      id: 'local',
      client: 'managed',
      providerId: 'ollama',
      model: 'local-model',
      configurationRevision: 'local-v1',
      local: true,
    },
    {
      id: 'cloud',
      client: 'managed',
      providerId: 'deepseek',
      model: 'cloud-model',
      configurationRevision: 'cloud-v1',
      local: false,
    },
    { id: 'codex', client: 'codex', configurationRevision: 'codex-v1', local: false },
  ];
  const profiles: ResourceProfile[] = [
    {
      id: 'mixed',
      name: 'Mixed',
      policy: 'hybrid',
      coordinator: 'local',
      worker: 'cloud',
      reviewer: 'cloud',
    },
    {
      id: 'local',
      name: 'Local',
      policy: 'local-only',
      coordinator: 'local',
      worker: 'local',
      reviewer: 'local',
    },
    {
      id: 'remote',
      name: 'Remote',
      policy: 'hybrid',
      coordinator: 'cloud',
      worker: 'cloud',
      reviewer: 'cloud',
    },
    {
      id: 'unsafe',
      name: 'Invalid local choice',
      policy: 'local-only',
      coordinator: 'cloud',
      worker: 'local',
      reviewer: 'local',
    },
  ];
  let defaultProfile = 'mixed',
    sequence = 0;
  const state = {
    project: { id: 'p', root: '/workspace' },
    profile: {} as { resourceProfile?: string },
    runs: [] as {
      id: string;
      threadId: string;
      resources?: ResourceSnapshot;
      workspace?: string;
    }[],
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
  const local = adapter('local'),
    cloud = adapter('cloud'),
    codex = adapter('codex');
  const registry = new RuntimeCatalog();
  for (const item of [local, cloud, codex]) registry.register(item.runtime);
  const routes = new MemoryRoutes(),
    routers: RuntimeRouter[] = [];
  const create = (store: RuntimeRouteStore = routes) => {
    const router = new RuntimeRouter({
      projects,
      selection,
      resources,
      registry,
      routes: store,
      id: () => String(++sequence),
    });
    routers.push(router);
    return router;
  };
  t.after(async () => {
    for (const router of routers) await router.dispose();
    await registry.dispose();
  });
  return {
    resources,
    selection,
    state,
    local,
    cloud,
    codex,
    routes,
    create,
    setDefault: (id: string) => {
      defaultProfile = id;
    },
  };
}
const turnOptions = () => ({ schema: {}, signal: new AbortController().signal, timeoutMs: 1000 });

test('same native IDs from different runtimes receive distinct Buro handles and event identities', async (t) => {
  const f = fixture(t),
    router = f.create();
  const events: RuntimeEvent[] = [];
  router.subscribe((event) => events.push(event));
  const coordinator = await router.start({
    projectId: 'p',
    runId: 'R-one',
    instructions: 'Plan',
    purpose: 'coordination',
  });
  const worker = await router.start({
    projectId: 'p',
    runId: 'R-one',
    instructions: 'Work',
    purpose: 'implementation',
  });
  assert.notEqual(coordinator.threadId, worker.threadId);
  assert.deepEqual(
    JSON.parse((await router.turn(coordinator.threadId, 'Plan', turnOptions())).text),
    { runtime: 'local' },
  );
  assert.deepEqual(JSON.parse((await router.turn(worker.threadId, 'Work', turnOptions())).text), {
    runtime: 'cloud',
  });
  for (const runtime of [f.local, f.cloud])
    runtime.emit({
      id: 'same-event',
      runId: 'R-one',
      threadId: 'same-native-thread',
      type: 'message.completed',
      text: 'Progress',
    });
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => event.threadId),
    [coordinator.threadId, worker.threadId],
  );
  assert.notEqual(events[0].id, events[1].id);
  f.local.emit({
    id: 'foreign-run',
    runId: 'R-foreign',
    threadId: 'same-native-thread',
    type: 'message.completed',
    text: 'Foreign',
  });
  assert.equal(events.length, 2);
  assert.deepEqual(f.local.calls.turns, ['same-native-thread']);
  assert.deepEqual(f.cloud.calls.turns, ['same-native-thread']);
});

test('a run keeps its resource snapshot when defaults change, and project overrides affect future selection', async (t) => {
  const f = fixture(t),
    router = f.create();
  f.state.runs.push({ id: 'R-saved', threadId: '', resources: f.selection.forProject('p') });
  f.setDefault('local');
  await router.start({
    projectId: 'p',
    runId: 'R-saved',
    instructions: 'Saved worker',
    purpose: 'implementation',
  });
  await router.start({
    projectId: 'p',
    runId: 'R-new',
    instructions: 'New worker',
    purpose: 'implementation',
  });
  assert.equal(f.cloud.calls.starts.length, 1);
  assert.equal(f.local.calls.starts.length, 1);
  f.state.profile.resourceProfile = 'remote';
  assert.equal(f.selection.forProject('p').coordinator.id, 'cloud');
  assert.equal(f.state.runs[0].resources?.coordinator.id, 'local');
});

test('local-only and unavailable profiles fail before any native client starts', async (t) => {
  const f = fixture(t),
    router = f.create();
  f.setDefault('unsafe');
  await assert.rejects(router.start({ projectId: 'p', instructions: 'Work' }), {
    code: 'DATA_POLICY_BLOCKED',
  });
  f.setDefault('missing');
  await assert.rejects(router.start({ projectId: 'p', instructions: 'Work' }), {
    code: 'RESOURCE_PROFILE_UNAVAILABLE',
  });
  assert.equal(
    f.local.calls.starts.length + f.cloud.calls.starts.length + f.codex.calls.starts.length,
    0,
  );
  assert.equal(f.routes.saved.size, 0);
});

test('restart resumes the persisted runtime rather than the new default and verifies scope', async (t) => {
  const f = fixture(t),
    first = f.create();
  const started = await first.start({
    projectId: 'p',
    runId: 'R-one',
    workspace: '/workspace',
    instructions: 'Work',
    purpose: 'implementation',
  });
  await first.dispose();
  f.setDefault('local');
  const restored = f.create();
  const input = {
    projectId: 'p',
    runId: 'R-one',
    workspace: '/workspace',
    threadId: started.threadId,
    instructions: 'Continue',
  };
  assert.deepEqual(await restored.resume(input), started);
  assert.equal(f.cloud.calls.starts.length, 1);
  assert.equal(f.cloud.calls.resumes.length, 1);
  assert.equal(f.cloud.calls.resumes[0].threadId, 'same-native-thread');
  assert.equal(f.local.calls.resumes.length, 0);
  for (const patch of [{ projectId: 'foreign' }, { runId: 'R-other' }, { workspace: '/other' }])
    await assert.rejects(restored.resume({ ...input, ...patch }), { code: 'SESSION_MISMATCH' });
  assert.equal(f.cloud.calls.resumes.length, 1);
});

test('configuration changes fail closed instead of moving an existing session', async (t) => {
  const f = fixture(t),
    router = f.create();
  const started = await router.start({
    projectId: 'p',
    runId: 'R-one',
    instructions: 'Work',
    purpose: 'implementation',
  });
  f.resources[1].configurationRevision = 'cloud-v2';
  await assert.rejects(router.turn(started.threadId, 'Continue', turnOptions()), {
    code: 'RUNTIME_CONFIG_CHANGED',
  });
  await assert.rejects(
    router.resume({
      projectId: 'p',
      runId: 'R-one',
      workspace: '/workspace',
      threadId: started.threadId,
      instructions: 'Continue',
    }),
    { code: 'RUNTIME_CONFIG_CHANGED' },
  );
  assert.equal(f.cloud.calls.turns.length + f.local.calls.turns.length, 0);
  f.resources[1].configurationRevision = 'cloud-v1';
});

test('failed route intent prevents dispatch; failed binding releases the started client and never restarts it on resume', async (t) => {
  const f = fixture(t);
  const noIntent = f.create({
    async load() {
      return undefined;
    },
    async save() {
      throw Error('intent storage unavailable');
    },
  });
  await assert.rejects(
    noIntent.start({ projectId: 'p', instructions: 'Work' }),
    /intent storage unavailable/,
  );
  assert.equal(f.local.calls.starts.length, 0);
  const routes = new MemoryRoutes();
  const brokenBinding: RuntimeRouteStore = {
    load: (id) => routes.load(id),
    save: async (route) => {
      if (route.status === 'ready') throw Error('binding storage unavailable');
      await routes.save(route);
    },
  };
  const router = f.create(brokenBinding);
  await assert.rejects(
    router.start({ projectId: 'p', runId: 'R-one', workspace: '/workspace', instructions: 'Work' }),
    /binding storage unavailable/,
  );
  assert.equal(f.local.calls.starts.length, 1);
  assert.deepEqual(f.local.calls.releases, ['same-native-thread']);
  const saved = [...routes.saved.values()][0];
  assert.equal(saved.status, 'unknown');
  await assert.rejects(
    router.resume({
      projectId: 'p',
      runId: 'R-one',
      workspace: '/workspace',
      threadId: saved.id,
      instructions: 'Continue',
    }),
    { code: 'SESSION_RECONCILIATION_REQUIRED' },
  );
  assert.equal(f.local.calls.starts.length, 1);
  assert.equal(f.local.calls.resumes.length, 0);
});

test('legacy Codex continuation requires a matching historical run and an explicitly remote-permitted policy', async (t) => {
  const f = fixture(t),
    router = f.create();
  const input = {
    projectId: 'p',
    runId: 'R-legacy',
    workspace: '/workspace',
    threadId: 'legacy-native-thread',
    instructions: 'Continue',
  };
  await assert.rejects(router.resume(input), { code: 'THREAD_NOT_FOUND' });
  f.state.runs.push({ id: 'R-legacy', threadId: 'different-thread', workspace: '/workspace' });
  await assert.rejects(router.resume(input), { code: 'THREAD_NOT_FOUND' });
  f.state.runs[0].threadId = input.threadId;
  f.setDefault('local');
  await assert.rejects(router.resume(input), { code: 'DATA_POLICY_BLOCKED' });
  f.setDefault('mixed');
  assert.deepEqual(await router.resume(input), { threadId: input.threadId });
  assert.equal(f.codex.calls.resumes.length, 1);
  assert.equal(f.codex.calls.starts.length, 0);
  assert.equal(f.codex.calls.resumes[0].threadId, input.threadId);
});

test('durable route files preserve external references privately and refuse identity tampering', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-routes-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const routes = new FileRuntimeRoutes(directory);
  const route: RuntimeRoute = {
    id: 'B-one',
    projectId: 'p',
    runId: 'R-one',
    workspace: '/workspace',
    status: 'ready',
    externalThreadId: 'private-native-reference',
    resource: { id: 'local', client: 'managed', local: true, configurationRevision: 'v1' },
  };
  await routes.save(route);
  assert.deepEqual(await new FileRuntimeRoutes(directory).load(route.id), route);
  const entries = await fs.readdir(directory);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^[a-f0-9]{64}\.json$/);
  assert.equal((await fs.stat(path.join(directory, entries[0]))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  await fs.writeFile(path.join(directory, entries[0]), JSON.stringify({ ...route, id: 'B-other' }));
  await assert.rejects(routes.load(route.id), { code: 'INVALID_CHECKPOINT' });
});

test('shutdown cannot publish a late-started client and releases its native session', async (t) => {
  const f = fixture(t),
    router = f.create();
  let entered!: () => void, finishStart!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  const originalStart = f.local.runtime.start;
  f.local.runtime.start = async (input) => {
    const started = await originalStart(input);
    entered();
    await wait;
    return started;
  };
  const start = router.start({ projectId: 'p', runId: 'R-one', instructions: 'Work' });
  await ready;
  const stopping = router.dispose();
  finishStart();
  await stopping;
  await assert.rejects(start, { code: 'RUNTIME_CLOSED' });
  assert.deepEqual(f.local.calls.releases, ['same-native-thread']);
});

test('legacy continuation validates the historical workspace before creating a route', async (t) => {
  const f = fixture(t),
    router = f.create();
  f.state.runs.push({ id: 'R-legacy', threadId: 'legacy-native-thread', workspace: '/workspace' });
  await assert.rejects(
    router.resume({
      projectId: 'p',
      runId: 'R-legacy',
      threadId: 'legacy-native-thread',
      workspace: '/different-workspace',
      instructions: 'Continue',
    }),
    { code: 'SESSION_MISMATCH' },
  );
  assert.equal(f.codex.calls.resumes.length, 0);
  assert.equal(f.routes.saved.size, 0);
});

test('undeclared native children cannot move activity to another run through their parent or cached ID', async (t) => {
  const f = fixture(t),
    router = f.create();
  await router.start({ projectId: 'p', runId: 'R-one', instructions: 'Work' });
  const events: RuntimeEvent[] = [];
  router.subscribe((event) => events.push(event));
  const child: RuntimeEvent = {
    id: 'child',
    runId: 'R-one',
    threadId: 'native-child',
    type: 'agent.activity',
    parentThreadId: 'same-native-thread',
    completed: false,
  };
  f.local.emit({ ...child, runId: 'R-foreign' });
  assert.equal(events.length, 0);
  f.local.emit(child);
  assert.equal(events.length, 1);
  f.local.emit({
    id: 'message',
    runId: 'R-foreign',
    threadId: 'native-child',
    type: 'message.completed',
    text: 'Foreign',
  });
  assert.equal(events.length, 1);
  f.local.emit({
    id: 'message',
    runId: 'R-one',
    threadId: 'native-child',
    type: 'message.completed',
    text: 'Own progress',
  });
  assert.equal(events.length, 2);
});
