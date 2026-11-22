import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBuroApplication } from '../daemon/application.ts';
import { demoBootstrap } from '../daemon/demo.ts';

const execute = promisify(execFile);
const meta = { id: 'startup-read', fingerprint: 'startup-read' };

test('actual production composition starts without opening any project or invoking a model', async (t) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-application-')),
  );
  let modelCalls = 0;
  let storeOpens = 0;
  const app = await createBuroApplication({
    root: process.cwd(),
    directory,
    fetch: async () => {
      modelCalls++;
      throw Error('Unexpected model request');
    },
    credentials: () => undefined,
    storeFactory: {
      open: async () => {
        storeOpens++;
        throw Error('Unexpected seeded project');
      },
    },
  });
  t.after(async () => {
    await app.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const info = await app.ctx.commands.bus.execute({ method: 'service.info', params: {} }, meta);
  assert.deepEqual(info.projects, []);
  assert.deepEqual(app.ctx.projects.registry.list(), []);
  for (const method of ['project.connect', 'project.inspect', 'resources.list', 'filesystem.list'])
    assert.ok(info.capabilities.includes(method), method);
  assert.equal(storeOpens, 0);
  assert.equal(modelCalls, 0);
  assert.deepEqual(
    (await fs.readdir(directory)).filter((name) => name !== 'local'),
    [],
  );
});

test('production composition connects and restores a real first repository without demo state or model work', async (t) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-first-repository-')),
  );
  let app: Awaited<ReturnType<typeof createBuroApplication>> | undefined;
  t.after(async () => {
    await app?.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const repository = path.join(directory, 'repository');
  const state = path.join(directory, 'service');
  await fs.mkdir(repository);
  await fs.writeFile(path.join(repository, 'README.md'), 'Temporary project.\n');
  const git = (...args: string[]) => execute('git', args, { cwd: repository });
  await git('init', '-b', 'main');
  await git('add', 'README.md');
  await git(
    '-c',
    'user.name=Buro test',
    '-c',
    'user.email=buro@example.invalid',
    'commit',
    '--no-verify',
    '-m',
    'Initial',
  );
  let modelCalls = 0;
  const options = {
    root: process.cwd(),
    directory: state,
    fetch: async () => {
      modelCalls++;
      throw Error('Unexpected model request');
    },
    credentials: () => undefined,
  };
  app = await createBuroApplication(options);
  const bus = app.ctx.commands.bus;
  const inspected = await bus.execute(
    { method: 'project.inspect', params: { root: repository } },
    meta,
  );
  const connected = await bus.execute(
    {
      method: 'project.connect',
      params: { root: repository, name: 'First repository', profile: inspected.profile },
    },
    { id: 'connect-first', fingerprint: 'connect-first' },
  );
  const snapshot = app.ctx.projects.registry.get(connected.id).snapshot();
  assert.equal(snapshot.project.root, repository);
  assert.deepEqual(snapshot.goals, []);
  assert.deepEqual(snapshot.runs, []);
  assert.deepEqual(
    app.ctx.projects.registry.list().map((project) => project.id),
    [connected.id],
  );
  await app.dispose();
  app = undefined;
  app = await createBuroApplication(options);
  assert.deepEqual(app.ctx.projects.registry.list(), [snapshot.project]);
  assert.deepEqual(app.ctx.projects.registry.get(connected.id).snapshot(), snapshot);
  assert.equal(modelCalls, 0);
});

test('explicit demo uses isolated addresses and contributes its own fixtures', () => {
  const demo = demoBootstrap('/source', '/state');
  assert.deepEqual(
    demo.projects.map(({ project }) => project.id),
    ['demo-buro', 'demo-goals'],
  );
  assert.ok(demo.projects.every(({ storageAddress }) => storageAddress.startsWith('/state/demo/')));
  assert.deepEqual(Object.keys(demo.policies), ['demo-buro', 'demo-goals']);
  assert.deepEqual(Object.keys(demo.checks), ['demo-buro', 'demo-goals']);
});
