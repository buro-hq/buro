import { fixtureResources } from './fixtures/resource-configuration.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createRuntimeResources } from '../adapters/resources/runtime-resources.ts';
import {
  resourceConfigurationRevision,
  connectionConfigurationRevision,
} from '../adapters/files/resource-configuration.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import type { ResourceConfigurationChange } from '../protocol/domain.ts';

const meta = (id: string) => ({ id, fingerprint: id });
async function fixture(t: any, observe?: (change: ResourceConfigurationChange) => void) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-resource-events-')),
  );
  const config = fixtureResources();
  config.profiles.push({ ...config.profiles[0], id: 'other', name: 'Other profile' });
  await new PrivateJSONFiles(path.join(directory, 'local')).save('resources', config);
  const events: ResourceConfigurationChange[] = [];
  let modelCalls = 0;
  const resources = await createRuntimeResources({
    directory,
    projects: new ProjectStoreRegistry(),
    executors: new EnvironmentExecutors(),
    credentials: () => undefined,
    fetch: async () => {
      modelCalls++;
      throw Error('Metadata cannot invoke a model');
    },
    onConfigurationChange: (change) => {
      events.push(structuredClone(change));
      return observe?.(change);
    },
  });
  t.after(async () => {
    await resources.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { resources, events, modelCalls: () => modelCalls };
}

test('configuration changes notify only after a semantic change and never replay old selection receipts', async (t) => {
  const f = await fixture(t);
  await f.resources.useProfile('other', meta('other'));
  assert.deepEqual(f.events, [
    {
      topic: 'resources',
      revision: resourceConfigurationRevision(f.resources.configuration.snapshot()),
      appliesTo: 'new-runs',
    },
  ]);
  await f.resources.useProfile('other', meta('other'));
  await f.resources.useProfile('other', meta('same-selection-new-request'));
  assert.equal(f.events.length, 1, 'Receipt writes do not change resource semantics.');
  await f.resources.useProfile('codex', meta('back'));
  await f.resources.useProfile('other', meta('other'));
  assert.equal(f.events.length, 2);
  assert.equal(f.resources.configuration.snapshot().defaultProfile, 'codex');
  assert.equal(f.modelCalls(), 0);
});

test('queued mutations publish distinct persisted revisions while failures publish nothing', async (t) => {
  const f = await fixture(t);
  const current = f.resources.configuration
    .snapshot()
    .connections.find((connection) => connection.id === 'ollama')!;
  const originalRevision = connectionConfigurationRevision(current);
  await Promise.all([
    f.resources.saveConnection(
      { ...current, config: { ...current.config, think: false } },
      originalRevision,
      meta('edit'),
    ),
    f.resources.useProfile('other', meta('select')),
  ]);
  assert.equal(f.events.length, 2);
  assert.notEqual(f.events[0].revision, f.events[1].revision);
  assert.deepEqual(
    f.events.map((change) => change.appliesTo),
    ['new-runs', 'new-runs'],
  );
  assert.equal(
    f.events[1].revision,
    resourceConfigurationRevision(f.resources.configuration.snapshot()),
  );
  await assert.rejects(f.resources.saveConnection(current, originalRevision, meta('stale')), {
    code: 'RESOURCE_CONNECTION_CONFLICT',
  });
  await assert.rejects(f.resources.useProfile('missing', meta('missing')), {
    code: 'RESOURCE_PROFILE_UNAVAILABLE',
  });
  assert.equal(f.events.length, 2);
  for (const event of f.events)
    assert.deepEqual(Object.keys(event).sort(), ['appliesTo', 'revision', 'topic']);
  assert.equal(f.modelCalls(), 0);
});

for (const asynchronous of [false, true])
  test(`a ${asynchronous ? 'rejected asynchronous' : 'throwing synchronous'} notification cannot invalidate a committed command`, async (t) => {
    const f = await fixture(
      t,
      asynchronous
        ? async () => {
            throw Error('Subscriber failed');
          }
        : () => {
            throw Error('Subscriber failed');
          },
    );
    const result = await f.resources.useProfile('other', meta('change'));
    await setImmediate();
    assert.equal(f.resources.configuration.snapshot().defaultProfile, 'other');
    assert.deepEqual(await f.resources.useProfile('other', meta('change')), result);
    assert.equal(f.events.length, 1);
    assert.equal(f.modelCalls(), 0);
  });
