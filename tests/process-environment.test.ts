import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  previewEnvironment,
  deploymentEnvironment,
  environmentRedactor,
} from '../adapters/processes/environment.ts';
async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'preview-env-')));
  await fs.mkdir(path.join(root, 'apps/web'), { recursive: true });
  await fs.mkdir(path.join(root, '.buro/local'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('preview reads source dotenv, component dotenv and private overrides in order without copying files', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(
    path.join(root, '.env'),
    'export SHARED=base\nROOT_ONLY="source value"\nAPI_TOKEN="source-secret"\n',
  );
  await fs.writeFile(path.join(root, '.env.local'), 'SHARED=root-local\n');
  await fs.writeFile(
    path.join(root, 'apps/web/.env'),
    'SHARED=component\nCOMPONENT_ONLY=present\n',
  );
  await fs.writeFile(path.join(root, 'apps/web/.env.local'), 'SHARED=component-local\n');
  await fs.writeFile(
    path.join(root, '.buro/local/environment.env'),
    'SHARED=private-common\nQUOTED="a # b"\n',
  );
  await fs.writeFile(
    path.join(root, '.buro/local/web.env'),
    'export SHARED="private-component" # comment\nMULTILINE="first\nsecond"\n',
  );
  const env = await previewEnvironment(root, 'apps/web', 'web');
  assert.equal(env.values.SHARED, 'private-component');
  assert.equal(env.values.ROOT_ONLY, 'source value');
  assert.equal(env.values.API_TOKEN, 'source-secret');
  assert.equal(env.values.QUOTED, 'a # b');
  assert.equal(env.values.MULTILINE, 'first\nsecond');
  assert.deepEqual(env.sources, [
    '.env',
    '.env.local',
    'apps/web/.env',
    'apps/web/.env.local',
    '.buro/local/environment.env',
    '.buro/local/web.env',
  ]);
  assert.equal(
    (await previewEnvironment(root, './', 'other')).sources.filter((s) => s === '.env').length,
    1,
  );
  assert.match(await fs.readFile(path.join(root, '.env'), 'utf8'), /API_TOKEN="source-secret"/);
});
test('deployment does not inherit source development variables', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, '.env'), 'DEV_TOKEN=development-secret\n');
  await fs.writeFile(path.join(root, '.buro/local/environment.env'), 'SHARED=private\n');
  await fs.writeFile(
    path.join(root, '.buro/local/production.env'),
    'DEPLOY_TOKEN=production-secret\n',
  );
  const env = await deploymentEnvironment(root, 'production');
  assert.equal(env.values.DEV_TOKEN, undefined);
  assert.equal(env.values.DEPLOY_TOKEN, 'production-secret');
  assert.deepEqual(env.sources, ['.buro/local/environment.env', '.buro/local/production.env']);
});
test('dotenv sources cannot escape through a component path or symlink', async (t) => {
  const root = await fixture(t);
  await assert.rejects(previewEnvironment(root, '../', 'web'), /escapes the source project/);
  await fs.writeFile(path.join(root, 'secret.env'), 'TOKEN=private\n');
  await fs.symlink(path.join(root, 'secret.env'), path.join(root, '.env'));
  await assert.rejects(previewEnvironment(root, './', 'web'), /regular file/);
});
test('environment values are redacted from full, encoded and split secret log output', () => {
  const token = 'private value+%?key';
  const redact = environmentRedactor({
    API_TOKEN: token,
    API_URL: 'https://user:password@example.invalid?api_key=query-secret',
    PUBLIC_SETTING: 'visible',
  });
  for (const value of [
    token,
    encodeURIComponent(token),
    new URLSearchParams({ v: token }).toString().slice(2),
    JSON.stringify(token).slice(1, -1),
    'password',
    'query-secret',
  ])
    assert.equal(redact('log ' + value + ' end').includes(value), false);
  assert.equal(redact('log ' + token.slice(0, 7)).includes(token.slice(0, 7)), false);
  assert.ok(redact('log visible').includes('visible'));
});
