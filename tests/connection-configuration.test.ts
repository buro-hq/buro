import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FileResourceConfiguration,
  ResourceConfigurationSchema,
  connectionConfigurationRevision,
  defaultResources,
} from '../adapters/files/resource-configuration.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import { ResourceConnectionSchema } from '../protocol/resources.ts';
import { CommandSchema } from '../protocol/schema.ts';

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-connections-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configuration = new FileResourceConfiguration(directory, defaultResources());
  await configuration.init();
  return { directory, configuration };
}
const rtx = () =>
  ResourceConnectionSchema.parse({
    id: 'rtx',
    kind: 'ollama',
    endpoint: 'http://192.168.50.10:11434',
    trust: 'private-network',
  });

test('connection contract accepts API endpoints and rejects credentials, query, fragment and plaintext secrets', () => {
  for (const endpoint of [
    'http://192.168.50.10:11434',
    'https://models.example.org/ollama/v1/',
    'http://[fd12::1]:11434',
  ])
    assert.equal(
      ResourceConnectionSchema.safeParse({ id: 'model', kind: 'ollama', endpoint }).success,
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
      ResourceConnectionSchema.safeParse({ id: 'model', kind: 'ollama', endpoint }).success,
      false,
      endpoint,
    );
  assert.equal(
    ResourceConnectionSchema.safeParse({ id: 'ds', kind: 'deepseek', apiKey: 'secret' }).success,
    false,
  );
  assert.equal(
    ResourceConnectionSchema.safeParse({ id: 'ds', kind: 'deepseek', apiKeyEnv: 'secret value' })
      .success,
    false,
  );
  assert.equal(
    ResourceConnectionSchema.safeParse({ id: 'ds', kind: 'deepseek', trust: 'private-network' })
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
    const candidate = { id: 'ds-test', kind: 'deepseek', endpoint };
    assert.equal(ResourceConnectionSchema.safeParse(candidate).success, false);
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
      ResourceConnectionSchema.safeParse({ id: 'ds-test', kind: 'deepseek', endpoint }).success,
      true,
    );
  assert.equal(
    f.configuration.snapshot().connections.some((connection) => connection.id === 'ds-test'),
    false,
  );
});

test('private network trust requires literal private addresses while existing defaults remain compatible', () => {
  for (const endpoint of [
    'http://10.0.0.1:11434',
    'http://172.16.1.2',
    'http://192.168.50.10',
    'http://127.0.0.1',
    'http://[::1]',
    'http://[fd12::1]',
  ])
    assert.equal(
      ResourceConnectionSchema.safeParse({ ...rtx(), endpoint }).success,
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
      ResourceConnectionSchema.safeParse({ ...rtx(), endpoint }).success,
      false,
      endpoint,
    );
  const legacy = ResourceConfigurationSchema.parse({
    ...defaultResources(),
    connections: [
      { id: 'ollama', kind: 'ollama' },
      { id: 'deepseek', kind: 'deepseek' },
    ],
    receipts: { old: { fingerprint: 'legacy', profileId: 'codex' } },
  });
  assert.equal(legacy.connections[0].kind === 'ollama' && legacy.connections[0].trust, 'auto');
  assert.equal(
    legacy.connections[1].kind === 'deepseek' && legacy.connections[1].apiKeyEnv,
    'DEEPSEEK_API_KEY',
  );
  assert.deepEqual(legacy.receipts.old, { fingerprint: 'legacy', profileId: 'codex' });
});

test('save command requires a validated endpoint and an explicit nullable revision', () => {
  const command = {
    method: 'resources.connection.save',
    params: { connection: rtx(), expectedRevision: null },
  };
  assert.equal(CommandSchema.safeParse(command).success, true);
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
  const edited = { ...rtx(), endpoint: 'http://192.168.0.228:11434' };
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
  const restored = await FileResourceConfiguration.open(directory);
  assert.equal(
    restored.snapshot().connections.find((item) => item.id === 'rtx')?.endpoint,
    edited.endpoint,
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
  const edited = { ...rtx(), capacity: 2 };
  await configuration.save(
    'edit',
    'edit-fingerprint',
    edited,
    connectionConfigurationRevision(rtx()),
  );
  const restored = await FileResourceConfiguration.open(directory);
  assert.deepEqual(await restored.save('add', 'add-fingerprint', rtx(), null), result);
  assert.equal(restored.snapshot().connections.find((item) => item.id === 'rtx')?.capacity, 2);
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
    configuration.save('second', 'second', { ...rtx(), capacity: 2 }, null),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  if (second.status === 'rejected')
    assert.equal(second.reason.code, 'RESOURCE_CONNECTION_CONFLICT');
  assert.deepEqual(Object.keys(configuration.snapshot().receipts), ['first']);
});

test('changing the provider kind is rejected for connections referenced by runtimes', async (t) => {
  const { directory } = await fixture(t);
  const initial = defaultResources();
  initial.runtimes.push({
    id: 'local',
    client: 'managed',
    connectionId: 'ollama',
    model: 'qwen',
    limits: {
      contextTokens: 32768,
      maxOutputTokens: 4096,
      maxRequestsPerTurn: 24,
      maxToolCallsPerTurn: 64,
      maxSessionRequests: 256,
    },
  });
  await fs.writeFile(path.join(directory, 'resources.json'), JSON.stringify(initial));
  const configuration = await FileResourceConfiguration.open(directory);
  await assert.rejects(
    configuration.save(
      'switch',
      'switch',
      ResourceConnectionSchema.parse({ id: 'ollama', kind: 'deepseek' }),
      connectionConfigurationRevision(initial.connections[0]),
    ),
    { code: 'RESOURCE_CONNECTION_IN_USE' },
  );
  assert.deepEqual(configuration.snapshot(), initial);
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
  assert.equal((await FileResourceConfiguration.open(directory)).snapshot().connections.length, 3);
});

test('external edits and deleted configuration are never overwritten by connection saves', async (t) => {
  const { configuration } = await fixture(t);
  const changed = configuration.snapshot();
  changed.connections[0].capacity = 3;
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
