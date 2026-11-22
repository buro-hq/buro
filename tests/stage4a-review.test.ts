import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../plugins/host.ts';
import { websocketPlugin } from '../daemon/websocket.ts';
import { SocketProjectClient } from '../clients/socket-client.ts';
import { DomainError, type ProjectStore, type ProjectStoreOpenSpec } from '../core/ports.ts';
import type { Snapshot } from '../protocol/domain.ts';

function memoryStore(spec: ProjectStoreOpenSpec, close: () => Promise<void>): ProjectStore {
  const snapshot: Snapshot = {
    version: 1,
    project: structuredClone(spec.project),
    revision: 0,
    sequence: 0,
    roles: structuredClone(spec.roles || []),
    goals: [],
    runs: [],
    capabilities: [],
  };
  return {
    get project() {
      return structuredClone(snapshot.project);
    },
    snapshot: () => structuredClone(snapshot),
    receipt: () => undefined,
    async transact() {
      throw Error('Startup cannot invent project transactions.');
    },
    subscribe: () => () => {},
    close,
  };
}
function spec(id: string): ProjectStoreOpenSpec {
  return {
    storageAddress: 'memory://' + id,
    project: { id, name: id, root: 'repository://' + id },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('real Cordis startup closes earlier stores once and preserves the next open failure despite synchronous cleanup failure', async () => {
  const original = new DomainError('SYNTHETIC_ADMISSION_FAILED', 'Second store cannot open.');
  const opens: string[] = [],
    closes: string[] = [];
  await assert.rejects(
    createHost({
      projects: [spec('first'), spec('second')],
      storeFactory: {
        async open(input) {
          opens.push(input.project.id);
          if (input.project.id === 'second') throw original;
          return memoryStore(input, () => {
            closes.push(input.project.id);
            throw Error('Cleanup also failed.');
          });
        },
      },
    }),
    (error: unknown) => error === original,
  );
  assert.deepEqual(opens, ['first', 'second']);
  assert.deepEqual(closes, ['first']);
});

test('duplicate ownership discovered during real Cordis registry construction drains every opened store', async () => {
  const closes: string[] = [];
  let count = 0;
  await assert.rejects(
    createHost({
      projects: [spec('one'), spec('two')],
      storeFactory: {
        async open(input) {
          const index = ++count;
          return memoryStore({ ...input, project: { ...input.project, id: 'duplicate' } }, () => {
            closes.push(String(index));
            if (index === 1) throw Error('First cleanup failed.');
            return Promise.resolve();
          });
        },
      },
    }),
    { code: 'PROJECT_EXISTS' },
  );
  assert.equal(count, 2);
  assert.deepEqual(closes.sort(), ['1', '2']);
});

test('injected non-file stores serve real host commands and transfer ownership only to the registry', async () => {
  const opens: string[] = [],
    closes: string[] = [];
  const host = await createHost({
    projects: [spec('one'), spec('two')],
    storeFactory: {
      async open(input) {
        opens.push(input.storageAddress);
        return memoryStore(input, async () => {
          closes.push(input.project.id);
        });
      },
    },
  });
  try {
    const info = await host.ctx.commands.bus.execute(
      { method: 'service.info', params: {} },
      { id: 'service', fingerprint: 'service' },
    );
    assert.deepEqual(
      (info as { projects: { id: string }[] }).projects.map((project) => project.id),
      ['one', 'two'],
    );
    const snapshot = (await host.ctx.commands.bus.execute(
      { method: 'project.snapshot', params: { projectId: 'one' } },
      { id: 'snapshot', fingerprint: 'snapshot' },
    )) as Snapshot;
    assert.equal(snapshot.project.root, 'repository://one');
    assert.deepEqual(snapshot.roles, []);
    assert.deepEqual(snapshot.runs, []);
    assert.deepEqual(opens, ['memory://one', 'memory://two']);
    assert.deepEqual(closes, []);
  } finally {
    await host.dispose();
  }
  await host.dispose();
  assert.deepEqual(closes.sort(), ['one', 'two']);
});

for (const returnToOriginal of [false, true])
  test(
    returnToOriginal
      ? 'an old successful projection cannot roll history back after selecting A, B and A again'
      : 'a failed projection read of a previous project cannot disconnect the newly selected project',
    { timeout: 5000 },
    async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage4a-selection-race-'));
      const host = await createHost({
        projects: ['a', 'b'].map((id) => ({
          storageAddress: path.join(root, id),
          project: { id, name: id, root },
          roles: [],
        })),
      });
      const held = deferred(),
        release = deferred();
      const client = new SocketProjectClient();
      t.after(async () => {
        release.resolve();
        client.close();
        await host.dispose();
        await fs.rm(root, { recursive: true, force: true });
      });
      const original = host.ctx.commands.bus.handlers.get('project.snapshot')!;
      let hold = false,
        heldRequestId = '';
      host.ctx.commands.bus.handlers.set('project.snapshot', async (params, meta) => {
        const snapshot = await original(params, meta);
        if (hold && params.projectId === 'a') {
          hold = false;
          heldRequestId = meta.id;
          held.resolve();
          await release.promise;
          if (!returnToOriginal)
            throw new DomainError('SYNTHETIC_OLD_READ_FAILED', 'Previous project read failed.');
        }
        return snapshot;
      });
      let port = 0;
      await host.ctx.plugin(websocketPlugin, {
        port: 0,
        onListen: (value) => {
          port = value;
        },
      });
      client.url = `ws://127.0.0.1:${port}`;
      await client.connectService();
      await client.selectProject('a');
      hold = true;
      await client.saveRole({
        projectId: 'a',
        id: 'builder',
        title: 'Builder',
        description: 'Fixture role',
        instructions: 'No model work.',
        kind: 'general',
        expectedVersion: 0,
      });
      await held.promise;
      await client.selectProject('b');
      let laterGoalId: string | undefined;
      if (returnToOriginal) {
        const goal = await client.createGoal({
          projectId: 'a',
          title: 'A newer goal',
          body: 'Keep this observed history.',
          criteria: '',
        });
        laterGoalId = goal.id;
        await client.selectProject('a');
        assert.equal(client.snapshot().sequence, 2);
      }
      const socket = client.ws!;
      const connections: string[] = [];
      client.onConnection((state) => connections.push(state));
      const failedRead = new Promise<void>((resolve) => {
        socket.addEventListener('message', function observe(event) {
          const response = JSON.parse(String(event.data));
          if (response.type === 'response' && response.id === heldRequestId) {
            socket.removeEventListener('message', observe);
            resolve();
          }
        });
      });
      release.resolve();
      await failedRead;
      await Promise.resolve();
      assert.equal(socket.readyState, WebSocket.OPEN);
      assert.equal(client.ready, true);
      assert.equal(client.ws, socket);
      assert.equal(client.snapshot().project.id, returnToOriginal ? 'a' : 'b');
      await client.command({ method: 'service.info', params: {} });
      assert.equal(connections.includes('reconnecting'), false);
      assert.equal(host.ctx.projects.registry.get('a').snapshot().roles.length, 1);
      if (returnToOriginal) {
        assert.equal(client.snapshot().sequence, 2);
        assert.equal(
          client.snapshot().goals.some((goal) => goal.id === laterGoalId),
          true,
        );
      } else
        assert.deepEqual(
          client.snapshot().roles,
          [],
          'A failed old projection cannot inject previous project roles.',
        );
    },
  );
