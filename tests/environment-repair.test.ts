import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NodeEnvironment } from '../adapters/dependencies/node-environment.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import { dependencyManifestPreserved, withEnvironmentRepair } from '../core/environment-repair.ts';
import { inScope } from '../core/execution-ports.ts';
import type { AgentRuntime, RuntimeEvent } from '../core/ports.ts';
import type { ExecutionPolicy } from '../core/execution-ports.ts';
const exec = promisify(execFile);
async function fixture(t: any, enabled = true, tamper = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'environment-goal-')));
  const git = (args: string[]) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'master']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  const manifest = {
    name: 'fixture',
    packageManager: 'npm@11.6.2',
    scripts: { test: 'node --test' },
    dependencies: { fixture: '1.0.0' },
  };
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/main.mjs'), 'export const value=1;');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n.buro/\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  await fs.mkdir(path.join(root, 'node_modules/fixture'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules/fixture/version'), '1.0.0');
  const store = await FileProjectStore.open({
    directory: path.join(root, '.buro'),
    project: { id: 'p', name: 'P', root },
  });
  const projects = new FileProjectRegistry([store]),
    installations: string[] = [],
    prompts: string[] = [],
    inputs = new Map<string, any>(),
    listeners = new Set<(event: RuntimeEvent) => void>();
  const workspaces = new GitWorkspaces(
    projects,
    (workspace, root) =>
      new NodeEnvironment(workspace, root, async (command, cwd, source, signal, environment) => {
        assert.notEqual(cwd, root);
        assert.equal(source, root);
        assert.equal(signal.aborted, false);
        assert.ok(environment?.HOME?.startsWith(cwd + '/'));
        assert.match(command.command, /--ignore-scripts/);
        installations.push(cwd);
        await fs.writeFile(path.join(cwd, 'node_modules/fixture/version'), '2.0.0');
        await fs.writeFile(
          path.join(cwd, 'package-lock.json'),
          JSON.stringify({ lockfileVersion: 3 }),
        );
        return { exitCode: 0, output: 'Installed in isolated worktree', durationMs: 1 };
      }),
  );
  let id = 0,
    reviews = 0,
    checkCalls = 0;
  const runtime: AgentRuntime = {
    id: 'fixture',
    async start(input) {
      const threadId = 't-' + ++id;
      inputs.set(threadId, input);
      return { threadId };
    },
    async submit() {
      return { turnId: 't' };
    },
    async interrupt() {},
    async release() {},
    async dispose() {},
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async turn(threadId, text) {
      prompts.push(text);
      const input = inputs.get(threadId);
      if (text.startsWith('First,'))
        return {
          turnId: 'plan',
          text: JSON.stringify({
            summary: 'Implement; repair dependencies if needed',
            steps: [
              { step: 'Implement', owner: 'builder' },
              { step: 'Verify', owner: 'reviewer' },
            ],
            team: [
              {
                roleId: 'builder',
                action: 'create',
                title: 'Builder',
                description: 'Implementation',
                instructions: 'Implement assigned changes.',
                kind: 'implementation',
                paths: ['src/main.mjs'],
              },
            ],
          }),
        };
      if (input.readOnly) {
        reviews++;
        return {
          turnId: 'review',
          text: JSON.stringify({ verdict: 'approved', blockingFindings: [], summary: 'Verified' }),
        };
      }
      if (text.startsWith('Repair') || tamper) {
        const next = structuredClone(manifest);
        next.dependencies.fixture = '2.0.0';
        if (tamper) next.scripts.test = 'exit 0';
        await fs.writeFile(path.join(input.workspace, 'package.json'), JSON.stringify(next));
      }
      await fs.writeFile(path.join(input.workspace, 'src/main.mjs'), 'export const value=2;');
      for (const kind of ['started', 'completed'])
        for (const listener of listeners)
          listener({
            runId: input.runId,
            method: 'item/completed',
            params: {
              threadId,
              item: {
                type: 'subAgentActivity',
                kind,
                id: `${kind}-${prompts.length}`,
                agentThreadId: 'worker',
                agentPath: '/root/builder',
              },
            },
          });
      return {
        turnId: 'work',
        text: JSON.stringify({
          status: 'success',
          summary: 'Done',
          artifacts: ['src/main.mjs'],
          notesForNextAgent: '',
        }),
      };
    },
  };
  const policy: ExecutionPolicy = {
    allowedPaths: ['src/'],
    checks: [{ id: 'types', title: 'Types' }],
    defaultCheckIds: ['types'],
    maxWorkers: 1,
    maxRepairs: 1,
    turnTimeoutMs: 10000,
    profile: {
      version: 1,
      revision: 1,
      context: '',
      allowedPaths: ['src/'],
      protectedPaths: [],
      checks: [{ id: 'types', title: 'Types', command: 'tsc', timeoutMs: 1000 }],
      defaultCheckIds: ['types'],
      setup: [],
      dependencies: 'link-node-modules',
      maxWorkers: 1,
      maxRepairs: 1,
      turnTimeoutMs: 10000,
    },
  };
  const checks = {
    async run(_project: string, workspace: string) {
      checkCalls++;
      const passed =
        (await fs.readFile(path.join(workspace, 'node_modules/fixture/version'), 'utf8')) ===
        '2.0.0';
      return {
        passed: passed ? 1 : 0,
        total: 1,
        results: [
          {
            name: 'Types',
            passed,
            command: 'tsc',
            exitCode: passed ? 0 : 2,
            output: passed
              ? ''
              : 'node_modules/fixture/index.d.ts(1,1): error TS2307: Missing dependency.',
          },
        ],
      };
    },
  };
  const env = { projects, now: () => new Date().toISOString(), id: () => crypto.randomUUID() },
    goals = new GoalService(env),
    engine = new ExecutionService({ ...env, runtime, workspaces, checks, policies: { p: policy } });
  t.after(async () => {
    await engine.dispose();
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const goal = await goals.create('g', 'g', {
    projectId: 'p',
    title: 'Feature',
    body: 'Implement feature',
    criteria: '',
    repairEnvironment: enabled,
  });
  const started = await engine.start('s', 's', { projectId: 'p', goalId: goal.id });
  await engine.jobs.get(started.runId)?.promise;
  return {
    root,
    git,
    manifest,
    store,
    goals,
    goal,
    policy,
    workspaces,
    engine,
    installations,
    prompts,
    run: engine.get('p', started.runId),
    reviews,
    checkCalls,
  };
}
test('per-goal opt-in repairs baseline dependencies, installs in isolation, and returns to normal acceptance', async (t) => {
  const f = await fixture(t);
  assert.equal(f.run.status, 'completed', f.run.result);
  assert.equal(f.run.repairEnvironment, true);
  assert.equal(f.run.baseline.passed, 0);
  assert.equal(f.run.acceptance.passed, 1);
  assert.equal(f.reviews, 1);
  assert.equal(f.installations.length, 1);
  assert.ok(f.prompts[0].includes('Baseline checks'));
  assert.ok(f.prompts[0].includes('The user authorized'));
  assert.ok(f.run.events.some((e) => e.type === 'phase.repair'));
  assert.ok(f.run.events.some((e) => e.type === 'environment.install-completed'));
  assert.deepEqual(f.run.executionPolicySnapshot?.allowedPaths, ['src/']);
  assert.deepEqual(f.policy.allowedPaths, ['src/']);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(f.root, 'package.json'), 'utf8')),
    f.manifest,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, 'node_modules/fixture/version'), 'utf8'),
    '1.0.0',
  );
  assert.deepEqual(f.run.changedFiles.map((f) => f.path).sort(), [
    'package-lock.json',
    'package.json',
    'src/main.mjs',
  ]);
  const tracked = (await f.git(['ls-tree', '-r', '--name-only', f.run.commit!])).stdout;
  assert.ok(!tracked.includes('node_modules/'));
  assert.ok(!tracked.includes('.buro/'));
  await f.goals.update('edit', 'edit', {
    projectId: 'p',
    id: f.goal.id,
    expectedRevision: 1,
    title: 'Feature',
    body: 'New request',
    criteria: '',
    repairEnvironment: false,
  });
  assert.equal(f.store.snapshot().goals[0].repairEnvironment, false);
  assert.equal(f.store.snapshot().runs[0].repairEnvironment, true);
});
test('without the checkbox, unchanged baseline failures remain needs-attention and no dependencies are installed', async (t) => {
  const f = await fixture(t, false);
  assert.equal(f.run.status, 'needs-attention');
  assert.equal(f.run.issue?.code, 'BASELINE_CHECKS_FAILED');
  assert.equal(f.installations.length, 0);
  assert.equal(f.reviews, 0);
  assert.equal(f.prompts.length, 2);
});
test('the opt-in never permits changing test scripts and does not execute a tampered manifest', async (t) => {
  const f = await fixture(t, true, true);
  assert.equal(f.run.status, 'failed');
  assert.equal(f.run.scopePreserved, false);
  assert.equal(f.installations.length, 0);
  assert.equal(f.checkCalls, 1);
  assert.equal(f.reviews, 0);
});
test('dependency scope preserves protected paths and rejects tsconfig or script bypasses', () => {
  const policy: ExecutionPolicy = {
    allowedPaths: ['app/'],
    protectedPaths: ['package.json'],
    checks: [],
    defaultCheckIds: [],
    maxWorkers: 1,
    maxRepairs: 1,
    turnTimeoutMs: 10000,
  };
  const expanded = withEnvironmentRepair(policy, true);
  assert.equal(inScope('yarn.lock', expanded.allowedPaths, expanded.protectedPaths), true);
  assert.equal(inScope('package.json', expanded.allowedPaths, expanded.protectedPaths), false);
  assert.equal(inScope('tsconfig.json', expanded.allowedPaths), false);
  assert.equal(
    dependencyManifestPreserved([
      {
        path: 'package.json',
        before: '{"scripts":{"test":"tsc"}}',
        after: '{"scripts":{"test":"exit 0"}}',
      },
    ]),
    false,
  );
});
test('dependency copies dereference source symlinks and the installer never writes through the original tree', async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dependency-copy-'))),
    root = path.join(dir, 'source'),
    workspace = path.join(dir, 'worktree');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'node_modules/pkg'), { recursive: true });
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'package.json'), '{"name":"fixture"}');
  await fs.writeFile(path.join(root, 'node_modules/pkg/file'), 'original');
  await fs.symlink(path.join(root, 'node_modules/pkg'), path.join(root, 'node_modules/alias'));
  await fs.mkdir(path.join(root, 'node_modules/.bin'));
  await fs.symlink('../missing-package/bin.js', path.join(root, 'node_modules/.bin/broken'));
  await fs.writeFile(
    path.join(root, 'node_modules/pkg/cli.cjs'),
    "console.log(require('node:fs').readFileSync(require('node:path').join(__dirname,'file'),'utf8'))",
  );
  await fs.symlink('../pkg/cli.cjs', path.join(root, 'node_modules/.bin/tool'));
  const environment = new NodeEnvironment(workspace, root);
  await environment.prepare(true);
  assert.equal(
    (await fs.lstat(path.join(workspace, 'node_modules/alias'))).isSymbolicLink(),
    false,
  );
  await fs.writeFile(path.join(workspace, 'node_modules/alias/file'), 'changed');
  assert.equal(await fs.readFile(path.join(root, 'node_modules/pkg/file'), 'utf8'), 'original');
  await fs.writeFile(path.join(workspace, 'node_modules/pkg/file'), 'private');
  assert.equal(
    (await exec(process.execPath, [path.join(workspace, 'node_modules/.bin/tool')])).stdout.trim(),
    'private',
  );
  assert.equal(await fs.readFile(path.join(root, 'node_modules/pkg/file'), 'utf8'), 'original');
  assert.equal(await environment.synchronize(new AbortController().signal), undefined);
});

test('real npm installation uses private caches, unpacks a local package and skips install scripts', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'environment-npm-'))),
    packageRoot = path.join(directory, 'package'),
    workspace = path.join(directory, 'workspace');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(packageRoot);
  await fs.mkdir(workspace);
  const script = "node -e \"require('node:fs').writeFileSync('INSTALL_SCRIPT_RAN','yes')\"";
  await fs.writeFile(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'local-fixture', version: '1.0.0', scripts: { postinstall: script } }),
  );
  await fs.writeFile(path.join(packageRoot, 'index.js'), 'module.exports=7;');
  const archive = path.join(directory, 'fixture.tgz');
  await exec('tar', ['-czf', archive, '-C', directory, 'package']);
  await fs.writeFile(
    path.join(workspace, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      version: '1.0.0',
      scripts: { postinstall: script },
      dependencies: { 'local-fixture': 'file:' + archive },
    }),
  );
  const { runProjectCommand } = await import('../adapters/checks/project-commands.ts');
  const environment = new NodeEnvironment(workspace, directory, (command, cwd, root, signal, env) =>
    runProjectCommand(command, cwd, root, signal, { ...env, npm_config_offline: 'true' }),
  );
  await environment.prepare(false);
  const result = await environment.synchronize(new AbortController().signal);
  assert.equal(result?.passed, true, result?.output);
  assert.equal(
    (await fs.lstat(path.join(workspace, 'node_modules/local-fixture'))).isSymbolicLink(),
    false,
  );
  assert.equal(
    await fs.readFile(path.join(workspace, 'node_modules/local-fixture/index.js'), 'utf8'),
    'module.exports=7;',
  );
  await assert.rejects(fs.access(path.join(workspace, 'INSTALL_SCRIPT_RAN')));
  await assert.rejects(
    fs.access(path.join(workspace, 'node_modules/local-fixture/INSTALL_SCRIPT_RAN')),
  );
  assert.equal(await environment.synchronize(new AbortController().signal), undefined);
});

test('a stopped linked run can opt in through goal editing and resume with an isolated dependency tree', async (t) => {
  const f = await fixture(t, false);
  assert.equal(f.run.status, 'needs-attention');
  await f.goals.update('enable', 'enable', {
    projectId: 'p',
    id: f.goal.id,
    expectedRevision: 1,
    title: 'Feature',
    body: 'Repair dependencies and finish feature',
    criteria: '',
    repairEnvironment: true,
  });
  const resumed = await f.engine.resume('resume', 'resume', {
    projectId: 'p',
    runId: f.run.id,
    mode: 'repair',
    instructions: 'Fix the dependency baseline and preserve feature changes',
    useCurrentProfile: false,
  });
  await f.engine.jobs.get(resumed.runId)?.promise;
  const run = f.engine.get('p', resumed.runId);
  assert.equal(run.status, 'completed', run.result);
  assert.equal(run.workspace, f.run.workspace);
  assert.equal(run.repairEnvironment, true);
  assert.equal((await fs.lstat(path.join(run.workspace!, 'node_modules'))).isSymbolicLink(), false);
  assert.equal(
    await fs.readFile(path.join(f.root, 'node_modules/fixture/version'), 'utf8'),
    '1.0.0',
  );
  assert.equal(run.attempts?.[0].repairEnvironment, false);
});

test('the real pinned Yarn 4 accepts the installer mode and disables root install scripts', async (t) => {
  const workspace = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'environment-yarn4-')),
  );
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(workspace, 'package.json'),
    JSON.stringify({
      name: 'yarn-fixture',
      version: '1.0.0',
      packageManager: 'yarn@4.17.0',
      scripts: { postinstall: "node -e \"require('fs').writeFileSync('SCRIPT_RAN','yes')\"" },
    }),
  );
  const cli = path.resolve('node_modules/@yarnpkg/cli-dist/bin/yarn.js');
  const environment = new NodeEnvironment(
    workspace,
    workspace,
    async (command, cwd, _root, signal, env) => {
      try {
        const result = await exec(
          process.execPath,
          [cli, ...command.command.split(/\s+/).slice(1)],
          {
            cwd,
            signal,
            env: { PATH: process.env.PATH, CI: '1', ...env, YARN_ENABLE_NETWORK: 'false' },
          },
        );
        return { exitCode: 0, output: result.stdout + result.stderr, durationMs: 1 };
      } catch (error: any) {
        return {
          exitCode: error.code || 1,
          output: (error.stdout || '') + (error.stderr || ''),
          durationMs: 1,
        };
      }
    },
  );
  await environment.prepare(false);
  const result = await environment.synchronize(new AbortController().signal);
  assert.equal(result?.passed, true, result?.output);
  await assert.rejects(fs.access(path.join(workspace, 'SCRIPT_RAN')));
  assert.equal(await environment.synchronize(new AbortController().signal), undefined);
});
