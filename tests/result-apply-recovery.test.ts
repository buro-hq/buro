import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectManager } from '../adapters/files/project-manager.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { resultApplyReceiptId } from '../core/result-apply.ts';
import { sampleRun } from './fixtures/sample-run.ts';

const exec = promisify(execFile);

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-apply-recovery-')),
  );
  const root = path.join(directory, 'repo');
  await fs.mkdir(root);
  const git = (args: string[]) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(root, '.gitignore'), '.buro/\n');
  await fs.writeFile(path.join(root, 'value.txt'), 'before\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  let registry = new FileProjectRegistry([]);
  const makeManager = () =>
    new ProjectManager({
      registry,
      policies: {},
      catalogFile: path.join(directory, 'catalog.json'),
    });
  let manager = makeManager();
  const info = await manager.inspect(root);
  const project = await manager.connect('connect', 'connect', {
    root,
    name: 'Apply fixture',
    profile: info.profile,
  });
  let store = registry.get(project.id) as FileProjectStore;
  const workspaces = new GitWorkspaces(registry);
  const workspace = await workspaces.prepare(project.id, 'R-example');
  await fs.writeFile(path.join(workspace.path, 'value.txt'), 'after\n');
  const target = await workspaces.checkpoint(workspace.path, 'R-example');
  const run = { ...sampleRun(), commit: target };
  await store.transact('seed', 'seed', (doc) => {
    const goal = {
      id: run.goalId,
      projectId: project.id,
      title: run.title,
      body: run.goalText,
      criteria: '',
      createdAt: run.createdAt,
      status: 'completed' as const,
    };
    doc.goals.push(goal);
    doc.runs.push(run);
    return { result: null, change: { type: 'run.changed', run, goal } };
  });
  t.after(async () => {
    await manager.dispose();
    await registry.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    root,
    git,
    project,
    target,
    input: {
      projectId: project.id,
      runId: run.id,
      expectedHead: info.head,
      expectedBranch: 'main',
    },
    get store() {
      return store;
    },
    get manager() {
      return manager;
    },
    otherManager: makeManager,
    async reopen() {
      const data = store.directory;
      await manager.dispose();
      await registry.close();
      store = await FileProjectStore.open({ directory: data, project });
      registry = new FileProjectRegistry([store]);
      manager = makeManager();
    },
  };
}

test('apply persists intent before Git; a failed intent write changes no source files', async (t) => {
  const f = await fixture(t),
    replace = f.store.replace;
  f.store.replace = async (from, to) => {
    const state = JSON.parse(await fs.readFile(from, 'utf8'));
    if (state.resultApplyIntents?.apply) throw Error('Intent storage unavailable');
    return replace(from, to);
  };
  await assert.rejects(f.manager.apply('apply', 'fp-apply', f.input), /Intent storage unavailable/);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.input.expectedHead);
  assert.equal(await fs.readFile(path.join(f.root, 'value.txt'), 'utf8'), 'before\n');
  f.store.replace = replace;
  assert.deepEqual(await f.manager.apply('apply', 'fp-apply', f.input), {
    commit: f.target,
    branch: 'main',
  });
});

test('restart settles an observed fast-forward after receipt persistence failed without another merge', async (t) => {
  const f = await fixture(t),
    replace = f.store.replace;
  f.store.replace = async (from, to) => {
    const state = JSON.parse(await fs.readFile(from, 'utf8'));
    if (state.resultApplyIntents?.apply?.status === 'completed')
      throw Error('Receipt storage unavailable');
    return replace(from, to);
  };
  await assert.rejects(
    f.manager.apply('apply', 'fp-apply', f.input),
    /Receipt storage unavailable/,
  );
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.target);
  assert.equal(f.store.receipt('apply', 'fp-apply'), undefined);
  assert.equal(f.store.doc.resultApplyIntents?.apply.status, 'dispatched');
  await f.reopen();
  const reflogBefore = (await f.git(['reflog', '--format=%H %gs'])).stdout;
  const result = await f.manager.apply('apply', 'fp-apply', f.input);
  assert.deepEqual(result, { commit: f.target, branch: 'main' });
  assert.equal((await f.git(['reflog', '--format=%H %gs'])).stdout, reflogBefore);
  assert.equal(f.store.doc.resultApplyIntents?.apply.status, 'completed');
  assert.deepEqual(f.store.receipt('apply', 'fp-apply'), result);
  assert.equal(Object.hasOwn(f.store.snapshot(), 'resultApplyIntents'), false);
  assert.equal(JSON.stringify(f.store.snapshot()).includes('fp-apply'), false);
  await assert.rejects(f.manager.apply('apply', 'different', f.input), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

test('a lost dispatch acknowledgement with unchanged HEAD remains unknown and is never replayed', async (t) => {
  const f = await fixture(t),
    replace = f.store.replace;
  f.store.replace = async (from, to) => {
    const state = JSON.parse(await fs.readFile(from, 'utf8'));
    await replace(from, to);
    if (state.resultApplyIntents?.apply?.status === 'dispatched')
      throw Error('Lost dispatch acknowledgement');
  };
  await assert.rejects(
    f.manager.apply('apply', 'fp-apply', f.input),
    /Lost dispatch acknowledgement/,
  );
  await f.reopen();
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.input.expectedHead);
  await assert.rejects(f.manager.apply('apply', 'fp-apply', f.input), {
    code: 'APPLY_RECONCILIATION_REQUIRED',
  });
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.input.expectedHead);
  assert.equal(f.store.receipt('apply', 'fp-apply'), undefined);
});

test('a prepared operation without a dispatch may continue after restart', async (t) => {
  const f = await fixture(t),
    replace = f.store.replace;
  f.store.replace = async (from, to) => {
    const state = JSON.parse(await fs.readFile(from, 'utf8'));
    if (state.resultApplyIntents?.apply?.status === 'dispatched')
      throw Error('Dispatch storage unavailable');
    return replace(from, to);
  };
  await assert.rejects(
    f.manager.apply('apply', 'fp-apply', f.input),
    /Dispatch storage unavailable/,
  );
  assert.equal(f.store.doc.resultApplyIntents?.apply.status, 'prepared');
  await f.reopen();
  assert.deepEqual(await f.manager.apply('apply', 'fp-apply', f.input), {
    commit: f.target,
    branch: 'main',
  });
});

test('reconciliation never merges over a changed branch or an independently changed HEAD', async (t) => {
  const f = await fixture(t),
    replace = f.store.replace;
  f.store.replace = async (from, to) => {
    const state = JSON.parse(await fs.readFile(from, 'utf8'));
    if (state.resultApplyIntents?.apply?.status === 'completed')
      throw Error('Receipt storage unavailable');
    return replace(from, to);
  };
  await assert.rejects(f.manager.apply('apply', 'fp-apply', f.input));
  f.store.replace = replace;
  await f.git(['switch', '-c', 'another']);
  await assert.rejects(f.manager.apply('apply', 'fp-apply', f.input), {
    code: 'APPLY_RECONCILIATION_REQUIRED',
  });
  await f.git(['switch', 'main']);
  await fs.writeFile(path.join(f.root, 'user.txt'), 'user work\n');
  await f.git(['add', 'user.txt']);
  await f.git(['commit', '-m', 'Independent user commit']);
  const userHead = (await f.git(['rev-parse', 'HEAD'])).stdout;
  await assert.rejects(f.manager.apply('apply', 'fp-apply', f.input), {
    code: 'APPLY_RECONCILIATION_REQUIRED',
  });
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout, userHead);
  assert.equal(await fs.readFile(path.join(f.root, 'user.txt'), 'utf8'), 'user work\n');
});

test('one committed dispatch nonce owns application across managers sharing the store', async (t) => {
  const f = await fixture(t),
    other = f.otherManager();
  t.after(() => other.dispose());
  const before = f.store.snapshot().sequence;
  const results = await Promise.allSettled([
    f.manager.apply('apply', 'fp-apply', f.input),
    other.apply('apply', 'fp-apply', f.input),
  ]);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  for (const result of results)
    if (result.status === 'rejected')
      assert.equal(result.reason.code, 'APPLY_RECONCILIATION_REQUIRED');
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.target);
  assert.equal(f.store.snapshot().sequence, before + 3);
  assert.ok(f.store.receipt(resultApplyReceiptId('dispatch', 'apply'), 'fp-apply'));
});
