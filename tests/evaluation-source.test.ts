import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { safeGit } from '../adapters/processes/safe-git.ts';
const { prepareSourceFixture, captureSource } = createRequire(import.meta.url)(
  '../scripts/lib/evaluation-source.cjs',
);
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

async function source(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'evaluation-original-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await safeGit(['init', '-b', 'main'], { cwd: root });
  await safeGit(['config', 'user.name', 'Fixture'], { cwd: root });
  await safeGit(['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=1;\n');
  await fs.writeFile(path.join(root, '.env'), 'PRIVATE_FIXTURE_SOURCE_SECRET');
  await safeGit(['add', '.'], { cwd: root });
  await safeGit(['commit', '-m', 'Fixture'], { cwd: root });
  const head = (await safeGit(['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const definition = {
    sourceRoot: root,
    sourceCommit: head,
    sourceFiles: ['src/value.mjs'],
    sourceHashes: { 'src/value.mjs': hash('export const value=1;\n') },
  };
  return { root, head, definition };
}

test('evaluation copies only pinned tracked files into a new ordinary temporary directory', async (t) => {
  const f = await source(t),
    prepared = await prepareSourceFixture(f.definition);
  t.after(() => prepared.cleanup());
  assert.notEqual(prepared.root, f.root);
  assert.deepEqual(await fs.readdir(prepared.root), ['src']);
  assert.deepEqual(prepared.provenance.hashes, f.definition.sourceHashes);
  await fs.writeFile(path.join(prepared.root, 'src/value.mjs'), 'export const value=2;\n');
  assert.equal(
    await fs.readFile(path.join(f.root, 'src/value.mjs'), 'utf8'),
    'export const value=1;\n',
  );
  assert.equal(await prepared.assertOriginalUnchanged(), true);
  assert.equal((await safeGit(['status', '--porcelain'], { cwd: f.root })).stdout, '');
  assert.equal((await safeGit(['rev-parse', 'HEAD'], { cwd: f.root })).stdout.trim(), f.head);
});

test('evaluation sources reject secrets, path escapes, untracked files, hashes and symbolic links', async (t) => {
  const f = await source(t);
  for (const file of [
    '.env',
    '../outside',
    '/outside',
    '.buro/private.json',
    'src\\value.mjs',
    'node_modules/file',
  ])
    await assert.rejects(captureSource({ ...f.definition, sourceFiles: [file] }));
  await assert.rejects(captureSource({ ...f.definition, sourceFiles: ['missing.mjs'] }), /tracked/);
  await assert.rejects(
    captureSource({ ...f.definition, sourceHashes: { 'src/value.mjs': 'wrong' } }),
    /hash/,
  );
  await fs.symlink('value.mjs', path.join(f.root, 'src/link.mjs'));
  await safeGit(['add', 'src/link.mjs'], { cwd: f.root });
  await safeGit(['commit', '-m', 'Tracked link'], { cwd: f.root });
  const head = (await safeGit(['rev-parse', 'HEAD'], { cwd: f.root })).stdout.trim();
  await assert.rejects(
    captureSource({ ...f.definition, sourceCommit: head, sourceFiles: ['src/link.mjs'] }),
    /symlink/,
  );
});

test('changed original source invalidates evidence rather than reporting preserved state', async (t) => {
  const f = await source(t),
    prepared = await prepareSourceFixture(f.definition);
  t.after(() => prepared.cleanup());
  await fs.writeFile(path.join(f.root, 'src/value.mjs'), 'changed original fixture');
  await assert.rejects(prepared.assertOriginalUnchanged(), /changed/);
  await assert.rejects(captureSource(f.definition), /clean commit/);
});
