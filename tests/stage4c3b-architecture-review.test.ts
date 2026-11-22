import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeResources } from '../adapters/resources/runtime-resources.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { ResourceContributionCatalog } from '../core/resource-contributions.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { DomainError, type ProjectRegistry } from '../core/ports.ts';

async function resources(t: test.TestContext, projects: ProjectRegistry) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-empty-selection-review-')),
  );
  const created = await createRuntimeResources({
    directory,
    projects,
    contributions: new ResourceContributionCatalog(),
    builtins: false,
    executors: new EnvironmentExecutors(),
    credentials: () => undefined,
    fetch: async () => {
      throw Error('Empty selection cannot invoke a provider.');
    },
  });
  t.after(async () => {
    await created.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return created;
}

test('an empty machine does not turn an unknown project into a missing-profile selection issue', async (t) => {
  const registry = new ProjectStoreRegistry();
  const factory = await resources(t, registry);
  assert.equal((await factory.list()).selectionIssue?.code, 'RESOURCE_PROFILE_REQUIRED');
  await assert.rejects(factory.list('not-registered'), { code: 'PROJECT_NOT_FOUND' });
  assert.equal(factory.configuration.snapshot().defaultProfile, null);
  assert.deepEqual(factory.runtimes, []);
});

test('empty catalog discovery propagates unexpected project failures instead of claiming configuration readiness', async (t) => {
  let failure: Error = Error('Synthetic storage failure.');
  const factory = await resources(t, {
    get: () => {
      throw failure;
    },
    list: () => [],
  });
  for (const error of [
    Error('Synthetic storage failure.'),
    new DomainError('SYNTHETIC_STORE_FAILURE', 'Synthetic domain failure.'),
  ]) {
    failure = error;
    await assert.rejects(factory.list('p'), (observed: unknown) => observed === error);
  }
  const global = await factory.list();
  assert.equal(global.selectionIssue?.code, 'RESOURCE_PROFILE_REQUIRED');
  assert.equal(global.selected, undefined);
  assert.deepEqual(global.roleChoices, []);
});
