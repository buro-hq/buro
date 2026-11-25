import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplication } from '../modules/application/create-application.ts';
import { GitHubPublisher } from '../modules/deliveries/github-publisher.ts';
import type { PullRequests } from '../modules/deliveries/github-pull-requests.ts';
import { ApiClient } from '../modules/api/client.ts';
import { startApiServer } from '../modules/api/server.ts';

const exec = promisify(execFile);

test('explicit publication pushes only the run delta to a fresh base, keeps a blank PR body, and records a pushed branch if PR creation fails', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-deliveries-')),
    root = path.join(directory, 'source'),
    remote = path.join(directory, 'remote.git');
  await fs.mkdir(root);
  await exec('git', ['init', '--bare', '--initial-branch=main', '-q', remote]);
  await exec('git', ['init', '--initial-branch=main', '-q', root]);
  await fs.writeFile(path.join(root, 'README.md'), 'Committed source\n');
  await exec('git', ['add', '.'], { cwd: root });
  await exec(
    'git',
    [
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
    ],
    { cwd: root },
  );
  await exec('git', ['remote', 'add', 'origin', remote], { cwd: root });
  await exec('git', ['push', '-q', 'origin', 'HEAD'], { cwd: root });
  await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], {
    cwd: root,
  });
  await fs.writeFile(path.join(root, 'README.md'), 'Pre-existing user edit\n');
  await fs.writeFile(path.join(root, 'user-work.txt'), 'Pre-existing untracked work\n');
  const before = (await exec('git', ['status', '--porcelain'], { cwd: root })).stdout;
  const requests: Parameters<PullRequests['create']>[0][] = [];
  let failPr = false;
  const publisher = new GitHubPublisher({
    directory: path.join(directory, 'published'),
    protocols: ['file'],
    pullRequests: {
      async create(input) {
        requests.push(input);
        return failPr
          ? { ok: false, error: 'The branch was pushed, but PR creation failed.' }
          : { ok: true, url: 'https://example.invalid/pull/1' };
      },
    },
  });
  const app = await createApplication({
    directory: path.join(directory, 'state'),
    publishers: [publisher],
  });
  const api = await startApiServer({ application: app, token: 'test-delivery-token', port: 0 }),
    client = new ApiClient({ url: `ws://127.0.0.1:${api.port}`, token: 'test-delivery-token' });
  t.after(async () => {
    client.close();
    await api.close();
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  app.models.register({
    id: 'fixture',
    name: 'Fixture',
    model: 'fixture',
    contextTokens: 32768,
    outputTokens: 8192,
    backend: {
      id: 'fixture',
      revision: 'one',
      async complete() {
        return {
          model: 'fixture',
          finish: 'stop',
          message: { role: 'assistant', content: 'Done' },
        };
      },
    },
  });
  const project = (await app.projects.connect({ root })).project!,
    task = await app.tasks.create({
      projectId: project.id,
      title: 'Add result file',
      description: 'Intent',
    }),
    run = (await app.runs.start({ taskId: task.id })).run!;
  await app.runs.wait({ id: run.id });
  await fs.writeFile(
    path.join(run.workspace, 'result.txt'),
    'Only this change should be published\n',
  );
  const snapshot = await app.results.inspect({ runId: run.id });
  const result = await client.call('deliveries.publish', {
    runId: run.id,
    branch: 'test/publication',
    revision: snapshot.revision,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.delivery?.status, 'published');
  assert.equal(result.delivery?.url, 'https://example.invalid/pull/1');
  assert.equal(requests[0].description, '');
  assert.equal(requests[0].title, 'Add result file');
  assert.equal(requests[0].base, 'main');
  assert.equal(
    (await exec('git', ['--git-dir=' + remote, 'show', 'refs/heads/test/publication:result.txt']))
      .stdout,
    'Only this change should be published\n',
  );
  assert.equal(
    (await exec('git', ['--git-dir=' + remote, 'show', 'refs/heads/test/publication:README.md']))
      .stdout,
    'Committed source\n',
  );
  await assert.rejects(
    exec('git', ['--git-dir=' + remote, 'show', 'refs/heads/test/publication:user-work.txt']),
  );
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: root })).stdout, before);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'Pre-existing user edit\n');
  failPr = true;
  const partial = await client.call('deliveries.publish', {
    runId: run.id,
    branch: 'test/partial',
    description: 'Explicit description\nSecond line',
  });
  assert.equal(partial.ok, false);
  assert.ok(partial.delivery?.commit);
  assert.equal(partial.delivery?.status, 'failed');
  assert.equal(requests[1].description, 'Explicit description\nSecond line');
  assert.match(
    (await exec('git', ['--git-dir=' + remote, 'rev-parse', 'refs/heads/test/partial'])).stdout,
    /^[a-f0-9]{40}/,
  );
  assert.equal((await client.call('deliveries.list', { runId: run.id })).length, 2);
});
