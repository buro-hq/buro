import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../modules/application/create-application.ts';
import { ApiClient } from '../modules/api/client.ts';
import { startApiServer } from '../modules/api/server.ts';
import type { Application } from '../modules/application/application.ts';
import { FeatureCli } from '../cli/feature-cli.ts';

test('a second application cannot interrupt work owned by the first, and ownership is released on close', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-application-owner-'));
  let first: Application | undefined, second: Application | undefined;
  t.after(async () => {
    await first?.close();
    await second?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  first = await createApplication({ directory });
  await first.settings.update({ instructions: 'Keep the first application intact' });
  await assert.rejects(createApplication({ directory }), /Another Buro server/);
  assert.equal((await first.settings.get()).instructions, 'Keep the first application intact');
  await first.close();
  second = await createApplication({ directory });
  assert.equal((await second.settings.get()).instructions, 'Keep the first application intact');
});

test('model discovery uses a draft or a saved private credential without saving a connection or starting inference', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-model-discovery-'));
  const calls: { key?: string; model: string }[] = [];
  const credential = 'fixture-secret-not-a-real-key';
  const app = await createApplication({
    directory,
    transports: [
      {
        id: 'extension',
        name: 'Extension',
        create({ configuration, apiKey }) {
          return {
            id: configuration.id,
            revision: configuration.revision,
            async listModels() {
              calls.push({ key: apiKey, model: configuration.model });
              return [{ id: 'fixture', name: 'Fixture model' }];
            },
            async complete() {
              throw new Error('Discovery must never start inference');
            },
          };
        },
      },
    ],
  });
  const server = await startApiServer({ application: app, token: 'fixture-token', port: 0 }),
    client = new ApiClient({ url: `ws://127.0.0.1:${server.port}`, token: 'fixture-token' });
  t.after(async () => {
    client.close();
    await server.close();
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(await client.call('models.transports', {}), [
    { id: 'extension', name: 'Extension' },
  ]);
  const draft = await client.call('models.discover', {
    configuration: { transport: 'extension' },
    apiKey: credential,
  });
  assert.deepEqual(draft, { ok: true, models: [{ id: 'fixture', name: 'Fixture model' }] });
  assert.deepEqual(await client.call('models.list', {}), []);
  const saved = await client.call('models.save', {
    configuration: {
      transport: 'extension',
      name: 'Saved model',
      model: 'fixture',
      capacity: 3,
      reasoningEffort: 'high',
    },
    apiKey: credential,
  });
  const discovered = await client.call('models.discover', {
    configuration: { id: saved.configuration!.id, transport: 'extension' },
  });
  assert.equal(discovered.ok, true);
  assert.ok(calls.every((call) => call.key === credential));
  assert.ok(!JSON.stringify(discovered).includes(credential));
  assert.equal((await client.call('models.list', {})).length, 1);
  const cli = new FeatureCli({ client });
  const cleared = (await cli.call({
    method: 'models.save',
    params: {
      configuration: {
        id: saved.configuration!.id,
        name: 'Saved model',
        transport: 'extension',
        model: 'fixture',
        capacity: null,
        reasoningEffort: null,
      },
    },
  })) as { configuration: { capacity?: number; reasoningEffort?: string; hasApiKey: boolean } };
  assert.equal(cleared.configuration.capacity, undefined);
  assert.equal(cleared.configuration.reasoningEffort, undefined);
  assert.equal(cleared.configuration.hasApiKey, true);
  await assert.rejects(cli.call({ method: 'tasks.create', params: { title: 42 } }), /Invalid API/);
  await assert.rejects(cli.watch({ id: 'missing' }), /Run not found/);
});
