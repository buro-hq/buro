import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ToolContributionCatalog } from '../core/tool-contributions.ts';
import { DomainError } from '../core/ports.ts';
import type { ToolScope, ToolEffect } from '../core/model-ports.ts';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import { registerBuiltinRepositoryTools } from '../adapters/tools/builtin-tools.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import { createHost } from '../plugins/host.ts';
import type { ModelToolCall } from '../agent/contracts/model.ts';

async function directory(t: any) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-tool-contributions-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'checks'));
  await fs.writeFile(path.join(root, 'src/value.txt'), 'first\nsecond\n');
  await fs.writeFile(path.join(root, 'checks/contract.txt'), 'protected');
  await fs.writeFile(path.join(root, '.env'), 'PRIVATE_SENTINEL');
  return root;
}
const scope = (workspace: string): ToolScope => ({
  projectId: 'p',
  sessionId: 'S',
  workspace,
  readOnly: false,
  writeScope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
  materials: [],
  commands: [{ id: 'check', command: 'registered-check', timeoutMs: 1000 }],
});
const invoke = (tools: RepositoryTools, grant: ToolScope, name: string, args: unknown) =>
  tools.execute({ id: 'wire-call', name, arguments: args }, grant, {
    actionId: 'host-action',
    signal: new AbortController().signal,
  });
const contribution = (effect: ToolEffect = 'read', revision = 'plugin-v1') => ({
  name: 'plugin_tool',
  revision,
  description: 'A trusted contribution',
  effect,
  schema: z.strictObject({ path: z.string() }),
  execute: async (input: { path: string }, operations: any) => operations.readFile(input),
});

test('catalog rejects unsealed, duplicate, unknown and late tools and captures its definitions and revision', () => {
  const catalog = new ToolContributionCatalog(),
    registration = contribution();
  catalog.register(registration);
  assert.throws(() => new RepositoryTools(new EnvironmentExecutors(), catalog), {
    code: 'TOOL_CONTRIBUTIONS_UNSEALED',
  });
  assert.throws(() => catalog.register(registration), { code: 'TOOL_EXISTS' });
  catalog.seal();
  const revision = catalog.revision;
  registration.description = 'mutated';
  registration.revision = 'different';
  registration.execute = async () => ({ content: 'changed' });
  const definitions = catalog.definitions(scope('/synthetic'));
  definitions[0].description = 'external';
  (definitions[0].parameters.properties as any).path.type = 'number';
  assert.equal(catalog.get('plugin_tool').description, 'A trusted contribution');
  assert.equal(
    (catalog.definitions(scope('/synthetic'))[0].parameters.properties as any).path.type,
    'string',
  );
  assert.equal(catalog.revision, revision);
  assert.throws(() => catalog.get('missing'), { code: 'TOOL_UNAVAILABLE' });
  assert.throws(() => catalog.register({ ...registration, name: 'late' }), {
    code: 'TOOL_CONTRIBUTIONS_SEALED',
  });
  for (const changed of [
    contribution('write'),
    contribution('read', 'plugin-v2'),
    { ...contribution(), schema: z.strictObject({ path: z.string(), extra: z.boolean() }) },
  ]) {
    const other = new ToolContributionCatalog();
    other.register(changed);
    other.seal();
    assert.notEqual(other.revision, revision);
  }
});

test('argument validation rejects undeclared nested fields before calling a contributed handler', async (t) => {
  const root = await directory(t),
    catalog = new ToolContributionCatalog();
  let calls = 0;
  catalog.register({
    name: 'nested_read',
    revision: 'v1',
    description: 'Read nested input',
    effect: 'read',
    schema: z.object({ target: z.object({ path: z.string() }) }),
    async execute(input, operations) {
      calls++;
      return operations.readFile(input.target);
    },
  });
  catalog.seal();
  const tools = new RepositoryTools(new EnvironmentExecutors(), catalog);
  for (const input of [
    { target: { path: 'src/value.txt' }, extra: true },
    { target: { path: 'src/value.txt', extra: true } },
    { target: { path: () => {} } },
  ])
    assert.equal((await invoke(tools, scope(root), 'nested_read', input)).isError, true);
  assert.equal(calls, 0);
  assert.equal(
    (await invoke(tools, scope(root), 'nested_read', { target: { path: 'src/value.txt' } }))
      .isError,
    undefined,
  );
  assert.equal(calls, 1);
});

test('custom effect names obey read-only and strict policy, including helper calls with a stronger effect', async (t) => {
  const root = await directory(t),
    catalog = new ToolContributionCatalog();
  let handlers = 0,
    launches = 0;
  catalog.register({
    name: 'annotate_source',
    revision: 'v1',
    description: 'Edit source',
    effect: 'write',
    schema: z.strictObject({}),
    async execute(_input, operations) {
      handlers++;
      return operations.editFile({ path: 'src/value.txt', oldText: 'first', newText: 'changed' });
    },
  });
  catalog.register({
    name: 'verify_project',
    revision: 'v1',
    description: 'Run configured check',
    effect: 'command',
    schema: z.strictObject({}),
    async execute(_input, operations) {
      handlers++;
      return operations.runCommand({ command: 'registered-check' });
    },
  });
  catalog.register({
    name: 'read_attempts_write',
    revision: 'v1',
    description: 'Read-only contribution',
    effect: 'read',
    schema: z.strictObject({}),
    async execute(_input, operations) {
      return operations.editFile({ path: 'src/value.txt', oldText: 'first', newText: 'escaped' });
    },
  });
  catalog.seal();
  const tools = new RepositoryTools(
      {
        launch() {
          launches++;
          throw Error('Must not launch');
        },
      } as any,
      catalog,
    ),
    grant = scope(root);
  grant.readOnly = true;
  assert.deepEqual(
    tools.definitions(grant).map(({ name }) => name),
    ['read_attempts_write'],
  );
  assert.equal((await invoke(tools, grant, 'annotate_source', {})).isError, true);
  assert.equal((await invoke(tools, grant, 'verify_project', {})).isError, true);
  grant.readOnly = false;
  grant.writeScope.mode = 'strict';
  assert.equal((await invoke(tools, grant, 'verify_project', {})).isError, true);
  assert.equal((await invoke(tools, grant, 'read_attempts_write', {})).isError, true);
  assert.equal(handlers, 0);
  assert.equal(launches, 0);
  assert.equal(await fs.readFile(path.join(root, 'src/value.txt'), 'utf8'), 'first\nsecond\n');
});

test('contributed bounded helpers retain hard protections, private metadata and immutable workspace confinement', async (t) => {
  const root = await directory(t),
    catalog = new ToolContributionCatalog();
  catalog.register({
    ...contribution('write'),
    execute: (input, operations) =>
      operations.editFile({ path: input.path, oldText: 'protected', newText: 'changed' }),
  });
  catalog.register({ ...contribution(), name: 'read_alias' });
  catalog.seal();
  const tools = new RepositoryTools(new EnvironmentExecutors(), catalog),
    grant = scope(root);
  for (const target of ['checks/contract.txt', '../escape', '.env', '.git/config'])
    assert.equal((await invoke(tools, grant, 'plugin_tool', { path: target })).isError, true);
  for (const target of ['.env', '../escape', '.buro/local/control-state.json']) {
    const result = await invoke(tools, grant, 'read_alias', { path: target });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content, /PRIVATE_SENTINEL/);
  }
  const frozen = path.join(root, 'frozen');
  await fs.mkdir(frozen);
  await fs.writeFile(path.join(frozen, 'value.txt'), 'frozen');
  const review = {
    ...grant,
    workspace: frozen,
    readOnly: true,
    verificationViewId: 'issued',
    verificationTree: 'a'.repeat(40),
  };
  assert.equal(
    (await invoke(tools, review, 'read_alias', { path: path.join(root, 'src/value.txt') })).isError,
    true,
  );
  assert.match(
    (await invoke(tools, review, 'read_alias', { path: 'value.txt' })).content,
    /frozen/,
  );
  assert.equal(await fs.readFile(path.join(root, 'checks/contract.txt'), 'utf8'), 'protected');
});

test('handler inputs and workspace grants are captured before asynchronous work and returned results are detached', async (t) => {
  const root = await directory(t),
    catalog = new ToolContributionCatalog();
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    });
  const output = { content: 'initial' };
  catalog.register({
    ...contribution(),
    async execute(input, operations) {
      assert.ok(Object.isFrozen(input));
      started();
      await held;
      const value = await operations.readFile(input);
      output.content = value.content;
      return output;
    },
  });
  catalog.seal();
  const tools = new RepositoryTools(new EnvironmentExecutors(), catalog),
    grant = scope(root),
    args = { path: 'src/value.txt' };
  const running = invoke(tools, grant, 'plugin_tool', args);
  await entered;
  args.path = '.env';
  grant.workspace = '/outside';
  grant.readOnly = true;
  release();
  const result = await running;
  output.content = 'external mutation';
  assert.match(result.content, /first/);
  assert.doesNotMatch(result.content, /PRIVATE_SENTINEL|external mutation/);
});

test('DomainError after a bounded mutation is fatal instead of an ordinary recoverable tool result', async (t) => {
  const root = await directory(t),
    catalog = new ToolContributionCatalog();
  catalog.register({
    ...contribution('write'),
    async execute(input, operations) {
      await operations.editFile({ path: input.path, oldText: 'first', newText: 'changed' });
      throw new DomainError('TOOL_SCOPE', 'Failure after mutation');
    },
  });
  catalog.seal();
  const tools = new RepositoryTools(new EnvironmentExecutors(), catalog);
  await assert.rejects(invoke(tools, scope(root), 'plugin_tool', { path: 'src/value.txt' }), {
    code: 'TOOL_SCOPE',
  });
  assert.match(await fs.readFile(path.join(root, 'src/value.txt'), 'utf8'), /^changed/);
});

test('an unawaited bounded edit is drained before receipt and retained helpers cannot start later effects', async (t) => {
  const root = await directory(t),
    catalog = new ToolContributionCatalog();
  let retained: any, release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
      release = resolve;
    }),
    renaming = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const rename = fs.rename.bind(fs);
  let renames = 0;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    renames++;
    entered();
    await hold;
    await rename(...args);
  });
  catalog.register({
    ...contribution('write'),
    async execute(input, operations) {
      retained = operations;
      void operations.editFile({ path: input.path, oldText: 'first', newText: 'changed' });
      return { content: 'Handler returned' };
    },
  });
  catalog.seal();
  const tools = new RepositoryTools(new EnvironmentExecutors(), catalog);
  let settled = false;
  const running = invoke(tools, scope(root), 'plugin_tool', { path: 'src/value.txt' }).then(
    (result) => {
      settled = true;
      return result;
    },
  );
  await renaming;
  assert.equal(settled, false, 'the action must remain unsettled while its edit is in flight');
  assert.match(await fs.readFile(path.join(root, 'src/value.txt'), 'utf8'), /^first/);
  release();
  await running;
  assert.match(await fs.readFile(path.join(root, 'src/value.txt'), 'utf8'), /^changed/);
  await assert.rejects(
    retained.editFile({ path: 'src/value.txt', oldText: 'changed', newText: 'late' }),
    { code: 'TOOL_SCOPE' },
  );
  assert.equal(renames, 1);
  assert.match(await fs.readFile(path.join(root, 'src/value.txt'), 'utf8'), /^changed/);
});

test('a handler cannot swallow an unknown failure from its unawaited mutation helper', async (t) => {
  const root = await directory(t),
    catalog = new ToolContributionCatalog();
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args);
    throw new DomainError('TOOL_SCOPE', 'Uncertain post-rename failure');
  });
  catalog.register({
    ...contribution('write'),
    async execute(input, operations) {
      void operations
        .editFile({ path: input.path, oldText: 'first', newText: 'changed' })
        .catch(() => {});
      return { content: 'Claimed success' };
    },
  });
  catalog.seal();
  const tools = new RepositoryTools(new EnvironmentExecutors(), catalog);
  await assert.rejects(invoke(tools, scope(root), 'plugin_tool', { path: 'src/value.txt' }), {
    code: 'TOOL_SCOPE',
  });
  assert.match(await fs.readFile(path.join(root, 'src/value.txt'), 'utf8'), /^changed/);
});

async function managedFixture(t: any, mode: 'read' | 'throw-after-write' | 'invalid-after-write') {
  const root = await directory(t),
    calls: ModelToolCall[] = [];
  const host = await createHost({
    projects: [
      {
        storageAddress: path.join(root, '.buro', 'project'),
        project: { id: 'p', name: 'Fixture', root },
      },
    ],
    async configure(ctx) {
      await ctx.plugin({
        name: 'third-tool',
        inject: ['toolContributions'],
        apply(ctx) {
          ctx.toolContributions.catalog.register({
            name: 'project_excerpt',
            revision: 'third-tool-v1',
            description: 'Read or update through bounded repository helpers',
            effect: mode === 'read' ? 'read' : 'write',
            schema: z.strictObject({ path: z.string() }),
            async execute(input, operations) {
              if (mode === 'read') return operations.readFile(input);
              await operations.editFile({ path: input.path, oldText: 'first', newText: 'changed' });
              if (mode === 'throw-after-write')
                throw new DomainError('TOOL_SCOPE', 'Post-write failure');
              return { content: 42 } as any;
            },
          });
        },
      });
    },
  });
  const executors = new EnvironmentExecutors(),
    tools = new RepositoryTools(executors, host.ctx.toolContributions.catalog),
    sessions = new FileManagedSessions(path.join(root, '.buro', 'sessions'));
  let generations = 0;
  const provider = {
    id: 'synthetic',
    revision: 'v1',
    local: true,
    async complete(input: any) {
      generations++;
      assert.ok(input.tools.some((tool: any) => tool.name === 'project_excerpt'));
      if (generations === 1) {
        const call = {
          id: 'original-wire-call',
          name: 'project_excerpt',
          arguments: { path: 'src/value.txt' },
        };
        calls.push(structuredClone(call));
        return {
          model: 'synthetic',
          finish: 'tools' as const,
          message: { role: 'assistant' as const, content: '', toolCalls: [call] },
        };
      }
      return {
        model: 'synthetic',
        finish: 'stop' as const,
        message: { role: 'assistant' as const, content: '{"ok":true}' },
      };
    },
  };
  const options = {
    loopRunner: new PiAgentLoopRunner(),
    id: 'managed',
    model: 'synthetic',
    provider,
    sessions,
    tools,
    projects: host.ctx.projects.registry,
    idGenerator: randomUUID,
    limits: {
      contextTokens: 32768,
      maxOutputTokens: 1024,
      maxRequestsPerTurn: 8,
      maxToolCallsPerTurn: 8,
      maxSessionRequests: 32,
    },
  };
  const runtime = new ManagedAgentRuntime(options);
  t.after(async () => {
    await runtime.dispose();
    await host.dispose();
  });
  const { threadId } = await runtime.start({
    projectId: 'p',
    runId: 'standalone',
    workspace: root,
    readOnly: mode === 'read',
    instructions: 'Use the registered project tool.',
  });
  const turn = () =>
    runtime.turn(threadId, 'Execute', {
      schema: z.toJSONSchema(z.strictObject({ ok: z.boolean() })),
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
  return {
    root,
    host,
    tools,
    sessions,
    runtime,
    options,
    threadId,
    turn,
    calls,
    generations: () => generations,
  };
}

test('a real Cordis tool contribution executes through the SDK loop and sole host action journal', async (t) => {
  const f = await managedFixture(t, 'read');
  await f.turn();
  assert.equal(f.generations(), 2);
  const saved = (await f.sessions.load(f.threadId))!;
  assert.equal(saved.toolRevision, f.tools.revision);
  assert.equal(saved.actions.length, 1);
  assert.equal(saved.actions[0].status, 'completed');
  assert.deepEqual(saved.actions[0].call, f.calls[0]);
  assert.match(saved.actions[0].result!.content, /first/);
  assert.throws(() => f.host.ctx.toolContributions.catalog.register(contribution()), {
    code: 'TOOL_CONTRIBUTIONS_SEALED',
  });
  const changed = new ToolContributionCatalog();
  registerBuiltinRepositoryTools(changed);
  changed.register({ ...contribution('read', 'changed-v2'), name: 'project_excerpt' });
  changed.seal();
  const other = new ManagedAgentRuntime({
    ...f.options,
    tools: new RepositoryTools(new EnvironmentExecutors(), changed),
  });
  t.after(() => other.dispose());
  await assert.rejects(
    other.resume({
      projectId: 'p',
      runId: 'standalone',
      threadId: f.threadId,
      workspace: f.root,
      instructions: 'Continue',
    }),
    { code: 'TOOL_CONFIGURATION_CHANGED' },
  );
  assert.equal(f.generations(), 2);
});

for (const mode of ['throw-after-write', 'invalid-after-write'] as const)
  test(`contributed ${mode} retains an unknown host receipt and sends no follow-up generation`, async (t) => {
    const f = await managedFixture(t, mode);
    await assert.rejects(f.turn(), { code: 'ACTION_RECONCILIATION_REQUIRED' });
    assert.equal(f.generations(), 1);
    const saved = (await f.sessions.load(f.threadId))!;
    assert.equal(saved.actions[0].status, 'unknown');
    assert.equal(saved.actions[0].result, undefined);
    assert.deepEqual(saved.actions[0].call, f.calls[0]);
    assert.match(await fs.readFile(path.join(f.root, 'src/value.txt'), 'utf8'), /^changed/);
    await assert.rejects(f.turn(), { code: 'ACTION_RECONCILIATION_REQUIRED' });
    assert.equal(f.generations(), 1);
  });
