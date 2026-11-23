import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ToolContributionCatalog } from '../core/tool-contributions.ts';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { ModelCompletion } from '../agent/contracts/model.ts';

test('captured argument validation retains refinements that are absent from advertised JSON schema', async () => {
  const catalog = new ToolContributionCatalog();
  let calls = 0;
  catalog.register({
    name: 'even_number_probe',
    revision: 'v1',
    description: 'Accept even numbers only',
    effect: 'read',
    schema: z.strictObject({ number: z.number().refine((number) => number % 2 === 0) }),
    async execute(input) {
      calls++;
      return { content: String(input.number) };
    },
  });
  catalog.seal();
  const tool = catalog.get('even_number_probe');
  await assert.rejects(tool.invoke({ number: 3 }, {} as any), { code: 'TOOL_ARGUMENTS' });
  assert.equal(calls, 0);
  assert.deepEqual(await tool.invoke({ number: 4 }, {} as any), { content: '4' });
  assert.equal(calls, 1);
});

async function fixture(
  t: any,
  catalog: ToolContributionCatalog,
  readOnly: boolean,
  respond: (names: string[], request: number) => ModelCompletion,
) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-tool-review-')),
  );
  await fs.writeFile(path.join(directory, 'value.txt'), 'original');
  const sessionsDirectory = path.join(directory, 'private-sessions'),
    sessions = new FileManagedSessions(sessionsDirectory),
    tools = new RepositoryTools(new EnvironmentExecutors(), catalog.seal());
  let requests = 0,
    sequence = 0;
  const runtime = new ManagedAgentRuntime({
    id: 'fixture-runtime',
    model: 'fixture-model',
    provider: {
      id: 'fixture-provider',
      revision: 'fixture-v1',
      local: true,
      async complete(input) {
        return respond(
          input.tools.map((tool) => tool.name),
          ++requests,
        );
      },
    },
    tools,
    sessions,
    projects: {
      get: () => ({
        snapshot: () => ({
          project: { id: 'p', root: directory },
          profile: { scope: { mode: 'strict', plannedPaths: ['value.txt'], protectedPaths: [] } },
          runs: [],
        }),
      }),
    } as unknown as ProjectRegistry,
    loopRunner: new PiAgentLoopRunner(),
    idGenerator: () => String(++sequence),
    limits: {
      contextTokens: 8192,
      maxOutputTokens: 256,
      maxRequestsPerTurn: 4,
      maxToolCallsPerTurn: 4,
      maxSessionRequests: 8,
    },
  });
  t.after(async () => {
    await runtime.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const { threadId } = await runtime.start({
    projectId: 'p',
    runId: 'fixture-owner',
    workspace: directory,
    instructions: 'Exercise contributed tools through the host.',
    readOnly,
  });
  const turn = () =>
    runtime.turn(threadId, 'Execute', {
      schema: z.toJSONSchema(z.strictObject({ ok: z.boolean() })),
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
  const reopen = () => new FileManagedSessions(sessionsDirectory).load(threadId);
  return { directory, runtime, threadId, turn, reopen, requests: () => requests };
}

test('an unauthorized custom command in a model batch prevents an earlier permitted real edit', async (t) => {
  const catalog = new ToolContributionCatalog();
  let writes = 0,
    commands = 0;
  catalog.register({
    name: 'apply_patch_alias',
    revision: 'v1',
    description: 'Write the assigned file',
    effect: 'write',
    schema: z.strictObject({}),
    async execute(_input, operations) {
      writes++;
      return operations.editFile({ path: 'value.txt', oldText: 'original', newText: 'changed' });
    },
  });
  catalog.register({
    name: 'launch_validation_alias',
    revision: 'v1',
    description: 'Run a configured command',
    effect: 'command',
    schema: z.strictObject({}),
    async execute(_input, operations) {
      commands++;
      return operations.runCommand({ command: 'not-configured' });
    },
  });
  const f = await fixture(t, catalog, false, (names) => {
    assert.deepEqual(names, ['apply_patch_alias']);
    return {
      model: 'fixture-model',
      finish: 'tools',
      message: {
        role: 'assistant',
        content: '',
        continuation: { private: 'original-provider-state' },
        toolCalls: [
          { id: 'first-write', name: 'apply_patch_alias', arguments: {} },
          { id: 'second-command', name: 'launch_validation_alias', arguments: {} },
        ],
      },
    };
  });
  await assert.rejects(f.turn(), { code: 'TOOL_POLICY_VIOLATION' });
  assert.equal(writes, 0);
  assert.equal(commands, 0);
  assert.equal(f.requests(), 1);
  assert.equal(await fs.readFile(path.join(f.directory, 'value.txt'), 'utf8'), 'original');
  const durable = (await f.reopen())!;
  assert.equal(durable.generation?.outcome, 'completed');
  assert.deepEqual(durable.generation?.response?.message.continuation, {
    private: 'original-provider-state',
  });
  assert.deepEqual(
    durable.generation?.response?.message.toolCalls?.map((call) => call.id),
    ['first-write', 'second-command'],
  );
  assert.deepEqual(durable.actions, []);
});

test('a familiar command-like name with a declared read effect remains a read tool in a read-only SDK session', async (t) => {
  const catalog = new ToolContributionCatalog();
  let reads = 0;
  catalog.register({
    name: 'run_command',
    revision: 'third-party-read-v1',
    description: 'Read an excerpt without starting a process',
    effect: 'read',
    schema: z.strictObject({}),
    async execute(_input, operations) {
      reads++;
      return operations.readFile({ path: 'value.txt' });
    },
  });
  const f = await fixture(t, catalog, true, (names, request) => {
    assert.deepEqual(names, ['run_command']);
    return request === 1
      ? {
          model: 'fixture-model',
          finish: 'tools',
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'read-wire-id', name: 'run_command', arguments: {} }],
          },
        }
      : {
          model: 'fixture-model',
          finish: 'stop',
          message: { role: 'assistant', content: '{"ok":true}' },
        };
  });
  assert.equal((await f.turn()).text, '{"ok":true}');
  assert.equal(reads, 1);
  assert.equal(f.requests(), 2);
  const durable = (await f.reopen())!;
  assert.equal(durable.scope.readOnly, true);
  assert.equal(durable.actions.length, 1);
  assert.equal(durable.actions[0].status, 'completed');
  assert.equal(durable.actions[0].call.name, 'run_command');
  assert.match(durable.actions[0].result!.content, /original/);
  assert.equal(await fs.readFile(path.join(f.directory, 'value.txt'), 'utf8'), 'original');
});
