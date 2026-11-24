import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../modules/application/create-application.ts';
import { startApiServer } from '../modules/api/server.ts';
import { ApiClient } from '../modules/api/client.ts';
import { apiCredential } from '../modules/api/credentials.ts';

test('the feature API validates external inputs, persists edits, sends safe notifications and reconnects without replay', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-feature-api-'));
  const app = await createApplication({ directory });
  const token = 'test-local-api-token';
  const server = await startApiServer({ application: app, port: 0, token });
  const client = new ApiClient({ url: `ws://127.0.0.1:${server.port}`, token });
  t.after(async () => {
    client.close();
    await server.close();
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const notifications: unknown[] = [];
  client.subscribe((notification) => {
    notifications.push(notification);
  });
  const untrusted = new ApiClient({ url: `ws://127.0.0.1:${server.port}`, token: 'wrong-token' });
  const previous = await app.settings.get();
  await assert.rejects(untrusted.call('settings.update', { instructions: 'Untrusted change' }));
  untrusted.close();
  assert.equal((await app.settings.get()).instructions, previous.instructions);
  assert.deepEqual(await client.call('projects.list', {}), []);
  const missing = await client.call('projects.connect', { root: path.join(directory, 'missing') });
  assert.equal(missing.ok, false);
  const invalidModel = await client.call('models.save', {
    configuration: {
      name: 'Invalid',
      transport: 'openai-compatible',
      endpoint: 'http://127.0.0.1:1/v1',
      model: 'fixture',
      contextTokens: 1024,
      outputTokens: 2048,
    },
  });
  assert.equal(invalidModel.ok, false);
  assert.ok(invalidModel.error!.includes('Context'));
  const credential = 'fixture-not-a-real-credential';
  const saved = await client.call('models.save', {
    configuration: {
      name: 'Local model',
      transport: 'openai-compatible',
      endpoint: 'http://127.0.0.1:1/v1',
      model: 'fixture',
    },
    apiKey: credential,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.configuration!.thinking, true);
  assert.ok(!JSON.stringify(saved).includes(credential));
  assert.ok(!JSON.stringify(await client.call('models.list', {})).includes(credential));
  const agent = await client.call('agents.save', {
    name: 'Any name',
    description: 'Custom task',
    instructions: 'Instructions',
  });
  assert.ok(notifications.length > 0);
  assert.ok(!JSON.stringify(notifications).includes(credential));
  client.close();
  assert.equal((await client.call('agents.list', {}))[0].id, agent.id);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = reject;
  });
  await new Promise<void>((resolve) => {
    socket.onmessage = () => resolve();
    socket.send(JSON.stringify({ type: 'authenticate', token }));
  });
  t.after(() => {
    socket.close();
  });
  async function raw(
    method: string,
    params: unknown,
  ): Promise<{ id: string; ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      socket.onmessage = (event) => resolve(JSON.parse(String(event.data)));
      socket.send(JSON.stringify({ id: 'raw', method, params }));
    });
  }
  assert.equal(
    (await raw('tasks.create', { projectId: 'one', title: 12, description: '' })).ok,
    false,
  );
  assert.equal((await raw('__proto__', {})).ok, false);
});

test('concurrent local clients receive the same complete private API credential', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-api-credential-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokens = await Promise.all(Array.from({ length: 8 }, () => apiCredential({ directory })));
  assert.ok(tokens.every((token) => token === tokens[0] && token.length === 64));
  assert.equal((await fs.stat(path.join(directory, 'private', 'api-token'))).mode & 0o077, 0);
});
