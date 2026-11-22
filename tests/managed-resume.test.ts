import { fixtureToolEffect } from './fixtures/tool-broker.ts';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ManagedSession,
  ManagedSessionStore,
  ToolBroker,
  ToolScope,
} from '../core/model-ports.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { ContextMaterial, Run, Snapshot } from '../protocol/domain.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';

const material = (letter: string): ContextMaterial => ({
  id: 'M-' + letter.repeat(8),
  name: letter + '.txt',
  mimeType: 'text/plain',
  size: 1,
  hash: letter.repeat(64),
  relativePath: 'local/context/' + letter.repeat(64) + '.txt',
  scope: 'goal',
  active: true,
  createdAt: '2026-11-20T00:00:00.000Z',
});
const policy = (allowedPaths = ['src/'], command = 'node old-check') => ({
  scope: { mode: 'advisory' as const, plannedPaths: allowedPaths, protectedPaths: ['checks/'] },
  checks: [{ id: 'check', title: 'Check' }],
  defaultCheckIds: ['check'],
  maxWorkers: 1,
  turnTimeoutMs: 10000,
  profile: { checks: [{ id: 'check', title: 'Check', command, timeoutMs: 10000 }] },
});
const limits = {
  contextTokens: 100000,
  maxOutputTokens: 2000,
  maxRequestsPerTurn: 4,
  maxToolCallsPerTurn: 4,
  maxSessionRequests: 30,
};
const turnOptions = () => ({
  schema: { type: 'object' },
  signal: new AbortController().signal,
  timeoutMs: 10000,
});

async function fixture(t: any, fileStore = false) {
  const run = {
    id: 'R-owner',
    workspace: '/repo/worktree',
    baseCommit: 'a'.repeat(40),
    executionPolicySnapshot: policy(),
    contextMaterials: [material('a')],
    repairEnvironment: false,
  } as unknown as Run;
  const snapshot = {
    project: { id: 'p', name: 'Fixture', root: '/repo' },
    runs: [run],
    contextMaterials: [material('f')],
  } as unknown as Snapshot;
  const projects = {
    get: () => ({ snapshot: () => structuredClone(snapshot) }),
  } as unknown as ProjectRegistry;
  const records = new Map<string, ManagedSession>();
  const memory: ManagedSessionStore = {
    async load(id) {
      const value = records.get(id);
      return value ? structuredClone(value) : undefined;
    },
    async save(session) {
      records.set(session.id, structuredClone(session));
    },
  };
  const directory = fileStore
    ? await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-resume-')))
    : undefined;
  const sessions = directory ? new FileManagedSessions(directory) : memory;
  let serial = 0;
  const scopes: ToolScope[] = [];
  const runtimes: ManagedAgentRuntime[] = [];
  const make = (
    store: ManagedSessionStore = sessions,
    provider?: ModelProvider,
    tools?: ToolBroker,
  ) => {
    const runtime = new ManagedAgentRuntime({
      loopRunner: new PiAgentLoopRunner(),
      id: 'managed',
      model: 'fixture',
      projects,
      sessions: store,
      limits,
      idGenerator: () => String(++serial),
      tools: tools || {
        revision: 'fixture-tools-v1',
        effect: fixtureToolEffect,
        definitions(scope) {
          scopes.push(structuredClone(scope));
          return [
            {
              name: 'read_file',
              description: 'Read assigned input',
              parameters: { type: 'object' },
            },
          ];
        },
        async execute() {
          return { content: 'read result' };
        },
      },
      provider: provider || {
        id: 'provider',
        revision: '1',
        local: true,
        async complete() {
          return {
            model: 'fixture',
            finish: 'stop',
            message: {
              role: 'assistant',
              content: '{}',
              continuation: { private: 'preserved reasoning' },
            },
          };
        },
      },
    });
    runtimes.push(runtime);
    return runtime;
  };
  const start = (runtime: ManagedAgentRuntime, extra = {}) =>
    runtime.start({
      projectId: 'p',
      runId: run.id,
      workspace: run.workspace,
      instructions: 'original',
      ...extra,
    });
  const resume = (runtime: ManagedAgentRuntime, threadId: string, extra = {}) =>
    runtime.resume({
      projectId: 'p',
      runId: run.id,
      threadId,
      workspace: run.workspace!,
      instructions: 'updated',
      ...extra,
    });
  t.after(async () => {
    for (const runtime of runtimes) await runtime.dispose().catch(() => {});
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });
  return { run, snapshot, projects, sessions, memory, records, scopes, make, start, resume };
}

test('manual managed continuation snapshots revised scope and materials without rewriting prior evidence', async (t) => {
  const f = await fixture(t, true);
  let response = 0;
  const runtime = f.make(f.sessions, {
    id: 'provider',
    revision: '1',
    local: true,
    async complete() {
      return ++response === 1
        ? {
            model: 'fixture',
            finish: 'tools',
            message: {
              role: 'assistant',
              content: '',
              continuation: { private: 'reasoning before tool' },
              toolCalls: [
                { id: 'read-once', name: 'read_file', arguments: { path: 'src/file.ts' } },
              ],
            },
          }
        : {
            model: 'fixture',
            finish: 'stop',
            message: {
              role: 'assistant',
              content: '{}',
              continuation: { private: 'final reasoning' },
            },
          };
    },
  });
  const { threadId } = await f.start(runtime);
  await runtime.turn(threadId, 'Read once', turnOptions());
  const before = (await f.sessions.load(threadId))!;
  f.run.contextMaterials = [material('b')];
  f.run.executionPolicySnapshot = policy(
    ['src/', 'docs/'],
    'node new-check',
  ) as Run['executionPolicySnapshot'];
  f.run.repairEnvironment = true;
  await f.resume(runtime, threadId);
  const after = (await f.sessions.load(threadId))!;
  assert.deepEqual(after.scope.materials, ['.buro/context/' + 'b'.repeat(64) + '.txt']);
  assert.ok(after.scope.writeScope.plannedPaths.includes('docs/'));
  assert.ok(after.scope.writeScope.plannedPaths.includes('package.json'));
  assert.equal(after.scope.commands[0].command, 'node new-check');
  assert.deepEqual(after.actions, before.actions);
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
  assert.equal(after.scopeRevisions?.length, 2);
  assert.deepEqual(after.scopeRevisions?.[0].scope, before.scope);
  assert.equal(after.scopeRevisions?.[1].instructions, 'updated');
  assert.deepEqual(after.scopeRevisions?.[1].scope, after.scope);
  assert.match(JSON.stringify(after.messages), /reasoning before tool/);
  await runtime.release(threadId);
  const restored = f.make();
  await f.resume(restored, threadId);
  assert.equal((await f.sessions.load(threadId))?.scopeRevisions?.length, 3);
});

test('explicit owning run binds environment activity to its frozen manifest, not current project material', async (t) => {
  const f = await fixture(t);
  const runtime = f.make();
  const { threadId } = await f.start(runtime, {
    runId: 'environment-R-owner',
    ownerRunId: f.run.id,
    readOnly: true,
    purpose: 'environment',
  });
  const before = (await f.sessions.load(threadId))!;
  assert.equal(before.scope.ownerRunId, f.run.id);
  assert.equal(before.scope.runId, 'environment-R-owner');
  assert.match(before.scope.materials[0], /aaaa/);
  assert.doesNotMatch(before.scope.materials[0], /ffff/);
  f.run.contextMaterials = [material('b')];
  await f.resume(runtime, threadId, { runId: 'environment-R-owner', ownerRunId: f.run.id });
  const after = (await f.sessions.load(threadId))!;
  assert.equal(after.scope.readOnly, true);
  assert.match(after.scope.materials[0], /bbbb/);
  await assert.rejects(
    f.resume(runtime, threadId, { runId: 'environment-R-owner', ownerRunId: 'R-other' }),
    { code: 'SESSION_MISMATCH' },
  );
});

test('a resumed managed session can actually read a newly selected staged attachment', async (t) => {
  const f = await fixture(t, true);
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'managed-attachment-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  f.snapshot.project.root = path.join(directory, 'project');
  f.run.workspace = path.join(directory, 'worktree');
  await fs.mkdir(path.join(f.run.workspace, '.buro/context'), { recursive: true });
  const relative = '.buro/context/' + 'b'.repeat(64) + '.txt';
  await fs.writeFile(path.join(f.run.workspace, relative), 'new attachment');
  let calls = 0;
  const runtime = f.make(
    f.sessions,
    {
      id: 'provider',
      revision: '1',
      local: true,
      async complete(input) {
        if (++calls === 1)
          return {
            model: 'fixture',
            finish: 'tools',
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'read-new', name: 'read_file', arguments: { path: relative } }],
            },
          };
        const result = JSON.parse(input.messages.at(-1)!.content);
        assert.equal(result.text, 'new attachment');
        return {
          model: 'fixture',
          finish: 'stop',
          message: { role: 'assistant', content: '{"seen":true}' },
        };
      },
    },
    new RepositoryTools(new EnvironmentExecutors()),
  );
  const { threadId } = await f.start(runtime, { readOnly: true });
  f.run.contextMaterials = [material('b')];
  await f.resume(runtime, threadId);
  assert.deepEqual(
    JSON.parse(
      (await runtime.turn(threadId, 'Read the newly selected attachment', turnOptions())).text,
    ),
    { seen: true },
  );
  assert.equal((await f.sessions.load(threadId))?.actions[0].result?.isError, undefined);
});

test('explicit worker continuation adopts advisory policy without an old hidden fence and rejects incompatible strict replan', async (t) => {
  const f = await fixture(t, true),
    runtime = f.make();
  const { threadId } = await f.start(runtime, {
    assignment: {
      sessionId: 'S-worker',
      roleId: 'builder',
      scope: { mode: 'advisory', plannedPaths: ['src/owned.ts'], protectedPaths: ['checks/'] },
    },
  });
  f.run.executionPolicySnapshot = policy(['./']) as Run['executionPolicySnapshot'];
  await f.resume(runtime, threadId);
  let saved = (await f.sessions.load(threadId))!;
  assert.deepEqual(saved.scope.writeScope, {
    mode: 'advisory',
    plannedPaths: ['src/owned.ts'],
    protectedPaths: ['checks/'],
  });
  f.run.executionPolicySnapshot = {
    ...policy(['docs/']),
    scope: { mode: 'strict', plannedPaths: ['docs/'], protectedPaths: ['checks/'] },
  } as Run['executionPolicySnapshot'];
  await assert.rejects(f.resume(runtime, threadId), { code: 'SESSION_SCOPE_CHANGED' });
  assert.equal((await f.sessions.load(threadId))!.scopeRevisions!.length, 2);
  f.run.executionPolicySnapshot = {
    ...policy(['src/']),
    scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
  } as Run['executionPolicySnapshot'];
  await f.resume(runtime, threadId);
  saved = (await f.sessions.load(threadId))!;
  assert.equal(saved.scope.writeScope.mode, 'strict');
  assert.deepEqual(saved.scope.writeScope.plannedPaths, ['src/owned.ts']);
  assert.equal(saved.scopeRevisions![0].scope.writeScope.mode, 'advisory');
});

test('private checkpoints reject changes to previously saved scope history', async (t) => {
  const f = await fixture(t, true),
    runtime = f.make();
  const { threadId } = await f.start(runtime);
  const checkpoint = (await f.sessions.load(threadId))!;
  checkpoint.scopeRevisions![0].scope.writeScope.mode = 'strict';
  await assert.rejects(f.sessions.save(checkpoint), { code: 'INVALID_CHECKPOINT' });
  assert.equal(
    (await f.sessions.load(threadId))!.scopeRevisions![0].scope.writeScope.mode,
    'advisory',
  );
});

test('failed scope-revision persistence cannot grant uncommitted permissions to later turns', async (t) => {
  const f = await fixture(t);
  let reject = true;
  const store: ManagedSessionStore = {
    load: (id) => f.memory.load(id),
    save: (session) => {
      if (reject && (session.scopeRevisions?.length || 0) > 1)
        return Promise.reject(Error('disk failed'));
      return f.memory.save(session);
    },
  };
  const runtime = f.make(store);
  const { threadId } = await f.start(runtime);
  f.run.executionPolicySnapshot = policy(['./']) as Run['executionPolicySnapshot'];
  await assert.rejects(f.resume(runtime, threadId), /disk failed/);
  await runtime.turn(threadId, 'Still original', turnOptions());
  assert.ok(f.scopes.every((scope) => !scope.writeScope.plannedPaths.includes('./')));
  assert.equal((await f.memory.load(threadId))?.scopeRevisions?.length, 1);
  reject = false;
  await f.resume(runtime, threadId);
  assert.deepEqual((await f.memory.load(threadId))?.scope.writeScope.plannedPaths, ['./']);
});

test('unknown tool outcomes and identity changes cannot be repaired by replacing scope', async (t) => {
  const f = await fixture(t);
  const runtime = f.make();
  const { threadId } = await f.start(runtime, { readOnly: true });
  await assert.rejects(f.resume(runtime, threadId, { projectId: 'other' }), {
    code: 'SESSION_MISMATCH',
  });
  await assert.rejects(f.resume(runtime, threadId, { workspace: '/elsewhere' }), {
    code: 'SESSION_MISMATCH',
  });
  await runtime.release(threadId);
  const saved = (await f.sessions.load(threadId))!;
  saved.actions.push({
    id: 'A-unknown',
    turnId: 'T-old',
    call: { id: 'call', name: 'edit_file', arguments: {} },
    status: 'unknown',
  });
  await f.sessions.save(saved);
  await assert.rejects(f.resume(runtime, threadId), { code: 'ACTION_RECONCILIATION_REQUIRED' });
  assert.equal((await f.sessions.load(threadId))?.scopeRevisions?.length, 1);
});

test('resume reserves its session until the revised scope is durably saved', async (t) => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store: ManagedSessionStore = {
    load: (id) => f.memory.load(id),
    async save(session) {
      if ((session.scopeRevisions?.length || 0) > 1) {
        entered();
        await gate;
      }
      await f.memory.save(session);
    },
  };
  const runtime = f.make(store);
  const { threadId } = await f.start(runtime);
  const pending = f.resume(runtime, threadId);
  await entering;
  await assert.rejects(runtime.turn(threadId, 'Concurrent', turnOptions()), {
    code: 'SESSION_BUSY',
  });
  await assert.rejects(f.resume(runtime, threadId), { code: 'SESSION_BUSY' });
  release();
  await pending;
  assert.equal((await f.memory.load(threadId))?.scopeRevisions?.length, 2);
});

test('failed cancellation persistence still aborts inference and cleanup observes its termination', async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let aborted = false;
  const store: ManagedSessionStore = {
    load: (id) => f.memory.load(id),
    async save(session) {
      if (session.cancelRequested) throw Error('disk failed');
      await f.memory.save(session);
    },
  };
  const runtime = f.make(store, {
    id: 'provider',
    revision: '1',
    local: true,
    async complete({ signal }) {
      entered();
      await new Promise<never>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new DOMException('Interrupted', 'AbortError'));
          },
          { once: true },
        ),
      );
      throw Error('Unreachable');
    },
  });
  let turnId = '';
  runtime.subscribe((event) => {
    if (event.type === 'turn.started') turnId = event.turnId || '';
  });
  const { threadId } = await f.start(runtime);
  const turn = runtime.turn(threadId, 'Wait', turnOptions());
  const rejected = assert.rejects(turn, { code: 'GENERATION_RECONCILIATION_REQUIRED' });
  await entering;
  await assert.rejects(runtime.interrupt(threadId, turnId), /disk failed/);
  await rejected;
  assert.equal(aborted, true);
  await runtime.release(threadId);
});

test('strict start rejects an exact-file plan expanded to a directory before saving or generating', async (t) => {
  const f = await fixture(t);
  let generated = 0;
  const runtime = f.make(f.sessions, {
    id: 'provider',
    revision: '1',
    local: true,
    async complete() {
      generated++;
      throw Error('No generation expected');
    },
  });
  f.run.executionPolicySnapshot = {
    ...policy(['src']),
    scope: { mode: 'strict', plannedPaths: ['src'], protectedPaths: ['checks/'] },
  } as Run['executionPolicySnapshot'];
  await assert.rejects(
    f.start(runtime, {
      assignment: {
        sessionId: 'S-worker',
        roleId: 'builder',
        scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
      },
    }),
    { code: 'SESSION_SCOPE_CHANGED' },
  );
  assert.equal(f.records.size, 0);
  assert.equal(generated, 0);
  assert.equal(f.scopes.length, 0);
});

test('strict resume cannot retain a directory grant after the parent policy becomes an exact-file selector', async (t) => {
  const f = await fixture(t, true);
  let generated = 0;
  const runtime = f.make(f.sessions, {
    id: 'provider',
    revision: '1',
    local: true,
    async complete() {
      generated++;
      throw Error('No generation expected');
    },
  });
  f.run.executionPolicySnapshot = {
    ...policy(['src/']),
    scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
  } as Run['executionPolicySnapshot'];
  const { threadId } = await f.start(runtime, {
    assignment: {
      sessionId: 'S-worker',
      roleId: 'builder',
      scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
    },
  });
  const before = (await f.sessions.load(threadId))!;
  f.run.executionPolicySnapshot.scope.plannedPaths = ['src'];
  await assert.rejects(f.resume(runtime, threadId), { code: 'SESSION_SCOPE_CHANGED' });
  const after = (await f.sessions.load(threadId))!;
  assert.deepEqual(after.scope, before.scope);
  assert.deepEqual(after.scopeRevisions, before.scopeRevisions);
  assert.equal(generated, 0);
  assert.equal(f.scopes.length, 0);
});

test('advisory assignment selectors remain guidance when the parent plan names an exact file', async (t) => {
  const f = await fixture(t),
    runtime = f.make();
  f.run.executionPolicySnapshot = policy(['src']) as Run['executionPolicySnapshot'];
  const { threadId } = await f.start(runtime, {
    assignment: {
      sessionId: 'S-worker',
      roleId: 'builder',
      scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
    },
  });
  assert.deepEqual((await f.sessions.load(threadId))!.scope.writeScope.plannedPaths, ['src/']);
});
