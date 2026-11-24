import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModelCompletion, ModelProvider } from '../agent/contracts/model.ts';
import { SqliteStorage } from '../modules/storage/sqlite-storage.ts';
import { JsonStorage } from '../modules/storage/json-storage.ts';
import { EventBus } from '../modules/events/event-bus.ts';
import type { Notification } from '../modules/events/notifications.ts';
import { ModelRegistry } from '../modules/models/model-registry.ts';
import { ToolRegistry } from '../modules/tools/tool-registry.ts';
import { ActivityLog } from '../modules/sessions/activity.ts';
import { SessionService } from '../modules/sessions/session-service.ts';
import { TaskService } from '../modules/tasks/task-service.ts';
import { ProjectService } from '../modules/projects/project-service.ts';
import { RunService } from '../modules/runs/run-service.ts';
import { GitWorkspaces } from '../modules/workspaces/git-workspaces.ts';
import { conversationContext } from '../modules/sessions/context.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function reply(content: string, finish: ModelCompletion['finish'] = 'stop'): ModelCompletion {
  return { model: 'test-model', finish, message: { role: 'assistant', content } };
}

function tool(name: string, argumentsValue: unknown = {}): ModelCompletion {
  return { ...reply('', 'tools'), message: { role: 'assistant', content: '',
    toolCalls: [{ id: 'call-' + name, name, arguments: argumentsValue }] } };
}

function fixture(t: { after(callback: () => Promise<void>): void }) {
  const storage = new SqliteStorage({ filename: ':memory:' });
  const observations: Notification[] = [];
  const events = new EventBus();
  events.subscribe(event => { observations.push(event); });
  const models = new ModelRegistry({ adapterState: storage.records('adapter-state') });
  const tools = new ToolRegistry();
  const activity = new ActivityLog({ store: storage.records('activity') });
  const sessions = new SessionService({ store: storage.records('sessions'), models, tools, activity, events });
  t.after(() => storage.close());
  function model(id: string, complete: ModelProvider['complete']) {
    models.register({ id, name: id, model: id, contextTokens: 32768, outputTokens: 8192,
      provider: { id, revision: id + '-v1', local: true, complete } });
  }
  return { storage, models, tools, activity, sessions, observations, model, events };
}

for (const backend of ['sqlite', 'json']) {
  test(`${backend}: feature state persists independently of notifications and returned objects`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-modules-'));
    const open = () => backend === 'sqlite'
      ? new SqliteStorage({ filename: path.join(directory, 'state.sqlite') })
      : new JsonStorage({ directory });
    let storage = open();
    t.after(async () => { await storage.close(); await fs.rm(directory, { recursive: true, force: true }); });
    const events = new EventBus();
    events.subscribe(() => { throw new Error('An observer cannot undo persisted work'); });
    const tasks = new TaskService({ store: storage.records('tasks'), events });
    const created = await tasks.create({ projectId: 'project', title: 'Original', description: 'Intent' });
    created.title = 'Changed by caller';
    assert.equal((await tasks.get({ id: created.id }))!.title, 'Original');
    await storage.close();
    storage = open();
    const reopened = new TaskService({ store: storage.records('tasks'), events: new EventBus() });
    assert.equal((await reopened.get({ id: created.id }))!.title, 'Original');
    assert.equal((await storage.records('sessions').list()).length, 0);
    assert.equal(await reopened.update({ id: 'missing', projectId: 'project', title: 'Missing', description: '' }), undefined);
  });
}

test('any session can use tools and return a result without a role, workflow grammar, reviewer or mandatory checks', async t => {
  const f = fixture(t);
  let writes = 0, requests = 0;
  f.tools.register({ effect: 'write', definition: { name: 'save', description: 'Save the requested result', parameters: { type: 'object' } },
    async execute() { writes++; return { content: 'Saved' }; } });
  f.model('local', async input => {
    requests++;
    assert.equal(input.schema, undefined);
    if (requests === 1) return tool('save');
    assert.equal(input.messages.at(-1)!.content, 'Saved');
    return reply('Done');
  });
  const created = await f.sessions.create();
  const result = await f.sessions.run({ sessionId: created.sessionId, input: 'Complete the task', workspace: '/tmp' });
  assert.equal(result.text, 'Done');
  assert.equal(writes, 1);
  assert.equal((await f.sessions.get({ id: created.sessionId }))!.status, 'completed');
});

test('output truncation continues inside the model/tool loop and never executes an incomplete proposal', async t => {
  const f = fixture(t);
  let requests = 0, writes = 0;
  f.tools.register({ effect: 'write', definition: { name: 'save', description: 'Save', parameters: { type: 'object' } },
    async execute() { writes++; return { content: 'Saved once' }; } });
  f.model('local', async input => {
    requests++;
    if (requests === 1) return { ...tool('save'), finish: 'length' };
    if (requests === 2) {
      assert.ok(input.messages.some(message => message.role === 'tool' && message.content.includes('not executed')));
      return tool('save');
    }
    return reply('Done');
  });
  const created = await f.sessions.create();
  const result = await f.sessions.run({ sessionId: created.sessionId, input: 'Save it', workspace: '/tmp' });
  assert.equal(result.ok, true);
  assert.equal(writes, 1);
  assert.equal(requests, 3);
});

test('model changes keep the same history while private adapter state stays with its model and outside notifications', async t => {
  const f = fixture(t);
  const privateA = 'private-test-continuation-A';
  const privateB = 'private-test-continuation-B';
  let firstRequests = 0;
  f.tools.register({ effect: 'read', definition: { name: 'switch', description: 'Select another model', parameters: { type: 'object' } },
    async execute(input) {
      const modelId = (input.arguments as { modelId: string }).modelId;
      assert.equal(await f.sessions.switchModel({ sessionId: input.context.sessionId, modelId }), true);
      return { content: 'Selected ' + modelId };
    } });
  f.model('first', async input => {
    firstRequests++;
    if (firstRequests === 1) {
      const response = tool('switch', { modelId: 'second' });
      response.message.continuation = { value: privateA };
      return response;
    }
    assert.ok(JSON.stringify(input.messages).includes(privateA));
    assert.ok(!JSON.stringify(input.messages).includes(privateB));
    return reply('Finished with shared history');
  });
  f.model('second', async input => {
    assert.ok(input.messages.some(message => message.content === 'Selected second'));
    assert.ok(!JSON.stringify(input.messages).includes(privateA));
    const response = tool('switch', { modelId: 'first' });
    response.message.continuation = { value: privateB };
    return response;
  });
  const created = await f.sessions.create({ modelId: 'first' });
  const result = await f.sessions.run({ sessionId: created.sessionId, input: 'Use both models', workspace: '/tmp' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.sessionId, created.sessionId);
  assert.equal((await f.sessions.list()).length, 1);
  assert.ok(!JSON.stringify(f.observations).includes('private-test-continuation'));
  assert.ok(!JSON.stringify(await f.sessions.get({ id: created.sessionId })).includes('private-test-continuation'));
});

test('a second writer cannot enter a session while independent sessions remain runnable', async t => {
  const f = fixture(t);
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => started = resolve);
  const waiting = new Promise<void>(resolve => release = resolve);
  let requests = 0;
  f.model('local', async () => { requests++; started(); await waiting; return reply('Done'); });
  const first = await f.sessions.create(), second = await f.sessions.create();
  const active = f.sessions.run({ sessionId: first.sessionId, input: 'First', workspace: '/tmp' });
  const duplicate = await f.sessions.run({ sessionId: first.sessionId, input: 'Duplicate', workspace: '/tmp' });
  assert.equal(duplicate.ok, false);
  await entered;
  const independent = f.sessions.run({ sessionId: second.sessionId, input: 'Second', workspace: '/tmp' });
  release();
  assert.ok((await active).ok);
  assert.ok((await independent).ok);
  assert.equal(requests, 2);
});

async function projectFixture(t: { after(callback: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-run-modules-'));
  const root = path.join(directory, 'source');
  await fs.mkdir(root);
  await exec('git', ['init', '-q', root]);
  await exec('git', ['config', 'user.name', 'Buro test'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await fs.writeFile(path.join(root, 'result.txt'), 'original');
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-qm', 'Initial'], { cwd: root });
  const f = fixture({ after() {} });
  const projects = new ProjectService({ store: f.storage.records('projects'), events: f.events });
  const tasks = new TaskService({ store: f.storage.records('tasks'), events: f.events });
  const runs = new RunService({ store: f.storage.records('runs'), projects, tasks, sessions: f.sessions,
    workspaces: new GitWorkspaces({ directory: path.join(directory, 'workspaces') }), events: f.events });
  t.after(async () => { await runs.close(); await f.storage.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const project = await projects.connect({ root });
  const task = await tasks.create({ projectId: project.id, title: 'Write the result', description: 'Keep the source intact.' });
  return { ...f, root, directory, projects, tasks, runs, task };
}

test('parallel runs of one task have independent files and linked sessions; completion needs no review gate', async t => {
  const f = await projectFixture(t);
  let waiting = 0, release!: () => void;
  const bothEntered = new Promise<void>(resolve => release = resolve);
  f.tools.register({ effect: 'write', definition: { name: 'save', description: 'Save', parameters: {} },
    async execute({ context }) {
      await fs.writeFile(path.join(context.workspace, 'result.txt'), context.runId!);
      if (++waiting === 2) release();
      await bothEntered;
      return { content: context.runId! };
    } });
  f.model('local', async ({ messages }) => messages.at(-1)?.role === 'tool' ? reply('Done') : tool('save'));
  const starts = await Promise.all([f.runs.start({ taskId: f.task.id }), f.runs.start({ taskId: f.task.id })]);
  assert.ok(starts.every(start => start.ok));
  const [first, second] = starts.map(start => start.run!);
  const finished = await Promise.all(starts.map(start => f.runs.wait({ id: start.run!.id })));
  assert.ok(finished.every(run => run?.status === 'completed'));
  assert.notEqual(first.workspace, second.workspace);
  assert.equal(await fs.readFile(path.join(first.workspace, 'result.txt'), 'utf8'), first.id);
  assert.equal(await fs.readFile(path.join(second.workspace, 'result.txt'), 'utf8'), second.id);
  assert.equal(await fs.readFile(path.join(f.root, 'result.txt'), 'utf8'), 'original');
  assert.equal((await f.sessions.get({ id: first.sessionId }))!.runId, first.id);
  assert.notEqual(first.sessionId, second.sessionId);
});

test('retry carries saved files and history into a new attempt and preserves explicit access options', async t => {
  const f = await projectFixture(t);
  let requests = 0;
  f.model('local', async input => {
    requests++;
    if (requests === 1) return reply('First attempt result');
    assert.ok(input.messages.some(message => message.content === 'First attempt result'));
    assert.ok(input.messages.at(-1)!.content.includes('new attempt'));
    return reply('Continued result');
  });
  const first = (await f.runs.start({ taskId: f.task.id, options: { readOnly: true, tools: [] } })).run!;
  await f.runs.wait({ id: first.id });
  await fs.writeFile(path.join(first.workspace, 'result.txt'), 'preserved edit');
  await fs.writeFile(path.join(first.workspace, 'new.txt'), 'preserved untracked file');
  const retry = (await f.runs.retry({ id: first.id })).run!;
  assert.notEqual(retry.id, first.id);
  assert.notEqual(retry.sessionId, first.sessionId);
  assert.notEqual(retry.workspace, first.workspace);
  assert.equal(retry.previousRunId, first.id);
  assert.deepEqual(retry.options, { readOnly: true, tools: [] });
  assert.equal(await fs.readFile(path.join(retry.workspace, 'result.txt'), 'utf8'), 'preserved edit');
  assert.equal(await fs.readFile(path.join(retry.workspace, 'new.txt'), 'utf8'), 'preserved untracked file');
  assert.equal((await f.runs.wait({ id: retry.id }))!.status, 'completed');
  assert.equal((await f.sessions.get({ id: retry.sessionId }))!.parentId, first.sessionId);
});

test('recovery marks an abandoned run interrupted and a new attempt does not replay an unknown tool outcome', async t => {
  const f = await projectFixture(t);
  f.model('local', async () => reply('Initial'));
  const previous = (await f.runs.start({ taskId: f.task.id })).run!;
  await f.runs.wait({ id: previous.id });
  const session = (await f.sessions.get({ id: previous.sessionId }))!;
  await f.storage.records('sessions').save({ ...session, status: 'running',
    messages: [...session.messages, tool('external-action').message] });
  await f.storage.records('runs').save({ ...previous, status: 'running' });
  let actions = 0;
  f.tools.register({ effect: 'command', definition: { name: 'external-action', description: 'Action', parameters: {} },
    async execute() { actions++; return { content: 'Executed' }; } });
  f.model('local', async input => {
    assert.ok(input.messages.some(message => message.role === 'tool' && message.content.includes('outcome is unknown')));
    return reply('Inspected saved state');
  });
  await f.runs.recover();
  assert.equal((await f.runs.get({ id: previous.id }))!.status, 'interrupted');
  const next = (await f.runs.retry({ id: previous.id })).run!;
  assert.equal((await f.runs.wait({ id: next.id }))!.status, 'completed');
  assert.equal(actions, 0);
});

test('oversized tool output cannot evict the current request and context projection does not change saved history', () => {
  const messages = [
    { role: 'system' as const, content: 'Instructions' },
    { role: 'user' as const, content: 'Original task' },
    { role: 'assistant' as const, content: '', toolCalls: [{ id: 'read', name: 'read', arguments: {} }] },
    { role: 'tool' as const, toolCallId: 'read', content: 'x'.repeat(100000) },
    { role: 'user' as const, content: 'Current task: fix the saved file' },
  ];
  const context = conversationContext({ messages, contextTokens: 1024, outputTokens: 256 });
  assert.ok(context.some(message => message.content.includes('Current task')));
  assert.ok(context.some(message => message.role === 'tool' && message.toolCallId === 'read'));
  assert.ok(JSON.stringify(context).length < (1024 - 256) * 4);
  assert.equal(messages[3].content.length, 100000);
});

test('ambiguous tool IDs are a response failure, never authority to perform actions', async t => {
  const f = fixture(t);
  let writes = 0;
  f.tools.register({ effect: 'write', definition: { name: 'save', description: 'Save', parameters: {} },
    async execute() { writes++; return { content: 'Saved' }; } });
  f.model('local', async () => { const response = tool('save'); response.message.toolCalls!.push(response.message.toolCalls![0]); return response; });
  const created = await f.sessions.create();
  const result = await f.sessions.run({ sessionId: created.sessionId, input: 'Save', workspace: '/tmp' });
  assert.equal(result.ok, false);
  assert.equal(writes, 0);
});
