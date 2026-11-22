import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeResources } from '../adapters/resources/runtime-resources.ts';
import {
  ResourceConfigurationSchema,
  defaultResources,
} from '../adapters/files/resource-configuration.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import {
  ResourceConnectionSchema,
  type ResourceConnection,
  type ResourceSnapshot,
} from '../protocol/resources.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import { RuntimeRouter } from '../core/runtime-router.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { createHost } from '../plugins/host.ts';
import { resourcesPlugin } from '../plugins/resources.ts';

const meta = (id: string) => ({ id, fingerprint: id });
const initialConfiguration = () =>
  ResourceConfigurationSchema.parse({
    ...defaultResources(),
    runtimes: [
      ...defaultResources().runtimes,
      {
        id: 'local',
        backend: 'managed',
        config: { connectionId: 'ollama', model: 'fixture-small' },
      },
    ],
    profiles: [
      ...defaultResources().profiles,
      {
        id: 'local',
        name: 'Local',
        policy: 'local-only',
        coordinator: 'local',
        worker: 'local',
        reviewer: 'local',
      },
      // A pending optional worker must also prevent a new pool from being frozen.
      {
        id: 'pool',
        name: 'Pool',
        policy: 'hybrid',
        coordinator: 'codex',
        worker: 'codex',
        reviewer: 'codex',
        workerPool: ['codex', 'local'],
      },
    ],
  });

async function fixture(t: any, configuration = initialConfiguration()) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-connection-runtime-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
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
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'fixture-small' }] });
    if (url.endsWith('/api/show'))
      return Response.json({
        capabilities: ['tools'],
        model_info: { 'fixture.context_length': 32768 },
      });
    if (url.endsWith('/api/chat'))
      return new Response(
        JSON.stringify({
          model: 'fixture-small',
          message: { role: 'assistant', content: '{"ok":true}' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 10,
          eval_count: 5,
        }) + '\n',
      );
    throw new Error('Unexpected fixture URL: ' + url);
  };
  const factories: Awaited<ReturnType<typeof createRuntimeResources>>[] = [];
  const create = async () => {
    const factory = await createRuntimeResources({
      directory,
      projects,
      executors: new EnvironmentExecutors(),
      fetch: fakeFetch,
      credentials: (reference) =>
        reference === 'DEEPSEEK_API_KEY' ? 'fixture-secret-never-in-catalog' : undefined,
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
  t.after(async () => {
    for (const factory of factories) {
      await factory.dispose();
      await Promise.all(factory.runtimes.map((runtime) => runtime.dispose?.()));
    }
  });
  return { directory, state, projects, calls, create };
}

async function update(
  resources: Awaited<ReturnType<typeof createRuntimeResources>>,
  connection: ResourceConnection,
  id = 'save',
) {
  const previous = (await resources.list()).connections.find((item) => item.id === connection.id);
  return resources.saveConnection(connection, previous?.revision || null, meta(id));
}
const direct = () =>
  ResourceConnectionSchema.parse({
    id: 'ollama',
    provider: 'ollama',
    config: {
      endpoint: 'http://192.168.50.10:11434',
      trust: 'private-network',
      capacity: 2,
      think: false,
    },
  });

test('connection saves expose saved settings and optimistic revisions without invoking a model or leaking credentials', async (t) => {
  const f = await fixture(t),
    resources = await f.create();
  const before = (await resources.list('p')).connections.find((item) => item.id === 'ollama')!;
  const saved = await update(resources, direct());
  assert.deepEqual(saved, { connectionId: 'ollama', appliesTo: 'service-restart' });
  assert.deepEqual(await resources.saveConnection(direct(), before.revision, meta('save')), saved);
  await assert.rejects(
    resources.saveConnection(
      { ...direct(), config: { ...direct().config, capacity: 3 } },
      before.revision,
      meta('stale'),
    ),
    { code: 'RESOURCE_CONNECTION_CONFLICT' },
  );
  const catalog = await resources.list('p');
  const after = catalog.connections.find((item) => item.id === 'ollama')!;
  assert.equal(after.endpoint, new URL(String(direct().config.endpoint)).href);
  assert.equal(after.activeEndpoint, before.endpoint);
  assert.equal(after.restartRequired, true);
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.config.capacity, 2);
  assert.equal(after.provider === 'ollama' && after.config.trust, 'private-network');
  assert.equal(after.provider === 'ollama' && after.config.think, false);
  assert.equal(catalog.selected?.coordinator.backendId, 'codex');
  assert.equal(
    catalog.connections.find((item) => item.id === 'deepseek')?.credentialConfigured,
    true,
  );
  assert.doesNotMatch(JSON.stringify(catalog), /fixture-secret-never-in-catalog/);
  assert.equal((await fs.stat(resources.configuration.filename)).mode & 0o777, 0o600);
  assert.deepEqual(f.calls, []);
});

test('pending connections block discovery and cached probe replay before lookup or new receipts', async (t) => {
  const f = await fixture(t),
    resources = await f.create();
  const probes = new PrivateJSONFiles(path.join(f.directory, 'local/resource-probes'));
  const result = {
    runtimeId: 'local',
    configurationRevision: resources.resources.find((item) => item.id === 'local')!
      .configurationRevision,
    checkedAt: '2026-11-20T00:00:00Z',
    status: 'passed',
    tools: true,
    structured: true,
    reportedModel: 'fixture-small',
  };
  await probes.save('local', result);
  await probes.save('request-old', {
    ...meta('old'),
    runtimeId: 'local',
    status: 'completed',
    result,
  });
  assert.equal((await resources.list()).probes.length, 1);
  assert.deepEqual(await resources.probe('local', meta('old')), result);
  await update(resources, direct());
  assert.deepEqual((await resources.list()).probes, []);
  await assert.rejects(resources.models('ollama'), { code: 'CONNECTION_RESTART_REQUIRED' });
  await assert.rejects(resources.probe('local', meta('old')), {
    code: 'CONNECTION_RESTART_REQUIRED',
  });
  await assert.rejects(resources.probe('local', meta('new')), {
    code: 'CONNECTION_RESTART_REQUIRED',
  });
  assert.equal(await probes.load('request-new'), undefined);
  const added = ResourceConnectionSchema.parse({ ...direct(), id: 'rtx' });
  await update(resources, added, 'add');
  await assert.rejects(resources.models('rtx'), { code: 'CONNECTION_RESTART_REQUIRED' });
  await assert.rejects(resources.models('missing'), { code: 'CONNECTION_UNAVAILABLE' });
  assert.deepEqual(f.calls, []);
});

test('default selection still supports native work, but pending selected resources and optional workers block new work', async (t) => {
  const f = await fixture(t),
    resources = await f.create();
  await update(resources, direct());
  assert.equal(resources.selection.forProject('p').coordinator.backendId, 'codex');
  await resources.configuration.use('local', 'local', 'local');
  assert.throws(() => resources.selection.forProject('p'), { code: 'CONNECTION_RESTART_REQUIRED' });
  assert.equal((await resources.list('p')).selected?.profileId, 'local');
  await resources.configuration.use('pool', 'pool', 'pool');
  assert.throws(() => resources.selection.forProject('p'), { code: 'CONNECTION_RESTART_REQUIRED' });
  await resources.configuration.use('native', 'native', 'codex');
  assert.equal(resources.selection.forProject('p').coordinator.id, 'codex');
  assert.deepEqual(f.calls, []);
});

test('service restart activates saved endpoint and trust while leaving model and native runtime identities stable', async (t) => {
  const f = await fixture(t),
    active = await f.create();
  const oldManaged = active.resources.find((item) => item.id === 'local')!;
  const oldNative = active.resources.find((item) => item.id === 'codex')!;
  await active.models('ollama');
  await update(active, direct());
  const restarted = await f.create();
  const current = (await restarted.list()).connections.find((item) => item.id === 'ollama')!;
  assert.equal(current.restartRequired, false);
  assert.equal(current.activeEndpoint, new URL(String(direct().config.endpoint)).href);
  const newManaged = restarted.resources.find((item) => item.id === 'local')!;
  assert.equal(
    newManaged.local,
    true,
    'Explicit private network trust must reach the provider factory',
  );
  assert.equal(newManaged.model, oldManaged.model);
  assert.notEqual(newManaged.configurationRevision, oldManaged.configurationRevision);
  assert.deepEqual(
    restarted.resources.find((item) => item.id === 'codex'),
    oldNative,
  );
  await restarted.models('ollama');
  assert.deepEqual(
    f.calls.map((call) => call.url),
    ['http://127.0.0.1:11434/api/tags', 'http://192.168.50.10:11434/api/tags'],
  );
  await restarted.configuration.use('choose-local', 'choose-local', 'local');
  assert.equal(restarted.selection.forProject('p').policy, 'local-only');
});

test('editing a connection preserves frozen run routes and blocks fresh research until restart', async (t) => {
  const f = await fixture(t),
    active = await f.create();
  await active.configuration.use('local', 'local', 'local');
  const frozen = active.selection.forProject('p');
  f.state.runs.push({ id: 'running', workspace: f.directory, resources: frozen });
  const registry = new RuntimeCatalog();
  for (const runtime of active.runtimes) registry.register(runtime);
  let sequence = 0;
  const router = new RuntimeRouter({
    registry,
    selection: active.selection,
    projects: f.projects,
    resources: active.resources,
    routes: new FileRuntimeRoutes(path.join(f.directory, 'routes')),
    id: () => String(++sequence),
  });
  t.after(() => router.dispose());
  const original = await router.start({
    projectId: 'p',
    runId: 'running',
    purpose: 'coordination',
    instructions: 'Original run',
  });
  await update(active, direct());
  assert.deepEqual(
    active.resources.find((item) => item.id === 'local'),
    frozen.coordinator,
  );
  await assert.rejects(
    router.start({
      projectId: 'p',
      runId: 'fresh',
      purpose: 'research',
      instructions: 'New research',
    }),
    { code: 'CONNECTION_RESTART_REQUIRED' },
  );
  await assert.rejects(
    router.start({ projectId: 'p', purpose: 'coordination', instructions: 'New goal' }),
    { code: 'CONNECTION_RESTART_REQUIRED' },
  );
  // Both a saved session and a new service session for the already-owned run stay on the active endpoint.
  const continuation = await router.start({
    projectId: 'p',
    runId: 'running',
    purpose: 'coordination',
    instructions: 'Continue frozen run',
  });
  for (const session of [original, continuation]) {
    const result = await router.turn(session.threadId, 'Return ready', {
      schema: { type: 'object' },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    assert.deepEqual(JSON.parse(result.text), { ok: true });
  }
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every((call) => call.url.startsWith('http://127.0.0.1:11434/')));
  assert.ok(
    f.calls
      .filter((call) => call.url.endsWith('/api/chat'))
      .every((call) => call.body.think === undefined),
  );
  const restarted = await f.create(),
    freshRegistry = new RuntimeCatalog();
  for (const runtime of restarted.runtimes) freshRegistry.register(runtime);
  const afterRestart = new RuntimeRouter({
    registry: freshRegistry,
    selection: restarted.selection,
    projects: f.projects,
    resources: restarted.resources,
    routes: new FileRuntimeRoutes(path.join(f.directory, 'routes')),
    id: () => String(++sequence),
  });
  t.after(() => afterRestart.dispose());
  const callsBefore = f.calls.length;
  await assert.rejects(
    afterRestart.start({
      projectId: 'p',
      runId: 'running',
      purpose: 'coordination',
      instructions: 'Old configuration',
    }),
    { code: 'RUNTIME_CONFIG_CHANGED' },
  );
  assert.equal(
    f.calls.length,
    callsBefore,
    'A historical run must never be silently retargeted after restart',
  );
  const fresh = await afterRestart.start({
    projectId: 'p',
    purpose: 'research',
    instructions: 'New research',
  });
  await afterRestart.turn(fresh.threadId, 'Return ready', {
    schema: {},
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  assert.ok(
    f.calls.slice(callsBefore).every((call) => call.url.startsWith('http://192.168.50.10:11434/')),
  );
  assert.ok(
    f.calls
      .slice(callsBefore)
      .filter((call) => call.url.endsWith('/api/chat'))
      .every((call) => call.body.think === false),
  );
});

test('resource plugin publishes and executes API connection saves through the shared command bus', async (t) => {
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
    fetch: async () => {
      throw new Error('Settings must not contact models');
    },
    credentials: () => undefined,
  });
  const bus = host.ctx.commands.bus;
  const snapshot = await bus.execute(
    { method: 'project.snapshot', params: { projectId: 'p' } },
    meta('snapshot'),
  );
  assert.ok(snapshot.capabilities.includes('resources.connection.save'));
  const catalog = await bus.execute({ method: 'resources.list', params: {} }, meta('list'));
  const prior = catalog.connections.find((item: any) => item.id === 'ollama');
  const saved = await bus.execute(
    {
      method: 'resources.connection.save',
      params: { connection: direct(), expectedRevision: prior.revision },
    },
    meta('save-api'),
  );
  assert.deepEqual(saved, { connectionId: 'ollama', appliesTo: 'service-restart' });
  const after = await bus.execute({ method: 'resources.list', params: {} }, meta('after'));
  assert.equal(after.connections.find((item: any) => item.id === 'ollama').restartRequired, true);
});

test('role choices expose server eligibility for the selected profile and actual provider diagnostics without model calls', async (t) => {
  const f = await fixture(t),
    resources = await f.create();
  Object.assign(f.state.profile, {
    resourceProfile: 'pool',
    scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
  });
  Object.assign(f.state, {
    roles: [
      { id: 'coordinator', version: 3 },
      { id: 'reviewer', version: 2 },
      { id: 'builder', version: 4 },
      { id: 'local_preview', version: 1 },
      { id: 'delivery_pr', version: 1 },
      { id: 'production_delivery', version: 1 },
    ],
  });
  const catalog = await resources.list('p');
  assert.deepEqual(catalog.probeRuntimeIds, ['local']);
  const choices = catalog.roleChoices!;
  const coordinator = choices.find((entry) => entry.roleId === 'coordinator')!;
  assert.equal(coordinator.roleVersion, 3);
  assert.equal(coordinator.purpose, 'coordination');
  assert.equal(coordinator.requirements.strictPlannedWrites, true);
  assert.equal(
    coordinator.choices.find((choice) => choice.resource.id === 'codex')!.eligible,
    false,
  );
  assert.match(
    coordinator.choices.find((choice) => choice.resource.id === 'codex')!.reason,
    /outside planned paths/,
  );
  assert.equal(
    coordinator.choices.find((choice) => choice.resource.id === 'local')!.eligible,
    true,
  );
  const worker = choices.find((entry) => entry.roleId === '*')!;
  assert.equal(worker.roleVersion, undefined);
  assert.equal(worker.purpose, 'implementation');
  assert.equal(worker.choices.find((choice) => choice.resource.id === 'local')!.eligible, true);
  const reviewer = choices.find((entry) => entry.roleId === 'reviewer')!;
  assert.equal(reviewer.requirements.immutableReview, true);
  assert.equal(reviewer.requirements.readOnlySessions, true);
  for (const id of ['local_preview', 'delivery_pr', 'production_delivery']) {
    const operational = choices.find((entry) => entry.roleId === id)!;
    assert.equal(operational.purpose, 'delivery');
    assert.equal(operational.requirements.readOnlySessions, true);
  }
  assert.deepEqual(
    [
      ...new Set(choices.flatMap((entry) => entry.choices.map((choice) => choice.resource.id))),
    ].sort(),
    ['codex', 'local'],
  );
  await update(resources, direct());
  const pending = (await resources.list('p'))
    .roleChoices!.find((entry) => entry.roleId === '*')!
    .choices.find((choice) => choice.resource.id === 'local')!;
  assert.equal(pending.eligible, false);
  assert.match(pending.reason, /Restart the service/);
  assert.deepEqual(f.calls, []);
});
