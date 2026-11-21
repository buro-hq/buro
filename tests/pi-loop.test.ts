import test from 'node:test';
import assert from 'node:assert/strict';
import { setDefaultStreamFn } from '@earendil-works/pi-agent-core';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import type { AgentLoopBatch, AgentLoopHost, AgentLoopRequest } from '../agent/contracts/loop.ts';
import { AgentLoopFailure } from '../agent/contracts/loop-errors.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const packet = (id: string): AgentLoopRequest => ({
  id,
  model: {
    id: 'owned-model',
    providerId: 'owned-provider',
    contextTokens: 32768,
    maxOutputTokens: 1024,
  },
  messages: [
    { role: 'system', content: 'Host instructions' },
    { role: 'user', content: 'Host task' },
  ],
  tools: [
    {
      name: 'edit',
      description: 'Edit',
      parameters: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
        additionalProperties: false,
      },
    },
  ],
});
const batch = (id: string, actions = 1): AgentLoopBatch => ({
  id,
  response: {
    model: 'reported-model',
    finish: actions ? 'tools' : 'stop',
    message: {
      role: 'assistant',
      content: 'Observed response',
      ...(actions
        ? {
            toolCalls: Array.from({ length: actions }, (_, index) => ({
              id: 'provider-' + index,
              name: 'edit',
              arguments: { count: '7' },
            })),
          }
        : {}),
    },
  },
  actions: Array.from({ length: actions }, (_, index) => ({
    id: 'saved-action-' + index,
    call: { id: 'provider-' + index, name: 'edit', arguments: { count: '7' } },
  })),
});
function rig() {
  const calls = {
    prepare: [] as string[],
    generate: [] as string[],
    execute: [] as string[][],
    advance: [] as string[],
  };
  let generated = 0;
  const host: AgentLoopHost = {
    async prepare() {
      const id = 'request-' + (calls.prepare.length + 1);
      calls.prepare.push(id);
      return packet(id);
    },
    async generate(id) {
      calls.generate.push(id);
      return batch('batch-' + ++generated);
    },
    async execute(batchId, actionId) {
      calls.execute.push([batchId, actionId]);
      return { content: 'Saved tool result' };
    },
    async advance(id) {
      calls.advance.push(id);
      return { kind: 'complete' };
    },
  };
  return { host, calls };
}

test('the actual Pi loop schedules more than twenty host generations with sequential durable batches and no SDK provider fallback', async (t) => {
  const f = rig(),
    parent = new AbortController();
  let active = 0,
    maxActive = 0,
    ambient = 0,
    fallback = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    ambient++;
    throw Error('No SDK network');
  };
  setDefaultStreamFn(() => {
    fallback++;
    throw Error('No SDK provider');
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    setDefaultStreamFn(undefined);
  });
  f.host.execute = async (batchId, actionId) => {
    active++;
    maxActive = Math.max(active, maxActive);
    await Promise.resolve();
    active--;
    f.calls.execute.push([batchId, actionId]);
    return { content: 'Committed' };
  };
  f.host.advance = async (id) => {
    f.calls.advance.push(id);
    return { kind: f.calls.advance.length === 27 ? 'complete' : 'continue' };
  };
  assert.deepEqual(await new PiAgentLoopRunner().run(f.host, parent.signal), { kind: 'complete' });
  assert.equal(f.calls.prepare.length, 27);
  assert.equal(f.calls.generate.length, 27);
  assert.equal(f.calls.execute.length, 27);
  assert.equal(f.calls.advance.length, 27);
  assert.equal(maxActive, 1);
  assert.equal(ambient, 0);
  assert.equal(fallback, 0);
  assert.equal(parent.signal.aborted, false);
});

test('SDK validation cannot coerce original host arguments or rewrite unknown usage and the host alone binds action IDs', async () => {
  const f = rig(),
    request = packet('owned-request'),
    owned = batch('owned-batch', 2);
  const before = structuredClone(owned);
  f.host.prepare = async () => request;
  f.host.generate = async (requestId) => {
    assert.equal(requestId, request.id);
    return owned;
  };
  f.host.execute = async (batchId, actionId) => {
    assert.equal(batchId, owned.id);
    const action = owned.actions.find((item) => item.id === actionId)!;
    assert.equal((action.call.arguments as any).count, '7');
    f.calls.execute.push([batchId, actionId]);
    return { content: 'Actual receipt' };
  };
  assert.deepEqual(await new PiAgentLoopRunner().run(f.host, new AbortController().signal), {
    kind: 'complete',
  });
  assert.deepEqual(f.calls.execute, [
    ['owned-batch', 'saved-action-0'],
    ['owned-batch', 'saved-action-1'],
  ]);
  assert.deepEqual(owned, before);
  assert.equal(owned.response.usage, undefined);
  assert.equal((request.tools[0].parameters as any).properties.count.type, 'integer');
});

for (const phase of ['prepare', 'generate', 'advance'] as const)
  test(`a fatal host ${phase} failure retains its original identity and never aborts the parent`, async () => {
    const f = rig(),
      parent = new AbortController(),
      original = new Error('Original host failure');
    if (phase === 'prepare')
      f.host.prepare = async () => {
        throw original;
      };
    if (phase === 'generate')
      f.host.generate = async () => {
        f.calls.generate.push('attempt');
        throw original;
      };
    if (phase === 'advance')
      f.host.advance = async () => {
        f.calls.advance.push('attempt');
        throw original;
      };
    await assert.rejects(
      new PiAgentLoopRunner().run(f.host, parent.signal),
      (error) => error === original,
    );
    assert.equal(parent.signal.aborted, false);
    assert.equal(f.calls.prepare.length, phase === 'prepare' ? 0 : 1);
    assert.equal(f.calls.execute.length, phase === 'advance' ? 1 : 0);
    assert.equal(f.calls.advance.length, phase === 'advance' ? 1 : 0);
  });

test('a tool receipt failure is not swallowed as SDK model feedback, never repeats a side effect and drains the active callback', async () => {
  const f = rig(),
    parent = new AbortController(),
    entered = deferred<void>(),
    receipt = deferred<{ content: string }>(),
    failure = new Error('Receipt persistence failed');
  f.host.generate = async (id) => {
    f.calls.generate.push(id);
    return batch('durable', 2);
  };
  f.host.execute = async (batchId, actionId) => {
    f.calls.execute.push([batchId, actionId]);
    entered.resolve();
    return receipt.promise;
  };
  let finished = false;
  const work = new PiAgentLoopRunner().run(f.host, parent.signal).finally(() => {
    finished = true;
  });
  const rejection = assert.rejects(work, (error) => error === failure);
  await entered.promise;
  await Promise.resolve();
  assert.equal(finished, false);
  receipt.reject(failure);
  await rejection;
  assert.equal(f.calls.execute.length, 1);
  assert.equal(f.calls.generate.length, 1);
  assert.equal(f.calls.advance.length, 0);
  assert.equal(parent.signal.aborted, false);
});

test('parent cancellation drains an already-started action and prevents every later action or model callback', async () => {
  const f = rig(),
    parent = new AbortController(),
    entered = deferred<void>(),
    effect = deferred<{ content: string }>();
  f.host.generate = async (id) => {
    f.calls.generate.push(id);
    return batch('durable', 2);
  };
  f.host.execute = async (batchId, actionId) => {
    f.calls.execute.push([batchId, actionId]);
    entered.resolve();
    return effect.promise;
  };
  let finished = false;
  const work = new PiAgentLoopRunner().run(f.host, parent.signal).finally(() => {
    finished = true;
  });
  const rejection = assert.rejects(work, (error) => error === parent.signal.reason);
  await entered.promise;
  parent.abort();
  await Promise.resolve();
  assert.equal(finished, false);
  effect.resolve({ content: 'The in-flight action settled' });
  await rejection;
  assert.equal(f.calls.execute.length, 1);
  assert.equal(f.calls.generate.length, 1);
  assert.equal(f.calls.advance.length, 0);
});

test('a late unknown host outcome takes precedence over parent cancellation', async () => {
  const f = rig(),
    parent = new AbortController(),
    entered = deferred<void>(),
    effect = deferred<{ content: string }>(),
    unknown = new Error('Original unknown effect');
  f.host.execute = async () => {
    entered.resolve();
    return effect.promise;
  };
  const work = new PiAgentLoopRunner().run(f.host, parent.signal);
  const rejection = assert.rejects(work, (error) => error === unknown);
  await entered.promise;
  parent.abort();
  effect.reject(unknown);
  await rejection;
});

test('duplicate provider call IDs cannot execute two host actions or advance an incomplete batch', async () => {
  const f = rig(),
    parent = new AbortController();
  f.host.generate = async () => {
    const value = batch('dup', 2);
    value.actions[1].call.id = value.actions[0].call.id;
    return value;
  };
  await assert.rejects(new PiAgentLoopRunner().run(f.host, parent.signal), AgentLoopFailure);
  assert.equal(f.calls.execute.length, 0);
  assert.equal(f.calls.advance.length, 0);
  assert.equal(parent.signal.aborted, false);
});

test('a host-durable context yield ends this SDK window and the next window takes only newly prepared authority', async () => {
  const f = rig(),
    runner = new PiAgentLoopRunner(),
    parent = new AbortController();
  let windows = 0;
  f.host.prepare = async () => {
    windows++;
    return {
      ...packet('window-' + windows),
      messages: [{ role: 'user', content: 'Canonical window ' + windows }],
    };
  };
  f.host.advance = async (id) => {
    f.calls.advance.push(id);
    return { kind: windows === 1 ? 'yield' : 'complete' };
  };
  assert.deepEqual(await runner.run(f.host, parent.signal), { kind: 'yield' });
  assert.deepEqual(await runner.run(f.host, parent.signal), { kind: 'complete' });
  assert.deepEqual(f.calls.generate, ['window-1', 'window-2']);
  assert.equal(f.calls.execute.length, 2);
  assert.equal(f.calls.advance.length, 2);
  assert.equal(parent.signal.aborted, false);
});

test('an unexpected scheduler projection fault is sanitized instead of exposing private data', async () => {
  const f = rig(),
    privateError = new Error('PRIVATE_TOOL_PAYLOAD');
  f.host.prepare = async () => {
    const request = packet('invalid');
    Object.defineProperty(request.tools[0], 'description', {
      enumerable: true,
      get() {
        throw privateError;
      },
    });
    return request;
  };
  await assert.rejects(
    new PiAgentLoopRunner().run(f.host, new AbortController().signal),
    (error) => {
      assert.ok(error instanceof AgentLoopFailure);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE_TOOL_PAYLOAD/);
      assert.equal(error.cause, privateError);
      return true;
    },
  );
  assert.equal(f.calls.generate.length, 0);
  assert.equal(f.calls.execute.length, 0);
});

test('the complete admitted batch is checked before a valid first action can hide an unsupported second tool', async () => {
  const f = rig();
  f.host.generate = async () => {
    const value = batch('opaque-durable-batch', 2);
    value.actions[1].call.name = 'not-advertised';
    return value;
  };
  await assert.rejects(
    new PiAgentLoopRunner().run(f.host, new AbortController().signal),
    AgentLoopFailure,
  );
  assert.equal(f.calls.execute.length, 0);
  assert.equal(f.calls.advance.length, 0);
});

test('incomplete or non-tool responses cannot carry executable actions and tools finish requires admitted actions', async () => {
  for (const finish of ['length', 'failed', 'stop', 'tools'] as const) {
    const f = rig();
    f.host.generate = async () => {
      const value = batch('opaque-batch', finish === 'tools' ? 0 : 1);
      value.response.finish = finish;
      return value;
    };
    await assert.rejects(
      new PiAgentLoopRunner().run(f.host, new AbortController().signal),
      AgentLoopFailure,
    );
    assert.equal(f.calls.execute.length, 0);
    assert.equal(f.calls.advance.length, 0);
  }
  const f = rig();
  f.host.generate = async () => batch('', 0);
  await assert.rejects(
    new PiAgentLoopRunner().run(f.host, new AbortController().signal),
    AgentLoopFailure,
  );
  assert.equal(f.calls.execute.length, 0);
  assert.equal(f.calls.advance.length, 0);
});

test('an incomplete action-free response follows up only when the host explicitly continues and keeps its original finish', async () => {
  for (const finish of ['length', 'failed'] as const) {
    for (const continueFirst of [false, true]) {
      const f = rig();
      let attempts = 0;
      const observed: AgentLoopBatch[] = [];
      f.host.generate = async (requestId) => {
        f.calls.generate.push(requestId);
        const value = batch('opaque-batch-' + ++attempts, 0);
        if (attempts === 1) value.response.finish = finish;
        observed.push(value);
        return value;
      };
      f.host.advance = async (batchId) => {
        f.calls.advance.push(batchId);
        assert.equal(observed[0].response.finish, finish);
        return { kind: continueFirst && f.calls.advance.length === 1 ? 'continue' : 'complete' };
      };
      assert.deepEqual(await new PiAgentLoopRunner().run(f.host, new AbortController().signal), {
        kind: 'complete',
      });
      assert.equal(attempts, continueFirst ? 2 : 1);
      assert.equal(f.calls.execute.length, 0);
      assert.equal(observed[0].response.finish, finish);
    }
  }
});
