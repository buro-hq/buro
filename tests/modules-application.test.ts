import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplication } from '../modules/application/create-application.ts';
import { SqliteStorage } from '../modules/storage/sqlite-storage.ts';
import { JsonStorage } from '../modules/storage/json-storage.ts';
import type { Application } from '../modules/application/application.ts';
import type { ModelTransport } from '../modules/models/model-configuration.ts';
import type { ModelMessage } from '../agent/contracts/model.ts';

const exec = promisify(execFile);

test('application restarts with persisted feature records, default model and private adapter state without publishing credentials', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-application-modules-'));
  const root = path.join(directory, 'source'),
    state = path.join(directory, 'application');
  await fs.mkdir(root);
  await exec('git', ['init', '-q', root]);
  await fs.writeFile(path.join(root, 'README.md'), 'Project');
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
  const observations: unknown[] = [],
    requests: ModelMessage[][] = [];
  const credential = 'test-credential-not-a-real-key',
    continuation = 'test-private-thinking';
  const transport: ModelTransport = {
    id: 'fixture',
    create({ configuration, apiKey }) {
      assert.equal(apiKey, credential);
      return {
        id: configuration.id,
        revision: configuration.revision,
        local: true,
        async complete(input) {
          requests.push(input.messages);
          return {
            model: 'fixture',
            finish: 'stop',
            message: { role: 'assistant', content: 'Done', continuation: { value: continuation } },
          };
        },
      };
    },
  };
  let app: Application | undefined;
  t.after(async () => {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  app = await createApplication({ directory: state, transports: [transport] });
  assert.deepEqual(await app.projects.list(), []);
  assert.deepEqual(await app.modelConfigurations.list(), []);
  app.events.subscribe((notification) => {
    observations.push(notification);
  });
  await app.settings.update({ instructions: 'Default task instructions' });
  const model = (
    await app.modelConfigurations.save({
      configuration: {
        name: 'Fixture',
        transport: 'fixture',
        endpoint: 'http://127.0.0.1:1',
        model: 'fixture',
        contextTokens: 16384,
        outputTokens: 4096,
      },
      apiKey: credential,
      default: true,
    })
  ).configuration!;
  assert.equal(model.hasApiKey, true);
  assert.equal(model.thinking, true);
  assert.ok(!JSON.stringify(model).includes(credential));
  const project = (await app.projects.connect({ root })).project!;
  const task = await app.tasks.create({
    projectId: project.id,
    title: 'Task',
    description: 'Intent',
  });
  const started = (await app.runs.start({ taskId: task.id })).run!;
  assert.equal((await app.runs.wait({ id: started.id }))!.status, 'completed');
  assert.equal(requests[0][0].content, 'Default task instructions');
  assert.ok(!JSON.stringify(observations).includes(credential));
  assert.ok(!JSON.stringify(observations).includes(continuation));
  await app.close();
  app = await createApplication({ directory: state, transports: [transport] });
  assert.equal((await app.settings.get()).defaultModelId, model.id);
  assert.equal((await app.tasks.get({ id: task.id }))!.description, 'Intent');
  assert.equal((await app.runs.get({ id: started.id }))!.status, 'completed');
  await app.sessions.run({
    sessionId: started.sessionId,
    input: 'Follow-up',
    workspace: started.workspace,
  });
  assert.ok(JSON.stringify(requests[1]).includes(continuation));
  assert.ok(
    !JSON.stringify(await app.sessions.get({ id: started.sessionId })).includes(continuation),
  );
  const updated = (
    await app.modelConfigurations.save({
      configuration: {
        id: model.id,
        name: 'Renamed',
        transport: 'fixture',
        endpoint: model.endpoint,
        model: model.model,
      },
    })
  ).configuration!;
  assert.equal(updated.contextTokens, 16384);
  assert.equal(updated.hasApiKey, true);
  await app.sessions.run({
    sessionId: started.sessionId,
    input: 'After transport configuration change',
    workspace: started.workspace,
  });
  assert.ok(!JSON.stringify(requests[2]).includes(continuation));
});

for (const backend of ['sqlite', 'json']) {
  test(`${backend}: concurrent record patches preserve unrelated fields`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-record-patch-'));
    const storage =
      backend === 'sqlite'
        ? new SqliteStorage({ filename: ':memory:' })
        : new JsonStorage({ directory });
    t.after(async () => {
      await storage.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const records = storage.records<{ id: string; first: number; second: number }>('values');
    await records.save({ id: 'one', first: 0, second: 0 });
    await Promise.all([
      records.patch({ id: 'one', changes: { first: 1 } }),
      records.patch({ id: 'one', changes: { second: 2 } }),
    ]);
    assert.deepEqual(await records.get('one'), { id: 'one', first: 1, second: 2 });
    assert.equal(await records.patch({ id: 'missing', changes: { first: 3 } }), undefined);
  });
}
