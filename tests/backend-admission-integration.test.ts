import test from 'node:test';
import assert from 'node:assert/strict';
import type { BackendCapabilities } from '../agent/contracts/capabilities.ts';
import {
  RuntimeRouter,
  type RuntimeRoute,
  type RuntimeRouteStore,
} from '../core/runtime-router.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { DomainError, type ProjectRegistry, type RegisteredRuntime } from '../core/ports.ts';
import { isKnownTurnRejection } from '../core/run-reconciliation.ts';
import type { RuntimeResource } from '../protocol/resources.ts';
import type { Run } from '../protocol/domain.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import { sampleRun } from './fixtures/sample-run.ts';

class MemoryRoutes implements RuntimeRouteStore {
  readonly saved = new Map<string, RuntimeRoute>();
  saves = 0;
  async load(id: string) {
    return structuredClone(this.saved.get(id));
  }
  async save(route: RuntimeRoute) {
    this.saves++;
    this.saved.set(route.id, structuredClone(route));
  }
}

function fakeBackend(id: string, capabilities: BackendCapabilities) {
  const effects = { starts: 0, resumes: 0, turns: 0 };
  const behavior = { turnFailure: undefined as Error | undefined };
  const runtime: RegisteredRuntime = {
    id,
    capabilities,
    async start() {
      effects.starts++;
      return { threadId: 'backend-session' };
    },
    async resume(input) {
      effects.resumes++;
      return { threadId: input.threadId };
    },
    async turn() {
      effects.turns++;
      if (behavior.turnFailure) throw behavior.turnFailure;
      return { turnId: 'backend-turn', text: JSON.stringify({ backend: id }) };
    },
    async submit() {
      effects.turns++;
      return { turnId: 'backend-turn' };
    },
    async interrupt() {},
    async dispose() {},
  };
  return { runtime, effects, behavior };
}

function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  definitions: {
    id: string;
    backendId: RuntimeResource['backendId'];
    capabilities: BackendCapabilities;
  }[],
) {
  const backends = definitions.map(({ id, capabilities }) => fakeBackend(id, capabilities));
  const registry = new RuntimeCatalog();
  for (const backend of backends) registry.register(backend.runtime);
  const resources: RuntimeResource[] = definitions.map(({ id, backendId, capabilities }) => ({
    id,
    backendId,
    configurationRevision: id + '-configuration-v1',
    local: true,
    capabilities: structuredClone(capabilities),
  }));
  const originalResources = structuredClone(resources);
  const state = {
    project: { id: 'p', name: 'Synthetic project', root: '/synthetic/project' },
    runs: [] as Run[],
  };
  const projects = {
    get: () => ({ snapshot: () => structuredClone(state) }),
    list: () => [state.project],
  } as unknown as ProjectRegistry;
  const routes = new MemoryRoutes();
  let selected = 0,
    sequence = 0;
  const routers: RuntimeRouter[] = [];
  const create = () => {
    const router = new RuntimeRouter({
      registry,
      resources,
      projects,
      routes,
      id: () => String(++sequence),
      selection: {
        forProject: () => {
          const resource = structuredClone(resources[selected]);
          return {
            profileId: 'synthetic',
            policy: 'local-only',
            coordinator: resource,
            worker: resource,
            reviewer: resource,
          };
        },
      },
    });
    routers.push(router);
    return router;
  };
  t.after(async () => {
    // Test-induced catalog mutations must not obstruct the fixture's normal teardown.
    resources.splice(0, resources.length, ...structuredClone(originalResources));
    for (const router of routers) await router.dispose();
    await registry.dispose();
  });
  return {
    backends,
    resources,
    routes,
    state,
    create,
    select: (index: number) => {
      selected = index;
    },
  };
}

const startInput = () => ({
  projectId: 'p',
  runId: 'R-synthetic',
  instructions: 'Use only synthetic data.',
  workspace: '/synthetic/run',
});
const turnOptions = () => ({
  schema: {},
  signal: new AbortController().signal,
  timeoutMs: 1000,
  toolPolicy: 'none' as const,
});
const filePolicy = (mode: 'advisory' | 'strict') => ({
  scope: { mode, plannedPaths: ['src/value.ts'], protectedPaths: ['checks/'] },
  checks: [],
  defaultCheckIds: [],
  maxWorkers: 1,
  maxRepairs: 0,
  turnTimeoutMs: 10000,
});
async function rejectionOf(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  assert.fail('Expected admission or dispatch to reject.');
}
function knownRejection(error: unknown, code: string) {
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, code);
  assert.equal(isKnownTurnRejection(error), true);
}

test('the same declared mechanics admit tools-free turns under arbitrary backend IDs and client labels', async (t) => {
  const capabilities = fixtureCapabilities({ structuredTurns: true, toolsFreeTurns: true });
  const f = fixture(t, [
    { id: 'orchid-engine', backendId: 'codex', capabilities },
    { id: 'quartz-engine', backendId: 'managed', capabilities },
  ]);
  const router = f.create();
  const handles: string[] = [];
  for (let index = 0; index < f.backends.length; index++) {
    f.select(index);
    const started = await router.start(startInput());
    handles.push(started.threadId);
    const result = await router.turn(started.threadId, 'Return a decision.', turnOptions());
    assert.deepEqual(JSON.parse(result.text), { backend: f.backends[index].runtime.id });
    assert.deepEqual(f.backends[index].effects, { starts: 1, resumes: 0, turns: 1 });
  }
  assert.notEqual(handles[0], handles[1]);
});

test('a managed label and a turn method do not bypass tools-free admission', async (t) => {
  const f = fixture(t, [
    {
      id: 'managed-looking-client',
      backendId: 'managed',
      capabilities: fixtureCapabilities({ structuredTurns: true }),
    },
  ]);
  const router = f.create();
  const started = await router.start(startInput());
  knownRejection(
    await rejectionOf(router.turn(started.threadId, 'No tools.', turnOptions())),
    'BACKEND_CAPABILITY_UNAVAILABLE',
  );
  assert.deepEqual(f.backends[0].effects, { starts: 1, resumes: 0, turns: 0 });
  assert.equal(f.routes.saved.get(started.threadId)?.status, 'ready');
});

test('post-dispatch backend failures remain unknown rather than becoming preflight rejections', async (t) => {
  for (const failure of [
    new Error('The response was lost after backend dispatch.'),
    new DomainError(
      'BACKEND_CAPABILITY_UNAVAILABLE',
      'A backend-originated failure after dispatch.',
    ),
  ]) {
    // Each case owns a separate host; an unknown turn is never retried by this test.
    const f = fixture(t, [
      {
        id: 'independent-client',
        backendId: 'managed',
        capabilities: fixtureCapabilities({ structuredTurns: true, toolsFreeTurns: true }),
      },
    ]);
    const router = f.create();
    const started = await router.start(startInput());
    f.backends[0].behavior.turnFailure = failure;
    const observed = await rejectionOf(
      router.turn(started.threadId, 'Perform synthetic work.', turnOptions()),
    );
    assert.equal(observed, failure);
    assert.equal(isKnownTurnRejection(observed), false);
    assert.equal(f.backends[0].effects.turns, 1);
  }
});

test('unsupported read-only sessions reject before durable starting intent or backend effects', async (t) => {
  const f = fixture(t, [
    { id: 'review-client', backendId: 'managed', capabilities: fixtureCapabilities() },
  ]);
  knownRejection(
    await rejectionOf(f.create().start({ ...startInput(), readOnly: true, purpose: 'review' })),
    'BACKEND_CAPABILITY_UNAVAILABLE',
  );
  assert.equal(f.routes.saves, 0);
  assert.equal(f.routes.saved.size, 0);
  assert.deepEqual(f.backends[0].effects, { starts: 0, resumes: 0, turns: 0 });
});

test('a forged saved capability descriptor cannot dispatch or resume even when metadata matches it', async (t) => {
  const f = fixture(t, [
    {
      id: 'custom-session-client',
      backendId: 'codex',
      capabilities: fixtureCapabilities({ structuredTurns: true, resumeSessions: true }),
    },
  ]);
  const first = await f.create().start(startInput());
  const saved = f.routes.saved.get(first.threadId)!;
  saved.resource.capabilities = fixtureCapabilities({
    structuredTurns: true,
    toolsFreeTurns: true,
    resumeSessions: true,
  });
  f.resources[0].capabilities = structuredClone(saved.resource.capabilities);
  const restored = f.create();
  knownRejection(
    await rejectionOf(restored.turn(first.threadId, 'Forged grant.', turnOptions())),
    'BACKEND_CAPABILITIES_CHANGED',
  );
  knownRejection(
    await rejectionOf(restored.resume({ ...startInput(), threadId: first.threadId })),
    'BACKEND_CAPABILITIES_CHANGED',
  );
  assert.deepEqual(f.backends[0].effects, { starts: 1, resumes: 0, turns: 0 });
});

test('configuration revision changes block an existing route before turn or resume dispatch', async (t) => {
  const f = fixture(t, [
    {
      id: 'revisioned-client',
      backendId: 'managed',
      capabilities: fixtureCapabilities({
        structuredTurns: true,
        toolsFreeTurns: true,
        resumeSessions: true,
      }),
    },
  ]);
  const first = await f.create().start(startInput());
  f.resources[0].configurationRevision = 'different-configuration';
  const restored = f.create();
  knownRejection(
    await rejectionOf(restored.turn(first.threadId, 'Stale grant.', turnOptions())),
    'RUNTIME_CONFIG_CHANGED',
  );
  knownRejection(
    await rejectionOf(restored.resume({ ...startInput(), threadId: first.threadId })),
    'RUNTIME_CONFIG_CHANGED',
  );
  assert.deepEqual(f.backends[0].effects, { starts: 1, resumes: 0, turns: 0 });
});

test('a historical Codex thread without a durable route cannot acquire a fallback route', async (t) => {
  const f = fixture(t, [
    {
      id: 'codex',
      backendId: 'codex',
      capabilities: fixtureCapabilities({ resumeSessions: true }),
    },
  ]);
  const historical = {
    ...sampleRun(),
    id: 'R-synthetic',
    workspace: '/synthetic/run',
    threadId: 'historical-native-thread',
  };
  f.state.runs.push(historical);
  knownRejection(
    await rejectionOf(f.create().resume({ ...startInput(), threadId: historical.threadId })),
    'THREAD_NOT_FOUND',
  );
  assert.equal(f.routes.saves, 0);
  assert.deepEqual(f.backends[0].effects, { starts: 0, resumes: 0, turns: 0 });
});

test('strict writable work rejects unsupported backends before intent regardless of the client label', async (t) => {
  for (const client of ['managed', 'codex'] as const) {
    const f = fixture(t, [{ id: 'unsupported', client, capabilities: fixtureCapabilities() }]);
    f.state.runs.push({
      ...sampleRun(),
      id: 'R-synthetic',
      executionPolicySnapshot: filePolicy('strict'),
    });
    knownRejection(
      await rejectionOf(f.create().start(startInput())),
      'BACKEND_CAPABILITY_UNAVAILABLE',
    );
    assert.equal(f.routes.saves, 0);
    assert.equal(f.backends[0].effects.starts, 0);
  }
});

test('an explicit change to strict policy cannot resume an existing unsupported writable session', async (t) => {
  const f = fixture(t, [
    {
      id: 'opaque-client',
      backendId: 'codex',
      capabilities: fixtureCapabilities({ resumeSessions: true }),
    },
  ]);
  const owner = {
    ...sampleRun(),
    id: 'R-synthetic',
    workspace: '/synthetic/run',
    executionPolicySnapshot: filePolicy('advisory'),
  };
  f.state.runs.push(owner);
  const router = f.create();
  const started = await router.start(startInput());
  await router.release(started.threadId);
  owner.executionPolicySnapshot = filePolicy('strict');
  knownRejection(
    await rejectionOf(router.resume({ ...startInput(), threadId: started.threadId })),
    'BACKEND_CAPABILITY_UNAVAILABLE',
  );
  assert.equal(f.backends[0].effects.resumes, 0);
  assert.equal(f.backends[0].effects.turns, 0);
});

test('strict project scope still permits an eligible read-only inspection session', async (t) => {
  const f = fixture(t, [
    {
      id: 'inspector',
      backendId: 'codex',
      capabilities: fixtureCapabilities({ readOnlySessions: true }),
    },
  ]);
  f.state.runs.push({
    ...sampleRun(),
    id: 'R-synthetic',
    executionPolicySnapshot: filePolicy('strict'),
  });
  await f.create().start({ ...startInput(), purpose: 'research', readOnly: true });
  assert.equal(f.backends[0].effects.starts, 1);
});
