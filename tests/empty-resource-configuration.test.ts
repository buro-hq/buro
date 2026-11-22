import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  defaultResources,
  FileResourceConfiguration,
  ResourceConfigurationSchema,
  resourceConfigurationRevision,
} from '../adapters/files/resource-configuration.ts';
import { ResourceContributionCatalog } from '../core/resource-contributions.ts';
import { ResourceSelection } from '../core/resource-selection.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { ResourceProfile, RuntimeResource } from '../protocol/resources.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';

async function directory(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-empty-resources-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const profile: ResourceProfile = {
  id: 'first',
  name: 'First team',
  policy: 'local-only',
  coordinator: 'shared',
  worker: 'shared',
  reviewer: 'shared',
};
function contributions() {
  const catalog = new ResourceContributionCatalog();
  const unused = (): never => {
    throw Error('Saving configuration must not create execution adapters.');
  };
  const provider = z.strictObject({ local: z.boolean() });
  const backend = z.strictObject({ connectionId: z.string().min(1) });
  catalog.registerProvider({
    id: 'custom-provider',
    label: 'Custom provider',
    revision: 'v1',
    defaultConfig: { local: true },
    parse: (config) => provider.parse(config),
    describe: (config) => ({
      local: provider.parse(config).local,
      capacityKey: 'custom',
      capacity: 1,
      credentialReferences: [],
      modelListing: false,
    }),
    create: unused,
  });
  catalog.registerBackend({
    id: 'custom-backend',
    label: 'Custom backend',
    revision: 'v1',
    defaultConfig: { connectionId: 'connection' },
    parse: (config) => backend.parse(config),
    dependencies: (config) => [backend.parse(config).connectionId],
    describe: (config, providers) => ({
      local: providers.get(backend.parse(config).connectionId)!.local,
    }),
    create: unused,
  });
  return catalog.seal();
}

test('a fresh private resource file needs no installed contribution and restores an explicitly empty machine', async (t) => {
  const root = await directory(t);
  const catalog = new ResourceContributionCatalog().seal();
  const expected = {
    version: 1,
    defaultProfile: null,
    connections: [],
    runtimes: [],
    profiles: [],
    receipts: {},
  };
  assert.deepEqual(defaultResources(), expected);
  const configuration = await FileResourceConfiguration.open(root, catalog);
  assert.deepEqual(configuration.snapshot(), expected);
  assert.equal((await configuration.init()).created, true);
  assert.equal((await fs.stat(configuration.filename)).mode & 0o777, 0o600);
  const restored = await FileResourceConfiguration.open(root, catalog);
  assert.deepEqual(restored.snapshot(), expected);
  await assert.rejects(restored.use('select', 'select', 'first'), {
    code: 'RESOURCE_PROFILE_UNAVAILABLE',
  });
  assert.deepEqual(restored.snapshot(), expected);
});

test('first connection and profile save atomically with receipts but never silently select the profile', async (t) => {
  const root = await directory(t);
  const catalog = contributions();
  const configuration = await FileResourceConfiguration.open(root, catalog);
  await configuration.init();
  await configuration.save(
    'connect',
    'connection-v1',
    { id: 'connection', provider: 'custom-provider', config: { local: true } },
    null,
  );
  const input = {
    expectedRevision: resourceConfigurationRevision(configuration.snapshot()),
    runtimes: [{ id: 'shared', backend: 'custom-backend', config: { connectionId: 'connection' } }],
    profile,
  };
  const receipt = await configuration.saveSetup('setup', 'setup-v1', input);
  assert.deepEqual(receipt, {
    profileId: 'first',
    runtimeIds: ['shared'],
    appliesTo: 'service-restart',
  });
  assert.equal(configuration.snapshot().defaultProfile, null);
  const restored = await FileResourceConfiguration.open(root, catalog);
  assert.deepEqual(await restored.saveSetup('setup', 'setup-v1', input), receipt);
  assert.equal(restored.snapshot().profiles.length, 1);
  assert.equal(restored.snapshot().runtimes.length, 1);
  assert.equal(restored.snapshot().defaultProfile, null);
  await assert.rejects(
    restored.saveSetup('stale', 'stale', {
      ...input,
      profile: { ...profile, id: 'second' },
      runtimes: [],
    }),
    { code: 'RESOURCE_SETUP_CONFLICT' },
  );
  await restored.use('explicit-choice', 'choose-first', 'first');
  assert.equal(
    (await FileResourceConfiguration.open(root, catalog)).snapshot().defaultProfile,
    'first',
  );
});

test('a null default does not waive configured dependency or local-only validation', async (t) => {
  const root = await directory(t);
  const catalog = contributions();
  const configuration = await FileResourceConfiguration.open(root, catalog);
  await configuration.init();
  const before = await fs.readFile(configuration.filename, 'utf8');
  await assert.rejects(
    configuration.saveSetup('missing', 'missing', {
      expectedRevision: resourceConfigurationRevision(configuration.snapshot()),
      runtimes: [{ id: 'shared', backend: 'custom-backend', config: { connectionId: 'absent' } }],
      profile,
    }),
    { code: 'RESOURCE_DEPENDENCY_UNAVAILABLE' },
  );
  assert.equal(await fs.readFile(configuration.filename, 'utf8'), before);
  await configuration.save(
    'remote',
    'remote',
    { id: 'connection', provider: 'custom-provider', config: { local: false } },
    null,
  );
  const afterConnection = await fs.readFile(configuration.filename, 'utf8');
  await assert.rejects(
    configuration.saveSetup('remote-team', 'remote-team', {
      expectedRevision: resourceConfigurationRevision(configuration.snapshot()),
      runtimes: [
        { id: 'shared', backend: 'custom-backend', config: { connectionId: 'connection' } },
      ],
      profile,
    }),
    { code: 'DATA_POLICY_BLOCKED' },
  );
  assert.equal(await fs.readFile(configuration.filename, 'utf8'), afterConnection);
  assert.equal(
    ResourceConfigurationSchema.safeParse({ ...defaultResources(), defaultProfile: 'missing' })
      .success,
    false,
  );
  assert.throws(
    () => catalog.validateConfiguration({ ...defaultResources(), defaultProfile: 'missing' }),
    { code: 'RESOURCE_PROFILE_UNAVAILABLE' },
  );
});

test('selection requires an explicit default even when profiles exist; a project override works with null', () => {
  let override: string | undefined;
  let selected: string | null = null;
  const projects = {
    get: () => ({ snapshot: () => ({ profile: { resourceProfile: override } }) }),
  } as unknown as ProjectRegistry;
  const runtime: RuntimeResource = {
    id: 'shared',
    backendId: 'custom-backend',
    local: true,
    configurationRevision: 'v1',
    capabilities: fixtureCapabilities(),
  };
  const selection = new ResourceSelection({
    projects,
    profiles: [profile],
    runtimes: [runtime],
    defaultProfile: () => selected,
  });
  assert.throws(() => selection.forMachine(), { code: 'RESOURCE_PROFILE_REQUIRED' });
  assert.throws(() => selection.forProject('p'), { code: 'RESOURCE_PROFILE_REQUIRED' });
  override = 'first';
  const saved = selection.forProject('p');
  assert.equal(saved.profileId, 'first');
  runtime.configurationRevision = 'later';
  assert.equal(saved.coordinator.configurationRevision, 'v1');
  assert.throws(() => selection.forMachine(), { code: 'RESOURCE_PROFILE_REQUIRED' });
  override = 'missing';
  assert.throws(() => selection.forProject('p'), { code: 'RESOURCE_PROFILE_UNAVAILABLE' });
  override = undefined;
  selected = 'first';
  assert.equal(selection.forMachine().profileId, 'first');
  runtime.local = false;
  assert.throws(() => selection.forProject('p'), { code: 'DATA_POLICY_BLOCKED' });
});
