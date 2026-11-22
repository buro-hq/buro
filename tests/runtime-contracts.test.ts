import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeCodexEvent } from '../adapters/codex/events.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import type { RegisteredRuntime } from '../core/ports.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import { createHost } from '../plugins/host.ts';
import { runtimePlugin } from '../plugins/runtime.ts';

test('native child event formats normalize to the same public lifecycle without private payloads', () => {
  const old = normalizeCodexEvent(
    {
      method: 'item/completed',
      params: {
        threadId: 'parent',
        item: {
          id: 'old',
          type: 'subAgentActivity',
          kind: 'completed',
          agentThreadId: 'child',
          agentPath: '/root/builder',
          prompt: 'assigned task',
          reasoning_content: 'private reasoning',
        },
      },
    },
    'run',
    1,
  );
  const modern = normalizeCodexEvent(
    {
      method: 'item/completed',
      params: {
        threadId: 'parent',
        item: {
          id: 'modern',
          type: 'collabAgentToolCall',
          receiverThreadIds: ['child', null, 'parent'],
          agentsStates: { child: { status: 'completed', message: 'Done' } },
        },
      },
    },
    'run',
    2,
  );
  for (const events of [old, modern]) {
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.type, 'agent.activity');
    assert.equal(event.runId, 'run');
    assert.equal(event.threadId, 'child');
    if (event.type === 'agent.activity') {
      assert.equal(event.parentThreadId, 'parent');
      assert.equal(event.completed, true);
    }
    assert.doesNotMatch(
      JSON.stringify(event),
      /reasoning_content|private reasoning|subAgentActivity|collabAgentToolCall|"params"/,
    );
  }
  assert.deepEqual(
    normalizeCodexEvent(
      { method: 'item/agentMessage/delta', params: { threadId: 't', delta: 'private token' } },
      'run',
      3,
    ),
    [],
  );
  assert.deepEqual(
    normalizeCodexEvent(
      { method: 'thread/tokenUsage/updated', params: { threadId: 't', private: 'state' } },
      'run',
      4,
    ),
    [],
  );
});

test('normalized command evidence is bounded, phase-specific and stable across duplicate deliveries', () => {
  const raw = {
    method: 'item/completed',
    params: {
      threadId: 't',
      item: {
        id: 'cmd',
        type: 'commandExecution',
        command: 'npm test',
        exitCode: 2,
        aggregatedOutput: 'x'.repeat(40000) + 'failure tail',
        secret: 'private',
      },
    },
  };
  const [event] = normalizeCodexEvent(raw, 'run', 1);
  assert.deepEqual(normalizeCodexEvent(raw, 'run', 99), [event]);
  assert.equal(event.type, 'command.completed');
  if (event.type === 'command.completed') {
    assert.equal(event.exitCode, 2);
    assert.equal(event.output.length, 30000);
    assert.ok(event.output.endsWith('failure tail'));
  }
  const [start] = normalizeCodexEvent({ ...raw, method: 'item/started' }, 'run', 2);
  assert.equal(start.type, 'command.started');
  assert.notEqual(start.id, event.id);
  assert.doesNotMatch(JSON.stringify(event), /private|secret/);
});

test('unknown completion status never becomes success; malformed wire data does not escape', () => {
  const normalize = (params: unknown) =>
    normalizeCodexEvent({ method: 'turn/completed', params }, 'run', 1);
  for (const status of ['failed', 'inProgress', undefined]) {
    const [event] = normalize({ threadId: 't', turn: { id: 'turn', status } });
    assert.equal(event.type === 'turn.completed' && event.status, 'failed');
  }
  for (const params of [null, [], 'text', {}, { threadId: 42 }, { threadId: 't', item: null }])
    assert.doesNotThrow(() => normalize(params));
  assert.deepEqual(normalize(null), []);
  const first = normalizeCodexEvent(
    { method: 'turn/started', params: { threadId: 't' } },
    'run',
    1,
  );
  const second = normalizeCodexEvent(
    { method: 'turn/started', params: { threadId: 't' } },
    'run',
    2,
  );
  assert.notEqual(first[0].id, second[0].id);
});

function runtime(id: string, cleanup: () => Promise<void> = async () => {}): RegisteredRuntime {
  return {
    id,
    capabilities: fixtureCapabilities(),
    async start() {
      return { threadId: 'same-native-id' };
    },
    async submit() {
      return { turnId: id };
    },
    async interrupt() {},
    dispose: cleanup,
  };
}

test('registry selects exact adapters, rejects duplicates and never falls back', async () => {
  const registry = new RuntimeCatalog();
  const local = runtime('local'),
    cloud = runtime('cloud');
  registry.register(local);
  registry.register(cloud);
  assert.deepEqual(registry.list(), ['local', 'cloud']);
  const selectedLocal = registry.get('local');
  assert.notEqual(selectedLocal, local);
  assert.equal(selectedLocal.id, local.id);
  assert.equal(registry.get('cloud').id, cloud.id);
  assert.equal((await registry.get('local').submit('same-native-id', 'task')).turnId, 'local');
  assert.equal((await registry.get('cloud').submit('same-native-id', 'task')).turnId, 'cloud');
  assert.throws(() => registry.get('unavailable'), { code: 'RUNTIME_UNAVAILABLE' });
  assert.throws(() => registry.register(runtime('local')), { code: 'RUNTIME_EXISTS' });
  assert.equal(registry.get('local'), selectedLocal);
  await registry.dispose();
});

test('registry stops selection during disposal, cleans every adapter and reports failures once', async () => {
  const calls: string[] = [];
  const registry = new RuntimeCatalog();
  registry.register(
    runtime('broken', async () => {
      calls.push('broken');
      throw Error('cleanup failed');
    }),
  );
  registry.register(
    runtime('healthy', async () => {
      calls.push('healthy');
    }),
  );
  const disposal = registry.dispose();
  assert.equal(registry.dispose(), disposal);
  assert.throws(() => registry.get('healthy'), { code: 'RUNTIME_CLOSED' });
  assert.throws(() => registry.register(runtime('late')), { code: 'RUNTIME_CLOSED' });
  await assert.rejects(disposal, AggregateError);
  assert.deepEqual(calls.sort(), ['broken', 'healthy']);
});

test('generic Cordis runtime composition works without loading Codex and owns cleanup', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-runtimes-'));
  let cleaned = 0;
  const host = await createHost({
    projects: [{ storageAddress: directory, project: { id: 'p', name: 'P', root: directory } }],
  });
  t.after(async () => {
    await host.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const a = runtime('local', async () => {
      cleaned++;
    }),
    b = runtime('cloud', async () => {
      cleaned++;
    });
  await host.ctx.plugin(runtimePlugin, { runtimes: [a, b], defaultRuntimeId: 'local' });
  assert.equal(host.ctx.agentRuntime.adapter, host.ctx.agentRuntime.registry.get('local'));
  assert.equal(host.ctx.agentRuntime.registry.get('cloud').id, b.id);
  assert.notEqual(host.ctx.agentRuntime.registry.get('cloud'), b);
  assert.deepEqual(host.ctx.agentRuntime.registry.list(), ['local', 'cloud']);
  await host.dispose();
  assert.equal(cleaned, 2);
});
