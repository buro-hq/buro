import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectManager } from '../adapters/files/project-manager.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import type { Run } from '../protocol/domain.ts';

const exec = promisify(execFile);

test('applying accepted model-written attributes cannot activate host smudge filters', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-apply-git-')));
  const root = path.join(directory, 'repo');
  await fs.mkdir(root);
  const git = (args: string[]) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(root, '.gitignore'), '.buro/\n');
  await fs.writeFile(path.join(root, 'file.txt'), 'before\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);

  const marker = path.join(directory, 'outside-marker');
  const program = path.join(directory, 'filter.sh');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await fs.writeFile(program, '#!/bin/sh\nprintf executed >> ' + quote(marker) + '\ncat\n', {
    mode: 0o755,
  });
  await git(['config', 'filter.sideeffect.smudge', quote(program)]);
  await git(['config', 'filter.sideeffect.required', 'true']);

  const registry = new ProjectStoreRegistry([]);
  const manager = new ProjectManager({
    registry,
    policies: {},
    catalogFile: path.join(directory, 'catalog.json'),
  });
  t.after(async () => {
    await manager.dispose();
    await registry.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const initial = await manager.inspect(root);
  initial.profile.dependencies = 'none';
  const project = await manager.connect('connect', 'connect', {
    root,
    name: initial.name,
    profile: initial.profile,
  });
  const workspaces = new GitWorkspaces(registry);
  const workspace = await workspaces.prepare(project.id, 'R-apply');
  await fs.writeFile(path.join(workspace.path, '.gitattributes'), '*.txt filter=sideeffect\n');
  await fs.writeFile(path.join(workspace.path, 'file.txt'), 'after\n');
  const commit = await workspaces.checkpoint(workspace.path, 'R-apply');
  const run: Run = {
    id: 'R-apply',
    key: 'G-apply',
    goalId: 'G-apply',
    title: 'Apply fixture',
    summary: 'Done',
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    threadId: 'fixture',
    status: 'completed',
    phase: 'done',
    commit,
    agents: [],
    events: [],
    commands: [],
    plan: [],
    changedFiles: [],
    baseline: { passed: 1, total: 1, results: [] },
    acceptance: { passed: 1, total: 1, results: [] },
    specsUnchanged: true,
    scopePreserved: true,
    independentReviewer: true,
    goalText: 'Apply fixture',
    result: 'Done',
    sourceHash: '',
  };
  await registry.get(project.id).transact('seed', 'seed', (doc) => {
    const goal = {
      revision: 1,
      id: run.goalId,
      projectId: project.id,
      title: run.title,
      body: run.goalText,
      criteria: '',
      createdAt: run.createdAt,
      status: 'completed' as const,
      runId: run.id,
    };
    doc.goals.push(goal);
    doc.runs.push(run);
    return { result: null, change: { type: 'run.changed', run, goal } };
  });
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'before\n');

  const result = await manager.apply('apply', 'apply', {
    projectId: project.id,
    runId: run.id,
    expectedHead: initial.head,
    expectedBranch: initial.branch,
  });
  assert.deepEqual(result, { commit, branch: 'main' });
  assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), commit);
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'after\n');
  assert.equal(
    await fs.readFile(path.join(root, '.gitattributes'), 'utf8'),
    '*.txt filter=sideeffect\n',
  );
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});
