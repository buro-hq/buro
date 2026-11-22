import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadModelCredentials } from '../adapters/files/model-credentials.ts';
import { PrivateJSONFiles } from '../adapters/files/private-json.ts';
import { createRuntimeResources } from '../adapters/resources/runtime-resources.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';

const marker = 'PRIVATE_FIXTURE_MODEL_CREDENTIAL';
async function directory(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'model-credentials-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('private credential references load without environment mutation and explicit environment takes precedence', async (t) => {
  const root = await directory(t);
  const reference = 'BURO_FIXTURE_PRIVATE_CREDENTIAL';
  const previous = process.env[reference];
  delete process.env[reference];
  t.after(() => {
    if (previous === undefined) delete process.env[reference];
    else process.env[reference] = previous;
  });
  await new PrivateJSONFiles(root).save('model-credentials', { [reference]: marker });
  const lookup = await loadModelCredentials(root);
  assert.equal(lookup(reference), marker);
  assert.equal(process.env[reference], undefined);
  assert.equal(lookup('toString'), undefined);
  process.env[reference] = 'EXPLICIT_FIXTURE_ENVIRONMENT';
  assert.equal(lookup(reference), 'EXPLICIT_FIXTURE_ENVIRONMENT');
});

test('unsafe permissions, malformed records and symlinks fail without disclosing credential values', async (t) => {
  const root = await directory(t),
    file = path.join(root, 'model-credentials.json');
  await new PrivateJSONFiles(root).save('model-credentials', { TEST_KEY: marker });
  await fs.chmod(file, 0o644);
  const sanitized = (error: any) => {
    assert.equal(error.code, 'INVALID_CREDENTIAL_STORE');
    assert.doesNotMatch(String(error), new RegExp(marker));
    return true;
  };
  await assert.rejects(loadModelCredentials(root), sanitized);
  await fs.chmod(file, 0o600);
  await new PrivateJSONFiles(root).save('model-credentials', { TEST_KEY: { value: marker } });
  await assert.rejects(loadModelCredentials(root), sanitized);
  await fs.writeFile(file, marker, { mode: 0o600 });
  await assert.rejects(loadModelCredentials(root), sanitized);
  await fs.rm(file);
  const outside = path.join(root, 'outside');
  await fs.writeFile(outside, JSON.stringify({ TEST_KEY: marker }));
  await fs.symlink(outside, file);
  await assert.rejects(loadModelCredentials(root), { code: 'UNSAFE_CHECKPOINT' });
  assert.equal(await fs.readFile(outside, 'utf8'), JSON.stringify({ TEST_KEY: marker }));
});

test('resource metadata exposes credential readiness without values or inference', async (t) => {
  const root = await directory(t),
    local = path.join(root, 'local');
  await new PrivateJSONFiles(local).save('model-credentials', { DEEPSEEK_API_KEY: marker });
  let calls = 0;
  const resources = await createRuntimeResources({
    directory: root,
    projects: {
      get() {
        throw Error('Unexpected project access');
      },
      list: () => [],
    },
    executors: new EnvironmentExecutors(),
    fetch: async () => {
      calls++;
      throw Error('Unexpected network');
    },
  });
  t.after(async () => {
    await resources.dispose();
    await Promise.all(resources.runtimes.map((runtime) => runtime.dispose()));
  });
  assert.deepEqual(
    (await resources.list()).connections,
    [],
    'A private key does not configure a provider.',
  );
  await resources.saveConnection({ id: 'deepseek', provider: 'deepseek', config: {} }, null, {
    id: 'configure-provider',
    fingerprint: 'configure-provider',
  });
  const catalog = await resources.list();
  assert.equal(
    catalog.connections.find((connection) => connection.id === 'deepseek')?.credentialConfigured,
    true,
  );
  assert.doesNotMatch(JSON.stringify(catalog), new RegExp(marker));
  assert.equal(calls, 0);
});
