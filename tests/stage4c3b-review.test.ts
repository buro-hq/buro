import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createHost } from '../plugins/host.ts';
import { resourcesPlugin } from '../plugins/resources.ts';
import { websocketPlugin } from '../daemon/websocket.ts';
import { SocketProjectClient } from '../clients/socket-client.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import { operationResourceReady } from '../src/features/resources/readiness.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import type { ResourceCatalog } from '../protocol/resources.ts';

function connectedAgain(client: SocketProjectClient) {
  return new Promise<void>((resolve) => {
    let disconnected = false;
    const unsubscribe = client.onConnection((status) => {
      if (status !== 'connected') disconnected = true;
      if (disconnected && status === 'connected') {
        unsubscribe();
        resolve();
      }
    });
  });
}
async function fixture(t: any, override?: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-empty-review-')));
  const hosts: Awaited<ReturnType<typeof createHost>>[] = [];
  const clients: SocketProjectClient[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const item of hosts.reverse()) await item.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  let creates = 0,
    starts = 0,
    calls = 0,
    disposes = 0,
    port = 0;
  const open = async () => {
    const host = await createHost({
      projects: [
        {
          storageAddress: path.join(root, 'project'),
          project: { id: 'p', name: 'Fixture', root },
          ...(override
            ? {
                profile: ProjectProfileSchema.parse({
                  version: 1,
                  revision: 1,
                  context: '',
                  scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
                  checks: [],
                  defaultCheckIds: [],
                  setup: [],
                  dependencies: 'none',
                  maxWorkers: 1,
                  turnTimeoutMs: 10000,
                  resourceProfile: override,
                }),
              }
            : {}),
        },
      ],
      async configure(ctx) {
        ctx.resourceContributions.catalog.registerBackend({
          id: 'codex',
          label: 'Third-party fixture',
          revision: 'third-v1',
          defaultConfig: {},
          parse: (config) => z.strictObject({}).parse(config),
          dependencies: () => [],
          describe: () => ({ local: true }),
          async create({ id }) {
            creates++;
            return {
              revision: 'instance-v1',
              model: 'fixture-model',
              local: true,
              runtime: {
                id,
                capabilities: fixtureCapabilities({ structuredTurns: true, toolsFreeTurns: true }),
                async start() {
                  starts++;
                  return { threadId: 'unused' };
                },
                async turn() {
                  calls++;
                  throw Error('No inference authorized.');
                },
                async submit() {
                  calls++;
                  throw Error('No inference authorized.');
                },
                async interrupt() {},
                async release() {},
                async dispose() {
                  disposes++;
                },
              },
            };
          },
        });
      },
    });
    hosts.push(host);
    await host.ctx.plugin(resourcesPlugin, {
      directory: path.join(root, 'service'),
      executors: new EnvironmentExecutors(),
      builtins: false,
      fetch: async () => {
        throw Error('No HTTP authorized.');
      },
      credentials: () => {
        throw Error('No credentials authorized.');
      },
    });
    await host.ctx.plugin(websocketPlugin, {
      port,
      onListen: (value) => {
        port = value;
      },
    });
    return host;
  };
  const host = await open();
  const url = `ws://127.0.0.1:${port}`;
  const service = new SocketProjectClient(url),
    project = new SocketProjectClient(url, 'p');
  clients.push(service, project);
  await Promise.all([service.connectService(), project.connect()]);
  const list = (client: SocketProjectClient, projectId?: string) =>
    client.command<ResourceCatalog>({
      method: 'resources.list',
      params: projectId ? { projectId } : {},
    });
  const command = (item: typeof host, method: string, params: any, id: string) =>
    item.ctx.commands.bus.execute({ method, params } as any, { id, fingerprint: id });
  return {
    root,
    host,
    open,
    service,
    project,
    list,
    command,
    creates: () => creates,
    starts: () => starts,
    calls: () => calls,
    disposes: () => disposes,
  };
}

test(
  'real service/project clients reconnect from null resources without auto-selecting or granting mechanics by a backend name',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const empty = await f.list(f.service);
    assert.equal(empty.defaultProfile, null);
    assert.equal(empty.selected, undefined);
    assert.equal(operationResourceReady(empty, 'project.research'), false);
    assert.equal(operationResourceReady(null, 'project.research'), false);
    assert.deepEqual(
      empty.backends.map((backend) => backend.id),
      ['codex'],
    );
    assert.equal(f.creates(), 0);
    const changes: string[] = [];
    f.service.onServiceInvalidation((change) => changes.push(change.revision));
    const setup = {
      expectedRevision: empty.configurationRevision!,
      runtimes: [{ id: 'ollama', backend: 'codex', config: {} }],
      profile: {
        id: 'first',
        name: 'First explicit profile',
        policy: 'local-only',
        coordinator: 'ollama',
        worker: 'ollama',
        reviewer: 'ollama',
      },
    };
    const result = await f.command(f.host, 'resources.setup.save', setup, 'first-setup');
    await f.service.command({ method: 'service.info', params: {} });
    assert.equal(changes.length, 1);
    const pending = await f.list(f.project, 'p');
    assert.equal(pending.defaultProfile, null);
    assert.equal(pending.selected, undefined);
    assert.equal(pending.configured!.profiles[0].restartRequired, false);
    assert.equal(pending.runtimes.length, 1);
    assert.equal(operationResourceReady(pending, 'project.research'), false);
    assert.deepEqual(await f.command(f.host, 'resources.setup.save', setup, 'first-setup'), result);
    assert.equal(f.creates(), 1);
    assert.equal(f.project.snapshot().sequence, 0);
    const generations = [f.service.getResourceGeneration(), f.project.getResourceGeneration()];
    const reconnect = Promise.all([connectedAgain(f.service), connectedAgain(f.project)]);
    await f.host.dispose();
    const restarted = await f.open();
    await reconnect;
    assert.ok(f.service.getResourceGeneration() > generations[0]);
    assert.ok(f.project.getResourceGeneration() > generations[1]);
    assert.equal(f.creates(), 2);
    for (const catalog of [await f.list(f.service), await f.list(f.project, 'p')]) {
      assert.equal(catalog.defaultProfile, null);
      assert.equal(catalog.selected, undefined);
      assert.equal(catalog.configured!.profiles[0].restartRequired, false);
    }
    await f.command(restarted, 'resources.use', { profileId: 'first' }, 'choose-first');
    const active = await f.list(f.project, 'p');
    assert.equal(active.defaultProfile, 'first');
    assert.equal(active.selected!.coordinator.id, 'ollama');
    assert.equal(active.selectionIssue, undefined);
    assert.equal(operationResourceReady(active, 'goal.coordination'), true);
    assert.equal(operationResourceReady(active, 'project.research'), false);
    assert.equal(operationResourceReady(active, 'goal.review'), false);
    assert.ok(
      active
        .roleChoices!.find((operation) => operation.operationId === 'project.research')!
        .choices.every((choice) => !choice.eligible),
    );
    await assert.rejects(
      restarted.ctx.agentRuntime.adapter.start({
        projectId: 'p',
        instructions: '',
        purpose: 'research',
        operationId: 'project.research',
        readOnly: true,
      }),
      { code: 'BACKEND_CAPABILITY_UNAVAILABLE' },
    );
    assert.equal(f.starts(), 0);
    assert.equal(f.calls(), 0);
    assert.equal(f.project.snapshot().sequence, 0);
  },
);

test(
  'an unknown project is not disguised as empty setup and unavailable selections expose only the safe public issue',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, 'private-missing-selection');
    const global = await f.list(f.service);
    assert.equal(global.selectionIssue!.code, 'RESOURCE_PROFILE_REQUIRED');
    const scoped = await f.list(f.project, 'p');
    assert.equal(scoped.selectionIssue!.code, 'RESOURCE_PROFILE_UNAVAILABLE');
    assert.equal(scoped.defaultProfile, null);
    assert.equal(scoped.selected, undefined);
    assert.deepEqual(scoped.roleChoices, []);
    assert.doesNotMatch(JSON.stringify(scoped.selectionIssue), /private-missing-selection/);
    await assert.rejects(f.list(f.service, 'unknown'), { code: 'PROJECT_NOT_FOUND' });
    const after = await f.list(f.service);
    assert.equal(after.defaultProfile, null);
    assert.deepEqual(after.runtimes, []);
    assert.equal(f.creates(), 0);
    assert.equal(f.starts(), 0);
    assert.equal(f.calls(), 0);
  },
);
