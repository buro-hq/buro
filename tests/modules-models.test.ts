import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../modules/application/create-application.ts';
import { JsonStorage } from '../modules/storage/json-storage.ts';
import type { Application } from '../modules/application/application.ts';
import type { ModelTransport } from '../modules/models/model-configuration.ts';

for (const storage of ['sqlite', 'json'])
  test(`${storage}: concurrent model edits keep the latest credential and a coherent default through restart`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-model-edits-'));
    const credentials = new Map<string, string | undefined>();
    const transport: ModelTransport = {
      id: 'fixture',
      create({ configuration, apiKey }) {
        if (configuration.name === 'Throw in factory')
          throw new Error('Fixture construction failed');

        credentials.set(configuration.revision, apiKey);
        return {
          id: configuration.id,
          revision: configuration.revision,
          async complete() {
            throw new Error('No inference is needed');
          },
        };
      },
    };
    const open = () =>
      createApplication({
        directory,
        storage:
          storage === 'json'
            ? new JsonStorage({
                directory: path.join(directory, 'json'),
              })
            : undefined,
        transports: [transport],
      });
    let app: Application = await open();
    t.after(async () => {
      await app.close();
      await fs.rm(directory, {
        recursive: true,
        force: true,
      });
    });
    const configuration = {
      id: 'fixture',
      name: 'Initial',
      transport: 'fixture',
      model: 'fixture',
    };
    await app.modelConfigurations.save({
      configuration,
      apiKey: 'fixture-old',
    });
    await Promise.all([
      app.modelConfigurations.save({
        configuration,
        apiKey: 'fixture-new',
      }),
      app.modelConfigurations.save({
        configuration: { ...configuration, name: 'Renamed' },
      }),
    ]);
    assert.equal((await app.modelConfigurations.list())[0].name, 'Renamed');
    assert.equal(
      credentials.get(app.models.get({
        id: 'fixture',
      })!.backend.revision),
      'fixture-new',
    );
    await Promise.all([
      app.modelConfigurations.save({
        configuration: { ...configuration, id: 'second' },
        default: true,
      }),
      app.modelConfigurations.select({
        id: 'fixture',
      }),
    ]);
    assert.equal((await app.settings.get()).defaultModelId, 'fixture');
    assert.equal(app.models.get()!.id, 'fixture');
    await assert.rejects(
      app.modelConfigurations.save({
        configuration: { ...configuration, name: 'Throw in factory' },
      }),
      /Fixture construction failed/,
    );
    assert.equal(
      (
        await app.modelConfigurations.save({
          configuration: { ...configuration, name: 'After a rejected edit' },
        })
      ).ok,
      true,
    );
    await app.close();
    app = await open();
    assert.equal(
      credentials.get(app.models.get({
        id: 'fixture',
      })!.backend.revision),
      'fixture-new',
    );
    assert.equal(app.models.get()!.id, (await app.settings.get()).defaultModelId);
    await Promise.all([
      app.modelConfigurations.save({
        configuration,
      }),
      app.modelConfigurations.delete({
        id: 'fixture',
      }),
    ]);
    assert.equal(app.models.get({
      id: 'fixture',
    }), undefined);
    assert.equal(app.models.get()!.id, (await app.settings.get()).defaultModelId);
  });

test('concurrent first connections choose the same persisted and running default', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-first-models-'));
  const app = await createApplication({
    directory,
    transports: [
      {
        id: 'fixture',
        create({ configuration }) {
          return {
            id: configuration.id,
            revision: configuration.revision,
            async complete() {
              throw new Error('No inference');
            },
          };
        },
      },
    ],
  });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, {
      recursive: true,
      force: true,
    });
  });
  await Promise.all(
    ['one', 'two'].map((id) =>
      app.modelConfigurations.save({
        configuration: { id, name: id, transport: 'fixture', model: id },
      })),
  );
  assert.equal(app.models.get()!.id, (await app.settings.get()).defaultModelId);
});
