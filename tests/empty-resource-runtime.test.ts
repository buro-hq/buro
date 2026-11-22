import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHost } from '../plugins/host.ts';
import { runtimePlugin } from '../plugins/runtime.ts';
import { resourcesPlugin } from '../plugins/resources.ts';
import { websocketPlugin } from '../daemon/websocket.ts';
import { createBuroApplication } from '../daemon/application.ts';
import { SocketProjectClient } from '../clients/socket-client.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { createRuntimeResources } from '../adapters/resources/runtime-resources.ts';
import { ResourceContributionCatalog } from '../core/resource-contributions.ts';
import { DomainError, type AgentRuntime } from '../core/ports.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import { sampleRun } from './fixtures/sample-run.ts';

const execute = promisify(execFile);
const meta = (id: string) => ({ id, fingerprint: id });
const profile = (resourceProfile?: string) =>
  ProjectProfileSchema.parse({
    version: 1,
    revision: 1,
    context: '',
    scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
    checks: [],
    defaultCheckIds: [],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    maxRepairs: 1,
    turnTimeoutMs: 10000,
    ...(resourceProfile ? { resourceProfile } : {}),
  });

async function directory(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-empty-resources-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t: any, resourceProfile?: string) {
  const root = await directory(t);
  const host = await createHost({
    projects: [
      {
        storageAddress: path.join(root, 'project-state'),
        project: { id: 'p', name: 'Unconfigured project', root },
        profile: profile(resourceProfile),
        runs: [sampleRun()],
      },
    ],
  });
  const factories: Awaited<ReturnType<typeof createRuntimeResources>>[] = [];
  const calls: string[] = [];
  const create = async (
    extra: { builtins?: boolean; contributions?: ResourceContributionCatalog } = {},
  ) => {
    const factory = await createRuntimeResources({
      directory: path.join(root, 'service'),
      projects: host.ctx.projects.registry,
      executors: new EnvironmentExecutors(),
      credentials: () => undefined,
      fetch: async (input) => {
        calls.push(String(input));
        throw Error('No model or discovery request is authorized by setup.');
      },
      codex: { executable: path.join(root, 'codex-must-not-start') },
      ...extra,
    });
    factories.push(factory);
    return factory;
  };
  t.after(async () => {
    await Promise.all(factories.map((factory) => factory.dispose()));
    await host.dispose();
  });
  return { root, host, create, calls };
}

async function saveFirstSetup(factory: Awaited<ReturnType<typeof createRuntimeResources>>) {
  await factory.saveConnection(
    { id: 'local-models', provider: 'ollama', config: { endpoint: 'http://127.0.0.1:11434' } },
    null,
    meta('connection'),
  );
  const before = await factory.list();
  await factory.saveSetup(
    {
      expectedRevision: before.configurationRevision!,
      runtimes: [
        {
          id: 'qwen',
          backend: 'managed',
          config: { connectionId: 'local-models', model: 'qwen-fixture' },
        },
      ],
      profile: {
        id: 'local-team',
        name: 'One model, independent sessions',
        policy: 'local-only',
        coordinator: 'qwen',
        worker: 'qwen',
        reviewer: 'qwen',
      },
    },
    meta('setup'),
  );
}

test('a routed runtime service can own an empty catalog without an implicit default', async () => {
  const host = await createHost();
  let disposed = 0;
  const routed: AgentRuntime = {
    id: 'empty-router',
    async start() {
      throw new DomainError('RESOURCE_PROFILE_REQUIRED', 'Choose a profile.');
    },
    async submit() {
      throw Error('Not started');
    },
    async interrupt() {},
    async dispose() {
      disposed++;
    },
  };
  await host.ctx.plugin(runtimePlugin, {
    runtimes: [],
    route: (registry) => {
      assert.deepEqual(registry.list(), []);
      return routed;
    },
  });
  assert.equal(host.ctx.agentRuntime.adapter, routed);
  assert.equal(host.ctx.agentRuntime.defaultRuntimeId, undefined);
  await assert.rejects(host.ctx.agentRuntime.adapter.start({ projectId: 'p', instructions: '' }), {
    code: 'RESOURCE_PROFILE_REQUIRED',
  });
  await host.dispose();
  await host.dispose();
  assert.equal(disposed, 1);
});

test('an unrouted runtime service requires an explicit default even when called from JavaScript', async () => {
  const host = await createHost();
  await assert.rejects(Promise.resolve(host.ctx.plugin(runtimePlugin, { runtimes: [] } as any)), {
    code: 'RUNTIME_DEFAULT_REQUIRED',
  });
  await host.dispose();
});

test('fresh resource catalogs expose installed descriptors but no configured execution grant', async (t) => {
  const f = await fixture(t);
  const factory = await f.create();
  assert.deepEqual(factory.configuration.snapshot(), {
    version: 1,
    defaultProfile: null,
    connections: [],
    runtimes: [],
    profiles: [],
    receipts: {},
  });
  assert.deepEqual(factory.runtimes, []);
  for (const projectId of [undefined, 'p']) {
    const catalog = await factory.list(projectId);
    assert.equal(catalog.defaultProfile, null);
    assert.equal(catalog.selected, undefined);
    assert.equal(catalog.selectionIssue?.code, 'RESOURCE_PROFILE_REQUIRED');
    assert.deepEqual(catalog.roleChoices, []);
    assert.deepEqual(catalog.connections, []);
    assert.deepEqual(catalog.runtimes, []);
    assert.deepEqual(catalog.profiles, []);
    assert.deepEqual(catalog.configured, { runtimes: [], profiles: [] });
    assert.deepEqual(catalog.probeRuntimeIds, []);
    assert.ok(catalog.providers.some((provider) => provider.id === 'ollama'));
    assert.ok(catalog.backends.some((backend) => backend.id === 'codex'));
  }
  assert.throws(() => factory.selection.forProject('p'), { code: 'RESOURCE_PROFILE_REQUIRED' });
  assert.equal(f.host.ctx.projects.registry.get('p').snapshot().runs[0].id, 'R-example');
  assert.deepEqual(f.calls, []);
});

test('a custom-only empty composition does not need first-party configured resources', async (t) => {
  const f = await fixture(t);
  const factory = await f.create({
    builtins: false,
    contributions: new ResourceContributionCatalog(),
  });
  const catalog = await factory.list('p');
  assert.deepEqual(catalog.providers, []);
  assert.deepEqual(catalog.backends, []);
  assert.deepEqual(catalog.runtimes, []);
  assert.equal(catalog.selectionIssue?.code, 'RESOURCE_PROFILE_REQUIRED');
  assert.deepEqual(f.calls, []);
});

test('first setup remains unselected through saving and restart until the user selects the active profile', async (t) => {
  const f = await fixture(t);
  const factory = await f.create();
  await saveFirstSetup(factory);
  const pending = await factory.list('p');
  assert.equal(pending.defaultProfile, null);
  assert.equal(pending.selected, undefined);
  assert.equal(pending.configured?.profiles[0].restartRequired, true);
  assert.equal(pending.configured?.runtimes[0].restartRequired, true);
  assert.deepEqual(pending.runtimes, []);
  await assert.rejects(factory.useProfile('local-team', meta('too-early')), {
    code: 'RESOURCE_PROFILE_RESTART_REQUIRED',
  });
  await factory.dispose();
  const restarted = await f.create();
  assert.equal((await restarted.list('p')).selectionIssue?.code, 'RESOURCE_PROFILE_REQUIRED');
  assert.equal((await restarted.list()).configured?.profiles[0].restartRequired, false);
  await restarted.useProfile('local-team', meta('select'));
  for (const projectId of [undefined, 'p']) {
    const active = await restarted.list(projectId);
    assert.equal(active.defaultProfile, 'local-team');
    assert.equal(active.selectionIssue, undefined);
    assert.equal(active.selected?.coordinator.id, 'qwen');
    assert.equal(active.selected?.worker.id, 'qwen');
    assert.equal(active.selected?.reviewer.id, 'qwen');
    const research = active.roleChoices?.find(
      (choice) => choice.operationId === 'project.research',
    );
    assert.ok(research?.choices.some((choice) => choice.resource.id === 'qwen' && choice.eligible));
  }
  assert.equal(restarted.selection.forProject('p').profileId, 'local-team');
  const activeConnection = (await restarted.list()).connections[0];
  await restarted.saveConnection(
    {
      id: activeConnection.id,
      provider: activeConnection.provider,
      config: { ...activeConnection.config, endpoint: 'http://127.0.0.1:11435' },
    },
    activeConnection.revision,
    meta('edit-connection'),
  );
  const pendingResearch = (await restarted.list()).roleChoices?.find(
    (choice) => choice.operationId === 'project.research',
  );
  assert.ok(pendingResearch?.choices.length);
  assert.ok(pendingResearch.choices.every((choice) => !choice.eligible));
  assert.throws(() => restarted.selection.forProject('p'), { code: 'CONNECTION_RESTART_REQUIRED' });
  assert.deepEqual(f.calls, []);
});

test('an explicit project profile works with a null machine default after activation', async (t) => {
  const f = await fixture(t, 'local-team');
  const factory = await f.create();
  assert.equal((await factory.list('p')).selectionIssue?.code, 'RESOURCE_PROFILE_UNAVAILABLE');
  await saveFirstSetup(factory);
  await factory.dispose();
  const restarted = await f.create();
  const global = await restarted.list();
  assert.equal(global.defaultProfile, null);
  assert.equal(global.selected, undefined);
  assert.equal(global.selectionIssue?.code, 'RESOURCE_PROFILE_REQUIRED');
  const project = await restarted.list('p');
  assert.equal(project.defaultProfile, null);
  assert.equal(project.selected?.profileId, 'local-team');
  assert.equal(project.selectionIssue, undefined);
  assert.equal(restarted.selection.forProject('p').coordinator.id, 'qwen');
  assert.deepEqual(f.calls, []);
});

test('a fresh production composition supports global RPC and CLI without models or projects', async (t) => {
  const root = await directory(t);
  const calls: string[] = [];
  const host = await createBuroApplication({
    root,
    directory: path.join(root, 'service'),
    credentials: () => undefined,
    fetch: async (input) => {
      calls.push(String(input));
      throw Error('No model requests during empty startup.');
    },
  });
  let port = 0;
  await host.ctx.plugin(websocketPlugin, {
    port: 0,
    onListen: (value) => {
      port = value;
    },
  });
  const url = `ws://127.0.0.1:${port}`;
  const client = new SocketProjectClient(url);
  t.after(async () => {
    client.close();
    await host.dispose();
  });
  const service = await client.connectService();
  assert.deepEqual(service.projects, []);
  assert.ok(service.capabilities.includes('resources.list'));
  assert.deepEqual(host.ctx.agentRuntime.registry.list(), []);
  assert.equal(host.ctx.agentRuntime.defaultRuntimeId, undefined);
  const catalog = await client.request({ method: 'resources.list', params: {} });
  assert.equal(catalog.defaultProfile, null);
  assert.equal(catalog.selectionIssue.code, 'RESOURCE_PROFILE_REQUIRED');
  const result = await execute(process.execPath, ['cli/main.ts', 'resources', 'list'], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, PROJECT_DAEMON_URL: url },
  });
  const cli = JSON.parse(result.stdout);
  assert.equal(cli.defaultProfile, null);
  assert.deepEqual(cli.runtimes, []);
  assert.deepEqual(cli.connections, []);
  assert.equal(cli.selectionIssue.code, 'RESOURCE_PROFILE_REQUIRED');
  assert.deepEqual(calls, []);
});
