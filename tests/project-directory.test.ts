import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findProjectDirectory } from '../adapters/files/project-directory.ts';
import { PROJECT_DIRECTORY } from '../protocol/project-directory.ts';

async function fixture(t: { after(action: () => Promise<void>): void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-metadata-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, PROJECT_DIRECTORY) };
}

test('metadata lookup returns the current location without creating files', async (t) => {
  const f = await fixture(t);
  assert.equal(await findProjectDirectory(f.root), f.directory);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('metadata lookup preserves an existing directory and every stored byte', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.directory);
  const bytes = '{"current":"unchanged"}\n';
  await fs.writeFile(path.join(f.directory, 'control-state.json'), bytes);
  assert.equal(await findProjectDirectory(f.root), f.directory);
  assert.deepEqual(await fs.readdir(f.directory), ['control-state.json']);
  assert.equal(await fs.readFile(path.join(f.directory, 'control-state.json'), 'utf8'), bytes);
});

test('metadata lookup rejects files and symlinks, including dangling links, without following them', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.directory, 'regular file');
  await assert.rejects(findProjectDirectory(f.root), { code: 'UNSAFE_PATH' });
  assert.equal(await fs.readFile(f.directory, 'utf8'), 'regular file');
  await fs.rm(f.directory);
  const target = path.join(f.root, 'outside');
  await fs.mkdir(target);
  await fs.symlink(target, f.directory, 'dir');
  await assert.rejects(findProjectDirectory(f.root), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(target), []);
  await fs.rm(f.directory);
  await fs.symlink(path.join(f.root, 'missing'), f.directory, 'dir');
  await assert.rejects(findProjectDirectory(f.root), { code: 'UNSAFE_PATH' });
  assert.equal((await fs.lstat(f.directory)).isSymbolicLink(), true);
});
