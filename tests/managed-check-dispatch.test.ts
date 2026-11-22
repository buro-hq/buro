import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionService } from '../core/execution.ts';
import type { AgentRuntime, ProjectRegistry } from '../core/ports.ts';
import type { ExecutionPolicy } from '../core/execution-ports.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import type { ResourceSnapshot, RuntimeResource } from '../protocol/resources.ts';
import { ProjectChecks } from '../adapters/checks/project-commands.ts';
import { EnvironmentExecutors, type Launch } from '../adapters/environments/executors.ts';
import { ProjectEnvironments } from '../adapters/environments/project-environments.ts';
import {
  virtualWorkspaceRevision,
  virtualVerificationViews,
  VIRTUAL_BASE_COMMIT,
} from './fixtures/virtual-workspace.ts';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const native: RuntimeResource = {
  capabilities: fixtureCapabilities(),
  id: 'codex',
  backendId: 'codex',
  local: false,
  configurationRevision: 'native-frozen',
};
const managed: RuntimeResource = {
  capabilities: fixtureCapabilities({ hostToolLifecycle: true }),
  id: 'small',
  backendId: 'managed',
  providerId: 'ollama',
  model: 'small',
  local: true,
  configurationRevision: 'managed-frozen',
};
const resources = (pool: RuntimeResource[] = [native]): ResourceSnapshot => ({
  profileId: 'team',
  policy: 'hybrid',
  coordinator: native,
  worker: native,
  reviewer: native,
  workerPool: pool,
});
const runtime = {
  id: 'unused',
  start: async () => {
    throw new Error('No model request is needed for these checks');
  },
} as AgentRuntime;

async function fixture(t: any, frozen: ResourceSnapshot | undefined) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-managed-dispatch-')),
  );
  const workspace = path.join(root, 'work');
  await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(workspace, 'check-ran');
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: '',
    scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: [] },
    setup: [],
    dependencies: 'none',
    checks: [
      {
        id: 'test',
        title: 'Check',
        command:
          quote(process.execPath) +
          ' -e ' +
          quote('require("node:fs").writeFileSync(' + JSON.stringify(marker) + ',"ran")'),
        timeoutMs: 1000,
      },
    ],
    defaultCheckIds: ['test'],
    maxWorkers: 1,
    maxRepairs: 0,
    turnTimeoutMs: 1000,
    environment: { provider: 'native' },
  };
  const state: any = {
    project: { id: 'p', root },
    goals: [{ id: 'g' }],
    runs: [
      {
        id: 'r',
        goalId: 'g',
        workspace,
        baseCommit: VIRTUAL_BASE_COMMIT,
        resources: frozen,
        checkIds: ['test'],
        events: [],
        status: 'running',
      },
    ],
  };
  const projects = {
    get: () => ({
      snapshot: () => structuredClone(state),
      transact: async (_id: string, _fingerprint: string, apply: (document: any) => unknown) =>
        apply(state),
    }),
  } as unknown as ProjectRegistry;
  const policy: ExecutionPolicy = {
    ...profile,
    profile,
    checks: profile.checks.map(({ id, title }) => ({ id, title })),
  };
  return { root, workspace, marker, profile, policy, projects, state };
}

test('baseline and final verification never run checks on the host after their required prepared world disappears', async (t) => {
  const f = await fixture(t, resources([native, managed]));
  f.profile.environment = {
    provider: 'native',
    recipe: {
      summary: 'Required prepared environment',
      variables: {},
      inputs: [],
      setup: [],
      ready: [{ id: 'ready', title: 'Ready', command: 'true', timeoutMs: 1000 }],
    },
  };
  let world: any;
  let observations = 0;
  let launches = 0;
  let fallback = 0;
  const executors = {
    get: () => world,
    releaseVerification() {},
    registerVerification: () => {
      throw new Error('The required world must be rejected before verification registration');
    },
    launch: () => {
      launches++;
      throw new Error('The lost world must be rejected before process launch');
    },
  } as unknown as EnvironmentExecutors;
  const checks = new ProjectChecks(
    f.projects,
    {
      run: async () => {
        fallback++;
        throw new Error('The fallback must not run');
      },
    },
    executors,
  );
  let sequence = 0;
  const service = new ExecutionService({
    workflowRoles: createBuiltinWorkflowRoles(),
    projects: f.projects,
    runtime,
    workspaces: {
      ...virtualVerificationViews,
      changes: async () => {
        if (++observations % 2 === 0) world = undefined;
        return [];
      },
      captureRevision: async (_workspace: string, base: string) =>
        virtualWorkspaceRevision([], base),
    } as any,
    environments: {
      prepare: async () => {
        world = {
          workspace: f.workspace,
          root: f.root,
          config: f.profile.environment,
          privateDataIsolation: true,
        };
        return { name: 'Prepared', passed: true };
      },
    } as any,
    checks,
    policies: { p: f.policy },
    now: () => '2026-11-20T00:00:00Z',
    id: () => String(++sequence),
  });
  // The same verify method is used for the initial baseline and final acceptance checks.
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      service.verify(
        'p',
        'r',
        { path: f.workspace, base: VIRTUAL_BASE_COMMIT },
        f.policy,
        new AbortController().signal,
      ),
      { code: 'ENVIRONMENT_UNAVAILABLE' },
    );
  assert.equal(launches, 0);
  assert.equal(fallback, 0);
  await assert.rejects(fs.stat(f.marker), { code: 'ENOENT' });
  await service.dispose();
});

test('native-only and legacy verification require immutable check isolation too', async (t) => {
  for (const frozen of [resources(), undefined]) {
    const f = await fixture(t, frozen);
    const checks = new ProjectChecks(f.projects, {
      run: async () => {
        throw new Error('The profile defines its own trusted check');
      },
    });
    let sequence = 0;
    const service = new ExecutionService({
      workflowRoles: createBuiltinWorkflowRoles(),
      projects: f.projects,
      runtime,
      workspaces: {
        ...virtualVerificationViews,
        changes: async () => [],
        captureRevision: async (_workspace: string, base: string) =>
          virtualWorkspaceRevision([], base),
      } as any,
      checks,
      policies: { p: f.policy },
      now: () => '2026-11-20T00:00:00Z',
      id: () => String(++sequence),
    });
    await assert.rejects(
      service.verify(
        'p',
        'r',
        { path: f.workspace, base: VIRTUAL_BASE_COMMIT },
        f.policy,
        new AbortController().signal,
      ),
      { code: 'ENVIRONMENT_UNAVAILABLE' },
    );
    await assert.rejects(fs.stat(f.marker), { code: 'ENOENT' });
    await service.dispose();
  }
});

// These fixtures exercise environment selection; OS confinement has its own integration suite.
class FixtureExecutors extends EnvironmentExecutors {
  launch(workspace: string, argv: string[]): Launch {
    return {
      executable: argv[0],
      args: argv.slice(1),
      cwd: workspace,
      env: { PATH: process.env.PATH },
    };
  }
}

test('an optional managed worker gets private-data isolation even with native defaults before any worker starts', async (t) => {
  const f = await fixture(t, resources([native, managed]));
  f.profile.environment = {
    provider: 'native',
    recipe: {
      summary: 'No dependencies',
      variables: {},
      inputs: [],
      setup: [],
      ready: [
        {
          id: 'ready',
          title: 'Ready',
          command: quote(process.execPath) + ' -e ' + quote('process.exit(0)'),
          timeoutMs: 1000,
        },
      ],
    },
  };
  const executors = new FixtureExecutors();
  const environment = new ProjectEnvironments(f.projects, runtime, executors, {
    // A changed machine default must not replace the run's frozen pool.
    forProject: () => resources(),
  });
  const result = await environment.prepare({
    projectId: 'p',
    runId: 'r',
    workspace: f.workspace,
    base: VIRTUAL_BASE_COMMIT,
    profile: f.profile,
    signal: new AbortController().signal,
    report: async () => {},
  });
  assert.equal(result.passed, true);
  assert.equal(executors.get(f.workspace)?.privateDataIsolation, true);
  await environment.release(f.workspace);
});
