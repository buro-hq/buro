import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FileResourceConfiguration,
  ResourceConfigurationSchema,
  defaultResources,
} from '../adapters/files/resource-configuration.ts';

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-resource-config-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const initial = ResourceConfigurationSchema.parse({
    ...defaultResources(),
    profiles: [
      ...defaultResources().profiles,
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
  const configuration = new FileResourceConfiguration(directory, initial);
  await configuration.init();
  return { directory, configuration };
}

test('resource default changes are serialized and replaying an old receipt never rolls back the later choice', async (t) => {
  const { directory, configuration } = await fixture(t);
  const first = await configuration.use('first', 'choose-alternate', 'alternate');
  await configuration.use('second', 'choose-codex', 'codex');
  assert.deepEqual(await configuration.use('first', 'choose-alternate', 'alternate'), first);
  assert.equal(configuration.snapshot().defaultProfile, 'codex');
  const restored = await FileResourceConfiguration.open(directory);
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
  const restored = await FileResourceConfiguration.open(directory);
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
  const original = defaultResources();
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
  assert.equal(
    ResourceConfigurationSchema.safeParse({
      ...original,
      runtimes: [{ id: 'local', client: 'managed', connectionId: 'missing', model: 'small' }],
    }).success,
    false,
  );
  assert.equal(
    ResourceConfigurationSchema.safeParse({
      ...original,
      runtimes: [{ id: 'codex', client: 'managed', connectionId: 'ollama', model: 'small' }],
    }).success,
    false,
  );
  assert.equal(
    ResourceConfigurationSchema.safeParse({
      ...original,
      runtimes: [
        ...original.runtimes,
        {
          id: 'local',
          client: 'managed',
          connectionId: 'ollama',
          model: 'small',
          limits: { contextTokens: 2048, maxOutputTokens: 2048 },
        },
      ],
    }).success,
    false,
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
  await assert.rejects(FileResourceConfiguration.open(path.join(root, 'link', 'nested')), {
    code: 'UNSAFE_CHECKPOINT',
  });
  assert.deepEqual(await fs.readdir(outside), []);
});
