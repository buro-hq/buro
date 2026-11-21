import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectManager } from '../adapters/files/project-manager.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { ProjectChecks, runProjectCommand } from '../adapters/checks/project-commands.ts';
import { GoalService } from '../core/services.ts';
import type { ExecutionPolicy } from '../core/execution-ports.ts';
import type { Run } from '../protocol/domain.ts';
const exec = promisify(execFile);
async function fixture(t: any) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'user-projects-'))),
    root = path.join(directory, 'repo'),
    data = path.join(directory, 'daemon');
  await fs.mkdir(root);
  await fs.mkdir(data);
  const git = (args: string[]) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'master']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=1;\n');
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'Fixture project', scripts: { test: 'node --test' } }),
  );
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\ndist/\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  const registry = new FileProjectRegistry([]),
    policies: Record<string, ExecutionPolicy> = {},
    manager = new ProjectManager({
      registry,
      policies,
      catalogFile: path.join(data, 'linked-projects.json'),
    });
  await manager.restore();
  const workspaces = new GitWorkspaces(registry),
    checks = new ProjectChecks(registry, {
      async run() {
        throw Error('Unexpected fallback');
      },
    });
  t.after(async () => {
    await manager.dispose();
    await registry.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const info = await manager.inspect(root);
  info.profile.dependencies = 'none';
  info.profile.checks = [
    {
      id: 'test',
      title: 'Tests',
      command: 'node -e "console.log(\'check passed\')"',
      timeoutMs: 30000,
    },
  ];
  info.profile.defaultCheckIds = ['test'];
  const connect = () =>
    manager.connect('connect', 'connect', { root, name: info.name, profile: info.profile });
  return {
    directory,
    root,
    data,
    git,
    registry,
    policies,
    manager,
    workspaces,
    checks,
    info,
    connect,
  };
}
function run(commit: string): Run {
  return {
    id: 'R-fixture',
    key: 'G-fixture',
    goalId: 'G-fixture',
    title: 'Fixture',
    summary: 'Done',
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    threadId: 'fake',
    status: 'completed',
    phase: 'done',
    commit,
    agents: [],
    events: [],
    commands: [],
    plan: [],
    changedFiles: [],
    baseline: { passed: 0, total: 1, results: [] },
    acceptance: { passed: 1, total: 1, results: [{ name: 'ok', passed: true }] },
    specsUnchanged: true,
    scopePreserved: true,
    independentReviewer: true,
    goalText: 'Fixture',
    result: 'Done',
    sourceHash: '',
  };
}
async function seed(f: Awaited<ReturnType<typeof fixture>>, id: string, record: Run) {
  const store = f.registry.get(id);
  await store.transact('seed', 'seed', (doc) => {
    doc.goals.push({
      id: 'G-fixture',
      projectId: id,
      title: 'Fixture',
      body: 'Fixture',
      criteria: '',
      createdAt: record.createdAt,
      status: record.status === 'running' ? 'running' : 'completed',
      runId: record.id,
    });
    doc.runs.push(record);
    return { result: null, change: { type: 'run.changed', run: record, goal: doc.goals[0] } };
  });
}

test('inspect is read-only, detects dirty files, and rejects a nested or non-Git folder', async (t) => {
  const f = await fixture(t);
  await assert.rejects(fs.access(path.join(f.root, '.buro')));
  assert.equal(f.info.branch, 'master');
  assert.equal(f.info.dirty, false);
  assert.equal(f.info.profile.checks[0].id, 'test');
  assert.deepEqual(f.info.profile.scope, {
    mode: 'advisory',
    plannedPaths: [],
    protectedPaths: ['AGENTS.md'],
  });
  await fs.writeFile(path.join(f.root, 'src/value.mjs'), 'dirty');
  assert.equal((await f.manager.inspect(f.root)).dirty, true);
  await assert.rejects(f.manager.inspect(path.join(f.root, 'src')), {
    code: 'NOT_REPOSITORY_ROOT',
  });
  await assert.rejects(f.manager.inspect(f.data), { code: 'INVALID_REPOSITORY' });
  await assert.rejects(fs.access(path.join(f.root, '.buro')));
});
test('connect persists a per-repo profile and isolated roles; aliases and retries do not duplicate projects', async (t) => {
  const f = await fixture(t),
    project = await f.connect();
  assert.equal(project.root, f.root);
  assert.equal(project.managed, true);
  assert.equal(f.registry.list().length, 1);
  assert.equal(f.registry.get(project.id).snapshot().roles.length, 5);
  assert.ok(
    f.registry
      .get(project.id)
      .snapshot()
      .roles.some((r) => r.id === 'production_delivery'),
  );
  await fs.access(path.join(f.root, '.buro/local'));
  assert.match(await fs.readFile(path.join(f.root, '.buro/.gitignore'), 'utf8'), /local\//);
  const alias = path.join(f.directory, 'alias');
  await fs.symlink(f.root, alias, 'dir');
  assert.equal(
    (
      await f.manager.connect('alias', 'alias', {
        root: alias,
        name: 'Other',
        profile: f.info.profile,
      })
    ).id,
    project.id,
  );
  assert.equal(f.registry.list().length, 1);
  assert.deepEqual(await f.connect(), project);
  await assert.rejects(
    f.manager.connect('connect', 'different', {
      root: f.root,
      name: 'Other',
      profile: f.info.profile,
    }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  const file = JSON.parse(await fs.readFile(path.join(f.root, '.buro/project.json'), 'utf8'));
  assert.equal(file.id, project.id);
  assert.equal(file.profile.revision, 1);
  assert.equal(file.profile.checks[0].command, f.info.profile.checks[0].command);
  const goals = new GoalService({
    projects: f.registry,
    now: () => new Date().toISOString(),
    id: () => crypto.randomUUID(),
  });
  await goals.create('g', 'g', {
    projectId: project.id,
    title: 'Owned goal',
    body: 'Context',
    criteria: '',
  });
  await f.manager.dispose();
  await f.registry.close();
  const registry = new FileProjectRegistry([]),
    manager = new ProjectManager({
      registry,
      policies: {},
      catalogFile: path.join(f.data, 'linked-projects.json'),
    });
  t.after(async () => {
    await manager.dispose();
    await registry.close();
  });
  await manager.restore();
  assert.equal(registry.get(project.id).snapshot().goals[0].title, 'Owned goal');
  assert.equal(registry.list().length, 1);
});
test('profiles have optimistic revisions; retrying an older successful save never rolls back the latest profile', async (t) => {
  const f = await fixture(t),
    project = await f.connect(),
    store = f.registry.get(project.id);
  const initial = store.snapshot().profile!;
  const first = await f.manager.configure('config-1', 'one', {
    projectId: project.id,
    expectedRevision: 1,
    profile: { ...initial, context: 'First' },
  });
  assert.equal(first.revision, 2);
  await assert.rejects(
    f.manager.configure('stale', 'stale', {
      projectId: project.id,
      expectedRevision: 1,
      profile: initial,
    }),
    { code: 'CONFLICT' },
  );
  await f.manager.configure('config-2', 'two', {
    projectId: project.id,
    expectedRevision: 2,
    profile: { ...first, context: 'Second' },
  });
  assert.deepEqual(
    await f.manager.configure('config-1', 'one', {
      projectId: project.id,
      expectedRevision: 1,
      profile: { ...initial, context: 'First' },
    }),
    first,
  );
  assert.equal(store.snapshot().profile!.context, 'Second');
  assert.equal(f.policies[project.id].context, 'Second');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, '.buro/project.json'), 'utf8')).profile.context,
    'Second',
  );
});
test('restart recovers a committed profile when its readable project.json export is stale', async (t) => {
  const f = await fixture(t),
    project = await f.connect(),
    initial = f.registry.get(project.id).snapshot().profile!;
  const oldFile = await fs.readFile(path.join(f.root, '.buro/project.json'), 'utf8');
  await f.manager.configure('new', 'new', {
    projectId: project.id,
    expectedRevision: 1,
    profile: { ...initial, context: 'Committed context' },
  });
  await fs.writeFile(path.join(f.root, '.buro/project.json'), oldFile);
  await f.manager.dispose();
  await f.registry.close();
  const registry = new FileProjectRegistry([]),
    policies: Record<string, ExecutionPolicy> = {},
    manager = new ProjectManager({
      registry,
      policies,
      catalogFile: path.join(f.data, 'linked-projects.json'),
    });
  t.after(async () => {
    await manager.dispose();
    await registry.close();
  });
  await manager.restore();
  assert.equal(policies[project.id].context, 'Committed context');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, '.buro/project.json'), 'utf8')).profile.context,
    'Committed context',
  );
});
test('profile edits are refused while a project goal is running', async (t) => {
  const f = await fixture(t),
    project = await f.connect(),
    record = run(f.info.head);
  record.status = 'running';
  await seed(f, project.id, record);
  const before = await fs.readFile(path.join(f.root, '.buro/project.json'), 'utf8');
  await assert.rejects(
    f.manager.configure('edit', 'edit', {
      projectId: project.id,
      profile: f.registry.get(project.id).snapshot().profile!,
      expectedRevision: 1,
    }),
    { code: 'PROJECT_BUSY' },
  );
  assert.equal(await fs.readFile(path.join(f.root, '.buro/project.json'), 'utf8'), before);
});
test('workspace preparation links dependencies and runs setup; ignored build artifacts do not enter the accepted diff', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'node_modules/fixture-package'), { recursive: true });
  await fs.writeFile(
    path.join(f.root, 'node_modules/fixture-package/index.js'),
    'module.exports=7;',
  );
  f.info.profile.dependencies = 'link-node-modules';
  f.info.profile.setup = [
    {
      id: 'setup',
      title: 'Prepare',
      command: 'mkdir -p dist && echo prepared > dist/ready',
      timeoutMs: 30000,
    },
  ];
  f.info.profile.checks[0].command =
    "node -e \"require('assert').equal(require('fixture-package'),7); console.log('dependency ok')\"";
  const project = await f.connect(),
    profile = f.registry.get(project.id).snapshot().profile!,
    workspace = await f.workspaces.prepare(project.id, 'test-workspace', undefined, { profile });
  assert.equal(
    await fs.realpath(path.join(workspace.path, 'node_modules')),
    path.join(f.root, 'node_modules'),
  );
  assert.match(await fs.readFile(path.join(workspace.path, 'dist/ready'), 'utf8'), /prepared/);
  const result = await f.checks.run(
    project.id,
    workspace.path,
    ['test'],
    new AbortController().signal,
    profile,
  );
  assert.equal(result.passed, 1);
  assert.match(result.results[0].output!, /dependency ok/);
  assert.deepEqual(await f.workspaces.changes(workspace.path, workspace.base), []);
  await fs.writeFile(path.join(workspace.path, 'src/value.mjs'), 'export const value=2;\n');
  await fs.writeFile(path.join(workspace.path, 'src/added.mjs'), 'export const added=true;\n');
  await exec('git', ['add', 'src/added.mjs'], { cwd: workspace.path });
  assert.deepEqual(
    (await f.workspaces.changes(workspace.path, workspace.base)).map((c) => c.path).sort(),
    ['src/added.mjs', 'src/value.mjs'],
  );
  const commit = await f.workspaces.checkpoint(workspace.path, 'test-workspace');
  assert.notEqual(commit, f.info.head);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.info.head);
  assert.equal(
    (await exec('git', ['ls-tree', '--name-only', commit], { cwd: f.root })).stdout.includes(
      'node_modules',
    ),
    false,
  );
});
test('configured project verification uses a separate worktree without changing the user branch or uncommitted edits', async (t) => {
  const f = await fixture(t),
    project = await f.connect();
  await fs.writeFile(path.join(f.root, 'src/value.mjs'), 'user edit');
  const result = await f.manager.verify(project.id, ['test'], f.workspaces, f.checks);
  assert.equal(result.passed, 1);
  assert.match(result.results[0].output!, /check passed/);
  assert.equal(await fs.readFile(path.join(f.root, 'src/value.mjs'), 'utf8'), 'user edit');
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), f.info.head);
});
test('accepted results fast-forward only the reviewed branch/head, and applying twice is idempotent', async (t) => {
  const f = await fixture(t),
    project = await f.connect(),
    workspace = await f.workspaces.prepare(project.id, 'accepted');
  await fs.writeFile(path.join(workspace.path, 'src/value.mjs'), 'export const value=2;\n');
  const commit = await f.workspaces.checkpoint(workspace.path, 'accepted');
  await seed(f, project.id, run(commit));
  await assert.rejects(
    f.manager.apply('wrong', 'wrong', {
      projectId: project.id,
      runId: 'R-fixture',
      expectedHead: '0'.repeat(40),
      expectedBranch: 'master',
    }),
    { code: 'BRANCH_CHANGED' },
  );
  const input = {
    projectId: project.id,
    runId: 'R-fixture',
    expectedHead: f.info.head,
    expectedBranch: 'master',
  };
  const result = await f.manager.apply('apply', 'apply', input);
  assert.equal(result.commit, commit);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), commit);
  assert.match(await fs.readFile(path.join(f.root, 'src/value.mjs'), 'utf8'), /value=2/);
  assert.equal(f.registry.get(project.id).snapshot().runs[0].appliedBranch, 'master');
  assert.deepEqual(await f.manager.apply('apply', 'apply', input), result);
  await assert.rejects(f.manager.apply('apply', 'different', input), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});
test('verification retries share one command execution and return the persisted result after restart', async (t) => {
  const f = await fixture(t),
    project = await f.connect();
  let preparations = 0;
  const workspaces = {
    prepare: async (...args: Parameters<GitWorkspaces['prepare']>) => {
      preparations++;
      return f.workspaces.prepare(...args);
    },
    changes: f.workspaces.changes.bind(f.workspaces),
    checkpoint: f.workspaces.checkpoint.bind(f.workspaces),
    captureRevision: f.workspaces.captureRevision.bind(f.workspaces),
  };
  const meta = { id: 'verify-once', fingerprint: 'same' };
  const [first, second] = await Promise.all([
    f.manager.verify(project.id, ['test'], workspaces, f.checks, meta),
    f.manager.verify(project.id, ['test'], workspaces, f.checks, meta),
  ]);
  assert.deepEqual(first, second);
  assert.equal(preparations, 1);
  assert.equal(f.registry.get(project.id).snapshot().verification?.passed, 1);
  await assert.rejects(
    f.manager.verify(project.id, ['test'], workspaces, f.checks, {
      id: meta.id,
      fingerprint: 'different',
    }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  await f.manager.dispose();
  await f.registry.close();
  const registry = new FileProjectRegistry([]),
    manager = new ProjectManager({
      registry,
      policies: {},
      catalogFile: path.join(f.data, 'linked-projects.json'),
    });
  t.after(async () => {
    await manager.dispose();
    await registry.close();
  });
  await manager.restore();
  assert.deepEqual(await manager.verify(project.id, ['test'], workspaces, f.checks, meta), first);
  assert.equal(preparations, 1);
});
test('applying refuses dirty or diverged branches without overwriting user files', async (t) => {
  const f = await fixture(t),
    project = await f.connect(),
    workspace = await f.workspaces.prepare(project.id, 'accepted');
  await fs.writeFile(path.join(workspace.path, 'src/value.mjs'), 'result');
  const commit = await f.workspaces.checkpoint(workspace.path, 'accepted');
  await seed(f, project.id, run(commit));
  await fs.writeFile(path.join(f.root, 'src/value.mjs'), 'user edit');
  await assert.rejects(
    f.manager.apply('dirty', 'dirty', {
      projectId: project.id,
      runId: 'R-fixture',
      expectedHead: f.info.head,
      expectedBranch: 'master',
    }),
    { code: 'DIRTY_WORKTREE' },
  );
  assert.equal(await fs.readFile(path.join(f.root, 'src/value.mjs'), 'utf8'), 'user edit');
  await f.git(['add', 'src/value.mjs']);
  await f.git(['commit', '-m', 'User work']);
  const head = (await f.git(['rev-parse', 'HEAD'])).stdout.trim();
  await assert.rejects(
    f.manager.apply('diverged', 'diverged', {
      projectId: project.id,
      runId: 'R-fixture',
      expectedHead: head,
      expectedBranch: 'master',
    }),
    { code: 'BRANCH_DIVERGED' },
  );
  assert.equal((await f.git(['rev-parse', 'HEAD'])).stdout.trim(), head);
});
test('symlinked metadata is rejected before project initialization', async (t) => {
  const f = await fixture(t);
  await fs.symlink(f.data, path.join(f.root, '.buro'), 'dir');
  await assert.rejects(f.manager.inspect(f.root), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(f.data), []);
});
test('configured commands report failure output and can be interrupted', async (t) => {
  const f = await fixture(t),
    signal = new AbortController();
  const failed = await runProjectCommand(
    { id: 'bad', title: 'Bad', command: 'echo useful-error >&2; exit 7', timeoutMs: 30000 },
    f.root,
    f.root,
    signal.signal,
  );
  assert.equal(failed.exitCode, 7);
  assert.match(failed.output, /useful-error/);
  const pending = runProjectCommand(
    { id: 'wait', title: 'Wait', command: 'node -e "setInterval(()=>{},1000)"', timeoutMs: 30000 },
    f.root,
    f.root,
    signal.signal,
  );
  signal.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('research proposals cannot overwrite a profile after repository or profile changes', async (t) => {
  const f = await fixture(t),
    project = await f.connect(),
    store = f.registry.get(project.id);
  const research = {
    id: 'research-fixture',
    status: 'ready' as const,
    startedAt: new Date().toISOString(),
    sourceHead: 'b'.repeat(40),
    profileRevision: 1,
    summary: 'Proposal',
    events: [],
  };
  await store.transact('research', 'research', (doc) => {
    doc.research = research;
    return { result: null, change: { type: 'project.research.changed', research } };
  });
  await assert.rejects(
    f.manager.configure('stale-research', 'stale-research', {
      projectId: project.id,
      profile: store.snapshot().profile!,
      expectedRevision: 1,
      researchId: research.id,
    }),
    { code: 'RESEARCH_STALE' },
  );
  await store.transact('current-research', 'current-research', (doc) => {
    doc.research!.sourceHead = f.info.head;
    return { result: null, change: { type: 'project.research.changed', research: doc.research! } };
  });
  await f.manager.configure('apply-research', 'apply-research', {
    projectId: project.id,
    profile: store.snapshot().profile!,
    expectedRevision: 1,
    researchId: research.id,
  });
  assert.equal(store.snapshot().research?.appliedProfileRevision, 2);
});

test('manual save acknowledges ready research and later proposal acceptance uses the current form revision', async (t) => {
  const f = await fixture(t),
    project = await f.connect(),
    store = f.registry.get(project.id);
  const research = {
    id: 'research-manual',
    status: 'ready' as const,
    startedAt: new Date().toISOString(),
    sourceHead: f.info.head,
    profileRevision: 1,
    summary: 'Proposal',
    events: [],
  };
  await store.transact('manual-research', 'manual-research', (doc) => {
    doc.research = research;
    return { result: null, change: { type: 'project.research.changed', research } };
  });
  const initial = store.snapshot().profile!;
  await f.manager.configure('manual-settings', 'manual-settings', {
    projectId: project.id,
    profile: { ...initial, context: 'User changes' },
    expectedRevision: 1,
  });
  assert.equal(store.snapshot().research?.reviewedProfileRevision, 2);
  assert.equal(store.snapshot().research?.appliedProfileRevision, undefined);
  await assert.rejects(
    f.manager.configure('old-form', 'old-form', {
      projectId: project.id,
      profile: initial,
      expectedRevision: 1,
      researchId: research.id,
    }),
    { code: 'CONFLICT' },
  );
  const current = store.snapshot().profile!;
  await f.manager.configure('apply-later', 'apply-later', {
    projectId: project.id,
    profile: current,
    expectedRevision: 2,
    researchId: research.id,
  });
  assert.equal(store.snapshot().profile?.context, 'User changes');
  assert.equal(store.snapshot().research?.appliedProfileRevision, 3);
  assert.equal(store.snapshot().research?.reviewedProfileRevision, 3);
});

test('quick research application adds missing launch settings and preserves manual commands and policies', async (t) => {
  const f = await fixture(t),
    project = await f.connect(),
    store = f.registry.get(project.id);
  const initial = store.snapshot().profile!;
  const component = {
    id: 'web',
    name: 'Web',
    kind: 'web' as const,
    path: './',
    command: 'node server.mjs',
    port: 3000,
    readyPath: '/health',
    instructions: 'Open preview',
    evidence: 'server.mjs',
  };
  const research = {
    id: 'research-quick',
    status: 'ready' as const,
    startedAt: new Date().toISOString(),
    sourceHead: f.info.head,
    profileRevision: 1,
    summary: 'Proposal',
    events: [],
    context: 'Agent generated context',
    components: [component],
    checks: [{ ...initial.checks[0], command: 'different generated command' }],
  };
  await store.transact('research-quick', 'research-quick', (doc) => {
    doc.research = research;
    return { result: null, change: { type: 'project.research.changed', research } };
  });
  await f.manager.applyResearch('accept-quick', 'accept-quick', {
    projectId: project.id,
    researchId: research.id,
    expectedRevision: 1,
  });
  const applied = store.snapshot().profile!;
  assert.deepEqual(applied.components, [component]);
  assert.equal(applied.context, initial.context);
  assert.deepEqual(applied.checks, initial.checks);
  assert.deepEqual(applied.scope, initial.scope);
  assert.deepEqual(applied.defaultCheckIds, initial.defaultCheckIds);
  assert.equal(store.snapshot().research?.appliedProfileRevision, 2);
  assert.deepEqual(
    await f.manager.applyResearch('accept-quick', 'accept-quick', {
      projectId: project.id,
      researchId: research.id,
      expectedRevision: 1,
    }),
    applied,
  );
  assert.equal(store.snapshot().profile?.revision, 2);
  const changed = {
    ...applied,
    components: [{ ...component, id: 'custom_web', command: 'manual local command' }],
  };
  await f.manager.configure('custom-launch', 'custom-launch', {
    projectId: project.id,
    profile: changed,
    expectedRevision: 2,
  });
  await f.manager.applyResearch('accept-again', 'accept-again', {
    projectId: project.id,
    researchId: research.id,
    expectedRevision: 3,
  });
  assert.equal(store.snapshot().profile?.components?.length, 1);
  assert.equal(store.snapshot().profile?.components?.[0].command, 'manual local command');
});

test('explicit check concurrency starts independent commands together and preserves configured result order', async (t) => {
  const f = await fixture(t),
    project = await f.connect();
  await fs.writeFile(
    path.join(f.root, 'concurrent.cjs'),
    `
const fs = require('node:fs');
const [own, other] = process.argv.slice(2);
fs.writeFileSync(own, 'started');
const deadline = Date.now() + 3000;
const poll = () => {
  if (fs.existsSync(other)) { console.log(own); process.exit(0); }
  if (Date.now() > deadline) process.exit(1);
  setTimeout(poll, 5);
};
poll();
`,
  );
  const profile = {
    ...f.info.profile,
    checkConcurrency: 2,
    checks: [
      { id: 'first', title: 'First', command: 'node concurrent.cjs first second', timeoutMs: 5000 },
      {
        id: 'second',
        title: 'Second',
        command: 'node concurrent.cjs second first',
        timeoutMs: 5000,
      },
    ],
  };
  const result = await f.checks.run(
    project.id,
    f.root,
    ['first', 'second'],
    new AbortController().signal,
    profile,
  );
  assert.equal(result.passed, 2);
  assert.deepEqual(
    result.results.map((check) => check.name),
    ['First', 'Second'],
  );
});
