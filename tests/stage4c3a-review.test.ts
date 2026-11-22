import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHost } from '../plugins/host.ts';
import { runtimePlugin } from '../plugins/runtime.ts';
import { projectManagementPlugin } from '../plugins/project-management.ts';
import { projectOperationsPlugin } from '../plugins/project-operations.ts';
import { executionPlugin } from '../plugins/execution.ts';
import { websocketPlugin } from '../daemon/websocket.ts';
import { SocketProjectClient } from '../clients/socket-client.ts';
import { RuntimeRouter } from '../core/runtime-router.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import { RoleTemplateCatalog, WorkflowCatalog } from '../core/workflow-roles.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import type { RegisteredRuntime } from '../core/ports.ts';
import type { ProjectProfile, Snapshot } from '../protocol/domain.ts';
import type { ResourceSnapshot, RuntimeResource } from '../protocol/resources.ts';

const exec = promisify(execFile);
function observed(client: SocketProjectClient, predicate: (snapshot: Snapshot) => boolean) {
  if (predicate(client.snapshot())) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = client.onChange((snapshot) => {
      if (predicate(snapshot)) {
        unsubscribe();
        resolve();
      }
    });
  });
}
async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-workflow-review-')));
  const git = (args: string[]) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(root, '.gitignore'), '.buro/\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture']);
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: 'Manual',
    scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
    checks: [{ id: 'check', title: 'Check', command: 'never-run-check', timeoutMs: 1000 }],
    defaultCheckIds: ['check'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    turnTimeoutMs: 10000,
    baseBranch: 'main',
    components: [],
  };
  const templates = new RoleTemplateCatalog();
  templates.register({
    id: 'third-specialist',
    revision: 'template-v7',
    kind: 'general',
    title: 'Third researcher',
    description: 'Selected by the custom workflow',
    instructions: 'THIRD_WORKFLOW_INSTRUCTIONS',
  });
  const workflows = new WorkflowCatalog();
  const selections: string[] = [];
  workflows.register({
    id: 'third-workflow',
    revision: 'workflow-v3',
    templateFor(operation) {
      selections.push(operation.id);
      assert.ok(Object.isFrozen(operation));
      return operation.id === 'goal.review' ? undefined : 'third-specialist';
    },
  });
  const host = await createHost({
    projects: [
      {
        storageAddress: path.join(root, '.buro', 'state'),
        project: { id: 'p', name: 'Fixture', root, managed: true },
        profile,
      },
    ],
    projectContributions: { roleTemplates: templates, workflows },
  });
  const store = host.ctx.projects.registry.get('p');
  const starts: { runtimeId: string; input: any }[] = [];
  let turns = 0,
    effects = 0,
    released!: () => void;
  const release = new Promise<void>((resolve) => {
    released = resolve;
  });
  const capabilities = fixtureCapabilities({
    structuredTurns: true,
    toolsFreeTurns: true,
    readOnlySessions: true,
    immutableReview: true,
    resumeSessions: true,
  });
  const resources: RuntimeResource[] = ['first', 'second'].map((id) => ({
    id,
    backendId: 'fixture',
    local: true,
    configurationRevision: id + '-v1',
    capabilities,
  }));
  const snapshot: ResourceSnapshot = {
    profileId: 'team',
    policy: 'local-only',
    coordinator: resources[0],
    worker: resources[0],
    reviewer: resources[0],
    workerPool: resources,
  };
  const selection = { forProject: () => structuredClone(snapshot) };
  const runtimes: RegisteredRuntime[] = resources.map((resource) => ({
    id: resource.id,
    capabilities,
    async start(input) {
      starts.push({ runtimeId: resource.id, input: structuredClone(input) });
      return { threadId: resource.id + '-thread' };
    },
    async submit() {
      throw Error('No unstructured submission');
    },
    async turn() {
      turns++;
      return {
        turnId: 'one',
        text: JSON.stringify({
          summary: 'Proposal only',
          context: 'Suggested',
          components: [],
          checks: [],
          questions: [],
        }),
      };
    },
    async resume(input) {
      return { threadId: input.threadId };
    },
    async interrupt() {},
    async release() {
      released();
    },
    async dispose() {},
  }));
  await host.ctx.plugin(runtimePlugin, {
    runtimes,
    defaultRuntimeId: 'first',
    selection,
    route: (registry) =>
      new RuntimeRouter({
        registry,
        selection,
        projects: host.ctx.projects.registry,
        resources,
        routes: new FileRuntimeRoutes(path.join(root, '.buro', 'routes')),
        id: () => crypto.randomUUID(),
      }),
  });
  const workspaces = {
    async prepare() {
      effects++;
      throw Error('No workspace effect before admission');
    },
  } as any;
  const checks = {
    async run() {
      effects++;
      throw Error('No check executor during research');
    },
  } as any;
  const policies = {
    p: {
      scope: profile.scope,
      checks: profile.checks,
      defaultCheckIds: profile.defaultCheckIds,
      maxWorkers: 1,
      turnTimeoutMs: 10000,
      profile,
    },
  };
  await host.ctx.plugin(projectManagementPlugin, {
    catalogFile: path.join(root, '.buro', 'catalog.json'),
    policies,
    workspaces,
    checks,
  });
  await host.ctx.plugin(projectOperationsPlugin, {
    operations: { async dispose() {} } as any,
    workflowId: 'third-workflow',
  });
  await host.ctx.plugin(executionPlugin, {
    policies,
    workspaces,
    checks,
    workflowId: 'third-workflow',
  });
  let port = 0;
  await host.ctx.plugin(websocketPlugin, {
    port: 0,
    onListen: (value) => {
      port = value;
    },
  });
  const client = new SocketProjectClient(`ws://127.0.0.1:${port}`, 'p');
  await client.connect();
  t.after(async () => {
    client.close();
    await host.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const command = (method: string, params: any, id: string) =>
    host.ctx.commands.bus.execute({ method, params } as any, { id, fingerprint: id });
  return {
    root,
    host,
    store,
    client,
    command,
    starts,
    selections,
    release,
    turns: () => turns,
    effects: () => effects,
  };
}

test(
  'a custom-only Cordis workflow lazily publishes one research role and retry preserves its receipt and frozen provenance',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    assert.deepEqual(f.store.snapshot().roles, []);
    assert.deepEqual(f.client.snapshot().roles, []);
    assert.deepEqual(f.host.ctx.projectContributions.workflows.list(), [
      { id: 'third-workflow', revision: 'workflow-v3' },
    ]);
    let sawInvalidated = false;
    const unsubscribe = f.client.onChange((snapshot) => {
      if (snapshot.roles.length === 1 && !snapshot.effectivePolicy) sawInvalidated = true;
    });
    const projected = observed(
      f.client,
      (snapshot) => snapshot.roles.length === 1 && !!snapshot.effectivePolicy,
    );
    const result = await f.command('project.research', { projectId: 'p' }, 'research');
    await f.release;
    await projected;
    unsubscribe();
    assert.equal(f.store.snapshot().research!.status, 'ready');
    assert.equal(sawInvalidated, true);
    assert.equal(f.client.snapshot().roles[0].instructions, 'THIRD_WORKFLOW_INSTRUCTIONS');
    assert.equal(f.client.snapshot().roles[0].id, 'coordinator');
    assert.deepEqual(f.client.snapshot().roles[0].provenance, {
      origin: 'workflow',
      workflow: { id: 'third-workflow', revision: 'workflow-v3' },
      template: { id: 'third-specialist', revision: 'template-v7' },
    });
    const sequence = f.store.snapshot().sequence;
    assert.deepEqual(await f.command('project.research', { projectId: 'p' }, 'research'), result);
    assert.equal(f.store.snapshot().sequence, sequence);
    assert.equal(f.store.snapshot().roles.length, 1);
    assert.equal(f.turns(), 1);
    assert.equal(f.effects(), 0);
    assert.deepEqual(f.selections, ['project.research']);
    const captured = f.store.snapshot().research!.roleSnapshot;
    await f.client.saveRole({
      projectId: 'p',
      id: captured.id,
      expectedVersion: 1,
      title: 'User version',
      description: captured.description,
      instructions: 'USER_EDITED_INSTRUCTIONS',
      kind: 'general',
      runtimePreference: { mode: 'fixed', runtimeId: 'second' },
    });
    assert.equal(f.store.snapshot().roles[0].provenance.origin, 'user');
    assert.deepEqual(f.store.snapshot().research!.roleSnapshot, captured);
    assert.equal(f.store.snapshot().research!.roleResource.resource.id, 'first');
    const bytes = await fs.readFile(
      path.join(f.root, '.buro', 'state', 'control-state.json'),
      'utf8',
    );
    await assert.rejects(
      f.store.transact('rewrite-provenance', 'rewrite-provenance', (doc) => {
        doc.research!.roleSnapshot.provenance = { origin: 'user' };
        return {
          result: null,
          change: { type: 'project.research.changed', research: doc.research! },
        };
      }),
      { code: 'PROJECT_ANALYSIS_CHANGED' },
    );
    assert.equal(f.store.receipt('rewrite-provenance', 'rewrite-provenance'), undefined);
    assert.equal(
      await fs.readFile(path.join(f.root, '.buro', 'state', 'control-state.json'), 'utf8'),
      bytes,
    );
  },
);

test(
  'an existing user role and fixed eligible runtime win over the selected workflow template and profile coordinator',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const role = await f.client.saveRole({
      projectId: 'p',
      id: 'coordinator',
      expectedVersion: 0,
      title: 'User researcher',
      description: 'User authored',
      instructions: 'USER_FIXED_RESEARCH_INSTRUCTIONS',
      kind: 'general',
      runtimePreference: { mode: 'fixed', runtimeId: 'second' },
    });
    await f.command('project.research', { projectId: 'p' }, 'research');
    await f.release;
    const research = f.store.snapshot().research!;
    assert.equal(research.status, 'ready', research.error);
    assert.deepEqual(research.roleSnapshot, role);
    assert.equal(research.roleResource.resource.id, 'second');
    assert.deepEqual(
      f.starts.map((call) => call.runtimeId),
      ['second'],
    );
    assert.match(f.starts[0].input.instructions, /USER_FIXED_RESEARCH_INSTRUCTIONS/);
    assert.doesNotMatch(f.starts[0].input.instructions, /THIRD_WORKFLOW_INSTRUCTIONS/);
    assert.deepEqual(f.selections, []);
    assert.equal(f.store.snapshot().roles.length, 1);
    assert.equal(f.effects(), 0);
  },
);

test(
  'a missing fresh-review template rolls back the coordinator and run instead of bypassing review or creating extra roles on retry',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const goal = await f.client.createGoal({
      projectId: 'p',
      title: 'Fixture',
      body: 'Must preserve independent review.',
      criteria: '',
    });
    const bytes = await fs.readFile(
      path.join(f.root, '.buro', 'state', 'control-state.json'),
      'utf8',
    );
    for (let retry = 0; retry < 2; retry++) {
      await assert.rejects(f.command('run.start', { projectId: 'p', goalId: goal.id }, 'run'), {
        code: 'WORKFLOW_ROLE_UNAVAILABLE',
      });
      assert.deepEqual(f.store.snapshot().roles, []);
      assert.deepEqual(f.store.snapshot().runs, []);
      assert.equal(f.store.snapshot().goals[0].status, 'draft');
      assert.equal(f.store.receipt('run', 'run'), undefined);
      assert.equal(
        await fs.readFile(path.join(f.root, '.buro', 'state', 'control-state.json'), 'utf8'),
        bytes,
      );
    }
    assert.equal(f.turns(), 0);
    assert.deepEqual(f.starts, []);
    assert.equal(f.effects(), 0);
  },
);
