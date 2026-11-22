import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { ProjectManager } from '../adapters/files/project-manager.ts';
import type { ProjectRegistry } from '../core/ports.ts';
const exec = promisify(execFile);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function fixture(t: any, attributes = false) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-service-git-')),
  );
  const root = path.join(directory, 'repo');
  await fs.mkdir(root);
  const git = (args: string[], cwd = root) => exec('git', args, { cwd, encoding: 'utf8' });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(root, 'file.txt'), 'before\n');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'config.json'), 'public\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.buro/\n');
  if (attributes)
    await fs.writeFile(
      path.join(root, '.gitattributes'),
      '*.txt filter=sideeffect diff=sideeffect\n',
    );
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const marker = path.join(directory, 'outside-side-effect');
  const program = path.join(directory, 'sideeffect.sh');
  await fs.writeFile(program, '#!/bin/sh\nprintf executed >> ' + quote(marker) + '\ncat\n', {
    mode: 0o755,
  });
  const hooks = path.join(directory, 'hooks');
  await fs.mkdir(hooks);
  for (const hook of [
    'post-checkout',
    'pre-commit',
    'prepare-commit-msg',
    'commit-msg',
    'post-commit',
  ])
    await fs.writeFile(
      path.join(hooks, hook),
      '#!/bin/sh\nprintf hook >> ' + quote(marker) + '\n',
      { mode: 0o755 },
    );
  for (const key of [
    'filter.sideeffect.clean',
    'filter.sideeffect.smudge',
    'filter.sideeffect.process',
    'diff.sideeffect.command',
    'diff.sideeffect.textconv',
    'diff.external',
    'core.fsmonitor',
    'gpg.program',
  ])
    await git(['config', key, quote(program)]);
  await git(['config', 'filter.sideeffect.required', 'true']);
  await git(['config', 'core.hooksPath', hooks]);
  await git(['config', 'commit.gpgsign', 'true']);
  const projects = {
    get: () => ({ snapshot: () => ({ project: { root } }) }),
  } as unknown as ProjectRegistry;
  const workspaces = new GitWorkspaces(projects);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, root, git, base, marker, workspaces };
}

test('service diff and checkpoint cannot activate repository drivers through model-written attributes', async (t) => {
  const f = await fixture(t);
  const workspace = await f.workspaces.prepare('p', 'R-safe');
  await fs.writeFile(
    path.join(workspace.path, '.gitattributes'),
    '*.txt filter=sideeffect diff=sideeffect\n',
  );
  await fs.writeFile(path.join(workspace.path, 'file.txt'), 'after\n');
  const changes = await f.workspaces.changes(workspace.path, workspace.base);
  assert.deepEqual(
    changes.find((file) => file.path === 'file.txt'),
    { path: 'file.txt', before: 'before\n', after: 'after\n' },
  );
  assert.ok(changes.some((file) => file.path === '.gitattributes'));
  await assert.rejects(fs.stat(f.marker), { code: 'ENOENT' });
  const commit = await f.workspaces.checkpoint(workspace.path, 'R-safe');
  assert.notEqual(commit, f.base);
  assert.equal((await f.git(['show', commit + ':file.txt'])).stdout, 'after\n');
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.base);
  assert.equal(await fs.readFile(path.join(f.root, 'file.txt'), 'utf8'), 'before\n');
  await assert.rejects(fs.stat(f.marker), { code: 'ENOENT' });
});

test('worktree preparation disables smudge filters and checkout hooks for existing attributes', async (t) => {
  const f = await fixture(t, true);
  const workspace = await f.workspaces.prepare('p', 'R-checkout');
  assert.equal(await fs.readFile(path.join(workspace.path, 'file.txt'), 'utf8'), 'before\n');
  await assert.rejects(fs.stat(f.marker), { code: 'ENOENT' });
});

test('read-only repository inspection does not execute fsmonitor or content conversion', async (t) => {
  const f = await fixture(t, true);
  await fs.writeFile(path.join(f.root, 'file.txt'), 'changed\n');
  const manager = new ProjectManager({
    registry: new ProjectStoreRegistry([]),
    policies: {},
    catalogFile: path.join(f.directory, 'catalog.json'),
  });
  t.after(() => manager.dispose());
  const info = await manager.inspect(f.root);
  assert.equal(info.dirty, true);
  assert.ok(info.dirtyFiles.some((file) => file.includes('file.txt')));
  await assert.rejects(fs.stat(f.marker), { code: 'ENOENT' });
});

test('service diff and checkpoint reject a tracked file behind a symlinked ancestor', async (t) => {
  const f = await fixture(t);
  const workspace = await f.workspaces.prepare('p', 'R-parent-symlink');
  const privateDirectory = path.join(f.directory, 'private');
  await fs.mkdir(privateDirectory);
  const secret = path.join(privateDirectory, 'config.json');
  await fs.writeFile(secret, 'PRIVATE-OUTSIDE-WORKSPACE\n');
  await fs.rm(path.join(workspace.path, 'src'), { recursive: true });
  await fs.symlink(privateDirectory, path.join(workspace.path, 'src'));
  await assert.rejects(
    f.workspaces.changes(workspace.path, workspace.base),
    /Unsafe workspace ancestor/,
  );
  await assert.rejects(
    f.workspaces.checkpoint(workspace.path, 'R-parent-symlink'),
    /Unsafe workspace ancestor/,
  );
  assert.equal(await fs.readFile(secret, 'utf8'), 'PRIVATE-OUTSIDE-WORKSPACE\n');
  assert.equal((await f.git(['rev-parse', 'HEAD'], workspace.path)).stdout.trim(), f.base);
  assert.equal(await fs.readFile(path.join(f.root, 'src', 'config.json'), 'utf8'), 'public\n');
});

test('workspace validation rejects symlinked Git control files and replaced workspace roots', async (t) => {
  const f = await fixture(t);
  const workspace = await f.workspaces.prepare('p', 'R-root-symlink');
  const gitPointer = path.join(workspace.path, '.git');
  const externalPointer = path.join(f.directory, 'external-git-pointer');
  await fs.rename(gitPointer, externalPointer);
  await fs.symlink(externalPointer, gitPointer);
  await assert.rejects(
    f.workspaces.changes(workspace.path, workspace.base),
    /Not a regular workspace file/,
  );
  await fs.unlink(gitPointer);
  await fs.rename(externalPointer, gitPointer);
  const moved = path.join(f.directory, 'moved-workspace');
  await fs.rename(workspace.path, moved);
  await fs.symlink(moved, workspace.path);
  await assert.rejects(
    f.workspaces.changes(workspace.path, workspace.base),
    /workspace path changed/,
  );
});

test('diff reports leaf symlinks without reading their targets and still handles deletions', async (t) => {
  const f = await fixture(t);
  const workspace = await f.workspaces.prepare('p', 'R-leaf-symlink');
  const secret = path.join(f.directory, 'private-file');
  await fs.writeFile(secret, 'PRIVATE-OUTSIDE-WORKSPACE\n');
  await fs.unlink(path.join(workspace.path, 'file.txt'));
  await fs.symlink(secret, path.join(workspace.path, 'file.txt'));
  await fs.unlink(path.join(workspace.path, 'src', 'config.json'));
  const changes = await f.workspaces.changes(workspace.path, workspace.base);
  assert.deepEqual(
    changes.find((file) => file.path === 'file.txt'),
    {
      path: 'file.txt',
      before: 'before\n',
      after: '[symlink ' + secret + ']',
    },
  );
  assert.deepEqual(
    changes.find((file) => file.path === 'src/config.json'),
    {
      path: 'src/config.json',
      before: 'public\n',
      after: '',
    },
  );
  assert.ok(!JSON.stringify(changes).includes('PRIVATE-OUTSIDE-WORKSPACE'));
});
