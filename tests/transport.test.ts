import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket as RawSocket } from 'ws';
import { defaultRoles } from './fixtures/roles.ts';
import { createHost } from '../plugins/host.ts';
import { websocketPlugin } from '../daemon/websocket.ts';
import { SocketProjectClient, applyEvent } from '../clients/socket-client.ts';
import { RequestSchema } from '../protocol/schema.ts';

async function server(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-transport-'));
  const host = await createHost({
    projects: [
      {
        storageAddress: directory,
        project: { id: 'codex-panel', name: 'Demo', root: directory },
        roles: structuredClone(defaultRoles),
      },
    ],
  });
  let port = 0;
  const transport = await host.ctx.plugin(websocketPlugin, {
    port: 0,
    onListen: (p) => (port = p),
  });
  t.after(async () => {
    await host.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { host, directory, transport, url: 'ws://127.0.0.1:' + port };
}
test('independent clients share goals and role revisions over the versioned protocol', async (t) => {
  const s = await server(t);
  const a = new SocketProjectClient(s.url, 'codex-panel'),
    b = new SocketProjectClient(s.url, 'codex-panel');
  t.after(() => {
    a.close();
    b.close();
  });
  await Promise.all([a.connect(), b.connect()]);
  const event = new Promise<void>((resolve) => {
    b.onChange((snapshot) => {
      if (snapshot.goals.length === 1) resolve();
    });
  });
  const goal = await a.createGoal({
    projectId: 'codex-panel',
    title: 'Via socket',
    body: 'Shared core',
    criteria: '',
  });
  await event;
  assert.equal(b.snapshot().goals[0].id, goal.id);
  const initial = b.snapshot().roles.find((r) => r.id === 'reviewer')!;
  const fields = {
    id: initial.id,
    title: initial.title,
    description: initial.description,
    instructions: initial.instructions,
    kind: initial.kind,
  };
  await a.saveRole({
    ...fields,
    projectId: 'codex-panel',
    expectedVersion: initial.version,
    title: 'New reviewer',
  });
  await assert.rejects(
    b.saveRole({ ...fields, projectId: 'codex-panel', expectedVersion: initial.version }),
    { code: 'CONFLICT' },
  );
  await a.deleteGoal('codex-panel', goal.id);
  assert.equal(a.snapshot().goals.length, 0);
});
test('transport unload does not stop core; reconnect catches work committed while disconnected', async (t) => {
  const s = await server(t);
  const client = new SocketProjectClient(s.url, 'codex-panel');
  t.after(() => client.close());
  await client.connect();
  await s.transport.dispose();
  const command = {
    method: 'goal.create' as const,
    params: { projectId: 'codex-panel', title: 'Without UI', body: 'Work continues', criteria: '' },
  };
  await s.host.ctx.commands.bus.execute(command, {
    id: 'offline-command',
    fingerprint: 'offline-fp',
  });
  const port = Number(new URL(s.url).port);
  await s.host.ctx.plugin(websocketPlugin, { port });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Reconnect timeout')), 6000);
    client.onChange((snapshot) => {
      if (snapshot.goals.some((g) => g.title === 'Without UI')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  assert.equal(client.snapshot().sequence, 1);
  assert.equal(client.snapshot().goals.length, 1);
});
test('event projection ignores duplicates and refuses missing or foreign sequences', async (t) => {
  const s = await server(t);
  const client = new SocketProjectClient(s.url, 'codex-panel');
  t.after(() => client.close());
  const before = await client.connect();
  await client.createGoal({ projectId: 'codex-panel', title: 'One', body: 'Body', criteria: '' });
  const after = client.snapshot();
  let saved: any;
  s.host.ctx.projects.registry.get('codex-panel').subscribe(0, (e) => (saved = e));
  assert.equal(applyEvent(after, saved), after);
  assert.equal(applyEvent(before, { ...saved, projectId: 'other' }), before);
  assert.throws(() => applyEvent(before, { ...saved, seq: 2 }), /Event gap/);
});
test('unknown commands, protocol versions and arbitrary project ids are rejected', async (t) => {
  assert.equal(
    RequestSchema.safeParse({
      version: 1,
      type: 'request',
      id: 'test',
      command: { method: 'shell.exec', params: { command: 'echo nope' } },
    }).success,
    false,
  );
  const s = await server(t),
    raw = new RawSocket(s.url);
  t.after(() => raw.close());
  await new Promise<void>((resolve) => raw.once('open', resolve));
  const result = new Promise<any>((resolve) =>
    raw.on('message', (bytes) => {
      const m = JSON.parse(bytes.toString());
      if (m.type === 'response') resolve(m);
    }),
  );
  raw.send(
    JSON.stringify({
      version: 2,
      type: 'request',
      id: 'wrong',
      command: { method: 'project.list', params: {} },
    }),
  );
  assert.equal((await result).error.code, 'BAD_REQUEST');
  const client = new SocketProjectClient(s.url, 'codex-panel');
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(
    client.command({ method: 'project.snapshot', params: { projectId: '../../elsewhere' } }),
  );
  await assert.rejects(
    client.command({ method: 'project.snapshot', params: { projectId: 'unknown' } }),
    { code: 'PROJECT_NOT_FOUND' },
  );
});

test('lost mutation response can be retried on a new connection without a duplicate', async (t) => {
  const s = await server(t);
  const request = {
    version: 1,
    type: 'request',
    id: 'durable-request',
    command: {
      method: 'goal.create',
      params: {
        projectId: 'codex-panel',
        title: 'Once',
        body: 'The response may be lost',
        criteria: '',
      },
    },
  };
  const committed = new Promise<void>((resolve) =>
    s.host.ctx.projects.registry.get('codex-panel').subscribe(0, () => resolve()),
  );
  const first = new RawSocket(s.url);
  await new Promise<void>((resolve) => first.once('open', resolve));
  first.send(JSON.stringify(request));
  first.close();
  await committed;
  const second = new RawSocket(s.url);
  t.after(() => second.close());
  await new Promise<void>((resolve) => second.once('open', resolve));
  const response = new Promise<any>((resolve) =>
    second.on('message', (bytes) => {
      const value = JSON.parse(bytes.toString());
      if (value.type === 'response' && value.id === request.id) resolve(value);
    }),
  );
  second.send(JSON.stringify(request));
  const result = await response;
  assert.equal(result.ok, true);
  const snapshot = s.host.ctx.projects.registry.get('codex-panel').snapshot();
  assert.equal(snapshot.goals.length, 1);
  assert.equal(snapshot.sequence, 1);
  assert.equal(snapshot.goals[0].id, result.result.id);
});

test('context uploads larger than the former message limit propagate to other clients and survive reconnect', async (t) => {
  const s = await server(t),
    a = new SocketProjectClient(s.url, 'codex-panel'),
    b = new SocketProjectClient(s.url, 'codex-panel');
  t.after(() => {
    a.close();
    b.close();
  });
  await Promise.all([a.connect(), b.connect()]);
  const text = 'A useful requirement.\n'.repeat(12000),
    materials = await a.command<any[]>({
      method: 'context.import',
      params: {
        projectId: 'codex-panel',
        scope: 'goal',
        upload: { name: 'requirements.md', base64: Buffer.from(text).toString('base64') },
      },
    });
  assert.equal(materials.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(b.snapshot().contextMaterials?.[0].id, materials[0].id);
  const goal = await a.createGoal({
    projectId: 'codex-panel',
    title: 'Use attachments',
    body: 'Follow the document',
    criteria: '',
    materialIds: [materials[0].id],
  });
  assert.deepEqual(goal.materialIds, [materials[0].id]);
  const directory = await a.command<any>({
    method: 'filesystem.list',
    params: { projectId: 'codex-panel', restricted: true },
  });
  assert.equal(directory.path, await fs.realpath(s.directory));
  await a.command({
    method: 'context.remove',
    params: { projectId: 'codex-panel', materialId: materials[0].id },
  });
  assert.equal(a.snapshot().contextMaterials?.[0].active, false);
  const c = new SocketProjectClient(s.url, 'codex-panel');
  t.after(() => c.close());
  const snapshot = await c.connect();
  assert.deepEqual(snapshot.goals[0].materialIds, goal.materialIds);
  assert.equal(snapshot.contextMaterials?.[0].active, false);
});
