import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../plugins/host.ts';
import { runtimePlugin } from '../plugins/runtime.ts';
import type { AgentRuntime, RegisteredRuntime } from '../core/ports.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';

function adapter(id: string, close: () => void | Promise<void>): RegisteredRuntime {
  return {
    id,
    capabilities: fixtureCapabilities({ structuredTurns: true }),
    start: async () => ({ threadId: 'thread' }),
    resume: async () => ({ threadId: 'thread' }),
    submit: async () => ({ turnId: 'turn' }),
    turn: async () => ({ turnId: 'turn', text: '{}' }),
    interrupt: async () => {},
    dispose: async () => {
      await close();
    },
  };
}

for (const failure of ['capabilities', 'duplicate-id', 'duplicate-instance', 'default', 'route'])
  test(`runtime plugin drains all owned instances once after ${failure} admission failure`, async () => {
    const host = await createHost();
    const closed: string[] = [];
    const first = adapter('first', () => {
      closed.push('first');
      throw Error('Cleanup failed');
    });
    const second = adapter('second', () => {
      closed.push('second');
    });
    const tail = adapter('tail', () => {
      closed.push('tail');
    });
    if (failure === 'capabilities') second.turn = undefined;
    if (failure === 'duplicate-id') Object.assign(second, { id: first.id });
    const original = Error('Route could not initialize');
    const inputs = failure === 'duplicate-instance' ? [first, first, tail] : [first, second, tail];
    await assert.rejects(
      Promise.resolve(
        host.ctx.plugin(runtimePlugin, {
          runtimes: inputs,
          defaultRuntimeId: failure === 'default' ? 'missing' : 'first',
          route: () => {
            if (failure === 'route') throw original;
            return first;
          },
        }),
      ),
      (error: unknown) => {
        if (failure === 'route') assert.equal(error, original);
        else if (failure === 'capabilities')
          assert.equal((error as { code: string }).code, 'INVALID_BACKEND_CAPABILITIES');
        else if (failure === 'duplicate-id')
          assert.equal((error as { code: string }).code, 'RUNTIME_EXISTS');
        else if (failure === 'default')
          assert.equal((error as { code: string }).code, 'RUNTIME_UNAVAILABLE');
        else assert.match(String(error), /cannot be owned twice/);
        return true;
      },
    );
    await host.dispose().catch(() => {});
    assert.deepEqual(
      closed.sort(),
      failure === 'duplicate-instance' ? ['first', 'tail'] : ['first', 'second', 'tail'],
    );
  });

test('routed sessions drain while their original backend catalog is still available', async () => {
  const host = await createHost();
  const events: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let draining!: () => void;
  const entered = new Promise<void>((resolve) => {
    draining = resolve;
  });
  const backend = adapter('backend', () => {
    events.push('backend');
  });
  await host.ctx.plugin(runtimePlugin, {
    runtimes: [backend],
    defaultRuntimeId: backend.id,
    route: (catalog) =>
      ({
        ...backend,
        dispose: async () => {
          events.push('route-start');
          draining();
          await waiting;
          assert.equal(catalog.get('backend').id, 'backend');
          events.push('route-drained');
        },
      }) satisfies AgentRuntime,
  });
  const stopping = host.dispose();
  await entered;
  assert.deepEqual(events, ['route-start']);
  release();
  await stopping;
  assert.deepEqual(events, ['route-start', 'route-drained', 'backend']);
  await host.dispose();
});
