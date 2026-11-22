import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createHost } from '../plugins/host.ts';
import { resourcesPlugin } from '../plugins/resources.ts';
import { ResourceContributionCatalog } from '../core/resource-contributions.ts';
import { createRuntimeResources } from '../adapters/resources/runtime-resources.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import { RuntimeRouter } from '../core/runtime-router.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { managedContribution } from '../adapters/resources/contributions/managed.ts';
import { prepareRuntimeHost } from '../adapters/resources/runtime-host.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import type { ProjectRegistry } from '../core/ports.ts';

const connectionConfig = z.strictObject({
  capacity: z.number().int().min(1),
  local: z.boolean().default(true),
});
const backendConfig = z.strictObject({
  connection: z.string(),
  diagnostic: z.boolean().default(false),
});
const meta = (id: string) => ({ id, fingerprint: id });
const configuration = (runtimeIds = ['custom']) => ({
  version: 1,
  defaultProfile: 'custom',
  connections: [
    { id: 'one', provider: 'synthetic', config: { capacity: 4, local: true } },
    { id: 'two', provider: 'synthetic', config: { capacity: 1, local: true } },
  ],
  runtimes: runtimeIds.map((id) => ({
    id,
    backend: 'custom-backend',
    config: { connection: 'one', diagnostic: id === 'custom' },
  })),
  profiles: [
    {
      id: 'custom',
      name: 'Custom',
      policy: 'local-only',
      coordinator: runtimeIds[0],
      worker: runtimeIds[0],
      reviewer: runtimeIds[0],
    },
  ],
  receipts: {},
});

function registrations(
  catalog: ResourceContributionCatalog,
  options: { revision?: string; fail?: string } = {},
) {
  const events: string[] = [];
  const gates: unknown[] = [];
  const completions: string[] = [];
  catalog.registerProvider({
    id: 'synthetic',
    label: 'Synthetic model',
    revision: options.revision || 'provider-v1',
    defaultConfig: { capacity: 1, local: true },
    parse: (config) => connectionConfig.parse(config),
    describe: (input) => {
      const config = connectionConfig.parse(input);
      return {
        local: config.local,
        capacityKey: 'same-synthetic-endpoint',
        capacity: config.capacity,
        credentialReferences: [],
        modelListing: true,
      };
    },
    create: ({ id, config, gate }) => {
      gates.push(gate);
      events.push('provider.create:' + id);
      return {
        provider: {
          id,
          revision: 'wire-v1',
          local: config.local as boolean,
          complete: async (input) => {
            completions.push(id);
            return input.tools.length
              ? {
                  model: input.model,
                  finish: 'tools',
                  message: {
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                      { id: 'echo', name: 'diagnostic_echo', arguments: { value: 'buro-ready' } },
                    ],
                  },
                }
              : {
                  model: input.model,
                  finish: 'stop',
                  message: { role: 'assistant', content: '{"ok":true}' },
                };
          },
        },
        listModels: async () => [{ id: 'synthetic-small' }],
        dispose: async () => {
          events.push('provider.dispose:' + id);
        },
      };
    },
  });
  catalog.registerBackend({
    id: 'custom-backend',
    label: 'Custom agent',
    revision: 'backend-v1',
    defaultConfig: {},
    parse: (config) => backendConfig.parse(config),
    dependencies: (config) => [backendConfig.parse(config).connection],
    describe: (config, providers) => ({
      local: providers.get(backendConfig.parse(config).connection)!.local,
    }),
    template: (connection, model, provider) => ({
      label: 'Custom ' + model,
      config: { connection: connection.id, diagnostic: true },
      local: provider.local,
    }),
    create: ({ id, config: input, providers }) => {
      if (id === options.fail) throw Error('Synthetic backend construction failed');
      const config = backendConfig.parse(input);
      assert.deepEqual(
        [...providers.keys()],
        [config.connection],
        'factory sees only declared dependencies',
      );
      const provider = providers.get(config.connection)!.provider;
      events.push('backend.create:' + id);
      return {
        runtime: {
          id,
          capabilities: fixtureCapabilities({
            structuredTurns: true,
            toolsFreeTurns: true,
            resumeSessions: true,
            readOnlySessions: true,
            cancellation: 'settled-or-unknown',
          }),
          start: async () => {
            events.push('start:' + id);
            return { threadId: 'same-wire-thread' };
          },
          resume: async ({ threadId }) => {
            events.push('resume:' + id);
            return { threadId };
          },
          submit: async () => ({ turnId: 'turn' }),
          turn: async () => {
            events.push('turn:' + id);
            return { turnId: 'turn', text: '{"ok":true}' };
          },
          interrupt: async () => {
            events.push('interrupt:' + id);
          },
          release: async () => {
            events.push('release:' + id);
          },
          dispose: async () => {
            events.push('backend.dispose:' + id);
          },
        },
        revision: 'host-policy-v1',
        providerId: provider.id,
        model: 'synthetic-small',
        local: provider.local,
        ...(config.diagnostic
          ? {
              probe: {
                provider,
                model: 'synthetic-small',
                contextTokens: 4096,
                maxOutputTokens: 1024,
              },
            }
          : {}),
      };
    },
  });
  return { events, gates, completions };
}

async function directoryFixture(t: any, config = configuration()) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'resource-contributions-')),
  );
  await new PrivateJSONFiles(path.join(directory, 'local')).save('resources', config);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('third-party factories registered through Cordis own configured execution, diagnostics and lifecycle without Codex', async (t) => {
  const directory = await directoryFixture(t, configuration(['custom', 'no-probe']));
  const host = await createHost({
    projects: [
      {
        storageAddress: path.join(directory, 'project'),
        project: { id: 'p', name: 'Synthetic', root: directory, managed: true },
      },
    ],
  });
  t.after(() => host.dispose());
  let f!: ReturnType<typeof registrations>;
  await host.ctx.plugin({
    name: 'synthetic-contribution-plugin',
    inject: ['resourceContributions'],
    apply(ctx) {
      f = registrations(ctx.resourceContributions.catalog);
    },
  });
  await host.ctx.plugin(resourcesPlugin, {
    directory,
    builtins: false,
    executors: new EnvironmentExecutors(),
    credentials: () => undefined,
    fetch: async () => {
      throw Error('No network permitted');
    },
  });
  const list = await host.ctx.commands.bus.execute(
    { method: 'resources.list', params: { projectId: 'p' } },
    meta('list'),
  );
  assert.deepEqual(
    list.providers.map((entry: any) => entry.id),
    ['synthetic'],
  );
  assert.deepEqual(
    list.backends.map((entry: any) => entry.id),
    ['custom-backend'],
  );
  assert.deepEqual(list.probeRuntimeIds, ['custom']);
  assert.equal(list.selected!.coordinator.backendId, 'custom-backend');
  assert.equal(
    list.roleChoices!.find((entry: any) => entry.roleId === '*')!.choices[0].eligible,
    true,
  );
  const models = await host.ctx.commands.bus.execute(
    { method: 'resources.models', params: { connectionId: 'one' } },
    meta('models'),
  );
  assert.equal(models[0].templates![0].backend, 'custom-backend');
  const result = await host.ctx.commands.bus.execute(
    { method: 'resources.probe', params: { runtimeId: 'custom' } },
    meta('probe'),
  );
  assert.equal(result.status, 'passed');
  assert.equal(f.completions.length, 2);
  await assert.rejects(
    host.ctx.commands.bus.execute(
      { method: 'resources.probe', params: { runtimeId: 'no-probe' } },
      meta('no-probe'),
    ),
    { code: 'PROBE_UNSUPPORTED' },
  );
  const runtime = host.ctx.agentRuntime.adapter;
  const session = await runtime.start({
    projectId: 'p',
    purpose: 'research',
    instructions: 'Synthetic',
    workspace: directory,
    runId: 'synthetic',
  });
  assert.equal(
    (
      await runtime.turn!(session.threadId, 'Ready', {
        schema: {},
        signal: new AbortController().signal,
        timeoutMs: 1000,
      })
    ).text,
    '{"ok":true}',
  );
  await runtime.interrupt(session.threadId, 'turn');
  await runtime.release!(session.threadId);
  await runtime.resume!({
    projectId: 'p',
    threadId: session.threadId,
    instructions: 'Resume',
    workspace: directory,
    runId: 'synthetic',
    purpose: 'research',
  });
  await runtime.release!(session.threadId);
  assert.throws(() => registrations(host.ctx.resourceContributions.catalog), {
    code: 'RESOURCE_CONTRIBUTIONS_SEALED',
  });
  assert.equal(f.gates[0], f.gates[1], 'aliases share the same minimum-capacity gate');
  const gate = f.gates[0] as { run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> };
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signal = new AbortController().signal;
  const firstGateJob = gate.run(signal, async () => {
    entered();
    await held;
  });
  await started;
  let secondEntered = false;
  const secondGateJob = gate.run(signal, async () => {
    secondEntered = true;
  });
  await Promise.resolve();
  assert.equal(secondEntered, false, 'the lower-capacity alias constrains both connections');
  release();
  await Promise.all([firstGateJob, secondGateJob]);
  assert.equal(secondEntered, true);
  await host.dispose();
  await host.dispose();
  for (const id of ['custom', 'no-probe'])
    assert.equal(f.events.filter((event) => event === 'backend.dispose:' + id).length, 1);
  for (const id of ['one', 'two'])
    assert.equal(f.events.filter((event) => event === 'provider.dispose:' + id).length, 1);
});

test('partial construction drains all existing backends and providers exactly once', async (t) => {
  const directory = await directoryFixture(t, configuration(['custom', 'broken']));
  const catalog = new ResourceContributionCatalog();
  const f = registrations(catalog, { fail: 'broken' });
  const projects = {
    get: () => ({ snapshot: () => ({ project: { id: 'p' } }) }),
  } as unknown as ProjectRegistry;
  await assert.rejects(
    createRuntimeResources({
      directory,
      contributions: catalog,
      builtins: false,
      projects,
      executors: new EnvironmentExecutors(),
      credentials: () => undefined,
    }),
    /Synthetic backend construction failed/,
  );
  assert.equal(f.events.filter((event) => event === 'backend.dispose:custom').length, 1);
  for (const id of ['one', 'two'])
    assert.equal(f.events.filter((event) => event === 'provider.dispose:' + id).length, 1);
});

test('contribution revision changes freeze a new backend identity and stop historical resume', async (t) => {
  const directory = await directoryFixture(t);
  const projects = {
    get: () => ({ snapshot: () => ({ project: { id: 'p' }, runs: [] }) }),
  } as unknown as ProjectRegistry;
  const create = async (revision: string) => {
    const catalog = new ResourceContributionCatalog();
    registrations(catalog, { revision });
    return createRuntimeResources({
      directory,
      contributions: catalog,
      builtins: false,
      projects,
      executors: new EnvironmentExecutors(),
      credentials: () => undefined,
    });
  };
  const first = await create('v1');
  const same = await create('v1');
  const changed = await create('v2');
  assert.deepEqual(first.resources, same.resources);
  assert.notEqual(
    first.resources[0].configurationRevision,
    changed.resources[0].configurationRevision,
  );
  const originalCatalog = new RuntimeCatalog();
  const changedCatalog = new RuntimeCatalog();
  for (const runtime of first.takeRuntimes()) originalCatalog.register(runtime);
  for (const runtime of changed.takeRuntimes()) changedCatalog.register(runtime);
  const router = (registry: RuntimeCatalog, resources: typeof first) =>
    new RuntimeRouter({
      registry,
      projects,
      selection: resources.selection,
      resources: resources.resources,
      routes: new FileRuntimeRoutes(path.join(directory, 'routes')),
      id: () => 'logical-session',
    });
  const originalRouter = router(originalCatalog, first);
  const changedRouter = router(changedCatalog, changed);
  const session = await originalRouter.start({
    projectId: 'p',
    purpose: 'research',
    instructions: 'Synthetic',
    workspace: directory,
    runId: 'synthetic',
  });
  await originalRouter.release(session.threadId);
  await assert.rejects(
    changedRouter.resume({
      projectId: 'p',
      threadId: session.threadId,
      instructions: 'Resume old settings',
      workspace: directory,
      runId: 'synthetic',
      purpose: 'research',
    }),
    { code: 'RUNTIME_CONFIG_CHANGED' },
  );
  await Promise.all([originalRouter.dispose(), changedRouter.dispose()]);
  await Promise.all([originalCatalog.dispose(), changedCatalog.dispose()]);
  await Promise.all([first.dispose(), same.dispose(), changed.dispose()]);
});

test('model support and locality belong to provider registrations, including cloud-named third-party models', async (t) => {
  const config = {
    ...configuration(),
    runtimes: [
      {
        id: 'custom',
        backend: 'managed',
        config: { connectionId: 'one', model: 'synthetic-cloud' },
      },
    ],
  };
  const directory = await directoryFixture(t, config as ReturnType<typeof configuration>);
  const projects = {
    get: () => ({ snapshot: () => ({ project: { id: 'p' }, runs: [] }) }),
  } as unknown as ProjectRegistry;
  const options = {
    directory,
    projects,
    executors: new EnvironmentExecutors(),
    credentials: () => undefined,
  };
  const catalog = new ResourceContributionCatalog();
  registrations(catalog);
  catalog.registerBackend(managedContribution(options, prepareRuntimeHost(options)));
  const resources = await createRuntimeResources({
    ...options,
    contributions: catalog,
    builtins: false,
  });
  assert.equal(resources.resources[0].local, true);
  assert.equal(resources.resources[0].model, 'synthetic-cloud');
  await resources.dispose();

  const builtinsConfig = {
    ...config,
    connections: [{ id: 'one', provider: 'ollama', config: {} }],
    runtimes: [
      { id: 'custom', backend: 'managed', config: { connectionId: 'one', model: 'qwen:cloud' } },
    ],
  };
  await new PrivateJSONFiles(path.join(directory, 'local')).save('resources', builtinsConfig);
  let calls = 0;
  const builtinOptions = {
    ...options,
    fetch: async () => {
      calls++;
      throw Error('No HTTP permitted');
    },
  };
  await assert.rejects(createRuntimeResources(builtinOptions), { code: 'MODEL_UNSUPPORTED' });
  assert.equal(calls, 0, 'unsupported configured models are rejected before provider HTTP');
  await new PrivateJSONFiles(path.join(directory, 'local')).save('resources', {
    ...builtinsConfig,
    connections: [{ id: 'one', provider: 'deepseek', config: {} }],
    runtimes: [
      {
        id: 'custom',
        backend: 'managed',
        config: { connectionId: 'one', model: 'deepseek-cloud' },
      },
    ],
    profiles: builtinsConfig.profiles.map((profile) => ({ ...profile, policy: 'hybrid' })),
  });
  const deepseek = await createRuntimeResources(builtinOptions);
  assert.equal(deepseek.resources[0].local, false);
  assert.equal(calls, 0);
  await deepseek.dispose();
});
