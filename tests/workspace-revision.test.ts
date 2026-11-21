import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import { sameWorkspaceRevision } from '../core/workspace-revision.ts';

const exec = promisify(execFile);
async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-revision-test-')));
  const git = (args: string[], cwd = root) => exec('git', args, { cwd });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/code.txt'), 'base\n');
  await fs.writeFile(path.join(root, 'script.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  await fs.writeFile(path.join(root, '.gitignore'), '.buro/\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  const projects = {
    get: () => ({ snapshot: () => ({ project: { root } }) }),
  } as unknown as ProjectRegistry;
  const workspaces = new GitWorkspaces(projects);
  const workspace = await workspaces.prepare('p', 'revision');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, git, workspaces, workspace };
}

test('captured tree binds unstaged, staged, untracked and executable changes without modifying the live index', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace.path, 'src/code.txt'), 'verified\r\n');
  await fs.writeFile(path.join(f.workspace.path, 'added.txt'), 'added\n');
  await f.git(['add', 'added.txt'], f.workspace.path);
  await fs.chmod(path.join(f.workspace.path, 'script.sh'), 0o755);
  const beforeIndex = (await f.git(['ls-files', '--stage'], f.workspace.path)).stdout;
  const revision = await f.workspaces.captureRevision(f.workspace.path, f.workspace.base);
  assert.equal((await f.git(['ls-files', '--stage'], f.workspace.path)).stdout, beforeIndex);
  assert.deepEqual(
    revision.changes.map((file) => file.path),
    ['added.txt', 'script.sh', 'src/code.txt'],
  );
  assert.equal(
    revision.changes.find((file) => file.path === 'src/code.txt')?.after,
    'verified\r\n',
  );
  assert.equal((await f.git(['show', revision.tree + ':src/code.txt'])).stdout, 'verified\r\n');
  assert.match((await f.git(['ls-tree', revision.tree, 'script.sh'])).stdout, /^100755 blob/);
  assert.ok(
    sameWorkspaceRevision(
      revision,
      await f.workspaces.captureRevision(f.workspace.path, f.workspace.base),
    ),
  );
  const commit = await f.workspaces.checkpoint(f.workspace.path, 'revision', revision);
  assert.equal((await f.git(['rev-parse', commit + '^{tree}'])).stdout.trim(), revision.tree);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.workspace.base);
  assert.equal((await f.git(['status', '--porcelain'], f.workspace.path)).stdout, '');
});

test('an additional file or staged-index change after verification rejects checkpoint without changing HEAD', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace.path, 'src/code.txt'), 'verified\n');
  const revision = await f.workspaces.captureRevision(f.workspace.path, f.workspace.base);
  await fs.writeFile(path.join(f.workspace.path, 'late.txt'), 'not checked\n');
  await assert.rejects(f.workspaces.checkpoint(f.workspace.path, 'revision', revision), {
    code: 'VERIFICATION_REVISION_CHANGED',
  });
  await fs.unlink(path.join(f.workspace.path, 'late.txt'));
  await f.git(['add', 'src/code.txt'], f.workspace.path);
  await assert.rejects(f.workspaces.checkpoint(f.workspace.path, 'revision', revision), {
    code: 'VERIFICATION_REVISION_CHANGED',
  });
  assert.equal(
    (await f.git(['rev-parse', 'HEAD'], f.workspace.path)).stdout.trim(),
    f.workspace.base,
  );
  assert.equal(
    (await f.git(['diff', '--cached', '--name-only'], f.workspace.path)).stdout.trim(),
    'src/code.txt',
  );
});

test('checkpoint commits captured bytes even if a writer mutates files immediately after final revalidation', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace.path, 'src/code.txt'), 'verified\n');
  const revision = await f.workspaces.captureRevision(f.workspace.path, f.workspace.base);
  const capture = f.workspaces.captureRevision.bind(f.workspaces);
  let count = 0;
  f.workspaces.captureRevision = async (...args) => {
    const result = await capture(...args);
    if (++count === 2) {
      await fs.writeFile(path.join(f.workspace.path, 'src/code.txt'), 'late unreviewed\n');
      await fs.writeFile(path.join(f.workspace.path, 'late.txt'), 'late unreviewed\n');
      await f.git(['symbolic-ref', 'HEAD', 'refs/heads/main'], f.workspace.path);
    }
    return result;
  };
  const commit = await f.workspaces.checkpoint(f.workspace.path, 'revision', revision);
  assert.equal((await f.git(['show', commit + ':src/code.txt'])).stdout, 'verified\n');
  await assert.rejects(f.git(['show', commit + ':late.txt']));
  assert.equal(
    await fs.readFile(path.join(f.workspace.path, 'src/code.txt'), 'utf8'),
    'late unreviewed\n',
  );
  assert.match((await f.git(['status', '--porcelain'], f.workspace.path)).stdout, /late.txt/);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.workspace.base);
});

test('source capture refuses a changed HEAD and detects content hidden by assume-unchanged flags', async (t) => {
  const f = await fixture(t);
  await f.git(['update-index', '--assume-unchanged', 'src/code.txt'], f.workspace.path);
  await fs.writeFile(path.join(f.workspace.path, 'src/code.txt'), 'hidden from normal diff\n');
  const revision = await f.workspaces.captureRevision(f.workspace.path, f.workspace.base);
  assert.equal(
    revision.changes.find((file) => file.path === 'src/code.txt')?.after,
    'hidden from normal diff\n',
  );
  await f.git(
    ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'external'],
    f.workspace.path,
  );
  await assert.rejects(f.workspaces.captureRevision(f.workspace.path, f.workspace.base), {
    code: 'VERIFICATION_REVISION_CHANGED',
  });
  await assert.rejects(f.workspaces.checkpoint(f.workspace.path, 'revision', revision), {
    code: 'VERIFICATION_REVISION_CHANGED',
  });
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.workspace.base);
});

test('sparse missing entries remain baseline while an actually deleted source is captured', async (t) => {
  const f = await fixture(t);
  await f.git(['config', 'core.sparseCheckout', 'true'], f.workspace.path);
  await f.git(['update-index', '--skip-worktree', 'script.sh'], f.workspace.path);
  await fs.unlink(path.join(f.workspace.path, 'script.sh'));
  await fs.unlink(path.join(f.workspace.path, 'src/code.txt'));
  const revision = await f.workspaces.captureRevision(f.workspace.path, f.workspace.base);
  assert.deepEqual(
    revision.changes.map((file) => file.path),
    ['src/code.txt'],
  );
  assert.equal((await f.git(['show', revision.tree + ':script.sh'])).stdout, '#!/bin/sh\nexit 0\n');
  await assert.rejects(f.git(['show', revision.tree + ':src/code.txt']));
});
