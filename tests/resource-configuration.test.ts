import { fixtureResources } from './fixtures/resource-configuration.ts';
import { testResourceContributions } from './fixtures/resource-contributions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FileResourceConfiguration,
  ResourceConfigurationSchema,
} from '../adapters/files/resource-configuration.ts';

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-resource-config-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const initial = ResourceConfigurationSchema.parse({
    ...fixtureResources(),
    profiles: [
      ...fixtureResources().profiles,
      {
        id: 'alternate',
        name: 'Alternate Codex profile',
        policy: 'hybrid',
        coordinator: 'codex',
        worker: 'codex',
        reviewer: 'codex',
      },
    ],
  });
  const configuration = new FileResourceConfiguration(
    directory,
    initial,
    testResourceContributions(),
  );
  await configuration.init();
  return { directory, configuration };
}

test('resource default changes are serialized and replaying an old receipt never rolls back the later choice', async (t) => {
  const { directory, configuration } = await fixture(t);
  const first = await configuration.use('first', 'choose-alternate', 'alternate');
  await configuration.use('second', 'choose-codex', 'codex');
  assert.deepEqual(await configuration.use('first', 'choose-alternate', 'alternate'), first);
  assert.equal(configuration.snapshot().defaultProfile, 'codex');
  const restored = await FileResourceConfiguration.open(directory, testResourceContributions());
  assert.deepEqual(await restored.use('first', 'choose-alternate', 'alternate'), first);
  assert.equal(restored.snapshot().defaultProfile, 'codex');
  await assert.rejects(restored.use('first', 'changed-payload', 'codex'), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

test('simultaneous default changes retain both receipts and the last queued selection', async (t) => {
  const { directory, configuration } = await fixture(t);
  const results = await Promise.all([
    configuration.use('one', 'alternate', 'alternate'),
    configuration.use('two', 'codex', 'codex'),
    configuration.use('one', 'alternate', 'alternate'),
  ]);
  assert.deepEqual(
    results.map((result) => result.profileId),
    ['alternate', 'codex', 'alternate'],
  );
  const restored = await FileResourceConfiguration.open(directory, testResourceContributions());
  assert.equal(restored.snapshot().defaultProfile, 'codex');
  assert.deepEqual(Object.keys(restored.snapshot().receipts).sort(), ['one', 'two']);
});

test('unknown profiles and externally changed configuration are rejected without rewriting the file', async (t) => {
  const { configuration } = await fixture(t);
  await assert.rejects(configuration.use('missing', 'missing', 'unknown'), {
    code: 'RESOURCE_PROFILE_UNAVAILABLE',
  });
  const changed = { ...configuration.snapshot(), defaultProfile: 'alternate' };
  await fs.writeFile(configuration.filename, JSON.stringify(changed));
  await assert.rejects(configuration.use('stale', 'stale', 'codex'), {
    code: 'RESOURCE_CONFIG_CHANGED',
  });
  assert.deepEqual(JSON.parse(await fs.readFile(configuration.filename, 'utf8')), changed);
});

test('resource initialization preserves an existing private file and returned snapshots cannot mutate state', async (t) => {
  const { directory, configuration } = await fixture(t);
  const before = await fs.readFile(configuration.filename, 'utf8');
  assert.equal((await configuration.init()).created, false);
  const copy = configuration.snapshot();
  copy.defaultProfile = 'alternate';
  copy.profiles[0].coordinator = 'different';
  assert.equal(configuration.snapshot().defaultProfile, 'codex');
  assert.equal(await fs.readFile(configuration.filename, 'utf8'), before);
  assert.equal((await fs.stat(configuration.filename)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
});

test('configuration validation rejects duplicate IDs, dangling runtime references and invalid token reservations', () => {
  const original = fixtureResources();
  assert.equal(
    ResourceConfigurationSchema.safeParse({
      ...original,
      profiles: [...original.profiles, original.profiles[0]],
    }).success,
    false,
  );
  assert.equal(
    ResourceConfigurationSchema.safeParse({
      ...original,
      profiles: [{ ...original.profiles[0], worker: 'missing' }],
    }).success,
    false,
  );
  assert.throws(
    () =>
      testResourceContributions().validateConfiguration({
        ...original,
        runtimes: [
          ...original.runtimes,
          { id: 'local', backend: 'managed', config: { connectionId: 'missing', model: 'small' } },
        ],
      }),
    { code: 'RESOURCE_DEPENDENCY_UNAVAILABLE' },
  );
  assert.throws(
    () =>
      testResourceContributions().validateConfiguration({
        ...original,
        runtimes: [
          ...original.runtimes,
          {
            id: 'local',
            backend: 'managed',
            config: {
              connectionId: 'ollama',
              model: 'small',
              limits: { contextTokens: 2048, maxOutputTokens: 2048 },
            },
          },
        ],
      }),
    { code: 'INVALID_RESOURCE_CONFIGURATION' },
  );
});

test('private configuration refuses symlink storage before creating files outside its directory', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-resource-symlink-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'link'));
  await assert.rejects(
    FileResourceConfiguration.open(path.join(root, 'link', 'nested'), testResourceContributions()),
    {
      code: 'UNSAFE_CHECKPOINT',
    },
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test('managed-only configurations may use any ID including codex, without a native singleton', () => {
  const original = fixtureResources();
  const parsed = ResourceConfigurationSchema.parse({
    ...original,
    runtimes: [
      { id: 'codex', backend: 'managed', config: { connectionId: 'ollama', model: 'small' } },
    ],
  });
  assert.equal(parsed.runtimes.length, 1);
  assert.equal(parsed.runtimes[0].backend, 'managed');
  assert.equal(
    ResourceConfigurationSchema.safeParse({
      ...parsed,
      runtimes: [parsed.runtimes[0], { id: 'codex', backend: 'codex', config: {} }],
    }).success,
    false,
  );
});
