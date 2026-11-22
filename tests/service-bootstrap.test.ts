import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHost } from '../plugins/host.ts';
import { websocketPlugin } from '../daemon/websocket.ts';
import { SocketProjectClient } from '../clients/socket-client.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { RequestSchema, parseServiceInfo } from '../protocol/schema.ts';

const execute = promisify(execFile);

test('service discovery accepts an empty catalog and keeps the RPC closed', () => {
  assert.deepEqual(parseServiceInfo({ version: 1, projects: [], capabilities: [] }).projects, []);
  for (const value of [
    { version: 2, projects: [], capabilities: [] },
    { version: 1, projects: [], capabilities: [], snapshot: {} },
    {
      version: 1,
      projects: [
        { id: 'p', name: 'P', root: '.' },
        { id: 'p', name: 'P', root: '.' },
      ],
      capabilities: [],
    },
  ])
    assert.throws(() => parseServiceInfo(value));
  assert.equal(
    RequestSchema.safeParse({
      version: 1,
      type: 'request',
      id: 'r',
      command: { method: 'service.info', params: {} },
    }).success,
    true,
  );
  assert.equal(
    RequestSchema.safeParse({
      version: 1,
      type: 'request',
      id: 'r',
      command: { method: 'service.info', params: { projectId: 'invented' } },
    }).success,
    false,
  );
});

test(
  'project selection replays changes between snapshot and subscription; explicit clients do not require discovery',
  { timeout: 5000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-service-selection-'));
    const host = await createHost({
      projects: [
        {
          storageAddress: directory,
          project: { id: 'p', name: 'Selected', root: directory },
          roles: [],
        },
      ],
    });
    let port = 0;
    await host.ctx.plugin(websocketPlugin, {
      port: 0,
      onListen: (value) => {
        port = value;
      },
    });
    const url = `ws://127.0.0.1:${port}`;
    const discovered = new SocketProjectClient(url),
      legacy = new SocketProjectClient(url, 'p');
    t.after(async () => {
      discovered.close();
      legacy.close();
      await host.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    });
    await discovered.connectService();
    const original = host.ctx.commands.bus.handlers.get('project.snapshot')!;
    let inject = true;
    host.ctx.commands.bus.handlers.set('project.snapshot', async (...args) => {
      const snapshot = await original(...args);
      if (inject) {
        inject = false;
        await host.ctx.goals.api.create('gap-goal', 'fixture', {
          projectId: 'p',
          title: 'During selection',
          body: 'Must be replayed',
          criteria: '',
        });
      }
      return snapshot;
    });
    const selected = await discovered.selectProject('p');
    assert.equal(selected.sequence, 1);
    assert.equal(selected.goals[0].title, 'During selection');
    assert.equal(discovered.snapshot().sequence, 1);
    host.ctx.commands.bus.handlers.delete('service.info');
    assert.equal((await legacy.connect()).project.id, 'p');
  },
);

test(
  'an empty service supports global clients and CLI, then a real first project without fake state',
  { timeout: 15000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-empty-service-'));
    const host = await createHost({ projects: [] });
    const client = new SocketProjectClient();
    t.after(async () => {
      client.close();
      await host.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    });
    let snapshots = 0;
    const original = host.ctx.commands.bus.handlers.get('project.snapshot')!;
    host.ctx.commands.bus.handlers.set('project.snapshot', (...args) => {
      snapshots++;
      return original(...args);
    });
    host.ctx.commands.bus.register('resources.list', () => ({
      runtimes: [],
      profiles: [],
      connections: [],
    }));
    host.ctx.on('service/info', (info) => info.capabilities.push('resources.list'));
    let port = 0;
    await host.ctx.plugin(websocketPlugin, {
      port: 0,
      onListen: (value) => {
        port = value;
      },
    });
    client.url = `ws://127.0.0.1:${port}`;
    const info = await client.connectService();
    assert.equal(client.ready, true);
    assert.equal(client.state, null);
    assert.equal(client.projectId, undefined);
    assert.deepEqual(info.projects, []);
    assert.ok(info.capabilities.includes('resources.list'));
    assert.equal(snapshots, 0);
    assert.throws(() => client.snapshot(), /not connected/);
    await assert.rejects(client.selectProject('missing'), { code: 'PROJECT_NOT_FOUND' });
    assert.equal(client.state, null);
    for (const args of [['status'], ['projects'], ['resources', 'list']]) {
      const result = await execute(process.execPath, ['cli/main.ts', ...args], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, PROJECT_DAEMON_URL: client.url },
      });
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      if (args[0] === 'status') assert.deepEqual(output.projects, []);
      if (args[0] === 'projects') assert.deepEqual(output, []);
      if (args[0] === 'resources') assert.deepEqual(output.runtimes, []);
    }
    await assert.rejects(
      execute(process.execPath, ['cli/main.ts', 'goals'], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, PROJECT_DAEMON_URL: client.url },
      }),
      (error: unknown) =>
        /Select a project with PROJECT_ID/.test((error as { stderr: string }).stderr),
    );
    assert.equal(snapshots, 1, 'Only the explicit missing selection queried project state.');
    const store = await FileProjectStore.open({
      directory: path.join(directory, 'first'),
      project: { id: 'first', name: 'First project', root: directory },
      roles: [],
      runs: [],
    });
    host.ctx.projects.registry.add(store);
    assert.deepEqual(
      (await client.refreshService()).projects.map((project) => project.id),
      ['first'],
    );
    const selected = await client.selectProject('first');
    assert.equal(selected.project.id, 'first');
    assert.deepEqual(selected.roles, []);
    assert.deepEqual(selected.goals, []);
    assert.deepEqual(selected.runs, []);
    const observed = new Promise<void>((resolve) =>
      client.onChange((snapshot) => {
        if (snapshot.goals.length) resolve();
      }),
    );
    await client.createGoal({ projectId: 'first', title: 'First goal', body: 'No model request' });
    await observed;
    assert.equal(client.snapshot().goals[0].title, 'First goal');
  },
);
