import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplication } from '../modules/application/create-application.ts';

const exec = promisify(execFile);

test('initial dirty source becomes the baseline; results preserve binary/mode changes and apply without touching unrelated work', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-result-modules-'));
  const root = path.join(directory, 'source');
  await fs.mkdir(root);
  const git = (...args: string[]) => exec('git', args, { cwd: root });
  await git('init', '-q');
  await fs.writeFile(path.join(root, 'README.md'), 'Original\n');
  await fs.writeFile(path.join(root, 'delete.txt'), 'Delete me');
  await fs.writeFile(path.join(root, 'run.sh'), '#!/bin/sh\necho original\n', { mode: 0o644 });
  await fs.writeFile(path.join(root, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
  await git('add', '.');
  await git(
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'Initial',
  );
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  await fs.writeFile(path.join(root, 'README.md'), 'Existing user edit\n');
  await fs.writeFile(path.join(root, 'local.txt'), 'Existing user file');
  const index = await fs.readFile(path.join(root, '.git', 'index'));
  const app = await createApplication({ directory: path.join(directory, 'application') });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  app.models.register({
    id: 'fixture',
    name: 'Fixture',
    model: 'fixture',
    contextTokens: 32768,
    outputTokens: 8192,
    provider: {
      id: 'fixture',
      revision: 'one',
      local: true,
      async complete() {
        return {
          model: 'fixture',
          finish: 'stop',
          message: { role: 'assistant', content: 'Done' },
        };
      },
    },
  });
  const project = (await app.projects.connect({ root })).project!;
  const task = await app.tasks.create({ projectId: project.id, title: 'Task', description: '' });
  const run = (await app.runs.start({ taskId: task.id })).run!;
  await app.runs.wait({ id: run.id });
  assert.equal(
    await fs.readFile(path.join(run.workspace, 'README.md'), 'utf8'),
    'Existing user edit\n',
  );
  assert.equal(
    await fs.readFile(path.join(run.workspace, 'local.txt'), 'utf8'),
    'Existing user file',
  );
  assert.deepEqual((await app.results.inspect({ runId: run.id })).files, []);
  await fs.writeFile(path.join(run.workspace, 'README.md'), 'Agent result\n');
  await fs.writeFile(path.join(run.workspace, 'new.txt'), 'New result');
  await fs.writeFile(path.join(run.workspace, '.env'), 'private-test-value');
  await fs.writeFile(path.join(run.workspace, 'asset.bin'), Buffer.from([0, 5, 6, 7]));
  await fs.chmod(path.join(run.workspace, 'run.sh'), 0o755);
  await fs.rm(path.join(run.workspace, 'delete.txt'));
  const snapshot = await app.results.inspect({ runId: run.id });
  assert.equal(snapshot.ok, true, snapshot.error);
  assert.ok(snapshot.files!.some((file) => file.path === 'new.txt' && file.status === 'A'));
  assert.ok(snapshot.files!.some((file) => file.path === 'delete.txt' && file.status === 'D'));
  assert.ok(snapshot.patch!.includes('GIT binary patch'));
  assert.ok(snapshot.patch!.includes('new mode 100755'));
  assert.ok(!snapshot.patch!.includes('private-test-value'));
  assert.ok(!snapshot.files!.some((file) => file.path === '.env' || file.path === 'local.txt'));
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'index')), index);
  assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), head);
  await fs.writeFile(path.join(root, 'unrelated.txt'), 'Other user work');
  const applied = await app.results.apply({ runId: run.id, revision: snapshot.revision });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'Agent result\n');
  assert.equal(await fs.readFile(path.join(root, 'local.txt'), 'utf8'), 'Existing user file');
  assert.equal(await fs.readFile(path.join(root, 'unrelated.txt'), 'utf8'), 'Other user work');
  assert.deepEqual(await fs.readFile(path.join(root, 'asset.bin')), Buffer.from([0, 5, 6, 7]));
  assert.equal((await fs.stat(path.join(root, 'run.sh'))).mode & 0o111, 0o111);
  await assert.rejects(fs.stat(path.join(root, 'delete.txt')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'index')), index);
});

test('an invalid base is an ordinary start result and does not leave an idle session behind', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-invalid-base-'));
  const app = await createApplication({ directory: path.join(directory, 'app') });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  app.models.register({
    id: 'fixture',
    name: 'Fixture',
    model: 'fixture',
    contextTokens: 32768,
    outputTokens: 8192,
    provider: {
      id: 'fixture',
      revision: 'one',
      local: true,
      async complete() {
        throw new Error('Must not request inference');
      },
    },
  });
  const project = (await app.projects.connect({ root: directory })).project!;
  const task = await app.tasks.create({ projectId: project.id, title: 'Task', description: '' });
  const result = await app.runs.start({ taskId: task.id, options: { base: 'does-not-exist' } });
  assert.equal(result.ok, false);
  assert.deepEqual(await app.sessions.list(), []);
});
