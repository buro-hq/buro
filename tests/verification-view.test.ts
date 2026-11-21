import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { safeGit } from '../adapters/processes/safe-git.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { ContextMaterial } from '../protocol/context.ts';

const exec = promisify(execFile);
async function fixture(
  t: any,
  materials: ContextMaterial[] = [],
  initialFiles: Record<string, string | Buffer> = {},
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-view-test-')));
  const git = (args: string[], cwd = root) => exec('git', args, { cwd });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/value.txt'), 'base\n');
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 255, 128, 10]));
  await fs.writeFile(path.join(root, 'script.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, '.gitignore'), '.buro/\nnode_modules/\n');
  for (const [filename, content] of Object.entries(initialFiles)) {
    await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await fs.writeFile(path.join(root, filename), content);
  }
  await git(['add', '.']);
  for (const filename of Object.keys(initialFiles)) await git(['add', '-f', '--', filename]);
  await git(['commit', '-m', 'Initial']);
  if (materials.length) {
    await fs.mkdir(path.join(root, '.buro/local/context'), { recursive: true });
    await fs.writeFile(path.join(root, '.buro', materials[0].relativePath), 'selected material');
    await fs.writeFile(path.join(root, '.buro/local/context/unselected.txt'), 'private unrelated');
  }
  const projects = {
    get: () => ({ snapshot: () => ({ project: { root } }) }),
  } as unknown as ProjectRegistry;
  const workspaces = new GitWorkspaces(projects);
  const workspace = await workspaces.prepare('p', 'view-run', 'HEAD', { materials });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const open = async (outputPaths: string[] = []) => {
    const revision = await workspaces.captureRevision(workspace.path, workspace.base);
    const view = await workspaces.openVerificationView(workspace.path, revision, {
      projectId: 'p',
      runId: 'view-run',
      outputPaths,
    });
    t.after(() => workspaces.releaseVerificationView(view));
    return { revision, view };
  };
  return { root, git, workspaces, workspace, open };
}

test('verification inputs preserve raw Git bytes and modes with independent metadata and writable output aliases', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace.path, 'src/value.txt'), 'verified\r\n');
  await fs.writeFile(path.join(f.workspace.path, 'new.txt'), 'captured new\n');
  await fs.symlink('value.txt', path.join(f.workspace.path, 'src/internal-link'));
  const { view } = await f.open(['coverage/', 'build/generated']);
  assert.equal(Object.isFrozen(view.outputPaths), true);
  assert.equal(
    await fs.readFile(path.join(view.readRoot, 'src/value.txt'), 'utf8'),
    'verified\r\n',
  );
  assert.deepEqual(
    await fs.readFile(path.join(view.readRoot, 'binary.dat')),
    Buffer.from([0, 255, 128, 10]),
  );
  assert.equal((await fs.stat(path.join(view.readRoot, 'script.sh'))).mode & 0o111, 0o111);
  assert.equal((await fs.stat(path.join(view.readRoot, 'src/value.txt'))).mode & 0o222, 0);
  assert.equal((await fs.stat(path.join(view.readRoot, 'src'))).mode & 0o222, 0);
  assert.equal(
    await fs.realpath(path.join(view.readRoot, 'src/internal-link')),
    path.join(view.readRoot, 'src/value.txt'),
  );
  assert.equal((await fs.lstat(path.join(view.readRoot, '.git'))).isDirectory(), true);
  await fs.writeFile(path.join(view.readRoot, 'coverage/report.txt'), 'output');
  assert.equal(
    await fs.readFile(path.join(view.outputRoot, 'coverage/report.txt'), 'utf8'),
    'output',
  );
  await assert.rejects(fs.stat(path.join(f.workspace.path, 'coverage/report.txt')), {
    code: 'ENOENT',
  });
  await fs.writeFile(path.join(f.workspace.path, 'src/value.txt'), 'live source changed');
  assert.equal(
    await fs.readFile(path.join(view.readRoot, 'src/value.txt'), 'utf8'),
    'verified\r\n',
  );
  assert.match(
    (
      await safeGit(['diff', '--no-ext-diff', '--no-textconv', view.base, '--'], {
        cwd: view.readRoot,
      })
    ).stdout,
    /captured new/,
  );
  const metadata = (
    await safeGit(['rev-parse', '--absolute-git-dir'], { cwd: view.readRoot })
  ).stdout.trim();
  assert.ok(metadata.startsWith(view.readRoot + '/'));
  await f.workspaces.releaseVerificationView(view);
  await f.workspaces.releaseVerificationView(view);
  await assert.rejects(fs.stat(view.readRoot), { code: 'ENOENT' });
});

test('packed source objects are copied exactly and frozen Git diff survives deletion of the writer repository', async (t) => {
  const f = await fixture(t);
  await f.git(['repack', '-a', '-d']);
  await fs.writeFile(path.join(f.workspace.path, 'src/value.txt'), 'packed verification\n');
  const { view } = await f.open();
  await fs.rm(f.root, { recursive: true, force: true });
  const diff = (
    await safeGit(['diff', '--no-ext-diff', '--no-textconv', view.base, '--'], {
      cwd: view.readRoot,
    })
  ).stdout;
  assert.match(diff, /packed verification/);
  assert.equal(
    await fs.readFile(path.join(view.readRoot, 'src/value.txt'), 'utf8'),
    'packed verification\n',
  );
  await assert.rejects(fs.stat(path.join(view.readRoot, '.git/objects/info/alternates')), {
    code: 'ENOENT',
  });
});

test('outputs cannot shadow source or private input and source links cannot escape or alias writable outputs', async (t) => {
  const f = await fixture(t);
  for (const output of ['src', 'src/value.txt', '.buro/tmp', '.git', '../escape'])
    await assert.rejects(f.open([output]));
  await assert.rejects(f.open(['coverage', 'coverage/sub']), {
    code: 'VERIFICATION_VIEW_UNAVAILABLE',
  });
  await fs.symlink('../../outside', path.join(f.workspace.path, 'src/escape'));
  await assert.rejects(f.open(), { code: 'VERIFICATION_VIEW_UNAVAILABLE' });
  await fs.unlink(path.join(f.workspace.path, 'src/escape'));
  await fs.symlink('../coverage/generated', path.join(f.workspace.path, 'src/output-alias'));
  await assert.rejects(f.open(['coverage']), { code: 'VERIFICATION_VIEW_UNAVAILABLE' });
});

test('only selected materials and validated prepared dependencies enter a verification view', async (t) => {
  const hash = createHash('sha256').update('selected material').digest('hex');
  const material: ContextMaterial = {
    id: 'M-a',
    name: 'selected.txt',
    mimeType: 'text/plain',
    size: 17,
    hash,
    relativePath: `local/context/${hash}.txt`,
    scope: 'project',
    active: true,
    createdAt: new Date(0).toISOString(),
  };
  const f = await fixture(t, [material]);
  await fs.mkdir(path.join(f.workspace.path, 'node_modules/pkg'), { recursive: true });
  await fs.writeFile(path.join(f.workspace.path, 'node_modules/pkg/index.js'), 'module.exports=1');
  const { view } = await f.open();
  assert.equal(view.readonlyDependencies?.[0].path, path.join(view.readRoot, 'node_modules'));
  assert.equal(view.readonlyDependencies?.[0].target, path.join(f.workspace.path, 'node_modules'));
  assert.equal(
    await fs.readFile(path.join(view.readRoot, '.buro/context', hash + '.txt'), 'utf8'),
    'selected material',
  );
  await assert.rejects(fs.stat(path.join(view.readRoot, '.buro/context/unselected.txt')), {
    code: 'ENOENT',
  });
  await fs.symlink('../../src', path.join(f.workspace.path, 'node_modules/live-source'));
  await assert.rejects(f.open(), { code: 'VERIFICATION_VIEW_UNAVAILABLE' });
});

test('view ownership is pinned and aborted or forged handles cannot gain or release another view', async (t) => {
  const f = await fixture(t);
  const { view, revision } = await f.open();
  await assert.rejects(f.workspaces.releaseVerificationView({ ...view }), {
    code: 'VERIFICATION_VIEW_UNAVAILABLE',
  });
  await assert.rejects(
    f.workspaces.openVerificationView(f.workspace.path, revision, {
      projectId: 'other',
      runId: 'view-run',
      outputPaths: [],
    }),
    { code: 'VERIFICATION_REVISION_CHANGED' },
  );
  await assert.rejects(
    f.workspaces.openVerificationView(f.workspace.path, revision, {
      projectId: 'p',
      runId: 'other',
      outputPaths: [],
    }),
    { code: 'VERIFICATION_REVISION_CHANGED' },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.workspaces.openVerificationView(f.workspace.path, revision, {
      projectId: 'p',
      runId: 'view-run',
      outputPaths: [],
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(await fs.readFile(path.join(view.readRoot, 'src/value.txt'), 'utf8'), 'base\n');
});

test('a model-created dependency alias cannot grant access to another host directory', async (t) => {
  const f = await fixture(t);
  const external = path.join(f.root, 'node_modules');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'not-prepared.txt'), 'not granted');
  await fs.symlink(external, path.join(f.workspace.path, 'node_modules'), 'dir');
  await assert.rejects(f.open(), { code: 'VERIFICATION_VIEW_UNAVAILABLE' });
});

test('shared project configuration is immutable public input while tracked private files are an explicit unsupported capability', async (t) => {
  const publicProject = await fixture(t, [], { '.buro/project.json': '{"version":1}\n' });
  const { view } = await publicProject.open();
  assert.equal(
    await fs.readFile(path.join(view.readRoot, '.buro/project.json'), 'utf8'),
    '{"version":1}\n',
  );
  assert.equal((await fs.stat(path.join(view.readRoot, '.buro/project.json'))).mode & 0o222, 0);
  const secretProject = await fixture(t, [], { '.env': 'FAKE_ONLY=not-a-secret\n' });
  await assert.rejects(secretProject.open(), { code: 'VERIFICATION_VIEW_UNAVAILABLE' });
  await fs.unlink(path.join(secretProject.workspace.path, '.env'));
  await assert.rejects(secretProject.open(), { code: 'VERIFICATION_VIEW_UNAVAILABLE' });
});
