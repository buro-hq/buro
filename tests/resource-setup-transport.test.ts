import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket as RawSocket } from 'ws';
import { createHost } from '../plugins/host.ts';
import { resourcesPlugin } from '../plugins/resources.ts';
import { websocketPlugin } from '../daemon/websocket.ts';
import { SocketProjectClient } from '../clients/socket-client.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import {
  ResourceConfigurationSchema,
  defaultResources,
} from '../adapters/files/resource-configuration.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import { DEFAULT_MANAGED_RUN_BUDGET_POLICY } from '../protocol/run-budget.ts';
import { ResourceSetupInputSchema, type ResourceCatalog } from '../protocol/resources.ts';
import type { ClientCommand } from '../protocol/schema.ts';

const SECRET = 'fixture-private-model-credential-not-for-transport';
const initialResources = () =>
  ResourceConfigurationSchema.parse({
    ...defaultResources(),
    runtimes: [
      ...defaultResources().runtimes,
      {
        id: 'existing-worker',
        client: 'managed',
        connectionId: 'ollama',
        model: 'fixture-existing',
      },
    ],
    profiles: [
      ...defaultResources().profiles,
      {
        id: 'existing-local',
        name: 'Existing local team',
        policy: 'local-only',
        coordinator: 'existing-worker',
        worker: 'existing-worker',
        reviewer: 'existing-worker',
        workerPool: ['existing-worker'],
      },
    ],
  });

async function server(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-resource-setup-transport-')),
  );
  const projectDirectory = path.join(directory, 'project-state');
  const root = path.join(directory, 'repository');
  await fs.mkdir(root);
  const project = { id: 'p', name: 'Resource setup transport fixture', root, managed: true };
  const profile = ProjectProfileSchema.parse({
    version: 1,
    revision: 7,
    resourceProfile: 'existing-local',
    managedBudget: {
      ...DEFAULT_MANAGED_RUN_BUDGET_POLICY,
      maxRequests: 31,
      reviewReserve: { ...DEFAULT_MANAGED_RUN_BUDGET_POLICY.reviewReserve, requests: 4 },
    },
    context: 'Preserve project settings through machine resource setup.',
    allowedPaths: ['src/'],
    protectedPaths: ['checks/'],
    checks: [],
    defaultCheckIds: [],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    maxRepairs: 0,
    turnTimeoutMs: 10000,
  });
  const seed = await FileProjectStore.open({ directory: projectDirectory, project, profile });
  await seed.close();
  const original = initialResources();
  const privateFiles = new PrivateJSONFiles(path.join(directory, 'local'));
  await privateFiles.save('resources', original);
  const filename = path.join(directory, 'local/resources.json');
  const host = await createHost({ projects: [{ directory: projectDirectory, project }] });
  const http: string[] = [];
  const clients: SocketProjectClient[] = [];
  const raws: RawSocket[] = [];
  t.after(async () => {
    clients.forEach((client) => client.close());
    raws.forEach((socket) => socket.terminate());
    await host.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await host.ctx.plugin(resourcesPlugin, {
    directory,
    executors: new EnvironmentExecutors(),
    fetch: async (input) => {
      http.push(String(input));
      throw Error('Settings must not contact any model');
    },
    credentials: (reference) => (reference === 'DEEPSEEK_API_KEY' ? SECRET : undefined),
  });
  let port = 0;
  await host.ctx.plugin(websocketPlugin, {
    port: 0,
    onListen: (value) => {
      port = value;
    },
  });
  const url = 'ws://127.0.0.1:' + port;
  const client = async () => {
    const value = new SocketProjectClient(url, 'p');
    clients.push(value);
    await value.connect();
    return value;
  };
  const raw = async () => {
    const socket = new RawSocket(url);
    raws.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return socket;
  };
  return { directory, filename, original, profile, host, http, client, raw };
}
const catalog = (client: SocketProjectClient, project = true) =>
  client.command<ResourceCatalog>({
    method: 'resources.list',
    params: project ? { projectId: 'p' } : {},
  });
function setup(revision: string, suffix = 'new') {
  const runtimeId = suffix + '-worker';
  return ResourceSetupInputSchema.parse({
    expectedRevision: revision,
    runtimes: [
      { id: runtimeId, client: 'managed', connectionId: 'ollama', model: 'fixture-' + suffix },
    ],
    profile: {
      id: suffix + '-team',
      name: suffix + ' local team',
      policy: 'local-only',
      coordinator: runtimeId,
      worker: runtimeId,
      reviewer: runtimeId,
      workerPool: [runtimeId],
    },
  });
}
async function send(socket: RawSocket, id: string, command: ClientCommand): Promise<any> {
  const response = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(Error('Resource transport response timeout'));
    }, 5000);
    const onMessage = (bytes: any) => {
      const message = JSON.parse(bytes.toString());
      if (message.type === 'response' && message.id === id) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(message);
      }
    };
    socket.on('message', onMessage);
  });
  socket.send(JSON.stringify({ version: 1, type: 'request', id, command }));
  return response;
}

test('two real clients receive the setup capability and identical active/configured resource metadata without exposing credentials or starting inference', async (t) => {
  const s = await server(t),
    a = await s.client(),
    b = await s.client();
  assert.ok(a.snapshot().capabilities.includes('resources.setup.save'));
  assert.ok(b.snapshot().capabilities.includes('resources.setup.save'));
  const [first, second] = await Promise.all([catalog(a), catalog(b)]);
  assert.deepEqual(first, second);
  assert.match(first.configurationRevision!, /^[a-f0-9]{64}$/);
  assert.equal(first.defaultProfile, 'codex');
  assert.equal(first.selected?.profileId, 'existing-local');
  assert.equal(
    first.configured?.runtimes.find((item) => item.definition.id === 'codex')?.restartRequired,
    false,
  );
  assert.equal(
    first.configured?.profiles.find((item) => item.profile.id === 'existing-local')
      ?.restartRequired,
    false,
  );
  assert.equal(
    first.connections.find((connection) => connection.id === 'deepseek')?.credentialConfigured,
    true,
  );
  assert.equal(
    first.connections.find(
      (connection) => connection.id === 'deepseek' && connection.kind === 'deepseek',
    )?.apiKeyEnv,
    'DEEPSEEK_API_KEY',
  );
  assert.ok(!JSON.stringify([first, second, a.snapshot(), b.snapshot()]).includes(SECRET));
  assert.deepEqual(s.http, []);
});

test('concurrent clients saving against the same full revision produce one atomic setup and one stale conflict', async (t) => {
  const s = await server(t),
    a = await s.client(),
    b = await s.client();
  const revision = (await catalog(a)).configurationRevision!;
  const proposals = [setup(revision, 'alpha'), setup(revision, 'beta')];
  const results = await Promise.allSettled([
    a.command({ method: 'resources.setup.save', params: proposals[0] }),
    b.command({ method: 'resources.setup.save', params: proposals[1] }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'RESOURCE_SETUP_CONFLICT');
  const winner = results.findIndex((item) => item.status === 'fulfilled');
  const loser = 1 - winner;
  const persisted = ResourceConfigurationSchema.parse(
    JSON.parse(await fs.readFile(s.filename, 'utf8')),
  );
  assert.equal(persisted.runtimes.length, s.original.runtimes.length + 1);
  assert.equal(persisted.profiles.length, s.original.profiles.length + 1);
  assert.ok(persisted.runtimes.some((item) => item.id === proposals[winner].runtimes[0].id));
  assert.ok(persisted.profiles.some((item) => item.id === proposals[winner].profile.id));
  assert.ok(!persisted.runtimes.some((item) => item.id === proposals[loser].runtimes[0].id));
  assert.ok(!persisted.profiles.some((item) => item.id === proposals[loser].profile.id));
  const [one, two] = await Promise.all([catalog(a), catalog(b)]);
  assert.deepEqual(one, two);
  assert.notEqual(one.configurationRevision, revision);
  assert.deepEqual(s.http, []);
});

test('saved models and profiles remain pending over the socket and cannot select or probe an inactive runtime', async (t) => {
  const s = await server(t),
    a = await s.client(),
    b = await s.client();
  const before = await catalog(a),
    input = setup(before.configurationRevision!);
  const result = await a.command({ method: 'resources.setup.save', params: input });
  assert.deepEqual(result, {
    profileId: 'new-team',
    runtimeIds: ['new-worker'],
    appliesTo: 'service-restart',
  });
  const after = await catalog(b);
  assert.equal(
    after.configured?.runtimes.find((item) => item.definition.id === 'new-worker')?.restartRequired,
    true,
  );
  assert.equal(
    after.configured?.profiles.find((item) => item.profile.id === 'new-team')?.restartRequired,
    true,
  );
  assert.ok(!after.runtimes.some((item) => item.id === 'new-worker'));
  assert.ok(!after.profiles.some((item) => item.id === 'new-team'));
  assert.deepEqual(after.runtimes, before.runtimes);
  assert.deepEqual(after.selected, before.selected);
  await assert.rejects(b.command({ method: 'resources.use', params: { profileId: 'new-team' } }), {
    code: 'RESOURCE_PROFILE_RESTART_REQUIRED',
  });
  await assert.rejects(
    b.command({ method: 'resources.probe', params: { runtimeId: 'new-worker' } }),
    { code: 'RESOURCE_RUNTIME_RESTART_REQUIRED' },
  );
  assert.equal((await catalog(a)).defaultProfile, 'codex');
  assert.deepEqual(s.http, []);
});

test('retrying the same setup command ID on another connection reuses its receipt without reverting a newer setup', async (t) => {
  const s = await server(t),
    client = await s.client(),
    first = await s.raw();
  const input = setup((await catalog(client)).configurationRevision!, 'once');
  const command = { method: 'resources.setup.save' as const, params: input };
  const accepted = await send(first, 'durable-setup', command);
  assert.equal(accepted.ok, true);
  first.close();
  const revision = (await catalog(client)).configurationRevision!;
  await client.command({ method: 'resources.setup.save', params: setup(revision, 'later') });
  const bytes = await fs.readFile(s.filename, 'utf8');
  const second = await s.raw();
  assert.deepEqual(await send(second, 'durable-setup', command), accepted);
  assert.equal(await fs.readFile(s.filename, 'utf8'), bytes);
  const replayConflict = await send(second, 'durable-setup', {
    ...command,
    params: { ...input, profile: { ...input.profile, name: 'Changed body under same request ID' } },
  });
  assert.equal(replayConflict.ok, false);
  assert.equal(replayConflict.error.code, 'IDEMPOTENCY_CONFLICT');
  const saved = await catalog(client);
  assert.equal(
    saved.configured?.profiles.filter((item) =>
      ['once-team', 'later-team'].includes(item.profile.id),
    ).length,
    2,
  );
  assert.deepEqual(s.http, []);
});

test('invalid references and plaintext secret fields are rejected at the socket boundary without any partial file mutation', async (t) => {
  const s = await server(t),
    client = await s.client();
  const input = setup((await catalog(client)).configurationRevision!);
  const bytes = await fs.readFile(s.filename, 'utf8');
  const invalid = [
    { params: { ...input, apiKey: SECRET }, code: 'BAD_REQUEST' },
    {
      params: { ...input, runtimes: [{ ...input.runtimes[0], apiKey: SECRET }] },
      code: 'BAD_REQUEST',
    },
    {
      params: { ...input, runtimes: [{ ...input.runtimes[0], connectionId: 'missing' }] },
      code: 'RESOURCE_SETUP_REFERENCE',
    },
    {
      params: { ...input, profile: { ...input.profile, coordinator: 'missing' } },
      code: 'RESOURCE_SETUP_REFERENCE',
    },
    { params: { ...input, runtimes: [{ id: 'codex', client: 'codex' }] }, code: 'BAD_REQUEST' },
  ];
  for (const candidate of invalid) {
    await assert.rejects(
      client.command({ method: 'resources.setup.save', params: candidate.params } as any),
      (error: any) => {
        assert.equal(error.code, candidate.code);
        assert.ok(!error.message.includes(SECRET));
        return true;
      },
    );
    assert.equal(await fs.readFile(s.filename, 'utf8'), bytes);
  }
  assert.deepEqual(s.http, []);
});

test('machine setup preserves role preferences, project override, native bindings, default and managed-budget settings over transport', async (t) => {
  const s = await server(t),
    a = await s.client(),
    b = await s.client();
  const originalRole = a.snapshot().roles.find((role) => role.id === 'implementer')!;
  await a.saveRole({
    projectId: 'p',
    id: originalRole.id,
    expectedVersion: originalRole.version,
    title: originalRole.title,
    description: originalRole.description,
    instructions: originalRole.instructions,
    kind: originalRole.kind,
    runtimePreference: { mode: 'fixed', runtimeId: 'existing-worker' },
  });
  await a.createGoal({
    projectId: 'p',
    title: 'Preserve this goal',
    body: 'Machine resource setup must leave project state intact.',
    criteria: 'No execution is requested.',
  });
  const beforeSnapshot = await a.command<any>({
    method: 'project.snapshot',
    params: { projectId: 'p' },
  });
  const beforeCatalog = await catalog(a);
  await b.command({
    method: 'resources.setup.save',
    params: setup(beforeCatalog.configurationRevision!, 'extra'),
  });
  const afterSnapshot = await b.command<any>({
    method: 'project.snapshot',
    params: { projectId: 'p' },
  });
  const afterCatalog = await catalog(b);
  assert.deepEqual(afterSnapshot, beforeSnapshot);
  assert.deepEqual(afterSnapshot.profile.managedBudget, s.profile.managedBudget);
  assert.equal(afterSnapshot.profile.resourceProfile, 'existing-local');
  assert.deepEqual(
    afterSnapshot.roles.find((role: any) => role.id === 'implementer').runtimePreference,
    { mode: 'fixed', runtimeId: 'existing-worker' },
  );
  assert.equal(afterCatalog.defaultProfile, beforeCatalog.defaultProfile);
  assert.deepEqual(
    afterCatalog.runtimes.find((item) => item.client === 'codex'),
    beforeCatalog.runtimes.find((item) => item.client === 'codex'),
  );
  assert.deepEqual(afterCatalog.selected, beforeCatalog.selected);
  assert.ok(!JSON.stringify([afterCatalog, afterSnapshot]).includes(SECRET));
  assert.deepEqual(s.http, []);
});
