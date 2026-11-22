import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createHost } from '../plugins/host.ts';
import { resourcesPlugin } from '../plugins/resources.ts';
import { ResourceContributionCatalog } from '../core/resource-contributions.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import type { BackendContribution, ProviderContribution } from '../core/resource-contributions.ts';

async function fixture(
  t: any,
  options: { invalidTemplate?: boolean; invalidBackendLocality?: boolean } = {},
) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stage4b1-review-')));
  const local = path.join(directory, 'local');
  const connectionIds = ['engine'];
  const connectionId = connectionIds[0];
  await new PrivateJSONFiles(local).save('resources', {
    version: 1,
    defaultProfile: 'team',
    connections: connectionIds.map((id) => ({
      id,
      provider: 'codex',
      config: { local: true, area: 'home' },
    })),
    runtimes: [
      { id: 'codex', backend: 'ollama', config: { connectionId, model: 'tiny', tag: 'active' } },
    ],
    profiles: [
      {
        id: 'team',
        name: 'Third-party team',
        policy: 'local-only',
        coordinator: 'codex',
        worker: 'codex',
        reviewer: 'codex',
      },
    ],
    receipts: {},
  });
  const host = await createHost({
    projects: [
      {
        storageAddress: path.join(directory, 'project'),
        project: { id: 'p', name: 'Fixture', root: directory },
        roles: [],
      },
    ],
  });
  t.after(async () => {
    await host.dispose().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  const events: string[] = [];
  let starts = 0,
    turns = 0,
    completions = 0,
    network = 0;
  let capturedTemplateConnection: unknown;
  const connectionSchema = z.strictObject({ local: z.boolean(), area: z.string().min(1) });
  const runtimeSchema = z.strictObject({
    connectionId: z.string().min(1),
    model: z.string().min(1),
    tag: z.string(),
  });
  const provider: ProviderContribution = {
    id: 'codex',
    label: 'Third-party model transport',
    revision: 'provider-v1',
    defaultConfig: { local: true, area: 'home' },
    parse: (config) => connectionSchema.parse(config),
    describe: (config) => ({
      local: config.local as boolean,
      capacity: 1,
      capacityKey: 'synthetic-engine',
      credentialReferences: [],
      modelListing: true,
    }),
    create: ({ id, config }) => {
      const actual: ModelProvider = {
        id,
        revision: 'wire-v1',
        local: config.local as boolean,
        async complete() {
          completions++;
          throw Error('No model generation is authorized in this test.');
        },
      };
      events.push('provider.create:' + id);
      return {
        provider: actual,
        listModels: async () => [{ id: 'tiny' }],
        dispose: () => {
          events.push('provider.dispose:' + id);
          return Promise.resolve();
        },
      };
    },
  };
  const backend: BackendContribution = {
    id: 'ollama',
    label: 'Third-party agent backend',
    revision: 'backend-v1',
    defaultConfig: { connectionId, model: 'tiny', tag: 'default' },
    parse: (config) => runtimeSchema.parse(config),
    dependencies: (config) => [config.connectionId as string],
    describe: (config, providers) => ({
      local: providers.get(config.connectionId as string)!.local,
    }),
    template: (connection, model) => {
      capturedTemplateConnection = connection;
      return {
        label: 'Conservative model suggestion',
        local: false,
        config: {
          connectionId: connection.id,
          model: options.invalidTemplate ? { private: 'PRIVATE_INVALID_TEMPLATE' } : model,
          tag: 'suggestion',
        } as any,
      };
    },
    create: ({ id, config, providers }) => {
      const dependency = providers.get(config.connectionId as string)!.provider;
      events.push('backend.create:' + id);
      return {
        revision: 'host-policy-v1',
        model: config.model as string,
        providerId: dependency.id,
        local: options.invalidBackendLocality ? !dependency.local : dependency.local,
        runtime: {
          id,
          capabilities: fixtureCapabilities({
            structuredTurns: true,
            toolsFreeTurns: true,
            readOnlySessions: false,
            resumeSessions: true,
            cancellation: 'settled-or-unknown',
          }),
          async start() {
            starts++;
            return { threadId: 'opaque-thread' };
          },
          async resume({ threadId }) {
            return { threadId };
          },
          async submit() {
            return { turnId: 'turn' };
          },
          async turn() {
            turns++;
            return { turnId: 'turn', text: '{"ok":true}' };
          },
          async interrupt() {},
          async release() {},
          async dispose() {
            events.push('backend.dispose:' + id);
            if (options.invalidBackendLocality) throw Error('Synthetic backend cleanup failure.');
          },
        },
      };
    },
  };
  await host.ctx.plugin({
    name: 'review-contributions',
    inject: ['resourceContributions'],
    apply(ctx) {
      ctx.resourceContributions.catalog.registerProvider(provider);
      ctx.resourceContributions.catalog.registerBackend(backend);
    },
  });
  const install = () =>
    host.ctx.plugin(resourcesPlugin, {
      directory,
      builtins: false,
      credentials: () => undefined,
      executors: new EnvironmentExecutors(),
      fetch: async () => {
        network++;
        throw Error('No network.');
      },
    });
  return {
    host,
    directory,
    local,
    events,
    provider,
    backend,
    install,
    connectionId,
    starts: () => starts,
    turns: () => turns,
    completions: () => completions,
    network: () => network,
    templateConnection: () => capturedTemplateConnection,
  };
}
const meta = (id: string) => ({ id, fingerprint: id });

test('registered third-party factories with familiar IDs gain no backend privilege and keep conservative template locality', async (t) => {
  const f = await fixture(t);
  await f.install();
  const before = await fs.readFile(path.join(f.local, 'resources.json'), 'utf8');
  const catalog = await f.host.ctx.commands.bus.execute(
    { method: 'resources.list', params: { projectId: 'p' } },
    meta('list'),
  );
  assert.deepEqual(
    catalog.providers.map((entry: any) => entry.id),
    ['codex'],
  );
  assert.deepEqual(
    catalog.backends.map((entry: any) => entry.id),
    ['ollama'],
  );
  assert.equal(catalog.runtimes[0].backendId, 'ollama');
  const models = await f.host.ctx.commands.bus.execute(
    { method: 'resources.models', params: { connectionId: f.connectionId } },
    meta('models'),
  );
  assert.equal(
    models[0].templates[0].local,
    false,
    'A template explicitly marked nonlocal cannot be promoted to local.',
  );
  assert.equal(Object.isFrozen(f.templateConnection()), true);
  assert.throws(() => {
    (f.templateConnection() as any).config.area = 'changed';
  }, TypeError);
  models[0].templates[0].config.tag = 'consumer changed its suggestion';
  assert.equal(await fs.readFile(path.join(f.local, 'resources.json'), 'utf8'), before);
  const runtime = f.host.ctx.agentRuntime.adapter;
  await assert.rejects(
    runtime.start({
      projectId: 'p',
      runId: 'research-fixture',
      purpose: 'research',
      workspace: f.directory,
      readOnly: true,
      instructions: 'Read only.',
    }),
    { code: 'BACKEND_CAPABILITY_UNAVAILABLE' },
  );
  assert.equal(f.starts(), 0, 'The name codex cannot grant unsupported read-only mechanics.');
  const started = await runtime.start({
    projectId: 'p',
    runId: 'research-fixture',
    purpose: 'implementation',
    operationId: 'goal.implementation',
    workspace: f.directory,
    instructions: 'Explicit supported operation.',
  });
  const result = await runtime.turn!(started.threadId, 'Respond.', {
    schema: {},
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  assert.equal(result.text, '{"ok":true}');
  await runtime.release!(started.threadId);
  assert.equal(f.starts(), 1);
  assert.equal(f.turns(), 1);
  assert.equal(f.completions(), 0);
  assert.equal(f.network(), 0);
  await f.host.dispose();
  await f.host.dispose();
  assert.equal(f.events.filter((event) => event === 'backend.dispose:codex').length, 1);
  assert.equal(f.events.filter((event) => event === 'provider.dispose:engine').length, 1);
});

test('invalid third-party model templates fail semantic admission without mutating active configuration or dispatching execution', async (t) => {
  const f = await fixture(t, { invalidTemplate: true });
  await f.install();
  const before = await fs.readFile(path.join(f.local, 'resources.json'), 'utf8');
  await assert.rejects(
    f.host.ctx.commands.bus.execute(
      { method: 'resources.models', params: { connectionId: f.connectionId } },
      meta('bad-template'),
    ),
    (error: any) => {
      assert.equal(error.code, 'INVALID_RESOURCE_CONFIGURATION');
      assert.doesNotMatch(String(error), /PRIVATE_INVALID_TEMPLATE/);
      return true;
    },
  );
  assert.equal(await fs.readFile(path.join(f.local, 'resources.json'), 'utf8'), before);
  assert.equal(f.starts(), 0);
  assert.equal(f.completions(), 0);
  assert.equal(f.network(), 0);
});

test('a factory locality mismatch is rejected and all acquired instances drain despite backend cleanup failure', async (t) => {
  const f = await fixture(t, { invalidBackendLocality: true });
  await assert.rejects(Promise.resolve(f.install()), { code: 'INVALID_RUNTIME_INSTANCE' });
  await f.host.dispose().catch(() => {});
  assert.deepEqual(f.events, [
    'provider.create:engine',
    'backend.create:codex',
    'backend.dispose:codex',
    'provider.dispose:engine',
  ]);
  assert.equal(f.starts(), 0);
  assert.equal(f.network(), 0);
});

test('malformed contribution descriptors are rejected before registration or factory effects', () => {
  let effects = 0;
  const valid: ProviderContribution = {
    id: 'third',
    label: 'Third',
    revision: 'v1',
    defaultConfig: {},
    parse: (config) => config,
    describe: () => ({
      local: true,
      capacityKey: 'third',
      capacity: 1,
      credentialReferences: [],
      modelListing: false,
    }),
    create() {
      effects++;
      throw Error('Not allowed during registration.');
    },
  };
  for (const mutation of [
    { id: 'INVALID' },
    { label: ' ' },
    { revision: '' },
    { editor: '' },
    { defaultConfig: { forbidden: () => {} } },
  ]) {
    const catalog = new ResourceContributionCatalog();
    assert.throws(() =>
      catalog.registerProvider({ ...valid, ...mutation } as ProviderContribution),
    );
    assert.deepEqual(catalog.seal().providerDescriptors(), []);
  }
  assert.equal(effects, 0);
});
