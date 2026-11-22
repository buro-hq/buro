import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import { createBuiltinProjectAnalyses } from '../adapters/analysis/project-setup.ts';
import { readAuthorizedMaterialText } from '../adapters/files/context-material-text.ts';
import test from 'node:test';
import {
  fixtureExecutionSelection,
  fixtureExecutionCapabilities,
} from './fixtures/execution-resources.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { ProjectResearchService } from '../core/project-research.ts';
import { ResultService, type ResultOperations } from '../core/results.ts';
import { operationalRoles } from './fixtures/roles.ts';
import { NativeProjectOperations } from '../adapters/processes/project-operations.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import type { ProjectProfile, Run } from '../protocol/domain.ts';
import type { AgentRuntime } from '../core/ports.ts';
const exec = promisify(execFile);
const commit = 'a'.repeat(40);
const component = {
  id: 'api',
  name: 'API',
  kind: 'api' as const,
  path: './',
  command: 'node server.mjs',
  port: 3000,
  readyPath: '/health',
  instructions: 'GET /health',
  evidence: 'server.mjs',
};
const profile: ProjectProfile = {
  version: 1,
  revision: 1,
  context: 'Manual context',
  scope: { mode: 'advisory', plannedPaths: ['./'], protectedPaths: ['AGENTS.md'] },
  checks: [],
  defaultCheckIds: [],
  setup: [],
  dependencies: 'none',
  maxWorkers: 2,
  maxRepairs: 1,
  turnTimeoutMs: 360000,
  baseBranch: 'main',
  components: [component],
  delivery: {
    remote: 'origin',
    pullRequests: true,
    environments: [
      {
        id: 'production',
        name: 'Production',
        enabled: true,
        command: 'configured-deploy',
        url: 'https://example.invalid/health',
        roleId: 'production_delivery',
        requireConfirmation: true,
      },
    ],
  },
};
function record(): Run {
  return {
    id: 'R-fixture',
    key: 'G-fixture',
    goalId: 'G-fixture',
    title: 'Fixture',
    summary: 'Done',
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    threadId: 'implementation',
    status: 'completed',
    phase: 'done',
    commit,
    workspace: '/worktree',
    resources: fixtureExecutionSelection('fixture', fixtureExecutionCapabilities()).forProject('p'),
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
    goalText: 'Fixture',
    result: 'Done',
    sourceHash: '',
    outcome: { kind: 'pull-request' },
  };
}
async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'project-operations-')),
  );
  const store = await FileProjectStore.open({
    directory,
    project: { id: 'p', name: 'Fixture', root: directory, managed: true },
    profile: structuredClone(profile),
    roles: operationalRoles,
  });
  const projects = new ProjectStoreRegistry([store]);
  const run = record();
  await store.transact('seed', 'seed', (doc) => {
    doc.runs.push(run);
    const goal = {
      id: 'G-fixture',
      projectId: 'p',
      title: 'Fixture',
      body: 'Fixture',
      criteria: '',
      status: 'completed' as const,
      createdAt: run.createdAt,
    };
    doc.goals.push(goal);
    return { result: null, change: { type: 'run.changed', run, goal } };
  });
  const starts: any[] = [];
  let prCalls = 0,
    deployCalls = 0;
  const runtime: AgentRuntime = {
    id: 'fixture',
    async start(input) {
      starts.push(input);
      return { threadId: 'thread-' + starts.length };
    },
    async submit() {
      return { turnId: 'turn' };
    },
    async interrupt() {},
    async dispose() {},
    async release() {},
    async turn() {
      return {
        turnId: 'turn',
        text: JSON.stringify({ ready: true, summary: 'Verified result with checks', blockers: [] }),
      };
    },
  };
  const operations: ResultOperations = {
    async preview() {
      return { status: 'running', components: [], updatedAt: new Date().toISOString() };
    },
    async stopPreview() {},
    async pullRequest() {
      prCalls++;
      return { url: 'https://github.com/example/repo/pull/1', branch: 'goal/r-fixture' };
    },
    async deploy() {
      deployCalls++;
      return { url: 'https://example.invalid', output: 'deployed' };
    },
    async dispose() {},
  };
  const service = new ResultService({
    workflowRoles: createBuiltinWorkflowRoles(),
    projects,
    runtime,
    operations,
  });
  t.after(async () => {
    await service.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const drain = async () => {
    await Promise.all([...service.jobs.values()].map((j) => j.promise));
  };
  return {
    directory,
    store,
    projects,
    runtime,
    operations,
    service,
    starts,
    drain,
    prCalls: () => prCalls,
    deployCalls: () => deployCalls,
  };
}
test('PR preparation is read-only and duplicate/concurrent delivery requests create one PR', async (t) => {
  const f = await fixture(t);
  const meta = { id: 'deliver-1', fingerprint: 'same' };
  await Promise.all([
    f.service.deliver('p', 'R-fixture', commit, false, meta),
    f.service.deliver('p', 'R-fixture', commit, false, meta),
  ]);
  await f.drain();
  assert.equal(f.prCalls(), 1);
  assert.equal(f.starts[0].readOnly, true);
  assert.equal(f.store.snapshot().runs[0].delivery?.status, 'completed');
  assert.equal(f.store.snapshot().runs[0].status, 'completed');
  await f.service.deliver('p', 'R-fixture', commit, false, meta);
  assert.equal(f.prCalls(), 1);
  await assert.rejects(
    f.service.deliver('p', 'R-fixture', commit, false, { id: meta.id, fingerprint: 'changed' }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});
test('production role prepares a concrete commit, waits without an active agent, then deploys once', async (t) => {
  const f = await fixture(t);
  await f.service.update('p', 'R-fixture', (r) => {
    r.outcome = { kind: 'deploy', environmentId: 'production' };
  });
  await assert.rejects(f.service.deliver('p', 'R-fixture', commit, true), {
    code: 'PREPARE_FIRST',
  });
  await f.service.deliver('p', 'R-fixture', commit);
  await f.drain();
  assert.equal(f.deployCalls(), 0);
  assert.equal(f.store.snapshot().runs[0].delivery?.status, 'awaiting-confirmation');
  assert.equal(f.store.snapshot().runs[0].delivery?.roleId, 'production_delivery');
  await assert.rejects(f.service.deliver('p', 'R-fixture', 'b'.repeat(40), true), {
    code: 'COMMIT_CHANGED',
  });
  await f.service.deliver('p', 'R-fixture', commit, true, {
    id: 'confirm',
    fingerprint: 'confirm',
  });
  await f.drain();
  assert.equal(f.deployCalls(), 1);
  assert.equal(f.store.snapshot().runs[0].status, 'completed');
  await f.service.deliver('p', 'R-fixture', commit, true, {
    id: 'confirm',
    fingerprint: 'confirm',
  });
  assert.equal(f.deployCalls(), 1);
});
test('disabled delivery waits for configuration, then retries without rebuilding implementation', async (t) => {
  const f = await fixture(t);
  await f.store.transact('off', 'off', (doc) => {
    doc.profile!.delivery!.pullRequests = false;
    return {
      result: null,
      change: {
        type: 'project.configured',
        profile: doc.profile!,
        executionPolicy: {
          scope: { mode: 'advisory', plannedPaths: ['./'], protectedPaths: [] },
          checks: [],
          defaultCheckIds: [],
          maxWorkers: 2,
          maxRepairs: 1,
        },
      },
    };
  });
  await f.service.deliver('p', 'R-fixture', commit);
  assert.equal(f.store.snapshot().runs[0].delivery?.status, 'needs-attention');
  assert.equal(f.starts.length, 0);
  await f.store.transact('on', 'on', (doc) => {
    doc.profile!.delivery!.pullRequests = true;
    return {
      result: null,
      change: {
        type: 'project.configured',
        profile: doc.profile!,
        executionPolicy: {
          scope: { mode: 'advisory', plannedPaths: ['./'], protectedPaths: [] },
          checks: [],
          defaultCheckIds: [],
          maxWorkers: 2,
          maxRepairs: 1,
        },
      },
    };
  });
  await f.service.deliver('p', 'R-fixture', commit);
  await f.drain();
  assert.equal(f.prCalls(), 1);
});
test('delivery failure and restart preserve accepted implementation and never automatically repeat a deploy', async (t) => {
  const f = await fixture(t);
  f.operations.pullRequest = async () => {
    throw Error('provider unavailable');
  };
  await f.service.deliver('p', 'R-fixture', commit);
  await f.drain();
  assert.equal(f.store.snapshot().runs[0].status, 'completed');
  assert.equal(f.store.snapshot().runs[0].delivery?.status, 'failed');
  await f.service.update('p', 'R-fixture', (r) => {
    r.delivery!.status = 'running';
  });
  await f.service.recover();
  assert.equal(f.store.snapshot().runs[0].delivery?.status, 'interrupted');
  assert.equal(f.prCalls(), 0);
});
test('project research proposes components and checks without changing the existing profile', async (t) => {
  const f = await fixture(t);
  f.runtime.turn = async () => ({
    turnId: 'turn',
    text: JSON.stringify({
      summary: 'Web and API found',
      context: 'Proposed context',
      components: [component],
      checks: [],
      questions: ['Provide local database connection'],
    }),
  });
  const research = new ProjectResearchService({
    workflowRoles: createBuiltinWorkflowRoles(),
    selection: fixtureExecutionSelection('fixture', fixtureExecutionCapabilities()),
    analysis: createBuiltinProjectAnalyses().get('project-setup'),
    materials: (projectId, selected, signal) =>
      readAuthorizedMaterialText(f.projects, projectId, selected, signal),
    projects: f.projects,
    runtime: f.runtime,
    head: async () => commit,
  });
  t.after(() => research.dispose());
  await research.start('research', 'research', 'p');
  await research.jobs.get('p')?.promise;
  const snapshot = f.store.snapshot();
  assert.equal(snapshot.research?.status, 'ready', snapshot.research?.error);
  assert.equal(snapshot.research?.components?.[0].kind, 'api');
  assert.equal(snapshot.profile?.context, 'Manual context');
  assert.equal(f.starts[0].readOnly, true);
  await research.start('research', 'research', 'p');
  assert.equal(f.starts.length, 1);
});
test('native local preview uses a private HTTP port, verifies readiness, and stops its process group', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-preview-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const git = (args: string[]) => exec('git', args, { cwd: directory });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await git(['config', 'user.name', 'Test']);
  await fs.writeFile(
    path.join(directory, 'server.mjs'),
    "import http from 'node:http';console.log('token='+process.env.API_TOKEN);http.createServer((req,res)=>{res.writeHead(req.url==='/health'?200:404);res.end(JSON.stringify({source:process.env.SOURCE_ONLY==='source-value',override:process.env.API_TOKEN==='preview-env-value',managedPort:process.env.PORT!=='1',managedHost:process.env.HOST==='127.0.0.1'}));}).listen(Number(process.env.PORT),'127.0.0.1');\n",
  );
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  await fs.writeFile(
    path.join(directory, '.env'),
    'SOURCE_ONLY=source-value\nAPI_TOKEN=source-env-value\nPORT=1\nHOST=incorrect-host\n',
  );
  await fs.mkdir(path.join(directory, '.buro/local'), { recursive: true });
  await fs.writeFile(
    path.join(directory, '.buro/local/api.env'),
    'export API_TOKEN="preview-env-value" # override\n',
  );
  const store = await FileProjectStore.open({
    directory: path.join(directory, '.buro'),
    project: { id: 'p', name: 'Preview', root: directory },
  });
  const registry = new ProjectStoreRegistry([store]);
  t.after(() => store.close());
  const workspaces = new GitWorkspaces(registry),
    workspace = await workspaces.prepare('p', 'R-preview');
  const run = { ...record(), id: 'R-preview', workspace: workspace.path, commit: workspace.base };
  const operations = new NativeProjectOperations();
  t.after(() => operations.dispose());
  await fs.mkdir(path.join(workspace.path, '.buro/environment-cache'), { recursive: true });
  await fs.writeFile(path.join(workspace.path, '.buro/environment-cache/dependencies.json'), '{}');
  await fs.mkdir(path.join(workspace.path, 'node_modules/fixture'), { recursive: true });
  await fs.writeFile(path.join(workspace.path, 'node_modules/fixture/cache.txt'), 'service cache');
  const preview = await operations.preview({
    root: directory,
    run,
    components: [component],
    signal: new AbortController().signal,
    onChange() {},
  });
  assert.equal(preview.status, 'running');
  assert.ok(preview.components[0].url);
  assert.equal((await fetch(new URL('/health', preview.components[0].url))).status, 200);
  assert.deepEqual(await (await fetch(new URL('/health', preview.components[0].url))).json(), {
    source: true,
    override: true,
    managedPort: true,
    managedHost: true,
  });
  assert.deepEqual(preview.components[0].envFiles, ['.env', '.buro/local/api.env']);
  assert.equal(preview.components[0].output.includes('preview-env-value'), false);
  assert.equal(preview.components[0].output.includes('source-env-value'), false);
  await assert.rejects(fs.access(path.join(workspace.path, '.env')));
  await operations.stopPreview(run.id);
  await assert.rejects(fetch(new URL('/health', preview.components[0].url)));
  assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), workspace.base);
  await fs.writeFile(path.join(workspace.path, 'unexpected.mjs'), 'unaccepted source');
  await assert.rejects(operations.verifyWorkspace(directory, run), /changed after acceptance/);
  await fs.rm(path.join(workspace.path, 'unexpected.mjs'));
  const original = await fs.readFile(path.join(workspace.path, 'server.mjs'));
  await fs.writeFile(path.join(workspace.path, 'server.mjs'), 'changed tracked source');
  await assert.rejects(operations.verifyWorkspace(directory, run), /changed after acceptance/);
  await fs.writeFile(path.join(workspace.path, 'server.mjs'), original);
});

test('native PR delivery pushes an isolated branch and reuses its PR without changing source HEAD', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-pr-'))),
    root = path.join(directory, 'repo'),
    bare = path.join(directory, 'remote.git'),
    bin = path.join(directory, 'bin');
  await fs.mkdir(root);
  await fs.mkdir(bin);
  const git = (args) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await git(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(root, 'value.txt'), 'initial');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  const initial = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await exec('git', ['init', '--bare', bare]);
  await git(['remote', 'add', 'origin', 'https://github.com/fixture/result.git']);
  await git(['config', `url.${bare}.pushInsteadOf`, 'https://github.com/fixture/result.git']);
  const stateFile = path.join(directory, 'pr.json');
  await fs.writeFile(
    path.join(bin, 'gh'),
    `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);const p=process.env.FIXTURE_PR_PATH;if(a[0]==='auth')process.exit(0);if(a[1]==='list'){console.log(fs.existsSync(p)?'['+fs.readFileSync(p,'utf8')+']':'[]');}else if(a[1]==='create'){const state={url:'https://github.com/fixture/result/pull/1',state:'OPEN',baseRefName:a[a.indexOf('--base')+1],body:fs.readFileSync(a[a.indexOf('--body-file')+1],'utf8')};fs.writeFileSync(p,JSON.stringify(state));console.log(state.url);}else process.exit(1);\n`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH,
    previousFixture = process.env.FIXTURE_PR_PATH;
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.FIXTURE_PR_PATH = stateFile;
  const store = await FileProjectStore.open({
      directory: path.join(root, '.buro'),
      project: { id: 'p', name: 'PR', root },
    }),
    registry = new ProjectStoreRegistry([store]),
    operations = new NativeProjectOperations();
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousFixture === undefined) delete process.env.FIXTURE_PR_PATH;
    else process.env.FIXTURE_PR_PATH = previousFixture;
    await operations.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const workspaces = new GitWorkspaces(registry),
    workspace = await workspaces.prepare('p', 'R-native-pr', 'main');
  await fs.writeFile(path.join(workspace.path, 'value.txt'), 'changed');
  const sha = await workspaces.checkpoint(workspace.path, 'R-native-pr');
  const run = {
    ...record(),
    id: 'R-native-pr',
    workspace: workspace.path,
    commit: sha,
    baseBranch: 'main',
  };
  const input = {
    root,
    run,
    config: profile.delivery!,
    body: 'Exact PR body\n\nTests passed.',
    signal: new AbortController().signal,
  };
  const first = await operations.pullRequest(input),
    second = await operations.pullRequest(input);
  assert.equal(first.url, second.url);
  assert.equal(first.branch, 'goal/r-native-pr');
  assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), initial);
  assert.equal(
    (
      await exec('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/goal/r-native-pr'])
    ).stdout.trim(),
    sha,
  );
  assert.match(
    JSON.parse(await fs.readFile(stateFile, 'utf8')).body,
    /Exact PR body\n\nTests passed\./,
  );
});

test('redeploy preserves the previous result, requires fresh confirmation and deduplicates replay', async (t) => {
  const f = await fixture(t);
  await f.service.update('p', 'R-fixture', (r) => {
    r.outcome = { kind: 'deploy', environmentId: 'production' };
  });
  await f.service.deliver('p', 'R-fixture', commit);
  await f.drain();
  await f.service.deliver('p', 'R-fixture', commit, true);
  await f.drain();
  assert.equal(f.deployCalls(), 1);
  const meta = { id: 'redeploy-once', fingerprint: 'redeploy-once' };
  await f.service.deliver('p', 'R-fixture', commit, false, meta, true);
  await f.drain();
  const prepared = f.store.snapshot().runs[0];
  assert.equal(prepared.delivery?.status, 'awaiting-confirmation');
  assert.equal(prepared.deliveryHistory?.length, 1);
  assert.equal(prepared.deliveryHistory?.[0].status, 'completed');
  assert.equal(prepared.deliveryHistory?.[0].commit, commit);
  assert.equal(f.deployCalls(), 1);
  await f.service.deliver('p', 'R-fixture', commit, false, meta, true);
  assert.equal(f.store.snapshot().runs[0].deliveryHistory?.length, 1);
  assert.equal(f.deployCalls(), 1);
  const confirmed = { id: 'confirm-redeploy', fingerprint: 'confirm-redeploy' };
  await f.service.deliver('p', 'R-fixture', commit, true, confirmed);
  await f.drain();
  assert.equal(f.deployCalls(), 2);
  assert.equal(f.store.snapshot().runs[0].status, 'completed');
  assert.equal(f.store.snapshot().runs[0].commit, commit);
  await f.service.deliver('p', 'R-fixture', commit, true, confirmed);
  await f.service.deliver('p', 'R-fixture', commit);
  assert.equal(f.deployCalls(), 2);
});

test('redeploy respects newly required confirmation and cannot repeat a pull request as deployment', async (t) => {
  const f = await fixture(t);
  await f.service.deliver('p', 'R-fixture', commit);
  await f.drain();
  await assert.rejects(f.service.deliver('p', 'R-fixture', commit, false, undefined, true), {
    code: 'REDEPLOY_UNAVAILABLE',
  });
  await f.service.update('p', 'R-fixture', (r) => {
    r.outcome = { kind: 'deploy', environmentId: 'production' };
    r.delivery = undefined;
  });
  await f.store.transact('automatic', 'automatic', (doc) => {
    doc.profile!.delivery!.environments[0].requireConfirmation = false;
    return {
      result: null,
      change: {
        type: 'project.configured',
        profile: doc.profile!,
        executionPolicy: {
          scope: { mode: 'advisory', plannedPaths: ['./'], protectedPaths: [] },
          checks: [],
          defaultCheckIds: [],
          maxWorkers: 2,
          maxRepairs: 1,
        },
      },
    };
  });
  await f.service.deliver('p', 'R-fixture', commit);
  await f.drain();
  assert.equal(f.deployCalls(), 1);
  await f.store.transact('require-confirmation', 'require-confirmation', (doc) => {
    doc.profile!.delivery!.environments[0].requireConfirmation = true;
    return {
      result: null,
      change: {
        type: 'project.configured',
        profile: doc.profile!,
        executionPolicy: {
          scope: { mode: 'advisory', plannedPaths: ['./'], protectedPaths: [] },
          checks: [],
          defaultCheckIds: [],
          maxWorkers: 2,
          maxRepairs: 1,
        },
      },
    };
  });
  await f.service.deliver('p', 'R-fixture', commit, false, undefined, true);
  await f.drain();
  assert.equal(f.deployCalls(), 1);
  assert.equal(f.store.snapshot().runs[0].delivery?.status, 'awaiting-confirmation');
});

test('local restart stops the previous preview and replay does not start another process', async (t) => {
  const f = await fixture(t);
  let starts = 0,
    stops = 0;
  f.operations.preview = async () => {
    starts++;
    return { status: 'running', components: [], updatedAt: new Date().toISOString() };
  };
  f.operations.stopPreview = async () => {
    stops++;
  };
  await f.service.preview('p', 'R-fixture');
  await f.drain();
  assert.equal(starts, 1);
  const meta = { id: 'restart-once', fingerprint: 'restart-once' };
  await f.service.restartPreview('p', 'R-fixture', meta);
  await f.drain();
  assert.equal(starts, 2);
  assert.equal(stops, 1);
  assert.equal(f.store.snapshot().runs[0].preview?.status, 'running');
  await f.service.restartPreview('p', 'R-fixture', meta);
  await f.drain();
  assert.equal(starts, 2);
  assert.equal(stops, 1);
});
