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
  connectionConfigurationRevision,
} from '../adapters/files/resource-configuration.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import { ResourceConnectionSchema } from '../protocol/resources.ts';
function semanticConnection(input: unknown) {
  try {
    return { success: true, data: testResourceContributions().parseConnection(input) };
  } catch {
    return { success: false };
  }
}
import { CommandSchema } from '../protocol/schema.ts';

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-connections-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configuration = new FileResourceConfiguration(
    directory,
    fixtureResources(),
    testResourceContributions(),
  );
  await configuration.init();
  return { directory, configuration };
}
const rtx = () =>
  testResourceContributions().parseConnection({
    id: 'rtx',
    provider: 'ollama',
    config: { endpoint: 'http://192.168.50.10:11434', trust: 'private-network' },
  });

test('connection contract accepts API endpoints and rejects credentials, query, fragment and plaintext secrets', () => {
  for (const endpoint of [
    'http://192.168.50.10:11434',
    'https://models.example.org/ollama/v1/',
    'http://[fd12::1]:11434',
  ])
    assert.equal(
      semanticConnection({ id: 'model', provider: 'ollama', config: { endpoint } }).success,
      true,
    );
  for (const endpoint of [
    'file:///tmp/model',
    'ftp://example.org',
    'https://user:password@example.org',
    'https://example.org?key=x',
    'https://example.org#token',
  ])
    assert.equal(
      semanticConnection({ id: 'model', provider: 'ollama', config: { endpoint } }).success,
      false,
      endpoint,
    );
  assert.equal(
    semanticConnection({ id: 'ds', provider: 'deepseek', config: { apiKey: 'secret' } }).success,
    false,
  );
  assert.equal(
    semanticConnection({ id: 'ds', provider: 'deepseek', config: { apiKeyEnv: 'secret value' } })
      .success,
    false,
  );
  assert.equal(
    semanticConnection({ id: 'ds', provider: 'deepseek', config: { trust: 'private-network' } })
      .success,
    false,
  );
});

test('DeepSeek URL validation matches its transport before a connection can block daemon startup', async (t) => {
  const f = await fixture(t);
  for (const endpoint of [
    'http://192.168.50.10:11434',
    'http://api.example.org',
    'http://127.0.0.2:8000',
  ]) {
    const candidate = { id: 'ds-test', provider: 'deepseek', config: { endpoint } };
    assert.equal(semanticConnection(candidate).success, false);
    assert.throws(() =>
      f.configuration.save('bad-' + endpoint, 'bad-' + endpoint, candidate as any, null),
    );
  }
  for (const endpoint of [
    'https://api.example.org/v1',
    'http://127.0.0.1:8000',
    'http://localhost:8000',
    'http://[::1]:8000',
  ])
    assert.equal(
      semanticConnection({ id: 'ds-test', provider: 'deepseek', config: { endpoint } }).success,
      true,
    );
  assert.equal(
    f.configuration.snapshot().connections.some((connection) => connection.id === 'ds-test'),
    false,
  );
});

test('private network trust requires literal private addresses and installed providers apply semantic defaults', () => {
  for (const endpoint of [
    'http://10.0.0.1:11434',
    'http://172.16.1.2',
    'http://192.168.50.10',
    'http://127.0.0.1',
    'http://[::1]',
    'http://[fd12::1]',
  ])
    assert.equal(
      semanticConnection({ ...rtx(), config: { ...rtx().config, endpoint } }).success,
      true,
      endpoint,
    );
  for (const endpoint of [
    'https://example.org',
    'http://models.lan',
    'http://8.8.8.8',
    'http://172.32.0.1',
    'http://[2001:4860:4860::8888]',
  ])
    assert.equal(
      semanticConnection({ ...rtx(), config: { ...rtx().config, endpoint } }).success,
      false,
      endpoint,
    );
  const normalized = testResourceContributions().validateConfiguration(
    ResourceConfigurationSchema.parse({
      ...fixtureResources(),
      connections: [
        { id: 'ollama', provider: 'ollama', config: {} },
        { id: 'deepseek', provider: 'deepseek', config: {} },
      ],
      receipts: { retained: { fingerprint: 'receipt', profileId: 'codex' } },
    }),
  );
  assert.equal(normalized.connections[0].config.trust, 'auto');
  assert.equal(normalized.connections[1].config.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.deepEqual(normalized.receipts.retained, { fingerprint: 'receipt', profileId: 'codex' });
});

test('save command requires an open JSON envelope and an explicit nullable revision', () => {
  const command = {
    method: 'resources.connection.save',
    params: { connection: rtx(), expectedRevision: null },
  };
  assert.equal(CommandSchema.safeParse(command).success, true);
  const extension = {
    id: 'custom',
    provider: 'thirdparty',
    config: { arbitrary: { nested: [1, true, null] } },
  };
  assert.equal(ResourceConnectionSchema.safeParse(extension).success, true);
  assert.equal(
    CommandSchema.safeParse({
      ...command,
      params: { connection: extension, expectedRevision: null },
    }).success,
    true,
  );
  assert.throws(() => testResourceContributions().parseConnection(extension), {
    code: 'RESOURCE_PROVIDER_UNAVAILABLE',
  });
  assert.equal(
    CommandSchema.safeParse({ ...command, params: { connection: rtx() } }).success,
    false,
  );
  assert.equal(
    CommandSchema.safeParse({
      ...command,
      params: { connection: rtx(), expectedRevision: 'stale' },
    }).success,
    false,
  );
});

test('connections are added and edited with per-connection optimistic revisions without creating runtimes', async (t) => {
  const { directory, configuration } = await fixture(t);
  const original = configuration.snapshot();
  assert.deepEqual(await configuration.save('add', 'add-rtx', rtx(), null), {
    connectionId: 'rtx',
    appliesTo: 'service-restart',
  });
  const revision = connectionConfigurationRevision(rtx());
  const edited = { ...rtx(), config: { ...rtx().config, endpoint: 'http://192.168.0.228:11434' } };
  await assert.rejects(configuration.save('duplicate', 'duplicate', edited, null), {
    code: 'RESOURCE_CONNECTION_CONFLICT',
  });
  await assert.rejects(
    configuration.save('missing', 'missing', { ...rtx(), id: 'missing' }, revision),
    { code: 'RESOURCE_CONNECTION_CONFLICT' },
  );
  await configuration.save('edit', 'edit-rtx', edited, revision);
  await assert.rejects(configuration.save('stale', 'stale', rtx(), revision), {
    code: 'RESOURCE_CONNECTION_CONFLICT',
  });
  const restored = await FileResourceConfiguration.open(directory, testResourceContributions());
  assert.equal(
    restored.snapshot().connections.find((item) => item.id === 'rtx')?.config.endpoint,
    edited.config.endpoint,
  );
  assert.deepEqual(restored.snapshot().runtimes, original.runtimes);
  assert.deepEqual(restored.snapshot().profiles, original.profiles);
  assert.equal(restored.snapshot().defaultProfile, original.defaultProfile);
  assert.equal((await fs.stat(configuration.filename)).mode & 0o777, 0o600);
});

test('connection receipts survive restart and replay never rolls back newer settings or collides with profile receipts', async (t) => {
  const { directory, configuration } = await fixture(t);
  await configuration.use('profile', 'profile-fingerprint', 'codex');
  const result = await configuration.save('add', 'add-fingerprint', rtx(), null);
  const edited = { ...rtx(), config: { ...rtx().config, capacity: 2 } };
  await configuration.save(
    'edit',
    'edit-fingerprint',
    edited,
    connectionConfigurationRevision(rtx()),
  );
  const restored = await FileResourceConfiguration.open(directory, testResourceContributions());
  assert.deepEqual(await restored.save('add', 'add-fingerprint', rtx(), null), result);
  assert.equal(
    restored.snapshot().connections.find((item) => item.id === 'rtx')?.config.capacity,
    2,
  );
  await assert.rejects(restored.save('add', 'another-fingerprint', rtx(), null), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await assert.rejects(restored.use('add', 'add-fingerprint', 'codex'), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await assert.rejects(restored.save('profile', 'profile-fingerprint', rtx(), null), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  assert.deepEqual(await restored.use('profile', 'profile-fingerprint', 'codex'), {
    profileId: 'codex',
    appliesTo: 'new-runs',
  });
});

test('queued edits serialize and only one writer can use the same revision', async (t) => {
  const { configuration } = await fixture(t);
  const [first, second] = await Promise.allSettled([
    configuration.save('first', 'first', rtx(), null),
    configuration.save(
      'second',
      'second',
      { ...rtx(), config: { ...rtx().config, capacity: 2 } },
      null,
    ),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  if (second.status === 'rejected')
    assert.equal(second.reason.code, 'RESOURCE_CONNECTION_CONFLICT');
  assert.deepEqual(Object.keys(configuration.snapshot().receipts), ['first']);
});

test('changing the provider kind is rejected for connections referenced by runtimes', async (t) => {
  const { directory } = await fixture(t);
  const initial = fixtureResources();
  initial.runtimes.push({
    id: 'local',
    backend: 'managed',
    config: {
      connectionId: 'ollama',
      model: 'qwen',
      limits: {
        contextTokens: 32768,
        maxOutputTokens: 4096,
        maxRequestsPerTurn: 24,
        maxToolCallsPerTurn: 64,
        maxSessionRequests: 256,
      },
    },
  });
  await fs.writeFile(path.join(directory, 'resources.json'), JSON.stringify(initial));
  const configuration = await FileResourceConfiguration.open(
    directory,
    testResourceContributions(),
  );
  const before = configuration.snapshot();
  await assert.rejects(
    configuration.save(
      'switch',
      'switch',
      testResourceContributions().parseConnection({
        id: 'ollama',
        provider: 'deepseek',
        config: {},
      }),
      connectionConfigurationRevision(before.connections[0]),
    ),
    { code: 'RESOURCE_CONNECTION_IN_USE' },
  );
  assert.deepEqual(configuration.snapshot(), before);
});

test('failed persistence leaves settings and receipts unchanged and a retry can succeed', async (t) => {
  const { directory, configuration } = await fixture(t);
  const original = configuration.snapshot();
  const bytes = await fs.readFile(configuration.filename, 'utf8');
  const save = t.mock.method(PrivateJSONFiles.prototype, 'save', async () => {
    throw Error('disk unavailable');
  });
  await assert.rejects(configuration.save('save', 'save', rtx(), null), /disk unavailable/);
  assert.deepEqual(configuration.snapshot(), original);
  assert.equal(await fs.readFile(configuration.filename, 'utf8'), bytes);
  save.mock.restore();
  await configuration.save('save', 'save', rtx(), null);
  assert.equal(
    (await FileResourceConfiguration.open(directory, testResourceContributions())).snapshot()
      .connections.length,
    3,
  );
});

test('external edits and deleted configuration are never overwritten by connection saves', async (t) => {
  const { configuration } = await fixture(t);
  const changed = configuration.snapshot();
  changed.connections[0].config.capacity = 3;
  await fs.writeFile(configuration.filename, JSON.stringify(changed));
  await assert.rejects(configuration.save('edit', 'edit', rtx(), null), {
    code: 'RESOURCE_CONFIG_CHANGED',
  });
  assert.deepEqual(JSON.parse(await fs.readFile(configuration.filename, 'utf8')), changed);
  await fs.rm(configuration.filename);
  await assert.rejects(configuration.save('delete', 'delete', rtx(), null), {
    code: 'RESOURCE_CONFIG_CHANGED',
  });
  await assert.rejects(fs.stat(configuration.filename), { code: 'ENOENT' });
});
