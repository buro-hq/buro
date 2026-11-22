import { fixtureResources } from './fixtures/resource-configuration.ts';
import { testResourceContributions } from './fixtures/resource-contributions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeResources } from '../adapters/resources/runtime-resources.ts';
import {
  FileResourceConfiguration,
  ResourceConfigurationSchema,
  resourceConfigurationRevision,
} from '../adapters/files/resource-configuration.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { RuntimeRouter } from '../core/runtime-router.ts';
import { CodexRuntime } from '../adapters/codex/runtime.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { ResourceConfiguration } from '../adapters/files/resource-configuration.ts';

const profile = {
  id: 'team',
  name: 'Team',
  policy: 'hybrid' as const,
  coordinator: 'planner-native',
  worker: 'worker-native',
  reviewer: 'planner-native',
  workerPool: ['planner-native', 'worker-native'],
};
const configuration = () =>
  ResourceConfigurationSchema.parse({
    ...fixtureResources(),
    defaultProfile: profile.id,
    profiles: [profile],
    runtimes: [
      {
        id: 'planner-native',
        backend: 'codex',
        config: { model: 'fixture-plan', reasoningEffort: 'high' },
      },
      {
        id: 'worker-native',
        backend: 'codex',
        config: { model: 'fixture-work', reasoningEffort: 'low' },
      },
    ],
  });
async function fixture(t: any, initial: ResourceConfiguration = configuration()) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-native-instances-')),
  );
  const log = path.join(directory, 'wire.jsonl');
  const executable = path.join(directory, 'offline-native');
  await fs.writeFile(
    executable,
    `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
const log=${JSON.stringify(log)}; const argv=process.argv.slice(2);
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line); fs.appendFileSync(log,JSON.stringify({argv,...m})+'\\n');
 const send=result=>process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
 if(m.method==='initialize')send({serverInfo:'offline-fixture'});
 else if(m.method==='thread/start')send({thread:{id:'same-wire-thread'}});
 else if(m.method==='thread/resume')send({thread:{id:m.params.threadId}});
 else if(m.method==='turn/start')send({turn:{id:'same-wire-turn'}});
 else if(m.method==='turn/interrupt')send({});
}
`,
    { mode: 0o700 },
  );
  await new PrivateJSONFiles(path.join(directory, 'local')).save('resources', initial);
  const projects = {
    get: () => ({ snapshot: () => ({ project: { id: 'p', root: directory }, runs: [] }) }),
  } as unknown as ProjectRegistry;
  const factories: Awaited<ReturnType<typeof createRuntimeResources>>[] = [];
  const create = async (
    options: { model?: string; reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' } = {},
  ) => {
    const factory = await createRuntimeResources({
      directory,
      projects,
      executors: new EnvironmentExecutors(),
      codex: { executable, args: [], ...options },
      credentials: () => undefined,
      fetch: async () => {
        throw Error('No model or network allowed in this fixture');
      },
    });
    factories.push(factory);
    return factory;
  };
  t.after(async () => {
    for (const factory of factories) {
      await factory.dispose();
      await Promise.all(factory.runtimes.map((runtime) => runtime.dispose()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, projects, create, log };
}

test('two configured native instances isolate identical wire handles and honor per-instance models and reasoning', async (t) => {
  const f = await fixture(t),
    factory = await f.create({ model: 'injected-default', reasoningEffort: 'xhigh' });
  assert.deepEqual(
    factory.runtimes.map((runtime) => runtime.id),
    ['planner-native', 'worker-native'],
  );
  assert.notEqual(
    factory.resources[0].configurationRevision,
    factory.resources[1].configurationRevision,
  );
  for (const runtime of factory.runtimes)
    assert.deepEqual(
      factory.resources.find((resource) => resource.id === runtime.id)?.capabilities,
      runtime.capabilities,
    );
  const registry = new RuntimeCatalog();
  for (const runtime of factory.runtimes) registry.register(runtime);
  let sequence = 0;
  const router = new RuntimeRouter({
    registry,
    selection: factory.selection,
    projects: f.projects,
    resources: factory.resources,
    routes: new FileRuntimeRoutes(path.join(f.directory, 'routes')),
    id: () => String(++sequence),
  });
  t.after(() => router.dispose());
  const planner = await router.start({
    projectId: 'p',
    runId: 'R',
    purpose: 'coordination',
    instructions: 'Plan',
  });
  const worker = await router.start({
    projectId: 'p',
    runId: 'R',
    purpose: 'implementation',
    instructions: 'Implement',
  });
  assert.notEqual(planner.threadId, worker.threadId);
  await router.submit(planner.threadId, 'Plan');
  await router.submit(worker.threadId, 'Work');
  const records = (await fs.readFile(f.log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const starts = records.filter((record) => record.method === 'thread/start');
  assert.equal(starts.length, 2);
  for (const [index, model, effort] of [
    [0, 'fixture-plan', 'high'],
    [1, 'fixture-work', 'low'],
  ] as const) {
    assert.ok(starts[index].argv.includes(`model=${JSON.stringify(model)}`));
    assert.ok(starts[index].argv.includes(`model_reasoning_effort=${JSON.stringify(effort)}`));
    assert.ok(!starts[index].argv.includes('model="injected-default"'));
  }
  const turns = records.filter((record) => record.method === 'turn/start');
  assert.deepEqual(
    turns.map((record) => record.params.threadId),
    ['same-wire-thread', 'same-wire-thread'],
  );
  assert.deepEqual(
    turns.map((record) => record.params.input[0].text),
    ['Plan', 'Work'],
  );
});

test('native identity tracks effective model settings and leaves unspecified models explicitly unknown', async (t) => {
  const initial = configuration();
  initial.runtimes = [
    { id: 'planner-native', backend: 'codex', config: {} },
    { id: 'worker-native', backend: 'codex', config: {} },
  ];
  const f = await fixture(t, initial),
    unknown = await f.create(),
    first = await f.create({ model: 'fixture-a', reasoningEffort: 'low' }),
    second = await f.create({ model: 'fixture-b', reasoningEffort: 'low' }),
    effort = await f.create({ model: 'fixture-a', reasoningEffort: 'high' });
  assert.equal(unknown.resources[0].model, undefined);
  assert.equal(first.resources[0].model, 'fixture-a');
  assert.notEqual(
    first.resources[0].configurationRevision,
    second.resources[0].configurationRevision,
  );
  assert.notEqual(
    first.resources[0].configurationRevision,
    effort.resources[0].configurationRevision,
  );
  assert.notEqual(
    unknown.resources[0].configurationRevision,
    unknown.resources[1].configurationRevision,
  );
  await assert.rejects(fs.readFile(f.log), { code: 'ENOENT' });
});

test('resource setup persists arbitrary native instances through the same configuration contract', async (t) => {
  const f = await fixture(t),
    stored = await FileResourceConfiguration.open(
      path.join(f.directory, 'local'),
      testResourceContributions(),
    );
  const original = stored.snapshot();
  await stored.saveSetup('add-native', 'add-native', {
    expectedRevision: resourceConfigurationRevision(original),
    runtimes: [
      {
        id: 'new-native',
        backend: 'codex',
        config: { model: 'fixture-new', reasoningEffort: 'medium' },
      },
    ],
    profile: {
      ...profile,
      id: 'new-team',
      coordinator: 'new-native',
      worker: 'new-native',
      reviewer: 'new-native',
      workerPool: ['new-native'],
    },
  });
  const reopened = await FileResourceConfiguration.open(
    path.join(f.directory, 'local'),
    testResourceContributions(),
  );
  assert.deepEqual(reopened.snapshot().runtimes.at(-1), {
    id: 'new-native',
    backend: 'codex',
    config: { model: 'fixture-new', reasoningEffort: 'medium' },
  });
  await assert.rejects(fs.readFile(f.log), { code: 'ENOENT' });
});

test('managed-only factories accept codex as a normal configured ID without constructing a native adapter', async (t) => {
  const initial = ResourceConfigurationSchema.parse({
    ...fixtureResources(),
    runtimes: [
      {
        id: 'codex',
        backend: 'managed',
        config: { connectionId: 'ollama', model: 'fixture-small' },
      },
    ],
  });
  const f = await fixture(t, initial),
    factory = await f.create();
  assert.equal(factory.runtimes.length, 1);
  assert.equal(factory.runtimes[0].id, 'codex');
  assert.equal(factory.runtimes[0] instanceof CodexRuntime, false);
  assert.equal(factory.resources[0].backendId, 'managed');
  assert.equal(factory.selection.forProject('p').coordinator.id, 'codex');
  assert.deepEqual(factory.resources[0].capabilities, factory.runtimes[0].capabilities);
  await assert.rejects(fs.readFile(f.log), { code: 'ENOENT' });
});
