import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHost } from '../plugins/host.ts';
import { websocketPlugin } from '../daemon/websocket.ts';
import { SocketProjectClient } from '../clients/socket-client.ts';
import { effectiveProjectPolicy } from '../core/autonomy-policy.ts';
import { ResourceConfigurationChangeSchema } from '../protocol/schema.ts';
import type { ResourceConfigurationChange } from '../protocol/domain.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: any, ids = ['a', 'b']) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-invalidations-'));
  const host = await createHost({
    projects: ids.map((id) => ({
      storageAddress: path.join(directory, id),
      project: { id, name: id, root: directory },
    })),
  });
  let policyRevision = 1;
  host.ctx.on('project/snapshot', (snapshot) => {
    snapshot.effectivePolicy = effectiveProjectPolicy({
      policy: {
        scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
        checks: [],
        defaultCheckIds: [],
        maxWorkers: 1,
        maxRepairs: 0,
      },
    });
    snapshot.effectivePolicy.origin.revision = policyRevision;
  });
  let port = 0;
  await host.ctx.plugin(websocketPlugin, {
    port: 0,
    onListen: (value) => {
      port = value;
    },
  });
  const clients: SocketProjectClient[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await host.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const client = (id?: string) => {
    const value = new SocketProjectClient(`ws://127.0.0.1:${port}`, id);
    clients.push(value);
    return value;
  };
  return {
    host,
    client,
    setPolicy: (revision: number) => {
      policyRevision = revision;
    },
    emit: (revision: string, appliesTo: ResourceConfigurationChange['appliesTo'] = 'new-runs') =>
      host.ctx.emit('service/change', { topic: 'resources', revision, appliesTo }),
  };
}
function policy(client: SocketProjectClient, revision: number) {
  if (client.state?.effectivePolicy?.origin.revision === revision) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = client.onChange((snapshot) => {
      if (snapshot.effectivePolicy?.origin.revision === revision) {
        unsubscribe();
        resolve();
      }
    });
  });
}

test(
  'service invalidation reaches different projects and a client without any project subscription',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const a = f.client('a'),
      b = f.client('b'),
      service = f.client();
    await Promise.all([a.connect(), b.connect(), service.connectService()]);
    const received = [a, b, service].map(() => [] as ResourceConfigurationChange[]);
    [a, b, service].forEach((client, index) =>
      client.onServiceInvalidation((change) => received[index].push(change)),
    );
    a.onServiceInvalidation(() => {
      throw Error('Bad synchronous observer');
    });
    a.onServiceInvalidation(async () => {
      throw Error('Bad asynchronous observer');
    });
    a.onServiceInvalidation((change) => {
      change.revision = 'mutated observer value';
    });
    const generations = [a, b, service].map((client) => client.getResourceGeneration());
    f.setPolicy(2);
    const after = Promise.all([policy(a, 2), policy(b, 2)]);
    f.emit('f'.repeat(64));
    await after;
    await service.command({ method: 'service.info', params: {} });
    [a, b, service].forEach((client, index) => {
      assert.equal(client.getResourceGeneration(), generations[index] + 1);
      assert.deepEqual(received[index], [
        { topic: 'resources', revision: 'f'.repeat(64), appliesTo: 'new-runs' },
      ]);
      assert.equal(client.getResourceRevision(), 'f'.repeat(64));
    });
    assert.equal(a.snapshot().sequence, 0);
    assert.equal(b.snapshot().sequence, 0);
    assert.equal(f.host.ctx.projects.registry.get('a').snapshot().sequence, 0);
    assert.equal(f.host.ctx.projects.registry.get('b').snapshot().sequence, 0);
  },
);

test(
  'hash equality deduplicates receipts while a lexically smaller revision still invalidates',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const client = f.client('a');
    await client.connect();
    const changes: ResourceConfigurationChange[] = [];
    client.onServiceInvalidation((change) => changes.push(change));
    f.setPolicy(2);
    f.emit('f'.repeat(64));
    await policy(client, 2);
    const generation = client.getResourceGeneration();
    f.emit('f'.repeat(64));
    await client.command({ method: 'service.info', params: {} });
    assert.equal(client.getResourceGeneration(), generation);
    assert.equal(changes.length, 1);
    f.setPolicy(3);
    f.emit('0'.repeat(64), 'service-restart');
    await policy(client, 3);
    assert.equal(client.getResourceGeneration(), generation + 1);
    assert.equal(changes.length, 2);
    assert.equal(changes[1].appliesTo, 'service-restart');
  },
);

test(
  'an older held projection cannot become current after a later service invalidation',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const client = f.client('a');
    const original = f.host.ctx.commands.bus.handlers.get('project.snapshot')!;
    const captured = deferred(),
      release = deferred();
    t.after(() => release.resolve());
    let hold = false;
    f.host.ctx.commands.bus.handlers.set('project.snapshot', async (...args) => {
      const snapshot = await original(...args);
      if (hold) {
        hold = false;
        captured.resolve();
        await release.promise;
      }
      return snapshot;
    });
    await client.connect();
    hold = true;
    f.setPolicy(2);
    f.emit('e'.repeat(64));
    await captured.promise;
    f.setPolicy(3);
    const notified = deferred();
    client.onServiceInvalidation((change) => {
      if (change.revision === '1'.repeat(64)) notified.resolve();
    });
    f.emit('1'.repeat(64));
    await notified.promise;
    const observed: (number | undefined)[] = [];
    client.onChange((snapshot) => observed.push(snapshot.effectivePolicy?.origin.revision));
    release.resolve();
    await policy(client, 3);
    assert.equal(observed.includes(2), false);
    assert.equal(client.snapshot().sequence, 0);
  },
);

test(
  'reconnect refreshes current policy and advances local generation even if configuration events were missed',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const client = f.client('a');
    await client.connect();
    const generation = client.getResourceGeneration();
    let changes = 0;
    client.onServiceInvalidation(() => {
      changes++;
    });
    const reconnected = deferred();
    client.onConnection((state) => {
      if (state === 'connected' && client.getResourceGeneration() > generation)
        reconnected.resolve();
    });
    f.setPolicy(4);
    client.ws!.close();
    await reconnected.promise;
    assert.equal(client.snapshot().effectivePolicy?.origin.revision, 4);
    assert.ok(client.getResourceGeneration() > generation);
    assert.equal(changes, 0, 'reconnect does not fabricate a persisted configuration event');
  },
);

test(
  'project selection retries a snapshot captured before a service configuration change',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const client = f.client();
    await client.connectService();
    const original = f.host.ctx.commands.bus.handlers.get('project.snapshot')!;
    const captured = deferred(),
      release = deferred(),
      changed = deferred();
    t.after(() => release.resolve());
    let hold = true;
    f.host.ctx.commands.bus.handlers.set('project.snapshot', async (...args) => {
      const snapshot = await original(...args);
      if (hold) {
        hold = false;
        captured.resolve();
        await release.promise;
      }
      return snapshot;
    });
    client.onServiceInvalidation(() => changed.resolve());
    const selecting = client.selectProject('a');
    await captured.promise;
    f.setPolicy(2);
    f.emit('b'.repeat(64));
    await changed.promise;
    release.resolve();
    const selected = await selecting;
    assert.equal(selected.effectivePolicy?.origin.revision, 2);
    assert.equal(selected.sequence, 0);
  },
);

test(
  'closed invalidation data excludes settings and credentials, including for an empty service',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, []);
    const client = f.client();
    await client.connectService();
    const valid = { topic: 'resources', revision: 'a'.repeat(64), appliesTo: 'new-runs' } as const;
    assert.equal(
      ResourceConfigurationChangeSchema.safeParse({
        ...valid,
        config: { credential: 'synthetic-private-value' },
      }).success,
      false,
    );
    const changes: ResourceConfigurationChange[] = [];
    client.onServiceInvalidation((change) => changes.push(change));
    f.host.ctx.emit('service/change', {
      ...valid,
      config: { credential: 'synthetic-private-value' },
    } as ResourceConfigurationChange);
    await client.command({ method: 'service.info', params: {} });
    assert.deepEqual(changes, []);
    f.emit(valid.revision);
    await client.command({ method: 'service.info', params: {} });
    assert.deepEqual(changes, [valid]);
    assert.doesNotMatch(JSON.stringify(changes), /synthetic-private-value|config|credential/);
  },
);
