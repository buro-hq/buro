import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createHost } from '../plugins/host.ts';
import { resourcesPlugin } from '../plugins/resources.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import { ResourceContributionCatalog } from '../core/resource-contributions.ts';
import { createRuntimeResources } from '../adapters/resources/runtime-resources.ts';
import type { ProjectRegistry } from '../core/ports.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('rejected shared-provider aliases still close every distinct returned instance wrapper', async (t) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-provider-alias-review-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await new PrivateJSONFiles(path.join(directory, 'local')).save('resources', {
    version: 1,
    defaultProfile: 'team',
    connections: ['one', 'two'].map((id) => ({ id, provider: 'synthetic', config: {} })),
    runtimes: [{ id: 'runtime', backend: 'synthetic', config: {} }],
    profiles: [
      {
        id: 'team',
        name: 'Synthetic team',
        policy: 'local-only',
        coordinator: 'runtime',
        worker: 'runtime',
        reviewer: 'runtime',
      },
    ],
    receipts: {},
  });
  const closed: string[] = [];
  const catalog = new ResourceContributionCatalog();
  const shared = {
    id: 'one',
    revision: 'v1',
    local: true,
    complete: async (): Promise<never> => {
      throw Error('Provider admission cannot generate.');
    },
  };
  catalog.registerProvider({
    id: 'synthetic',
    label: 'Synthetic provider',
    revision: 'v1',
    defaultConfig: {},
    parse: (value) => value,
    describe: () => ({
      local: true,
      capacityKey: 'synthetic',
      capacity: 1,
      credentialReferences: [],
      modelListing: false,
    }),
    create: ({ id }) => ({
      provider: shared,
      dispose: async () => {
        closed.push(id);
        if (id === 'one') throw Error('Synthetic wrapper cleanup failure.');
      },
    }),
  });
  catalog.registerBackend({
    id: 'synthetic',
    label: 'Synthetic backend',
    revision: 'v1',
    defaultConfig: {},
    parse: (value) => value,
    dependencies: () => ['one'],
    describe: () => ({ local: true }),
    create: () => {
      throw Error('Provider admission must fail before constructing a backend.');
    },
  });
  await assert.rejects(
    createRuntimeResources({
      directory,
      contributions: catalog,
      builtins: false,
      projects: {
        get: () => {
          throw Error('Provider admission cannot inspect a project.');
        },
        list: () => [],
      } as ProjectRegistry,
      executors: new EnvironmentExecutors(),
      credentials: () => undefined,
      fetch: async () => {
        throw Error('Provider admission cannot access a transport.');
      },
    }),
    { code: 'INVALID_PROVIDER_INSTANCE' },
  );
  assert.deepEqual(closed.sort(), ['one', 'two']);
});

for (const fails of [false, true])
  test(`actual resource composition preserves provider lifetime until backend drain settles${fails ? ' even on drain failure' : ''}`, async (t) => {
    const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'buro-resource-drain-review-')),
    );
    const host = await createHost();
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    let providerAlive = true;
    t.after(async () => {
      release.resolve();
      await host.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    });
    await new PrivateJSONFiles(path.join(directory, 'local')).save('resources', {
      version: 1,
      defaultProfile: 'team',
      connections: [{ id: 'connection', provider: 'synthetic', config: {} }],
      runtimes: [{ id: 'runtime', backend: 'synthetic', config: {} }],
      profiles: [
        {
          id: 'team',
          name: 'Synthetic team',
          policy: 'local-only',
          coordinator: 'runtime',
          worker: 'runtime',
          reviewer: 'runtime',
        },
      ],
      receipts: {},
    });
    host.ctx.resourceContributions.catalog.registerProvider({
      id: 'synthetic',
      label: 'Synthetic provider',
      revision: 'v1',
      defaultConfig: {},
      parse: (value) => value,
      describe: () => ({
        local: true,
        capacityKey: 'synthetic',
        capacity: 1,
        credentialReferences: [],
        modelListing: false,
      }),
      create: ({ id }) => ({
        provider: {
          id,
          revision: 'v1',
          local: true,
          complete: async () => {
            throw Error('This lifecycle proof cannot generate.');
          },
        },
        dispose: async () => {
          providerAlive = false;
          events.push('provider-disposed');
        },
      }),
    });
    host.ctx.resourceContributions.catalog.registerBackend({
      id: 'synthetic',
      label: 'Synthetic backend',
      revision: 'v1',
      defaultConfig: {},
      parse: (value) => value,
      dependencies: () => ['connection'],
      describe: () => ({ local: true }),
      create: ({ id }) => ({
        revision: 'v1',
        local: true,
        runtime: {
          id,
          capabilities: fixtureCapabilities(),
          start: async () => ({ threadId: 'unused' }),
          submit: async () => ({ turnId: 'unused' }),
          interrupt: async () => {},
          dispose: async () => {
            events.push('backend-drain-started');
            entered.resolve();
            await release.promise;
            assert.equal(providerAlive, true, 'Provider is needed throughout backend drain.');
            events.push('backend-drain-settled');
            if (fails) throw Error('Synthetic backend disposal failure.');
          },
        },
      }),
    });
    await host.ctx.plugin(resourcesPlugin, {
      directory,
      builtins: false,
      executors: new EnvironmentExecutors(),
      credentials: () => undefined,
      fetch: async () => {
        throw Error('This lifecycle proof cannot access a transport.');
      },
    });
    const stopping = host.dispose();
    await entered.promise;
    await setImmediate();
    assert.equal(providerAlive, true, 'Parent cleanup cannot race its child backend cleanup.');
    assert.deepEqual(events, ['backend-drain-started']);
    release.resolve();
    await stopping;
    await host.dispose();
    assert.deepEqual(events, [
      'backend-drain-started',
      'backend-drain-settled',
      'provider-disposed',
    ]);
  });
