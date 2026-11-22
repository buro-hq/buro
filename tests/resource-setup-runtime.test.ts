import { fixtureResources } from './fixtures/resource-configuration.ts';
import { defaultRoles } from './fixtures/roles.ts';
import { resolveRoleResource } from '../core/role-routing.ts';
import { serviceOperationContext, operationIds } from '../core/operation-catalog.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeResources } from '../adapters/resources/runtime-resources.ts';
import { ResourceConfigurationSchema } from '../adapters/files/resource-configuration.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { ResourceSetupInputSchema, type ResourceSnapshot } from '../protocol/resources.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { RuntimeRouter } from '../core/runtime-router.ts';
import { createHost } from '../plugins/host.ts';
import { resourcesPlugin } from '../plugins/resources.ts';

const meta = (id: string) => ({ id, fingerprint: id });
const initialConfiguration = () =>
  ResourceConfigurationSchema.parse({
    ...fixtureResources(),
    runtimes: [
      ...fixtureResources().runtimes,
      {
        id: 'local',
        backend: 'managed',
        config: { connectionId: 'ollama', model: 'fixture-small' },
      },
    ],
    profiles: [
      ...fixtureResources().profiles,
      {
        id: 'local',
        name: 'Existing local team',
        policy: 'local-only',
        coordinator: 'local',
        worker: 'local',
        reviewer: 'local',
      },
    ],
  });

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-setup-runtime-')),
  );
  const configuration = initialConfiguration();
  await new PrivateJSONFiles(path.join(directory, 'local')).save('resources', configuration);
  const state = {
    project: { id: 'p', root: directory },
    profile: {} as { resourceProfile?: string },
    runs: [] as { id: string; workspace?: string; resources?: ResourceSnapshot }[],
  };
  const projects = {
    get: () => ({ snapshot: () => structuredClone(state) }),
  } as unknown as ProjectRegistry;
  const calls: { url: string; body?: any }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input),
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/api/tags'))
      return Response.json({ models: [{ name: 'fixture-small' }, { name: 'fixture-new' }] });
    if (url.endsWith('/api/show'))
      return Response.json({
        capabilities: ['tools'],
        model_info: { 'fixture.context_length': 65536 },
      });
    if (url.endsWith('/api/chat')) {
      const diagnostic = body.tools?.some((tool: any) => tool.function.name === 'diagnostic_echo');
      return new Response(
        JSON.stringify({
          model: body.model,
          message: {
            role: 'assistant',
            content: diagnostic ? '' : '{"ok":true}',
            ...(diagnostic
              ? {
                  tool_calls: [
                    { function: { name: 'diagnostic_echo', arguments: { value: 'buro-ready' } } },
                  ],
                }
              : {}),
          },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 10,
          eval_count: 5,
        }) + '\n',
      );
    }
    throw new Error('Unexpected fixture destination');
  };
  const factories: Awaited<ReturnType<typeof createRuntimeResources>>[] = [];
  const routers: RuntimeRouter[] = [];
  const create = async () => {
    const factory = await createRuntimeResources({
      directory,
      projects,
      executors: new EnvironmentExecutors(),
      fetch: fakeFetch,
      credentials: () => 'fixture-secret-never-in-catalog',
      budgets: {
        reserveGeneration: async (input) => ({
          operationId: input.operationId,
          maxOutputTokens: input.requestedOutputTokens,
        }),
        recordUsage: async () => {},
        reserveTools: async () => {},
      },
    });
    factories.push(factory);
    return factory;
  };
  let sequence = 0;
  const router = (factory: Awaited<ReturnType<typeof createRuntimeResources>>) => {
    const registry = new RuntimeCatalog();
    factory.runtimes.forEach((runtime) => registry.register(runtime));
    const result = new RuntimeRouter({
      registry,
      projects,
      selection: factory.selection,
      resources: factory.resources,
      routes: new FileRuntimeRoutes(path.join(directory, 'routes')),
      id: () => String(++sequence),
    });
    routers.push(result);
    return result;
  };
  t.after(async () => {
    for (const value of routers) await value.dispose();
    for (const factory of factories) {
      await factory.dispose();
      await Promise.all(factory.runtimes.map((runtime) => runtime.dispose?.()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, configuration, state, projects, fakeFetch, calls, create, router };
}
async function setup(
  resources: Awaited<ReturnType<typeof createRuntimeResources>>,
  id = 'new-team',
) {
  const catalog = await resources.list();
  return ResourceSetupInputSchema.parse({
    expectedRevision: catalog.configurationRevision,
    runtimes: [
      {
        id: 'new-model',
        backend: 'managed',
        config: { connectionId: 'ollama', model: 'fixture-new' },
      },
    ],
    profile: {
      id,
      name: 'New local team',
      policy: 'local-only',
      coordinator: 'new-model',
      worker: 'new-model',
      reviewer: 'new-model',
      workerPool: ['new-model'],
    },
  });
}
async function editConnection(
  resources: Awaited<ReturnType<typeof createRuntimeResources>>,
  endpoint: string,
  trust: 'auto' | 'private-network' = 'auto',
) {
  const connection = (await resources.list()).connections.find((item) => item.id === 'ollama')!;
  const {
    revision,
    credentialConfigured: _credential,
    activeEndpoint: _active,
    restartRequired: _pending,
    local: _local,
    endpoint: _endpoint,
    modelListing: _modelListing,
    ...definition
  } = connection;
  assert.equal(definition.provider, 'ollama');
  return resources.saveConnection(
    { ...definition, provider: 'ollama', config: { ...definition.config, endpoint, trust } },
    revision,
    meta('endpoint-' + endpoint + '-' + trust),
  );
}

test('setup saves metadata atomically while active profiles, defaults and existing runtime bindings remain unchanged', async (t) => {
  const f = await fixture(t),
    active = await f.create();
  const before = await active.list('p');
  const bundle = await setup(active);
  const result = await active.saveSetup(bundle, meta('create'));
  assert.deepEqual(result, {
    profileId: 'new-team',
    runtimeIds: ['new-model'],
    appliesTo: 'service-restart',
  });
  assert.deepEqual(await active.saveSetup(bundle, meta('create')), result);
  const after = await active.list('p');
  assert.notEqual(after.configurationRevision, before.configurationRevision);
  assert.deepEqual(after.profiles, before.profiles);
  assert.deepEqual(after.runtimes, before.runtimes);
  assert.deepEqual(after.selected, before.selected);
  assert.equal(after.defaultProfile, 'codex');
  assert.equal(
    after.configured.profiles.find((entry) => entry.profile.id === 'new-team')?.restartRequired,
    true,
  );
  assert.equal(
    after.configured.runtimes.find((entry) => entry.definition.id === 'new-model')?.restartRequired,
    true,
  );
  assert.equal(
    after.configured.profiles.find((entry) => entry.profile.id === 'codex')?.restartRequired,
    false,
  );
  assert.equal(active.selection.forProject('p').coordinator.id, 'codex');
  await assert.rejects(active.useProfile('new-team', meta('use-pending')), {
    code: 'RESOURCE_PROFILE_RESTART_REQUIRED',
  });
  await assert.rejects(active.useProfile('missing', meta('missing')), {
    code: 'RESOURCE_PROFILE_UNAVAILABLE',
  });
  assert.doesNotMatch(JSON.stringify(after), /fixture-secret-never-in-catalog/);
  assert.deepEqual(f.calls, []);
});

test('profile selection validates pending dependencies before replaying cached selection receipts', async (t) => {
  const f = await fixture(t),
    active = await f.create();
  const cached = meta('choose-local');
  await active.useProfile('local', cached);
  const original = structuredClone(active.resources);
  await editConnection(active, 'http://10.12.0.3:11434', 'private-network');
  const catalog = await active.list('p');
  assert.equal(
    catalog.configured.profiles.find((entry) => entry.profile.id === 'local')?.restartRequired,
    true,
  );
  assert.equal(
    catalog.configured.runtimes.find((entry) => entry.definition.id === 'local')?.restartRequired,
    true,
  );
  await assert.rejects(active.useProfile('local', cached), { code: 'CONNECTION_RESTART_REQUIRED' });
  await assert.rejects(active.useProfile('local', meta('choose-again')), {
    code: 'CONNECTION_RESTART_REQUIRED',
  });
  assert.throws(() => active.selection.forProject('p'), { code: 'CONNECTION_RESTART_REQUIRED' });
  assert.equal(
    catalog.selected?.coordinator.id,
    'local',
    'Pending state must not hide settings for the active profile',
  );
  assert.deepEqual(active.resources, original);
  await active.useProfile('codex', meta('native-still-active'));
  assert.equal(active.selection.forProject('p').coordinator.id, 'codex');
  assert.deepEqual(f.calls, []);
});

test('a new pending runtime cannot replay a cached probe and service restart activates it without selecting or generating', async (t) => {
  const f = await fixture(t),
    active = await f.create();
  await active.saveSetup(await setup(active), meta('create'));
  const probes = new PrivateJSONFiles(path.join(f.directory, 'local/resource-probes'));
  await probes.save('request-cached', {
    ...meta('cached'),
    runtimeId: 'new-model',
    status: 'completed',
    result: { status: 'passed', runtimeId: 'new-model' },
  });
  await assert.rejects(active.probe('new-model', meta('cached')), {
    code: 'RESOURCE_RUNTIME_RESTART_REQUIRED',
  });
  await assert.rejects(active.probe('new-model', meta('fresh')), {
    code: 'RESOURCE_RUNTIME_RESTART_REQUIRED',
  });
  assert.equal(await probes.load('request-fresh'), undefined);
  const restarted = await f.create();
  const catalog = await restarted.list('p');
  assert.equal(catalog.defaultProfile, 'codex');
  assert.equal(catalog.selected?.coordinator.id, 'codex');
  assert.ok(catalog.profiles.some((profile) => profile.id === 'new-team'));
  assert.equal(
    catalog.configured.runtimes.find((entry) => entry.definition.id === 'new-model')
      ?.restartRequired,
    false,
  );
  assert.equal(
    catalog.configured.profiles.find((entry) => entry.profile.id === 'new-team')?.restartRequired,
    false,
  );
  assert.deepEqual(f.calls, []);
  await restarted.useProfile('new-team', meta('select-explicitly'));
  assert.equal(restarted.selection.forProject('p').coordinator.model, 'fixture-new');
  assert.equal(restarted.selection.forProject('p').policy, 'local-only');
  assert.deepEqual(f.calls, [], 'Profile selection must not imply a paid or local generation');
  const result = await restarted.probe('new-model', meta('probe-explicitly'));
  assert.equal(result.status, 'passed');
  assert.equal(f.calls.filter((call) => call.url.endsWith('/api/chat')).length, 2);
});

test('adding a setup leaves existing owned routes and their model identity usable across restart', async (t) => {
  const f = await fixture(t),
    active = await f.create();
  await active.useProfile('local', meta('select-local'));
  const frozen = active.selection.forProject('p');
  const coordinator = structuredClone(defaultRoles.find((role) => role.id === 'coordinator')!);
  const owned = {
    id: 'owned',
    workspace: f.directory,
    resources: frozen,
    roleSnapshots: [coordinator],
    roleResources: {
      coordinator: resolveRoleResource(
        frozen,
        coordinator,
        serviceOperationContext(operationIds.coordination),
      ),
    },
  };
  f.state.runs.push(owned);
  const router = f.router(active);
  const input = {
    projectId: 'p',
    runId: 'owned',
    purpose: 'coordination' as const,
    operationId: operationIds.coordination,
    roleId: 'coordinator',
    instructions: 'Keep the original task and model',
  };
  const original = await router.start(input);
  await active.saveSetup(await setup(active), meta('create'));
  assert.deepEqual(active.selection.forProject('p'), frozen);
  const turnOptions = {
    schema: { type: 'object' },
    signal: new AbortController().signal,
    timeoutMs: 1000,
  };
  assert.deepEqual(
    JSON.parse((await router.turn(original.threadId, 'Return ready', turnOptions)).text),
    { ok: true },
  );
  const restarted = await f.create();
  await restarted.useProfile('new-team', meta('new-default'));
  const afterRestart = f.router(restarted);
  const continued = await afterRestart.start(input);
  assert.deepEqual(
    JSON.parse((await afterRestart.turn(continued.threadId, 'Return ready', turnOptions)).text),
    { ok: true },
  );
  assert.deepEqual(f.state.runs[0].resources, frozen);
  assert.ok(
    f.calls
      .filter((call) => call.url.endsWith('/api/chat'))
      .every((call) => call.body.model === 'fixture-small'),
  );
});

test('local-only setup requires explicit LAN trust and never treats a remote model as local by saving a profile', async (t) => {
  const f = await fixture(t),
    active = await f.create();
  const originalConnection = structuredClone(
    active.configuration.snapshot().connections.find((connection) => connection.id === 'ollama'),
  );
  await assert.rejects(editConnection(active, 'http://10.12.0.3:11434'), {
    code: 'DATA_POLICY_BLOCKED',
  });
  assert.deepEqual(
    active.configuration.snapshot().connections.find((connection) => connection.id === 'ollama'),
    originalConnection,
  );
  assert.equal(
    active.configuration.snapshot().profiles.some((profile) => profile.id === 'new-team'),
    false,
  );
  await editConnection(active, 'http://10.12.0.3:11434', 'private-network');
  await active.saveSetup(await setup(active), meta('trusted-lan'));
  const restarted = await f.create();
  await restarted.useProfile('new-team', meta('choose-trusted'));
  assert.equal(restarted.selection.forProject('p').coordinator.local, true);
  assert.deepEqual(f.calls, []);
});

test('the shared resource command bus publishes setup creation and rejects pending profile use before restart', async (t) => {
  const f = await fixture(t);
  const host = await createHost({
    projects: [
      {
        storageAddress: path.join(f.directory, 'project-store'),
        project: { id: 'p', name: 'Fixture', root: f.directory, managed: true },
      },
    ],
  });
  t.after(() => host.dispose());
  await host.ctx.plugin(resourcesPlugin, {
    directory: f.directory,
    executors: new EnvironmentExecutors(),
    fetch: f.fakeFetch,
    credentials: () => undefined,
  });
  const bus = host.ctx.commands.bus;
  const snapshot = await bus.execute(
    { method: 'project.snapshot', params: { projectId: 'p' } },
    meta('snapshot'),
  );
  assert.ok(snapshot.capabilities.includes('resources.setup.save'));
  const catalog = await bus.execute({ method: 'resources.list', params: {} }, meta('catalog'));
  const bundle = ResourceSetupInputSchema.parse({
    expectedRevision: catalog.configurationRevision,
    runtimes: [],
    profile: {
      id: 'another-local-team',
      name: 'Another local team',
      policy: 'local-only',
      coordinator: 'local',
      worker: 'local',
      reviewer: 'local',
    },
  });
  const saved = await bus.execute(
    { method: 'resources.setup.save', params: bundle },
    meta('setup'),
  );
  assert.deepEqual(saved, {
    profileId: 'another-local-team',
    runtimeIds: [],
    appliesTo: 'service-restart',
  });
  await assert.rejects(
    bus.execute(
      { method: 'resources.use', params: { profileId: 'another-local-team' } },
      meta('use'),
    ),
    { code: 'RESOURCE_PROFILE_RESTART_REQUIRED' },
  );
  assert.deepEqual(f.calls, []);
});

test('queued profile selection cannot replay a receipt before an earlier connection edit becomes pending', async (t) => {
  const f = await fixture(t),
    active = await f.create();
  const cached = meta('select-local');
  await active.useProfile('local', cached);
  const connection = (await active.list()).connections.find((item) => item.id === 'ollama')!;
  const edit = active.saveConnection(
    {
      id: 'ollama',
      provider: 'ollama',
      config: { endpoint: 'http://10.12.0.4:11434', trust: 'private-network', capacity: 1 },
    },
    connection.revision,
    meta('edit'),
  );
  const selection = assert.rejects(active.useProfile('local', cached), {
    code: 'CONNECTION_RESTART_REQUIRED',
  });
  await edit;
  await selection;
  assert.equal(active.configuration.snapshot().defaultProfile, 'local');
  assert.throws(() => active.selection.forProject('p'), { code: 'CONNECTION_RESTART_REQUIRED' });
  assert.deepEqual(f.calls, []);
});

test('queued setup creation completes before selecting its still-inactive profile', async (t) => {
  const f = await fixture(t),
    active = await f.create();
  const creation = active.saveSetup(await setup(active), meta('create'));
  const selection = assert.rejects(active.useProfile('new-team', meta('select')), {
    code: 'RESOURCE_PROFILE_RESTART_REQUIRED',
  });
  await creation;
  await selection;
  assert.equal(active.configuration.snapshot().defaultProfile, 'codex');
  assert.equal(active.selection.forProject('p').coordinator.id, 'codex');
  assert.deepEqual(f.calls, []);
});

test('probe admission waits for an earlier queued setup before replaying a new-runtime receipt', async (t) => {
  const f = await fixture(t),
    active = await f.create();
  const probes = new PrivateJSONFiles(path.join(f.directory, 'local/resource-probes'));
  await probes.save('request-cached-new', {
    ...meta('cached-new'),
    runtimeId: 'new-model',
    status: 'completed',
    result: { runtimeId: 'new-model', status: 'passed' },
  });
  const creation = active.saveSetup(await setup(active), meta('create'));
  const probing = assert.rejects(active.probe('new-model', meta('cached-new')), {
    code: 'RESOURCE_RUNTIME_RESTART_REQUIRED',
  });
  await creation;
  await probing;
  assert.deepEqual(f.calls, []);
});

test('metadata and cached probe admission wait for a preceding queued connection edit', async (t) => {
  const f = await fixture(t),
    active = await f.create();
  const connection = (await active.list()).connections.find((item) => item.id === 'ollama')!;
  const probes = new PrivateJSONFiles(path.join(f.directory, 'local/resource-probes'));
  await probes.save('request-cached-local', {
    ...meta('cached-local'),
    runtimeId: 'local',
    status: 'completed',
    result: { runtimeId: 'local', status: 'passed' },
  });
  const edit = active.saveConnection(
    {
      id: 'ollama',
      provider: 'ollama',
      config: { endpoint: 'http://10.12.0.5:11434', trust: 'private-network', capacity: 1 },
    },
    connection.revision,
    meta('edit-before-admission'),
  );
  const discovery = assert.rejects(active.models('ollama'), {
    code: 'CONNECTION_RESTART_REQUIRED',
  });
  const probing = assert.rejects(active.probe('local', meta('cached-local')), {
    code: 'CONNECTION_RESTART_REQUIRED',
  });
  await edit;
  await Promise.all([discovery, probing]);
  assert.deepEqual(f.calls, []);
});

test('a cached receipt cannot make an unknown or native runtime appear probe-ready', async (t) => {
  const f = await fixture(t),
    active = await f.create();
  const probes = new PrivateJSONFiles(path.join(f.directory, 'local/resource-probes'));
  for (const runtimeId of ['missing', 'codex']) {
    const id = 'cached-' + runtimeId;
    await probes.save('request-' + id, {
      ...meta(id),
      runtimeId,
      status: 'completed',
      result: { runtimeId, status: 'passed' },
    });
    await assert.rejects(active.probe(runtimeId, meta(id)), { code: 'PROBE_UNSUPPORTED' });
  }
  assert.deepEqual(f.calls, []);
});
