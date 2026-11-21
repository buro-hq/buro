import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FileResourceConfiguration,
  ResourceConfigurationSchema,
  resourceConfigurationRevision,
  connectionConfigurationRevision,
  defaultResources,
  ManagedLimitsSchema as LegacyManagedLimitsSchema,
  type ResourceConfiguration,
} from '../adapters/files/resource-configuration.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import {
  ManagedLimitsSchema,
  ManagedRuntimeDefinitionSchema,
  ResourceConnectionSchema,
  ResourceSetupInputSchema,
  RuntimeDefinitionSchema,
  type ResourceSetupInput,
} from '../protocol/resources.ts';
import { CommandSchema } from '../protocol/schema.ts';

const runtime = (id = 'small-worker', connectionId = 'ollama') =>
  ManagedRuntimeDefinitionSchema.parse({
    id,
    client: 'managed',
    connectionId,
    model: 'fixture-small',
  });
function setup(configuration: ResourceConfiguration, suffix = ''): ResourceSetupInput {
  const worker = runtime('small-worker' + suffix);
  return {
    expectedRevision: resourceConfigurationRevision(configuration),
    runtimes: [worker],
    profile: {
      id: 'local-team' + suffix,
      name: 'Local team',
      policy: 'local-only',
      coordinator: worker.id,
      worker: worker.id,
      reviewer: worker.id,
      workerPool: [worker.id],
    },
  };
}
async function fixture(t: any, initial = defaultResources()) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-resource-setup-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configuration = new FileResourceConfiguration(directory, initial);
  await configuration.init();
  return { directory, configuration };
}
const rejects = (action: () => unknown, code?: string) =>
  assert.rejects(async () => action(), code ? { code } : undefined);

test('shared runtime and setup contracts retain defaults and reject malformed limits, invalid references and secret fields', () => {
  assert.equal(LegacyManagedLimitsSchema, ManagedLimitsSchema);
  assert.deepEqual(runtime().limits, ManagedLimitsSchema.parse({}));
  assert.deepEqual(RuntimeDefinitionSchema.parse({ id: 'codex', client: 'codex' }), {
    id: 'codex',
    client: 'codex',
  });
  const value = setup(defaultResources());
  assert.equal(
    CommandSchema.safeParse({ method: 'resources.setup.save', params: value }).success,
    true,
  );
  for (const candidate of [
    { ...value, expectedRevision: 'stale' },
    { ...value, expectedRevision: undefined },
    {
      ...value,
      runtimes: [
        {
          ...runtime(),
          limits: { ...runtime().limits, maxOutputTokens: runtime().limits.contextTokens },
        },
      ],
    },
    { ...value, runtimes: [{ ...runtime(), apiKey: 'must-not-be-a-public-field' }] },
    { ...value, runtimes: Array(9).fill(runtime()) },
    { ...value, profile: { ...value.profile, workerPool: ['another-worker'] } },
    { ...value, defaultProfile: 'local-team' },
  ])
    assert.equal(ResourceSetupInputSchema.safeParse(candidate).success, false);
});

test('configuration revisions cover semantic settings and normalize defaults while excluding command receipts', () => {
  const original = defaultResources(),
    revision = resourceConfigurationRevision(original);
  const receiptOnly = structuredClone(original);
  receiptOnly.receipts['use-old'] = { fingerprint: 'receipt-value', profileId: 'codex' };
  assert.equal(resourceConfigurationRevision(receiptOnly), revision);
  assert.equal(
    resourceConfigurationRevision(
      ResourceConfigurationSchema.parse({
        ...original,
        connections: [
          { id: 'ollama', kind: 'ollama' },
          { id: 'deepseek', kind: 'deepseek' },
        ],
      }),
    ),
    revision,
  );
  for (const modify of [
    (value: ResourceConfiguration) => {
      value.connections[0].capacity++;
    },
    (value: ResourceConfiguration) => {
      value.runtimes.push(runtime());
    },
    (value: ResourceConfiguration) => {
      value.profiles.push({ ...value.profiles[0], id: 'another' });
    },
    (value: ResourceConfiguration) => {
      value.profiles.push({ ...value.profiles[0], id: 'another' });
      value.defaultProfile = 'another';
    },
  ]) {
    const changed = structuredClone(original);
    modify(changed);
    assert.notEqual(resourceConfigurationRevision(changed), revision);
  }
});

test('one setup atomically adds its models and authorized profile while preserving native routes, credentials references and default', async (t) => {
  const f = await fixture(t),
    original = f.configuration.snapshot(),
    input = setup(original);
  const result = await f.configuration.saveSetup('setup', 'setup-fingerprint', input);
  assert.deepEqual(result, {
    profileId: input.profile.id,
    runtimeIds: [input.runtimes[0].id],
    appliesTo: 'service-restart',
  });
  const saved = f.configuration.snapshot();
  assert.equal(saved.defaultProfile, original.defaultProfile);
  assert.deepEqual(saved.connections, original.connections);
  assert.deepEqual(saved.runtimes.slice(0, original.runtimes.length), original.runtimes);
  assert.deepEqual(saved.profiles.slice(0, original.profiles.length), original.profiles);
  assert.deepEqual(saved.profiles.at(-1), input.profile);
  assert.deepEqual(saved.runtimes.at(-1), input.runtimes[0]);
  assert.deepEqual((await FileResourceConfiguration.open(f.directory)).snapshot(), saved);
  result.runtimeIds.push('return-value-mutation');
  assert.deepEqual(f.configuration.snapshot().receipts.setup, {
    fingerprint: 'setup-fingerprint',
    setupProfileId: input.profile.id,
    runtimeIds: [input.runtimes[0].id],
  });
  assert.equal((await fs.stat(f.configuration.filename)).mode & 0o777, 0o600);
});

test('profiles may combine existing native and new managed routes or use only existing model definitions', async (t) => {
  const f = await fixture(t),
    input = setup(f.configuration.snapshot());
  input.profile.policy = 'hybrid';
  input.profile.coordinator = 'codex';
  input.profile.reviewer = 'codex';
  input.profile.workerPool = [input.profile.worker, 'codex'];
  await f.configuration.saveSetup('mixed', 'mixed', input);
  const original = f.configuration.snapshot();
  await f.configuration.saveSetup('existing', 'existing', {
    expectedRevision: resourceConfigurationRevision(original),
    runtimes: [],
    profile: {
      id: 'another-codex',
      name: 'Another native profile',
      policy: 'hybrid',
      coordinator: 'codex',
      worker: 'codex',
      reviewer: 'codex',
      workerPool: ['codex'],
    },
  });
  assert.deepEqual(f.configuration.snapshot().runtimes, original.runtimes);
  assert.equal(f.configuration.snapshot().defaultProfile, 'codex');
});

test('local-only setup respects explicit endpoint trust across all roles and worker-pool alternatives', async (t) => {
  for (const [endpoint, trust, accepted] of [
    ['http://127.0.0.1:11434', 'auto', true],
    ['http://192.168.50.10:11434', 'auto', false],
    ['http://192.168.50.10:11434', 'private-network', true],
    ['http://127.0.0.1:11434', 'external', false],
  ] as const) {
    const initial = defaultResources();
    initial.connections[0] = ResourceConnectionSchema.parse({
      id: 'ollama',
      kind: 'ollama',
      endpoint,
      trust,
    });
    const f = await fixture(t, initial),
      input = setup(f.configuration.snapshot());
    if (accepted) await f.configuration.saveSetup('trusted', 'trusted', input);
    else {
      await rejects(
        () => f.configuration.saveSetup('untrusted', 'untrusted', input),
        'DATA_POLICY_BLOCKED',
      );
      assert.deepEqual(f.configuration.snapshot(), initial);
    }
  }
  for (const slot of ['coordinator', 'reviewer', 'workerPool', 'deepseek'] as const) {
    const f = await fixture(t),
      before = f.configuration.snapshot(),
      input = setup(before);
    if (slot === 'workerPool') input.profile.workerPool!.push('codex');
    else if (slot === 'deepseek' && input.runtimes[0].client === 'managed')
      input.runtimes[0].connectionId = 'deepseek';
    else input.profile[slot] = 'codex';
    await rejects(
      () => f.configuration.saveSetup('blocked', 'blocked', input),
      'DATA_POLICY_BLOCKED',
    );
    assert.deepEqual(f.configuration.snapshot(), before);
  }
});

test('new setup rejects known cloud-backed Ollama IDs without retroactively invalidating legacy profiles at startup', async (t) => {
  const legacy = defaultResources();
  legacy.profiles.push({
    id: 'old-local',
    name: 'Legacy incompatible profile',
    policy: 'local-only',
    coordinator: 'codex',
    worker: 'codex',
    reviewer: 'codex',
  });
  const f = await fixture(t, legacy),
    original = f.configuration.snapshot();
  for (const policy of ['hybrid', 'local-only'] as const) {
    const input = setup(original);
    input.profile.policy = policy;
    if (input.runtimes[0].client === 'managed') input.runtimes[0].model = 'fixture:cloud';
    await rejects(
      () => f.configuration.saveSetup('cloud-' + policy, 'cloud-' + policy, input),
      'MODEL_REMOTE_ROUTE',
    );
    assert.deepEqual(f.configuration.snapshot(), original);
  }
  await f.configuration.saveSetup('valid', 'valid', setup(original));
  const reopened = (await FileResourceConfiguration.open(f.directory)).snapshot();
  assert.deepEqual(
    reopened.profiles.find((profile) => profile.id === 'old-local'),
    legacy.profiles[1],
  );
});

test('setup never overwrites IDs or leaves a partial runtime behind for invalid references and limits', async (t) => {
  const f = await fixture(t),
    before = f.configuration.snapshot();
  for (const modify of [
    (input: ResourceSetupInput) => {
      input.profile.id = 'codex';
    },
    (input: ResourceSetupInput) => {
      input.runtimes.push(structuredClone(input.runtimes[0]));
    },
    (input: ResourceSetupInput) => {
      if (input.runtimes[0].client === 'managed') input.runtimes[0].connectionId = 'missing';
    },
    (input: ResourceSetupInput) => {
      input.profile.reviewer = 'missing';
    },
  ]) {
    const input = setup(before);
    modify(input);
    await rejects(() => f.configuration.saveSetup('invalid', 'invalid', input));
    assert.deepEqual(f.configuration.snapshot(), before);
  }
  const manyRuntimes = defaultResources();
  for (let i = 0; i < 31; i++) manyRuntimes.runtimes.push(runtime('existing-' + i));
  const r = await fixture(t, manyRuntimes);
  await rejects(
    () => r.configuration.saveSetup('limit', 'limit', setup(manyRuntimes)),
    'RESOURCE_SETUP_LIMIT',
  );
  assert.deepEqual(r.configuration.snapshot(), manyRuntimes);
  const manyProfiles = defaultResources();
  for (let i = 0; i < 31; i++)
    manyProfiles.profiles.push({ ...manyProfiles.profiles[0], id: 'existing-' + i });
  const p = await fixture(t, manyProfiles);
  await rejects(
    () => p.configuration.saveSetup('limit', 'limit', setup(manyProfiles)),
    'RESOURCE_SETUP_LIMIT',
  );
  assert.deepEqual(p.configuration.snapshot(), manyProfiles);
});

test('optimistic setup revisions serialize writers and conflict after connection or default changes', async (t) => {
  const f = await fixture(t),
    initial = f.configuration.snapshot();
  const results = await Promise.allSettled([
    f.configuration.saveSetup('first', 'first', setup(initial)),
    f.configuration.saveSetup('second', 'second', setup(initial, '-second')),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  if (results[1].status === 'rejected')
    assert.equal(results[1].reason.code, 'RESOURCE_SETUP_CONFLICT');
  const beforeDefault = setup(f.configuration.snapshot(), '-default');
  await f.configuration.use('select', 'select', 'local-team');
  await rejects(
    () => f.configuration.saveSetup('stale-default', 'stale-default', beforeDefault),
    'RESOURCE_SETUP_CONFLICT',
  );
  const beforeConnection = setup(f.configuration.snapshot(), '-connection');
  const connection = f.configuration.snapshot().connections[0];
  await f.configuration.save(
    'edit',
    'edit',
    { ...connection, capacity: 2 },
    connectionConfigurationRevision(connection),
  );
  await rejects(
    () => f.configuration.saveSetup('stale-connection', 'stale-connection', beforeConnection),
    'RESOURCE_SETUP_CONFLICT',
  );
  assert.deepEqual(
    f.configuration.snapshot().profiles.map((profile) => profile.id),
    ['codex', 'local-team'],
  );
});

test('setup receipts survive restart without rolling back newer settings or colliding with other resource commands', async (t) => {
  const f = await fixture(t),
    original = f.configuration.snapshot(),
    input = setup(original);
  await f.configuration.use('use', 'use-fingerprint', 'codex');
  const result = await f.configuration.saveSetup('setup', 'setup-fingerprint', input);
  const old = f.configuration.snapshot().connections[0];
  await f.configuration.save(
    'connection',
    'connection-fingerprint',
    { ...old, capacity: 2 },
    connectionConfigurationRevision(old),
  );
  await f.configuration.use('new-default', 'new-default', input.profile.id);
  const latest = f.configuration.snapshot(),
    reopened = await FileResourceConfiguration.open(f.directory);
  assert.deepEqual(await reopened.saveSetup('setup', 'setup-fingerprint', input), result);
  assert.deepEqual(reopened.snapshot(), latest);
  for (const [id, fingerprint] of [
    ['use', 'use-fingerprint'],
    ['connection', 'connection-fingerprint'],
  ])
    await rejects(() => reopened.saveSetup(id, fingerprint, input), 'IDEMPOTENCY_CONFLICT');
  await rejects(() => reopened.use('setup', 'setup-fingerprint', 'codex'), 'IDEMPOTENCY_CONFLICT');
  await rejects(
    () => reopened.save('setup', 'setup-fingerprint', old, connectionConfigurationRevision(old)),
    'IDEMPOTENCY_CONFLICT',
  );
  await rejects(
    () => reopened.saveSetup('setup', 'different-fingerprint', input),
    'IDEMPOTENCY_CONFLICT',
  );
  assert.deepEqual(reopened.snapshot(), latest);
});

test('failed setup persistence changes neither definitions nor receipt and an explicit retry succeeds', async (t) => {
  const f = await fixture(t),
    before = f.configuration.snapshot(),
    input = setup(before),
    bytes = await fs.readFile(f.configuration.filename, 'utf8');
  const mock = t.mock.method(PrivateJSONFiles.prototype, 'save', async () => {
    throw Error('setup disk unavailable');
  });
  await assert.rejects(
    f.configuration.saveSetup('setup', 'setup', input),
    /setup disk unavailable/,
  );
  assert.deepEqual(f.configuration.snapshot(), before);
  assert.equal(await fs.readFile(f.configuration.filename, 'utf8'), bytes);
  mock.mock.restore();
  await f.configuration.saveSetup('setup', 'setup', input);
  assert.equal(
    (await FileResourceConfiguration.open(f.directory)).snapshot().profiles.at(-1)!.id,
    input.profile.id,
  );
});

test('externally edited, malformed or deleted configuration cannot be overwritten by setup', async (t) => {
  for (const mutation of ['valid-edit', 'malformed', 'deleted'] as const) {
    const f = await fixture(t),
      before = f.configuration.snapshot(),
      input = setup(before);
    const changed = structuredClone(before);
    changed.connections[0].capacity = 3;
    if (mutation === 'valid-edit')
      await fs.writeFile(f.configuration.filename, JSON.stringify(changed));
    else if (mutation === 'malformed')
      await fs.writeFile(f.configuration.filename, '{"version":2}');
    else await fs.rm(f.configuration.filename);
    await rejects(
      () => f.configuration.saveSetup('setup', 'setup', input),
      'RESOURCE_CONFIG_CHANGED',
    );
    assert.deepEqual(f.configuration.snapshot(), before);
    if (mutation === 'deleted')
      await assert.rejects(fs.stat(f.configuration.filename), { code: 'ENOENT' });
    else if (mutation === 'valid-edit')
      assert.deepEqual(JSON.parse(await fs.readFile(f.configuration.filename, 'utf8')), changed);
    else assert.equal(await fs.readFile(f.configuration.filename, 'utf8'), '{"version":2}');
  }
});
