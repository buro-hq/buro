import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { CodexRuntime } from '../adapters/codex/runtime.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { EnvironmentExecutors } from '../adapters/environments/executors.ts';

const limits = {
  contextTokens: 32768,
  maxOutputTokens: 512,
  maxRequestsPerTurn: 8,
  maxToolCallsPerTurn: 8,
  maxSessionRequests: 16,
};
const answer = (content = '{"ok":true}') => ({
  model: 'fixture-model',
  message: { role: 'assistant' as const, content },
  finish: 'stop' as const,
  usage: { inputTokens: 10, outputTokens: 5 },
});
const call = (name = 'read_file') => ({
  ...answer('{"toolPolicy":"normal"}'),
  finish: 'tools' as const,
  message: {
    role: 'assistant' as const,
    content: '',
    toolCalls: [{ id: 'call-1', name, arguments: { path: 'src/value.ts' } }],
  },
});
const turnOptions = () => ({
  schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  signal: new AbortController().signal,
  timeoutMs: 1000,
});

async function fixture(t: any, complete: ModelProvider['complete'], separate = false) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-planning-gate-')),
  );
  const sessions = new FileManagedSessions(directory);
  const projects = {
    get: () => ({
      snapshot: () => ({
        project: { id: 'p', root: directory },
        runs: [{ id: 'R-test', workspace: directory }],
      }),
    }),
  } as unknown as ProjectRegistry;
  const reservations: string[] = [],
    effects: string[] = [];
  let nextId = 0;
  const runtime = new ManagedAgentRuntime({
    id: 'managed-fixture',
    model: 'fixture-model',
    projects,
    sessions,
    limits,
    provider: {
      id: 'fixture',
      revision: '1',
      local: true,
      ...(separate ? { structuredToolMode: 'separate-turn' as const } : {}),
      complete,
    },
    idGenerator: () => String(++nextId),
    budgets: {
      reserveGeneration: async (input) => {
        reservations.push('generation');
        return { operationId: input.operationId, maxOutputTokens: input.requestedOutputTokens };
      },
      recordUsage: async () => {},
      reserveTools: async () => {
        reservations.push('tools');
      },
    },
    tools: {
      definitions: () => [
        {
          name: 'read_file',
          description: 'Read an assigned input',
          parameters: { type: 'object' },
        },
      ],
      execute: async (input) => {
        effects.push(input.name);
        return { content: 'fixture input' };
      },
    },
  });
  t.after(async () => {
    await runtime.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const { threadId } = await runtime.start({
    projectId: 'p',
    runId: 'R-test',
    instructions: 'Coordinate the goal',
    purpose: 'coordination',
  });
  return { directory, sessions, runtime, threadId, reservations, effects };
}

test('tools-free planning persists authority before HTTP and requests the Ollama JSON schema directly', async (t) => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  let requests = 0;
  f = await fixture(
    t,
    async (input) => {
      requests++;
      const saved = (await f.sessions.load(f.threadId))!;
      assert.equal(saved.workSegments, undefined);
      assert.deepEqual(saved.turnAuthorities, [
        { turnId: 'T-2', toolPolicy: 'none', startedAtRequest: 0, scopeRevision: 1 },
      ]);
      assert.equal(saved.requests, 1);
      assert.deepEqual(input.tools, []);
      assert.deepEqual(input.schema, turnOptions().schema);
      assert.match(input.messages.at(-1)!.content, /Return your final answer as JSON/);
      return answer();
    },
    true,
  );
  await f.runtime.turn(f.threadId, 'Plan the goal', { ...turnOptions(), toolPolicy: 'none' });
  assert.equal(requests, 1);
  assert.deepEqual(f.reservations, ['generation']);
  assert.deepEqual(f.effects, []);
});

test('a none turn rejects every tool before reservation, intent journal and broker effects', async (t) => {
  const f = await fixture(t, async () => call());
  await assert.rejects(
    f.runtime.turn(f.threadId, 'Plan', { ...turnOptions(), toolPolicy: 'none' }),
    { code: 'TOOL_POLICY_VIOLATION' },
  );
  assert.deepEqual(f.reservations, ['generation']);
  assert.deepEqual(f.effects, []);
  const saved = (await f.sessions.load(f.threadId))!;
  assert.deepEqual(saved.actions, []);
  assert.equal(saved.turnAuthorities![0].toolPolicy, 'none');
  assert.equal(saved.usage.requestsWithUsage, 1);
});

test('ordinary turns also reject a tool missing from their actual advertised definitions', async (t) => {
  const f = await fixture(t, async () => call('run_hidden_command'));
  await assert.rejects(f.runtime.turn(f.threadId, 'Work', turnOptions()), {
    code: 'TOOL_POLICY_VIOLATION',
  });
  assert.deepEqual(f.reservations, ['generation']);
  assert.deepEqual(f.effects, []);
  assert.deepEqual((await f.sessions.load(f.threadId))!.actions, []);
});

test('the explicit next service turn restores ordinary tools without changing the frozen scope', async (t) => {
  const requests: Parameters<ModelProvider['complete']>[0][] = [];
  const f = await fixture(
    t,
    async (input) => {
      requests.push(
        structuredClone({
          ...input,
          signal: undefined,
          onProgress: undefined,
          onEvent: undefined,
        }) as any,
      );
      return requests.length === 2 ? call() : answer();
    },
    true,
  );
  const initial = (await f.sessions.load(f.threadId))!;
  await f.runtime.turn(f.threadId, 'Plan', { ...turnOptions(), toolPolicy: 'none' });
  await f.runtime.turn(f.threadId, 'Work', turnOptions());
  const saved = (await f.sessions.load(f.threadId))!;
  assert.deepEqual(saved.scope, initial.scope);
  assert.deepEqual(saved.scopeRevisions, initial.scopeRevisions);
  assert.deepEqual(
    saved.turnAuthorities!.map((entry) => entry.toolPolicy),
    ['none', 'normal'],
  );
  assert.deepEqual(
    saved.turnAuthorities!.map((entry) => entry.startedAtRequest),
    [0, 1],
  );
  assert.deepEqual(f.effects, ['read_file']);
  assert.equal(requests.length, 4); // Planning has no extra phase; normal Ollama work retains one.
  assert.equal(requests[1].tools[0].name, 'read_file');
  assert.equal(requests[1].schema, undefined);
  assert.deepEqual(requests[3].tools, []);
});

test('nonsegmented coordinator checkpoints reject authority rollback and counter or scope resets', async (t) => {
  const f = await fixture(t, async () => answer());
  await f.runtime.turn(f.threadId, 'Plan', { ...turnOptions(), toolPolicy: 'none' });
  const saved = (await f.sessions.load(f.threadId))!;
  for (const mutate of [
    (next: typeof saved) => {
      delete next.turnAuthorities;
    },
    (next: typeof saved) => {
      next.turnAuthorities![0].toolPolicy = 'normal';
    },
    (next: typeof saved) => {
      next.requests = 0;
    },
    (next: typeof saved) => {
      next.usage.outputTokens = 0;
    },
    (next: typeof saved) => {
      next.requestedModel = 'other';
    },
    (next: typeof saved) => {
      next.scope.writeScope.plannedPaths.push('secret/');
    },
    (next: typeof saved) => {
      next.turnAuthorities!.push({
        turnId: 'T-forged',
        toolPolicy: 'normal',
        startedAtRequest: 0,
        scopeRevision: 1,
      });
    },
  ]) {
    const next = structuredClone(saved);
    mutate(next);
    await assert.rejects(async () => f.sessions.save(next));
  }
  assert.deepEqual(await f.sessions.load(f.threadId), saved);
});

test('a none authority with a tool action is rejected on checkpoint load as well as save', async (t) => {
  const f = await fixture(t, async () => answer());
  await f.runtime.turn(f.threadId, 'Plan', { ...turnOptions(), toolPolicy: 'none' });
  const saved = (await f.sessions.load(f.threadId))!;
  saved.actions.push({
    id: 'A-forged',
    turnId: saved.turnAuthorities![0].turnId,
    call: call().message.toolCalls[0],
    status: 'pending',
  });
  await assert.rejects(async () => f.sessions.save(saved));
  await fs.writeFile(path.join(f.directory, f.threadId + '.json'), JSON.stringify(saved));
  await assert.rejects(f.sessions.load(f.threadId));
});

test('native Codex explicitly rejects tools-free authority before lookup or process launch', async () => {
  const runtime = new CodexRuntime({
    id: 'codex',
    projects: {} as ProjectRegistry,
    executable: '/does-not-exist',
  });
  assert.throws(
    () => runtime.turn('never-started', 'Plan', { ...turnOptions(), toolPolicy: 'none' }),
    { code: 'TOOL_POLICY_UNSUPPORTED' },
  );
  assert.equal(runtime.active.size, 0);
  await runtime.dispose();
});

test('native inspection requests a real read-only session and pins the same model before discovery and app-server', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-codex-pin-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'codex-fixture.mjs');
  const log = path.join(directory, 'argv.jsonl');
  const requests = path.join(directory, 'rpc.jsonl');
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args.includes('mcp')) console.log('[]');
else {
 const lines=readline.createInterface({input:process.stdin});
 for await(const line of lines){
  const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(requests)},line+'\\n');
  const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');
  if(m.method==='initialize')send({id:m.id,result:{}});
  if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'native'}}});
  if(m.method==='turn/start'){
   const turn={id:'turn',status:'completed'};send({id:m.id,result:{turn}});
   send({method:'item/completed',params:{threadId:'native',turnId:'turn',item:{id:'answer',type:'agentMessage',text:'{}'}}});
   send({method:'turn/completed',params:{threadId:'native',turn}});
  }
 }
}
`,
    { mode: 0o755 },
  );
  const projects = {
    get: () => ({ snapshot: () => ({ project: { root: directory } }) }),
  } as unknown as ProjectRegistry;
  const executors = {
    isVerificationWorkspace: () => false,
    get: () => ({ cacheRoot: path.join(directory, 'cache') }),
    launch: (_root: string, argv: string[]) => ({
      executable: argv[0],
      args: argv.slice(1),
      cwd: directory,
      env: process.env,
    }),
  } as unknown as EnvironmentExecutors;
  const runtime = new CodexRuntime({
    id: 'codex',
    projects,
    executors,
    executable,
    model: 'gpt-6.1-sol',
    reasoningEffort: 'high',
    networkAccess: false,
  });
  t.after(() => runtime.dispose());
  const { threadId } = await runtime.start({
    projectId: 'p',
    instructions: 'Fixture',
    readOnly: true,
  });
  await runtime.turn(threadId, 'Inspect and plan', turnOptions());
  await runtime.submit(threadId, 'Correct plan');
  await runtime.dispose();
  const argv = (await fs.readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(argv.length, 3);
  for (const args of argv) {
    assert.ok(args.includes('model="gpt-6.1-sol"'));
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.ok(args.includes('features.multi_agent=false'));
    assert.ok(args.includes('features.hooks=false'));
    assert.ok(args.includes('features.apps=false'));
    assert.equal(args.includes('--yolo'), false);
  }
  assert.equal(argv[2].at(-1), 'app-server');
  const rpc = (await fs.readFile(requests, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const turns = rpc.filter((entry) => entry.method === 'turn/start');
  const thread = rpc.find((entry) => entry.method === 'thread/start');
  assert.equal(thread.params.sandbox, 'read-only');
  assert.equal(thread.params.approvalPolicy, 'never');
  assert.equal(turns.length, 2);
  for (const entry of turns)
    assert.deepEqual(entry.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
});
