import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../modules/application/create-application.ts';
import { CodexBackend } from '../modules/engines/codex-backend.ts';
import { ToolRegistry } from '../modules/tools/tool-registry.ts';
import type { Tool, ToolContext } from '../modules/tools/tool.ts';

test('a native JSONL backend uses the common tool broker and keeps its observations in portable history', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-native-backend-'));
  const app = await createApplication({ directory });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  let writes = 0;
  app.tools.register({
    effect: 'write',
    definition: {
      name: 'save',
      description: 'Save',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      writes++;
      return { content: 'Saved by host' };
    },
  });
  app.models.register({
    id: 'native',
    name: 'Native',
    model: 'fixture',
    contextTokens: 32768,
    outputTokens: 8192,
    backend: new CodexBackend({
      id: 'native',
      revision: 'one',
      executable: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/native-backend.cjs', import.meta.url))],
    }),
  });
  const created = await app.sessions.create();
  const result = await app.sessions.run({
    sessionId: created.sessionId,
    input: 'Save the result',
    workspace: directory,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.text, 'Done by native');
  assert.equal(writes, 1);
  const history = (await app.sessions.get({ id: created.sessionId }))!.messages;
  assert.ok(
    history.some(
      (message) =>
        message.role === 'assistant' && message.toolCalls?.some((call) => call.name === 'save'),
    ),
  );
  assert.ok(
    history.some((message) => message.role === 'tool' && message.content === 'Saved by host'),
  );
  assert.equal(
    (await app.activity.list({ sessionId: created.sessionId })).filter(
      (event) => event.type === 'tool.completed',
    ).length,
    1,
  );
});

test('stateful tool instances retain their methods without mutating another invocation’s context', async () => {
  class StatefulTool implements Tool {
    effect = 'read' as const;
    definition = { name: 'stateful', description: 'Stateful tool', parameters: {} };
    calls = 0;
    async execute(input: { context: ToolContext }) {
      input.context.workspace = '/changed-by-tool';
      input.context.tools!.push('unexpected');
      return { content: String(++this.calls) };
    }
  }
  const registry = new ToolRegistry(),
    tool = new StatefulTool();
  registry.register(tool);
  const context = {
    sessionId: 'one',
    workspace: '/original',
    tools: ['stateful'],
    signal: new AbortController().signal,
  };
  assert.equal((await registry.execute({ name: 'stateful', arguments: {}, context })).content, '1');
  assert.equal((await registry.execute({ name: 'stateful', arguments: {}, context })).content, '2');
  assert.equal(context.workspace, '/original');
  assert.deepEqual(context.tools, ['stateful']);
});

test('a model selected from a native callback continues the same conversation with observed tool results', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-backend-switch-'));
  const app = await createApplication({ directory });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  let writes = 0;
  app.tools.register({
    effect: 'write',
    definition: { name: 'save', description: 'Save', parameters: {} },
    async execute() {
      writes++;
      return { content: 'Saved by first model' };
    },
  });
  app.models.register({
    id: 'first',
    name: 'First',
    model: 'first',
    contextTokens: 32768,
    outputTokens: 8192,
    backend: {
      id: 'first',
      revision: 'one',
      async complete(input) {
        await input.executeTool({ id: 'save', name: 'save', arguments: {} });
        await input.executeTool({
          id: 'select',
          name: 'model_select',
          arguments: { modelId: 'second' },
        });
        return {
          model: 'first',
          finish: 'stop',
          message: { role: 'assistant', content: 'First model result' },
        };
      },
    },
  });
  app.models.register({
    id: 'second',
    name: 'Second',
    model: 'second',
    contextTokens: 32768,
    outputTokens: 8192,
    backend: {
      id: 'second',
      revision: 'one',
      async complete(input) {
        assert.ok(
          input.messages.some(
            (message) => message.role === 'tool' && message.content === 'Saved by first model',
          ),
        );
        return {
          model: 'second',
          finish: 'stop',
          message: { role: 'assistant', content: 'Second model result' },
        };
      },
    },
  });
  const created = await app.sessions.create({ modelId: 'first' });
  const result = await app.sessions.run({
    sessionId: created.sessionId,
    input: 'Work together',
    workspace: directory,
  });
  assert.equal(result.text, 'Second model result');
  assert.equal(writes, 1);
  assert.equal((await app.sessions.list()).length, 1);
  assert.equal((await app.sessions.get({ id: created.sessionId }))!.modelId, 'second');
});

test('a native adapter cannot hide an unexpected tool failure by returning a successful terminal', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-native-tool-failure-'));
  const app = await createApplication({ directory });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  app.tools.register({
    effect: 'write',
    definition: { name: 'broken', description: 'Broken', parameters: {} },
    async execute() {
      throw new Error('Unexpected tool fault');
    },
  });
  app.models.register({
    id: 'native',
    name: 'Native',
    model: 'native',
    contextTokens: 32768,
    outputTokens: 8192,
    backend: {
      id: 'native',
      revision: 'one',
      async complete(input) {
        try {
          await input.executeTool({ id: 'broken', name: 'broken', arguments: {} });
        } catch {}
        return {
          model: 'native',
          finish: 'stop',
          message: { role: 'assistant', content: 'Pretend success' },
        };
      },
    },
  });
  const created = await app.sessions.create();
  const result = await app.sessions.run({
    sessionId: created.sessionId,
    input: 'Task',
    workspace: directory,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Unexpected tool fault');
  assert.equal((await app.sessions.get({ id: created.sessionId }))!.status, 'failed');
});
