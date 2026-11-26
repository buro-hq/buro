import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../../modules/application/create-application.ts';
import { apiMethods } from '../../modules/api/dispatch.ts';
import { ApiClient } from '../../modules/api/client.ts';
import { startApiServer } from '../../modules/api/server.ts';
import { JsonStorage } from '../../modules/storage/json-storage.ts';
import type { Application } from '../../modules/application/application.ts';
import type { LaunchOptions } from '#shared/contracts';
import { queryAffected } from '../../src/data/query-notifications.ts';
import { presetApplication } from '../fixtures/preset-application.ts';

for (const adapter of ['sqlite', 'json']) {
  test(`preset CRUD persists across application restarts through ${adapter} storage`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-presets-'));
    const open = (): Promise<Application> => createApplication({
      directory,
      ...(adapter === 'json'
        ? { storage: new JsonStorage({
            directory: path.join(directory, 'records'),
          }) }
        : {}),
    });
    let app = await open();
    t.after(async () => {
      await app.close();
      await fs.rm(directory, {
        recursive: true,
        force: true,
      });
    });
    const defaults = await app.settings.get();
    const api = await startApiServer({
      application: app,
      port: 0,
      token: 'preset-test',
    });
    const client = new ApiClient({
      url: `ws://127.0.0.1:${api.port}`,
      token: 'preset-test',
    });
    t.after(async () => {
      client.close();
      await api.close();
    });
    const notifications: string[] = [];
    client.subscribe((notification) => {
      notifications.push(notification.type);
      assert.equal(queryAffected({
        method: 'presets.list',
        params: {},
        notification,
      }), true);
    });
    assert.deepEqual(await client.call('presets.list', {}), []);
    assert.equal(await client.call('presets.get', {
      id: 'missing',
    }), undefined);
    const options: LaunchOptions = {
      modelId: 'arbitrary-model',
      instructions: '',
      review: {
        enabled: false,
        maxRounds: null,
        participants: [
          { name: 'Editable name', instructions: 'Check actual changes', modelId: 'any-model', tools: [] },
          { name: '', instructions: '', modelId: null },
          { name: 'No override', instructions: 'Another focus' },
        ],
      },
    };
    const created = await client.call('presets.save', {
      name: 'Reusable launch',
      options,
    });
    assert.equal(created.ok, true);
    assert.ok(created.preset?.id);
    const id = created.preset.id;
    assert.deepEqual(created.preset.options, options);
    const empty = await client.call('presets.save', {
      name: 'Use defaults',
      options: {},
    });
    assert.equal(empty.ok, true);
    assert.notEqual(empty.preset!.id, id);
    assert.deepEqual(empty.preset!.options, {});
    const partial = await client.call('presets.save', {
      name: 'Inherited enabled',
      options: { review: { participants: [{ name: 'Custom', instructions: '' }] } },
    });
    assert.equal(partial.ok, true);
    assert.equal(Object.hasOwn(partial.preset!.options.review!, 'enabled'), false);
    const updated = await client.call('presets.save', {
      id,
      name: 'Renamed',
      options: { instructions: '', review: { enabled: false } },
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.preset!.id, id);
    assert.equal((await client.call('presets.list', {})).length, 3);
    assert.deepEqual((await client.call('presets.get', {
      id,
    }))!.options, {
      instructions: '',
      review: { enabled: false },
    });
    const unknown = await client.call('presets.save', {
      id: 'unknown',
      name: 'Missing',
      options: {},
    });
    assert.equal(unknown.ok, false);
    assert.ok(unknown.error);
    assert.equal(unknown.preset, undefined);
    assert.equal(await app.presets.get({
      id: 'unknown',
    }), undefined);
    await client.call('presets.delete', {
      id: partial.preset!.id,
    });
    assert.equal(await client.call('presets.get', {
      id: partial.preset!.id,
    }), undefined);
    assert.deepEqual(await app.settings.get(), defaults);
    assert.deepEqual(await app.runs.list(), []);
    assert.deepEqual(notifications, ['preset.saved', 'preset.saved', 'preset.saved', 'preset.saved', 'preset.deleted']);
    client.close();
    await api.close();
    await app.close();
    app = await open();
    assert.deepEqual(await app.presets.get({
      id,
    }), updated.preset);
    assert.deepEqual((await app.presets.get({
      id: empty.preset!.id,
    }))!.options, {});
    await app.presets.delete({
      id,
    });
    await app.presets.delete({
      id,
    });
    assert.equal(await app.presets.get({
      id,
    }), undefined);
    assert.equal((await app.presets.list({})).length, 1);
    await app.close();
    app = await open();
    assert.equal(await app.presets.get({
      id,
    }), undefined);
    assert.deepEqual(await app.settings.get(), defaults);
  });
}

test('preset API rejects malformed external inputs without writes or arbitrary configuration limits', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-presets-validation-'));
  const app = await createApplication({
    directory,
  });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, {
      recursive: true,
      force: true,
    });
  });
  const api = apiMethods(app);
  const invalid = [
    null,
    {},
    { name: 'Missing options' },
    { name: '', options: {} },
    { name: ' \n ', options: {} },
    { name: 42, options: {} },
    { id: '', name: 'Name', options: {} },
    { name: 'Name', options: null },
    { name: 'Name', options: { instructions: null } },
    { name: 'Name', options: { modelId: 42 } },
    { name: 'Name', options: { review: { enabled: 'false' } } },
    { name: 'Name', options: { review: { maxRounds: 0 } } },
    { name: 'Name', options: { review: { maxRounds: 1.5 } } },
    { name: 'Name', options: { review: { participants: {} } } },
    { name: 'Name', options: { review: { participants: [{ name: 'Missing instructions' }] } } },
    { name: 'Name', options: { review: { participants: [{ name: 'Name', instructions: '', modelId: 2 }] } } },
    { name: 'Name', options: { review: { participants: [{ name: 'Name', instructions: '', tools: [2] }] } } },
    { name: 'Name', options: { role: 'special' } },
    { name: 'Name', options: { review: { role: 'special' } } },
    { name: 'Name', options: {}, role: 'special' },
  ];
  for (const input of invalid)
    await assert.rejects(api['presets.save'](input));

  for (const method of ['presets.get', 'presets.delete'] as const) {
    for (const input of [{}, { id: '' }, { id: 42 }, null])
      await assert.rejects(api[method](input));
  }
  await assert.rejects(api['presets.list']({
    unexpected: true,
  }));
  assert.deepEqual(await app.presets.list({}), []);
  const large = await api['presets.save']({
    name: 'Name'.repeat(500),
    options: {
      modelId: 'custom-model'.repeat(500),
      review: {
        participants: Array.from({
          length: 50,
        }, (_, index) => ({ name: String(index), instructions: 'Editable', modelId: 'arbitrary' })),
      },
    },
  });
  assert.equal(large.ok, true);
});

test('preset copies, saved runs and defaults remain independent after mutations, updates and deletion', async (t) => {
  const f = await presetApplication(t);
  const defaults = await f.app.settings.get();
  const options: LaunchOptions = {
    modelId: f.modelId,
    instructions: '',
    review: {
      enabled: false,
      participants: [{ name: 'Original name', instructions: 'Original focus', modelId: f.modelId }],
    },
  };
  const saved = await f.app.presets.save({
    name: 'Original',
    options,
  });
  const id = saved.preset!.id;
  options.review!.participants![0].name = 'Mutated input';
  saved.preset!.options.instructions = 'Mutated result';
  const record = (await f.app.presets.get({
    id,
  }))!;
  assert.equal(record.options.instructions, '');
  assert.equal(record.options.review!.participants![0].name, 'Original name');
  const listed = await f.app.presets.list({});
  listed[0].options.review!.participants![0].instructions = 'Mutated list';
  assert.equal((await f.app.presets.get({
    id,
  }))!.options.review!.participants![0].instructions, 'Original focus');
  const copied = structuredClone(record.options);
  copied.review!.participants![0].name = 'Launch-only name';
  const started = await f.app.runs.start({
    taskId: f.taskId,
    options: copied,
  });
  assert.equal(started.ok, true, started.error);
  const runId = started.run!.id;
  copied.instructions = 'Changed after launch';
  copied.review!.participants![0].name = 'Changed after launch';
  await f.app.presets.save({
    id,
    name: 'Updated',
    options: { instructions: 'New instructions', review: { enabled: true } },
  });
  await f.app.presets.delete({
    id,
  });
  const run = (await f.app.runs.wait({
    id: runId,
  }))!;
  assert.equal(run.status, 'completed');
  assert.notEqual(run.workspace, f.root);
  assert.equal(await fs.readFile(path.join(run.workspace, 'README.md'), 'utf8'), 'Initial\n');
  assert.equal(run.options?.instructions, '');
  assert.equal(run.options?.review?.enabled, false);
  assert.equal(run.options?.review?.participants?.[0].name, 'Launch-only name');
  assert.equal(run.review, undefined);
  assert.equal((await f.app.sessions.get({
    id: run.sessionId,
  }))!.instructions, '');
  assert.equal((await f.app.sessions.get({
    id: run.sessionId,
  }))!.policy, 'Application instructions');
  assert.deepEqual(await f.app.settings.get(), defaults);
  const ordinary = await f.app.runs.start({
    taskId: f.taskId,
    options: {},
  });
  assert.equal(ordinary.ok, true, ordinary.error);
  const next = (await f.app.runs.wait({
    id: ordinary.run!.id,
  }))!;
  assert.notEqual(next.workspace, run.workspace);
  assert.equal((await f.app.sessions.get({
    id: next.sessionId,
  }))!.policy, defaults.instructions);
  await f.app.close();
  const reopened = await createApplication({
    directory: f.state,
    transports: [f.transport],
  });
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.runs.get({
    id: runId,
  }))!.options, run.options);
  assert.equal(await reopened.presets.get({
    id,
  }), undefined);
});
