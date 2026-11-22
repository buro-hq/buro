import { fixtureResources } from './fixtures/resource-configuration.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ResourceContributionCatalog,
  type BackendContribution,
  type ProviderContribution,
} from '../core/resource-contributions.ts';
import { ResourceConnectionSchema, RuntimeDefinitionSchema } from '../protocol/resources.ts';
import {
  FileResourceConfiguration,
  connectionConfigurationRevision,
  resourceConfigurationRevision,
} from '../adapters/files/resource-configuration.ts';
import { testResourceContributions } from './fixtures/resource-contributions.ts';

function contributions() {
  const provider: ProviderContribution = {
    id: 'tiny-engine',
    label: 'Tiny engine',
    revision: 'engine-v1',
    defaultConfig: { nested: { a: 1 } },
    parse: (config) => {
      if (typeof config.remote !== 'boolean') throw Error('private configuration detail');
      return config;
    },
    describe: (config) => ({
      local: !config.remote,
      capacityKey: 'engine:shared',
      capacity: 1,
      credentialReferences: [],
      modelListing: false,
    }),
    create: () => {
      throw Error('No provider calls in semantic admission.');
    },
  };
  const backend: BackendContribution = {
    id: 'workflow',
    label: 'Workflow',
    revision: 'workflow-v1',
    defaultConfig: {},
    parse: (config) => {
      if (typeof config.connection !== 'string')
        throw Error('private backend configuration detail');
      return config;
    },
    dependencies: (config) => [String(config.connection)],
    // A buggy contribution cannot turn its remote dependencies into local ones.
    describe: () => ({ local: true }),
    create: () => {
      throw Error('No backend calls in semantic admission.');
    },
  };
  const catalog = new ResourceContributionCatalog();
  catalog.registerProvider(provider);
  catalog.registerBackend(backend);
  return { catalog, provider, backend };
}
const configuration = () => ({
  version: 1 as const,
  defaultProfile: 'team',
  connections: [{ id: 'engine', provider: 'tiny-engine', config: { remote: false } }],
  runtimes: [{ id: 'worker', backend: 'workflow', config: { connection: 'engine' } }],
  profiles: [
    {
      id: 'team',
      name: 'Team',
      policy: 'local-only' as const,
      coordinator: 'worker',
      worker: 'worker',
      reviewer: 'worker',
    },
  ],
  receipts: {},
});

test('open envelopes preserve arbitrary JSON but reject executable or non-JSON configuration', () => {
  const connection = {
    id: 'new-engine',
    provider: 'new-provider',
    config: { arbitrary: { rows: [1, true, null, 'text'] } },
  };
  assert.deepEqual(ResourceConnectionSchema.parse(connection), connection);
  assert.equal(
    RuntimeDefinitionSchema.safeParse({
      id: 'custom',
      backend: 'custom',
      config: { command: 'anything' },
    }).success,
    true,
  );
  for (const value of [() => {}, undefined, BigInt(1), Infinity, NaN])
    assert.equal(
      ResourceConnectionSchema.safeParse({ ...connection, config: { value } }).success,
      false,
    );
  assert.equal(
    ResourceConnectionSchema.safeParse({ ...connection, kind: 'ollama' }).success,
    false,
  );
});

test('catalog admits arbitrary registered IDs and rejects unknown, duplicate and late registrations explicitly', () => {
  const { catalog, provider, backend } = contributions();
  assert.throws(() => catalog.validateConfiguration(configuration()), {
    code: 'RESOURCE_CONTRIBUTIONS_UNSEALED',
  });
  assert.throws(() => catalog.registerProvider(provider), { code: 'RESOURCE_PROVIDER_EXISTS' });
  assert.throws(() => catalog.registerBackend(backend), { code: 'RESOURCE_BACKEND_EXISTS' });
  catalog.seal();
  assert.equal(catalog.validateConfiguration(configuration()).runtimes[0].backend, 'workflow');
  assert.throws(() => catalog.provider('ollama'), { code: 'RESOURCE_PROVIDER_UNAVAILABLE' });
  assert.throws(() => catalog.backend('managed'), { code: 'RESOURCE_BACKEND_UNAVAILABLE' });
  assert.throws(() => catalog.registerBackend({ ...backend, id: 'late' }), {
    code: 'RESOURCE_CONTRIBUTIONS_SEALED',
  });
  assert.throws(() => catalog.registerProvider({ ...provider, id: 'late' }), {
    code: 'RESOURCE_CONTRIBUTIONS_SEALED',
  });
});

test('catalog captures descriptor and parser registrations without retaining mutable configuration aliases', () => {
  const { catalog, provider } = contributions();
  let retained: any;
  const originalParse = provider.parse;
  const other = {
    ...provider,
    id: 'retaining',
    parse: (config: any) => {
      retained = config;
      return originalParse(config);
    },
  };
  catalog.registerProvider(other);
  catalog.seal();
  provider.label = 'Changed after registration';
  (provider.defaultConfig.nested as any).a = 999;
  provider.parse = () => ({ remote: 'invalid' });
  const descriptors = catalog.providerDescriptors();
  assert.equal(descriptors[0].label, 'Tiny engine');
  assert.deepEqual(descriptors[0].defaultConfig, { nested: { a: 1 } });
  descriptors[0].defaultConfig.nested = 'external';
  assert.deepEqual(catalog.providerDescriptors()[0].defaultConfig, { nested: { a: 1 } });
  const input = { id: 'one', provider: 'retaining', config: { remote: false, nested: { a: 1 } } };
  const parsed = catalog.parseConnection(input);
  retained.nested.a = 5;
  input.config.nested.a = 8;
  assert.deepEqual(parsed.config.nested, { a: 1 });
  assert.throws(
    () => catalog.parseConnection({ ...input, config: { remote: 'PRIVATE_SENTINEL' } }),
    { code: 'INVALID_RESOURCE_CONFIGURATION' },
  );
});

test('semantic validation checks every saved backend and every local-only pool alternative', () => {
  const { catalog } = contributions();
  catalog.seal();
  const dangling = configuration();
  dangling.runtimes.push({ id: 'unused', backend: 'workflow', config: { connection: 'missing' } });
  assert.throws(() => catalog.validateConfiguration(dangling), {
    code: 'RESOURCE_DEPENDENCY_UNAVAILABLE',
  });
  const remote = configuration();
  remote.connections.push({ id: 'remote', provider: 'tiny-engine', config: { remote: true } });
  remote.runtimes.push({
    id: 'remote-worker',
    backend: 'workflow',
    config: { connection: 'remote' },
  });
  Object.assign(remote.profiles[0], { workerPool: ['worker', 'remote-worker'] });
  assert.throws(() => catalog.validateConfiguration(remote), { code: 'DATA_POLICY_BLOCKED' });
  remote.profiles[0].policy = 'hybrid' as any;
  assert.equal(catalog.validateConfiguration(remote).runtimes.length, 2);
});

test('retained provider metadata cannot rewrite per-model locality after admission', () => {
  const { catalog, provider } = contributions();
  const retained = {
    local: false,
    capacityKey: 'remote-engine',
    capacity: 1,
    credentialReferences: [],
    modelListing: false,
  };
  const registration = {
    ...provider,
    id: 'retaining-model',
    describe: () => retained,
    describeModel: () => ({ local: true, supported: true }),
  };
  catalog.registerProvider(registration);
  catalog.seal();
  const metadata = catalog.provider('retaining-model').describe({ remote: true });
  retained.local = true;
  registration.describeModel = () => ({ local: true, supported: false });
  assert.equal(metadata.local, false);
  assert.deepEqual(metadata.describeModel!('model'), { local: false, supported: true });
  assert.ok(Object.isFrozen(metadata.describeModel!('model')));
});

test('model templates cannot mutate active connections and derive locality from declared dependencies', () => {
  const { catalog, backend } = contributions();
  const retained = { connection: 'engine', nested: { value: 1 } };
  catalog.registerBackend({
    ...backend,
    id: 'templated',
    template: (connection, _model, provider) => {
      assert.ok(Object.isFrozen(connection));
      assert.ok(Object.isFrozen(connection.config));
      assert.ok(Object.isFrozen(provider));
      assert.throws(() => {
        connection.id = 'retargeted';
      }, TypeError);
      assert.throws(() => {
        connection.config.remote = false;
      }, TypeError);
      assert.throws(() => {
        provider.local = true;
      }, TypeError);
      return { label: 'Suggested worker', config: retained, local: true };
    },
  });
  catalog.seal();
  const connection = { id: 'engine', provider: 'tiny-engine', config: { remote: true } };
  const before = structuredClone(connection);
  const metadata = catalog.provider('tiny-engine').describe(connection.config);
  const result = catalog.backend('templated').template!(connection, 'model', metadata)!;
  retained.nested.value = 99;
  assert.deepEqual(connection, before);
  assert.deepEqual(result.config, { connection: 'engine', nested: { value: 1 } });
  assert.equal(result.local, false, 'a template flag cannot relabel a remote dependency as local');
});

test('model templates reject unparsed backend configs and unavailable dependency retargeting', () => {
  const { catalog, backend } = contributions();
  catalog.registerBackend({
    ...backend,
    id: 'invalid-template',
    template: () => ({ label: 'Invalid', config: {}, local: true }),
  });
  catalog.registerBackend({
    ...backend,
    id: 'retarget-template',
    template: () => ({ label: 'Retargeted', config: { connection: 'another' }, local: true }),
  });
  catalog.seal();
  const connection = { id: 'engine', provider: 'tiny-engine', config: { remote: false } };
  const metadata = catalog.provider('tiny-engine').describe(connection.config);
  assert.throws(
    () => catalog.backend('invalid-template').template!(connection, 'model', metadata),
    { code: 'INVALID_RESOURCE_CONFIGURATION' },
  );
  assert.throws(
    () => catalog.backend('retarget-template').template!(connection, 'model', metadata),
    { code: 'RESOURCE_DEPENDENCY_UNAVAILABLE' },
  );
});

test('canonical nested object order stabilizes connection and whole-configuration revisions', () => {
  const first = {
    id: 'engine',
    provider: 'tiny-engine',
    config: { z: { b: 2, a: 1 }, remote: false },
  };
  const second = {
    id: 'engine',
    provider: 'tiny-engine',
    config: { remote: false, z: { a: 1, b: 2 } },
  };
  assert.equal(connectionConfigurationRevision(first), connectionConfigurationRevision(second));
  const a = configuration(),
    b = configuration();
  a.connections[0] = first as any;
  b.connections[0] = second as any;
  assert.equal(resourceConfigurationRevision(a), resourceConfigurationRevision(b));
});

async function directory(t: any) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-open-contributions-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('file configuration requires a sealed semantic catalog before opening or creating storage', async (t) => {
  const root = await directory(t);
  const unopened = path.join(root, 'not-created');
  await assert.rejects(
    FileResourceConfiguration.open(unopened, new ResourceContributionCatalog()),
    { code: 'RESOURCE_CONTRIBUTIONS_UNSEALED' },
  );
  await assert.rejects(fs.stat(unopened), { code: 'ENOENT' });
  const empty = new ResourceContributionCatalog().seal();
  const configuration = await FileResourceConfiguration.open(root, empty);
  assert.deepEqual(configuration.snapshot(), {
    version: 1,
    defaultProfile: null,
    connections: [],
    runtimes: [],
    profiles: [],
    receipts: {},
  });
  await assert.rejects(fs.stat(path.join(root, 'resources.json')), { code: 'ENOENT' });
});

test('file load rejects invalid semantic declarations and local-only profiles without rewriting their bytes', async (t) => {
  const root = await directory(t);
  const { catalog } = contributions();
  catalog.seal();
  for (const mutation of ['remote', 'missing', 'unknown', 'malformed'] as const) {
    const candidate = configuration();
    if (mutation === 'remote') candidate.connections[0].config.remote = true;
    if (mutation === 'missing') candidate.runtimes[0].config.connection = 'missing';
    if (mutation === 'unknown') candidate.connections[0].provider = 'unregistered';
    if (mutation === 'malformed') candidate.connections[0].config.remote = 'wrong' as any;
    const bytes = JSON.stringify(candidate);
    await fs.writeFile(path.join(root, 'resources.json'), bytes, { mode: 0o600 });
    await assert.rejects(FileResourceConfiguration.open(root, catalog));
    assert.equal(await fs.readFile(path.join(root, 'resources.json'), 'utf8'), bytes);
  }
});

test('changing a shared connection cannot silently invalidate an existing local-only profile', async (t) => {
  const root = await directory(t);
  const { catalog } = contributions();
  catalog.seal();
  const file = new FileResourceConfiguration(root, configuration(), catalog);
  await file.init();
  const before = file.snapshot(),
    bytes = await fs.readFile(file.filename, 'utf8');
  await assert.rejects(
    file.save(
      'retarget',
      'fp',
      { ...before.connections[0], config: { remote: true } },
      connectionConfigurationRevision(before.connections[0]),
    ),
    { code: 'DATA_POLICY_BLOCKED' },
  );
  assert.deepEqual(file.snapshot(), before);
  assert.equal(await fs.readFile(file.filename, 'utf8'), bytes);
  assert.equal(file.snapshot().receipts.retarget, undefined);
});

test('semantic config capture precedes queued writes and nested key reordering is not an external edit', async (t) => {
  const root = await directory(t);
  const { catalog } = contributions();
  catalog.seal();
  const file = new FileResourceConfiguration(root, configuration(), catalog);
  await file.init();
  const candidate = {
    id: 'second',
    provider: 'tiny-engine',
    config: { remote: false, nested: { a: 1, b: 2 } },
  };
  const saving = file.save('create', 'fp', candidate, null);
  candidate.config.nested.a = 99;
  await saving;
  assert.deepEqual(file.snapshot().connections[1].config.nested, { a: 1, b: 2 });
  const reordered = file.snapshot();
  reordered.connections[1].config = { nested: { b: 2, a: 1 }, remote: false };
  await fs.writeFile(file.filename, JSON.stringify(reordered));
  await file.use('select', 'fp', 'team');
  assert.equal(file.snapshot().defaultProfile, 'team');
});

test('builtin limits remain semantic gates after the RPC envelope becomes open', async (t) => {
  const root = await directory(t);
  const catalog = testResourceContributions();
  const file = new FileResourceConfiguration(root, fixtureResources(), catalog);
  await file.init();
  const before = file.snapshot();
  const runtime = {
    id: 'bad',
    backend: 'managed',
    config: {
      connectionId: 'ollama',
      model: 'small',
      limits: { contextTokens: 2048, maxOutputTokens: 2048 },
    },
  };
  assert.equal(RuntimeDefinitionSchema.safeParse(runtime).success, true);
  assert.throws(
    () =>
      file.saveSetup('bad', 'fp', {
        expectedRevision: resourceConfigurationRevision(before),
        runtimes: [runtime],
        profile: {
          id: 'team',
          name: 'Team',
          policy: 'hybrid',
          coordinator: 'bad',
          worker: 'bad',
          reviewer: 'bad',
        },
      }),
    { code: 'INVALID_RESOURCE_CONFIGURATION' },
  );
  assert.deepEqual(file.snapshot(), before);
});
