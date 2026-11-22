import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import type { ToolBroker } from '../core/model-ports.ts';
import type { ModelCompletion } from '../agent/contracts/model.ts';
import type { ProjectRegistry } from '../core/ports.ts';

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-tool-revisions-')),
  );
  const sessions = new FileManagedSessions(path.join(directory, 'sessions'));
  let revision = 'fixture-tools-v1';
  let requests = 0;
  let effects = 0;
  let sequence = 0;
  let respond: () => ModelCompletion = () => ({
    model: 'fixture',
    finish: 'stop',
    message: { role: 'assistant', content: '{"ok":true}' },
  });
  const tools: ToolBroker = {
    get revision() {
      return revision;
    },
    effect: () => 'read',
    definitions: () => [
      {
        name: 'echo',
        description: 'Read-only test tool',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    execute: async () => {
      effects++;
      return { content: 'Observed' };
    },
  };
  const runtimes: ManagedAgentRuntime[] = [];
  const create = () => {
    const runtime = new ManagedAgentRuntime({
      id: 'fixture-runtime',
      model: 'fixture',
      tools,
      sessions,
      provider: {
        id: 'fixture-provider',
        revision: 'provider-v1',
        local: true,
        complete: async () => {
          requests++;
          return respond();
        },
      },
      projects: {
        get: () => ({ snapshot: () => ({ project: { id: 'p', root: directory }, runs: [] }) }),
      } as unknown as ProjectRegistry,
      idGenerator: () => String(++sequence),
      loopRunner: new PiAgentLoopRunner(),
      limits: {
        contextTokens: 4096,
        maxOutputTokens: 128,
        maxRequestsPerTurn: 8,
        maxToolCallsPerTurn: 8,
        maxSessionRequests: 16,
      },
    });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const input = {
    projectId: 'p',
    runId: 'R-tools',
    workspace: directory,
    purpose: 'research' as const,
    readOnly: true,
    instructions: 'Read-only fixture',
  };
  const turn = (runtime: ManagedAgentRuntime, id: string) =>
    runtime.turn(id, 'Respond once', {
      schema: { type: 'object' },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
  return {
    sessions,
    create,
    input,
    turn,
    setRevision: (value: string) => {
      revision = value;
    },
    setResponse: (value: () => ModelCompletion) => {
      respond = value;
    },
    requests: () => requests,
    effects: () => effects,
  };
}

test('a cached session cannot dispatch through a changed tool revision and restoring the original tools preserves continuation', async (t) => {
  const f = await fixture(t),
    runtime = f.create();
  const { threadId } = await runtime.start(f.input);
  f.setRevision('fixture-tools-v2');
  await assert.rejects(f.turn(runtime, threadId), { code: 'TOOL_CONFIGURATION_CHANGED' });
  assert.equal(f.requests(), 0);
  assert.equal(f.effects(), 0);
  assert.equal((await f.sessions.load(threadId))!.toolRevision, 'fixture-tools-v1');
  f.setRevision('fixture-tools-v1');
  await runtime.resume({ ...f.input, threadId });
  assert.equal((await f.turn(runtime, threadId)).text, '{"ok":true}');
  assert.equal(f.requests(), 1);
});

test('fresh runtime reopen and checkpoint writes cannot replace a captured tool configuration', async (t) => {
  const f = await fixture(t),
    original = f.create();
  const { threadId } = await original.start(f.input);
  await original.dispose();
  const before = (await f.sessions.load(threadId))!;
  await assert.rejects(f.sessions.save({ ...before, toolRevision: 'rewritten' }), {
    code: 'INVALID_CHECKPOINT',
  });
  f.setRevision('fixture-tools-v2');
  await assert.rejects(f.create().resume({ ...f.input, threadId }), {
    code: 'TOOL_CONFIGURATION_CHANGED',
  });
  assert.deepEqual(await f.sessions.load(threadId), before);
  assert.equal(f.requests(), 0);
  assert.equal(f.effects(), 0);
});

test('a tool change during generation preserves the exact model receipt and dispatches no proposed action', async (t) => {
  const f = await fixture(t),
    runtime = f.create();
  const { threadId } = await runtime.start(f.input);
  f.setResponse(() => {
    f.setRevision('fixture-tools-v2');
    return {
      model: 'fixture',
      finish: 'tools',
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'proposed', name: 'echo', arguments: {} }],
        continuation: { private: 'preserve' },
      },
    };
  });
  await assert.rejects(f.turn(runtime, threadId), { code: 'TOOL_CONFIGURATION_CHANGED' });
  const saved = (await f.sessions.load(threadId))!;
  assert.equal(saved.generation?.outcome, 'completed');
  assert.deepEqual(saved.generation?.response?.message.continuation, { private: 'preserve' });
  assert.equal(saved.generation?.response?.message.toolCalls?.[0].id, 'proposed');
  assert.equal(saved.toolRevision, 'fixture-tools-v1');
  assert.deepEqual(saved.actions, []);
  assert.equal(f.requests(), 1);
  assert.equal(f.effects(), 0);
});
