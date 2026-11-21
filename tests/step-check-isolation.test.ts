import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectChecks } from '../adapters/checks/project-commands.ts';
import { WorkerStepChecks } from '../adapters/checks/worker-step-checks.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import type { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import type { ToolScope } from '../core/model-ports.ts';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-step-isolation-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = (id: string) => ({
    id,
    title: id,
    timeoutMs: 1000,
    command:
      quote(process.execPath) +
      ' -e ' +
      quote(
        'require("node:fs").writeFileSync(' +
          JSON.stringify(path.join(directory, id)) +
          ',"executed")',
      ),
  });
  const checks = [command('first'), command('second')];
  const profile = {
    version: 1,
    revision: 1,
    checks,
    environment: { provider: 'native' },
    checkConcurrency: 1,
  } as ProjectProfile;
  const resource = {
    capabilities: fixtureCapabilities({ hostToolLifecycle: true }),
    id: 'local',
    client: 'managed',
    providerId: 'ollama',
    model: 'small',
    configurationRevision: 'frozen',
    local: true,
  };
  const scope: ToolScope = {
    projectId: 'p',
    runId: 'r',
    ownerRunId: 'r',
    sessionId: 's',
    workspace: directory,
    baseCommit: 'a'.repeat(40),
    readOnly: false,
    allowedPaths: ['src/'],
    protectedPaths: [],
    materials: [],
    commands: checks,
  };
  const state: any = {
    project: { id: 'p', root: directory },
    runs: [
      {
        id: 'r',
        status: 'running',
        delegation: 'buro',
        workspace: directory,
        baseCommit: scope.baseCommit,
        resources: {
          profileId: 'local',
          policy: 'local-only',
          coordinator: resource,
          worker: resource,
          reviewer: resource,
        },
        checkIds: ['first'],
        roleAssignments: { coder: ['src/'] },
        executionPolicySnapshot: { allowedPaths: ['src/'], protectedPaths: [], profile },
        agents: [
          {
            status: 'running',
            session: {
              id: 's',
              roleId: 'coder',
              roleVersion: 1,
              runtimeId: 'local',
              providerId: 'ollama',
              model: 'small',
              configurationRevision: 'frozen',
            },
            assignment: { paths: ['src/'] },
          },
        ],
      },
    ],
  };
  const projects = {
    get: () => ({ snapshot: () => structuredClone(state) }),
  } as unknown as ProjectRegistry;
  const prepared = {
    workspace: directory,
    root: directory,
    config: { provider: 'native' },
    privateDataIsolation: true,
  };
  let world: any = prepared;
  let lookups = 0;
  let removeAfterFirstLookup = false;
  const launches: any[] = [];
  const executors = {
    get: () => {
      lookups++;
      const current = world;
      if (removeAfterFirstLookup) world = undefined;
      return current;
    },
    launch: (workspace: string, argv: string[], options: any) => {
      launches.push(options);
      if (!world) throw new Error('The workspace environment disappeared at launch.');
      return {
        executable: argv[0],
        args: argv.slice(1),
        cwd: workspace,
        env: { PATH: process.env.PATH },
      };
    },
  } as unknown as EnvironmentExecutors;
  let fallback = 0;
  const service = new ProjectChecks(
    projects,
    {
      run: async () => {
        fallback++;
        throw new Error('Unexpected fallback');
      },
    },
    executors,
  );
  return {
    directory,
    checks,
    profile,
    projects,
    state,
    scope,
    service,
    executors,
    launches,
    prepared,
    setWorld: (next: any) => {
      world = next;
    },
    loseAtLookup: () => {
      removeAfterFirstLookup = true;
    },
    fallbackCalls: () => fallback,
  };
}
const signal = () => new AbortController().signal;

test('world removal during pre-check inspection cannot cause a host-command fallback', async (t) => {
  const f = await fixture(t),
    fingerprint = 'b'.repeat(64);
  const step = new WorkerStepChecks({
    projects: f.projects,
    checks: f.service,
    executors: f.executors,
    evidence: {
      inspect: async () => {
        f.setWorld(undefined);
        return {
          version: 1,
          baseCommit: f.scope.baseCommit!,
          headCommit: f.scope.baseCommit!,
          workspaceFingerprint: fingerprint,
          files: [],
        };
      },
    },
  });
  const plan = step.plan(f.scope)!;
  await assert.rejects(step.run(f.scope, plan, fingerprint, signal()), {
    code: 'STEP_CHECK_UNAVAILABLE',
  });
  assert.equal(f.launches.length, 0);
  assert.equal(f.fallbackCalls(), 0);
  await assert.rejects(fs.stat(path.join(f.directory, 'first')), { code: 'ENOENT' });
});

test('prepared isolation is required again for every subsequent command', async (t) => {
  const f = await fixture(t);
  let launches = 0;
  const original = f.executors.launch.bind(f.executors);
  f.executors.launch = (...args: Parameters<EnvironmentExecutors['launch']>) => {
    const launch = original(...args);
    if (++launches === 1) f.setWorld(undefined);
    return launch;
  };
  await assert.rejects(
    f.service.run('p', f.directory, ['first', 'second'], signal(), f.profile, {
      requirePreparedIsolation: true,
    }),
    { code: 'STEP_CHECK_UNAVAILABLE' },
  );
  assert.equal(await fs.readFile(path.join(f.directory, 'first'), 'utf8'), 'executed');
  await assert.rejects(fs.stat(path.join(f.directory, 'second')), { code: 'ENOENT' });
  assert.deepEqual(f.launches, [{ privateDataIsolation: true }]);
});

test('required isolation rejects missing profile, executor, private guard or frozen environment mismatch', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.run('p', f.directory, ['first'], signal(), undefined, {
      requirePreparedIsolation: true,
    }),
    { code: 'STEP_CHECK_UNAVAILABLE' },
  );
  const noExecutor = new ProjectChecks(f.projects, {
    run: async () => {
      throw new Error('Fallback must not run');
    },
  });
  await assert.rejects(
    noExecutor.run('p', f.directory, ['first'], signal(), f.profile, {
      requirePreparedIsolation: true,
    }),
    { code: 'STEP_CHECK_UNAVAILABLE' },
  );
  for (const world of [
    undefined,
    { ...f.prepared, privateDataIsolation: false },
    { ...f.prepared, root: '/different-root' },
    { ...f.prepared, config: { provider: 'docker' } },
  ]) {
    f.setWorld(world);
    await assert.rejects(
      f.service.run('p', f.directory, ['first'], signal(), f.profile, {
        requirePreparedIsolation: true,
      }),
      { code: 'STEP_CHECK_UNAVAILABLE' },
    );
  }
  assert.equal(f.launches.length, 0);
  assert.equal(f.fallbackCalls(), 0);
  await assert.rejects(fs.stat(path.join(f.directory, 'first')), { code: 'ENOENT' });
});

test('ordinary trusted checks keep their existing host/fallback behavior unless isolation is required', async (t) => {
  const f = await fixture(t);
  f.setWorld(undefined);
  const result = await f.service.run('p', f.directory, ['first'], signal(), f.profile);
  assert.equal(result.passed, 1);
  assert.equal(await fs.readFile(path.join(f.directory, 'first'), 'utf8'), 'executed');
  assert.equal(f.launches.length, 0);
});
