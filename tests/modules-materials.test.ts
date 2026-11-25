import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../modules/application/create-application.ts';

test('uploaded context is read in ranges through ordinary tools without broadcasting document contents', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-materials-'));
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
  const notifications: unknown[] = [];
  app.events.subscribe((notification) => {
    notifications.push(notification);
  });
  const original = 'Первая строка\nСодержимое документа\nПоследняя строка';
  const uploaded = await app.materials.upload({
    projectId: 'project',
    name: 'context.md',
    contentBase64: Buffer.from(original).toString('base64'),
  });
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.material!.textAvailable, true);
  assert.ok(!JSON.stringify(notifications).includes('Содержимое документа'));
  let requests = 0;
  app.models.register({
    id: 'fixture',
    name: 'Fixture',
    model: 'fixture',
    contextTokens: 32768,
    outputTokens: 8192,
    backend: {
      id: 'fixture',
      revision: 'one',
      async complete(input) {
        const call = (name: string, args: unknown) => ({
          model: 'fixture',
          finish: 'tools' as const,
          message: {
            role: 'assistant' as const,
            content: '',
            toolCalls: [{ id: name, name, arguments: args }],
          },
        });
        if (++requests === 1)
          return call('materials_list', {});

        if (requests === 2) {
          const listed = JSON.parse(input.messages.at(-1)!.content);
          assert.equal(listed[0].id, uploaded.material!.id);
          return call('material_read', {
            id: uploaded.material!.id,
            line: 2,
            count: 1,
          });
        }

        const read = JSON.parse(input.messages.at(-1)!.content);
        assert.equal(read.text, 'Содержимое документа');
        assert.equal(read.totalLines, 3);
        return {
          model: 'fixture',
          finish: 'stop',
          message: { role: 'assistant', content: 'Used the attached context' },
        };
      },
    },
  });
  const session = await app.sessions.create();
  const result = await app.sessions.run({
    sessionId: session.sessionId,
    projectId: 'project',
    input: 'Read the attachment',
    workspace: directory,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.text, 'Used the attached context');
  assert.equal(
    (await app.materials.download({
      id: uploaded.material!.id,
    })).contentBase64,
    Buffer.from(original).toString('base64'),
  );
  await app.materials.delete({
    id: uploaded.material!.id,
  });
  assert.equal((await app.materials.read({
    id: uploaded.material!.id,
  })).ok, false);
});

test('image references remain available without claiming their pixels were analyzed; loaders need no frozen startup catalog', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-material-loader-'));
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
  const uploaded = await app.materials.upload({
    projectId: 'project',
    name: 'image.png',
    contentBase64: Buffer.from([0, 1, 2, 3]).toString('base64'),
  });
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.material!.textAvailable, false);
  const result = await app.materials.read({
    id: uploaded.material!.id,
  });
  assert.equal(result.ok, false);
  assert.ok(result.error!.includes('do not include image pixels'));
  assert.equal((await app.materials.download({
    id: uploaded.material!.id,
  })).ok, true);
});
