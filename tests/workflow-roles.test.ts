import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RoleTemplateCatalog,
  WorkflowCatalog,
  createWorkflowRoleResolver,
  validateCapturedRoleSnapshots,
} from '../core/workflow-roles.ts';
import {
  createBuiltinWorkflowRoles,
  createBuiltinRoleTemplates,
} from '../adapters/workflows/builtins.ts';
import { serviceOperationContext, operationIds } from '../core/operation-catalog.ts';
import { RoleService } from '../core/services.ts';
import { ResultService } from '../core/results.ts';
import { resolveTeam } from '../core/execution-ports.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { resolveRoleResource } from '../core/role-routing.ts';
import {
  fixtureExecutionSelection,
  fixtureExecutionCapabilities,
} from './fixtures/execution-resources.ts';
import type { Run } from '../protocol/domain.ts';

const template = () => ({
  id: 'custom',
  revision: 'template-v1',
  title: 'Custom role',
  description: 'Trusted content',
  instructions: 'Only the actual service operation grants effects.',
  kind: 'general' as const,
});
test('sealed workflow catalogs select content without granting role IDs, models or execution hooks', () => {
  const templates = new RoleTemplateCatalog(),
    workflows = new WorkflowCatalog();
  templates.register(template());
  workflows.register({
    id: 'custom-flow',
    revision: 'flow-v1',
    templateFor: (operation) => {
      assert.ok(Object.isFrozen(operation.requirements));
      return 'custom';
    },
  });
  assert.throws(
    () => createWorkflowRoleResolver({ templates, workflows, workflowId: 'custom-flow' }),
    { code: 'ROLE_TEMPLATES_UNSEALED' },
  );
  assert.throws(() => templates.register(template()), { code: 'ROLE_TEMPLATE_EXISTS' });
  templates.seal();
  workflows.seal();
  const resolver = createWorkflowRoleResolver({ templates, workflows, workflowId: 'custom-flow' }),
    doc = { roleVersions: [] };
  const resolved = resolver.ensureRole(
    doc,
    serviceOperationContext(operationIds.coordination),
    'first-time',
  );
  assert.equal(resolved.role.id, 'coordinator');
  assert.equal(resolved.role.version, 1);
  assert.equal(resolved.role.createdAt, 'first-time');
  assert.equal(resolved.role.runtimePreference, undefined);
  assert.deepEqual(resolved.role.provenance, {
    origin: 'workflow',
    workflow: { id: 'custom-flow', revision: 'flow-v1' },
    template: { id: 'custom', revision: 'template-v1' },
  });
  assert.throws(() => templates.register({ ...template(), id: 'late' }), {
    code: 'ROLE_TEMPLATES_SEALED',
  });
  assert.throws(
    () => workflows.register({ id: 'late', revision: 'v1', templateFor: () => undefined }),
    { code: 'WORKFLOWS_SEALED' },
  );
  for (const fields of [
    { model: 'model' },
    { roleId: 'wrong' },
    { runtimePreference: { mode: 'fixed', runtimeId: 'wrong' } },
    { capabilities: { readOnly: true } },
  ]) {
    const other = new RoleTemplateCatalog();
    assert.throws(() => other.register({ ...template(), ...fields } as any), {
      code: 'INVALID_ROLE_TEMPLATE',
    });
  }
});

test('resolver captures catalog options and preserves an existing user role without calling a missing template selector', () => {
  const templates = new RoleTemplateCatalog(),
    workflows = new WorkflowCatalog();
  templates.register(template());
  templates.seal();
  workflows.register({ id: 'custom-flow', revision: 'v1', templateFor: () => 'custom' });
  workflows.seal();
  const options = { templates, workflows, workflowId: 'custom-flow' },
    resolver = createWorkflowRoleResolver(options);
  const other = new RoleTemplateCatalog();
  other.register({ ...template(), instructions: 'Retargeted' });
  options.templates = other.seal();
  const doc: any = { roleVersions: [] };
  const first = resolver.ensureRole(doc, serviceOperationContext(operationIds.coordination), 'now');
  assert.notEqual(first.role.instructions, 'Retargeted');
  first.role.instructions = 'Returned copy changed';
  assert.notEqual(doc.roleVersions[0].instructions, first.role.instructions);
  const user = {
    ...doc.roleVersions[0],
    provenance: { origin: 'user' },
    instructions: 'User instructions',
    runtimePreference: { mode: 'fixed', runtimeId: 'chosen' },
  };
  doc.roleVersions = [user];
  const empty = new RoleTemplateCatalog().seal(),
    noTemplates = new WorkflowCatalog();
  noTemplates.register({ id: 'no-templates', revision: 'v1', templateFor: () => undefined });
  const existing = createWorkflowRoleResolver({
    templates: empty,
    workflows: noTemplates.seal(),
    workflowId: 'no-templates',
  }).ensureRole(doc, serviceOperationContext(operationIds.coordination), 'later');
  assert.equal(existing.created, false);
  assert.deepEqual(existing.role, user);
  assert.equal(doc.roleVersions.length, 1);
});

test('validated coordinator worker creation receives the saved host workflow, never a proposed provenance field', () => {
  const policy = {
    scope: { mode: 'advisory' as const, plannedPaths: ['src/'], protectedPaths: [] },
    checks: [],
    defaultCheckIds: [],
    maxWorkers: 1,
    turnTimeoutMs: 10000,
  };
  const plan: any = {
    summary: 'Plan',
    team: [
      {
        action: 'create',
        roleId: 'worker',
        title: 'Worker',
        description: 'Scoped worker',
        instructions: 'Implement the task',
        kind: 'implementation',
        paths: ['src/'],
        provenance: { origin: 'user' },
      },
    ],
    steps: [{ step: 'Implement', owner: 'worker' }],
  };
  const result = resolveTeam(plan, [], policy, 'now', { id: 'saved-workflow', revision: 'old-v1' });
  assert.deepEqual(result.roles[0].provenance, {
    origin: 'coordinator',
    workflow: { id: 'saved-workflow', revision: 'old-v1' },
  });
  assert.equal(result.roles[0].id, 'worker');
});

async function fixture(t: any) {
  const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'buro-workflow-roles-')),
    ),
    store = await FileProjectStore.open({
      directory: path.join(directory, 'state'),
      project: { id: 'p', name: 'Project', root: directory },
      roles: [],
    }),
    projects = new ProjectStoreRegistry([store]),
    workflowRoles = createBuiltinWorkflowRoles();
  t.after(async () => {
    await projects.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const seed = async () =>
    store.transact('role-seed', 'role-seed', (doc) => {
      const { role } = workflowRoles.ensureRole(
        doc,
        serviceOperationContext(operationIds.coordination),
        'created-now',
      );
      return { result: role, change: { type: 'role.saved', role } };
    });
  return { directory, store, projects, workflowRoles, seed };
}
test('user edits own their new version and cannot forge workflow or coordinator provenance', async (t) => {
  const f = await fixture(t),
    original = await f.seed(),
    roles = new RoleService({ projects: f.projects, now: () => 'edited-now', id: () => 'unused' });
  const changed = await roles.save('edit', 'edit', {
    projectId: 'p',
    id: original.id,
    title: 'User title',
    description: 'User description',
    instructions: 'User instructions',
    kind: 'general',
    expectedVersion: 1,
    provenance: { origin: 'coordinator', workflow: { id: 'forged', revision: 'forged' } },
  } as any);
  assert.equal(changed.version, 2);
  assert.equal(changed.createdAt, 'created-now');
  assert.equal(changed.updatedAt, 'edited-now');
  assert.deepEqual(changed.provenance, {
    origin: 'user',
    workflow: original.provenance.workflow,
    template: 'template' in original.provenance ? original.provenance.template : undefined,
  });
  const created = await roles.save('new', 'new', {
    projectId: 'p',
    id: 'new_user_role',
    title: 'User',
    description: 'User',
    instructions: 'User instructions',
    kind: 'general',
    expectedVersion: 0,
    provenance: {
      origin: 'workflow',
      workflow: { id: 'forged', revision: 'v1' },
      template: { id: 'forged', revision: 'v1' },
    },
  } as any);
  assert.deepEqual(created.provenance, { origin: 'user' });
});

test('file role history rejects old-version content/provenance rewrite, removal, reordering and skipped versions', async (t) => {
  const f = await fixture(t),
    role = await f.seed(),
    roles = new RoleService({ projects: f.projects, now: () => 'later', id: () => '' });
  await roles.save('second', 'second', {
    projectId: 'p',
    id: role.id,
    title: role.title,
    description: role.description,
    instructions: 'Second instructions',
    kind: role.kind,
    expectedVersion: 1,
  });
  const before = await fs.readFile(path.join(f.directory, 'state', 'control-state.json'), 'utf8');
  for (const [name, change] of [
    [
      'instructions',
      (doc: any) => {
        doc.roleVersions[0].instructions = 'Retargeted';
      },
    ],
    [
      'provenance',
      (doc: any) => {
        doc.roleVersions[0].provenance = { origin: 'user' };
      },
    ],
    [
      'remove',
      (doc: any) => {
        doc.roleVersions.shift();
      },
    ],
    [
      'reorder',
      (doc: any) => {
        doc.roleVersions.reverse();
      },
    ],
    [
      'skip',
      (doc: any) => {
        doc.roleVersions.push({ ...doc.roleVersions.at(-1), version: 4 });
      },
    ],
  ] as const)
    await assert.rejects(
      f.store.transact(name, name, (doc) => {
        change(doc);
        return { result: null, change: { type: 'role.saved', role: doc.roleVersions[0] } };
      }),
      { code: 'ROLE_HISTORY_CHANGED' },
    );
  assert.equal(
    await fs.readFile(path.join(f.directory, 'state', 'control-state.json'), 'utf8'),
    before,
  );
});

test('captured service-role provenance cannot be dropped while its frozen grant remains, while unreferenced replanning snapshots may change', async (t) => {
  const f = await fixture(t),
    role = await f.seed();
  const before: any = {
    runs: [
      {
        id: 'R',
        workflow: { id: 'code', revision: 'code-v1' },
        roleSnapshots: [role],
        roleResources: { coordinator: { roleVersion: 1 } },
      },
    ],
  };
  const removed = structuredClone(before);
  removed.runs[0].roleSnapshots = [];
  assert.throws(() => validateCapturedRoleSnapshots(before, removed), {
    code: 'ROLE_HISTORY_CHANGED',
  });
  const changed = structuredClone(before);
  changed.runs[0].roleSnapshots[0].provenance = { origin: 'user' };
  assert.throws(() => validateCapturedRoleSnapshots(before, changed), {
    code: 'ROLE_HISTORY_CHANGED',
  });
  const replanned = structuredClone(before);
  replanned.runs[0].roleResources = {};
  replanned.runs[0].roleSnapshots = [];
  validateCapturedRoleSnapshots(before, replanned);
});

test('result preparation creates only its missing role and preserves its original version after a user edits the team', async (t) => {
  const f = await fixture(t),
    resources = fixtureExecutionSelection('fixture', fixtureExecutionCapabilities()).forProject(
      'p',
    );
  const run: Run = {
    id: 'R',
    key: 'G',
    goalId: 'G',
    title: 'Goal',
    summary: 'Done',
    createdAt: 'now',
    threadId: 'implementation',
    status: 'completed',
    phase: 'done',
    workspace: path.join(f.directory, 'writer'),
    commit: 'b'.repeat(40),
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
    goalText: 'Goal',
    result: 'Done',
    sourceHash: '',
    resources,
  };
  await f.store.transact('seed-run', 'seed-run', (doc) => {
    doc.runs.push(run);
    const goal = {
      id: 'G',
      projectId: 'p',
      title: 'Goal',
      body: 'Goal',
      criteria: '',
      status: 'completed' as const,
      createdAt: 'now',
    };
    doc.goals.push(goal);
    return { result: null, change: { type: 'run.changed', run, goal } };
  });
  const starts: any[] = [],
    events: any[] = [];
  f.store.subscribe(f.store.snapshot().sequence, (event) => events.push(event));
  const results = new ResultService({
    projects: f.projects,
    workflowRoles: f.workflowRoles,
    runtime: {
      id: 'fixture',
      async start(input: any) {
        assert.equal(f.store.snapshot().roles.length, 1);
        starts.push(input);
        return { threadId: 'result-' + starts.length };
      },
      async turn() {
        return { turnId: 'turn', text: '{"ready":true,"summary":"Ready","blockers":[]}' };
      },
      async release() {},
    } as any,
    operations: { async dispose() {} } as any,
  });
  t.after(() => results.dispose());
  await results.prepare(
    'p',
    f.store.snapshot().runs[0],
    operationIds.preview,
    'local_preview',
    {},
    new AbortController().signal,
  );
  const role = f.store.snapshot().roles[0];
  assert.equal(role.id, 'local_preview');
  assert.equal(role.provenance.origin, 'workflow');
  assert.equal(events[0].change.roles[0].id, 'local_preview');
  const roles = new RoleService({ projects: f.projects, now: () => 'later', id: () => '' });
  await roles.save('edit-preview', 'edit-preview', {
    projectId: 'p',
    id: role.id,
    title: role.title,
    description: role.description,
    instructions: 'Future user instructions',
    kind: role.kind,
    expectedVersion: 1,
  });
  await results.prepare(
    'p',
    f.store.snapshot().runs[0],
    operationIds.preview,
    'local_preview',
    {},
    new AbortController().signal,
  );
  assert.equal(f.store.snapshot().runs[0].resultAgents![1].session!.roleVersion, 1);
  assert.match(starts[1].instructions, /Prepare local verification/);
  assert.doesNotMatch(starts[1].instructions, /Future user instructions/);
});

test('a durable runtime route cannot replace its saved role grant or backend session', async (t) => {
  const f = await fixture(t),
    role = await f.seed(),
    resources = fixtureExecutionSelection('fixture', fixtureExecutionCapabilities()).forProject(
      'p',
    ),
    decision = resolveRoleResource(resources, role, serviceOperationContext(operationIds.research)),
    routes = new FileRuntimeRoutes(path.join(f.directory, 'routes'));
  const route: any = {
    id: 'route',
    projectId: 'p',
    runId: 'research',
    workspace: f.directory,
    resource: decision.resource,
    requirements: { structuredTurns: true, readOnlySessions: true },
    readOnly: true,
    purpose: 'research',
    operationId: operationIds.research,
    roleId: role.id,
    roleDecision: decision,
    roleGrant: { role, resources },
    externalThreadId: 'original',
    status: 'ready',
  };
  await routes.save(route);
  const changed = structuredClone(route);
  changed.roleGrant.role.provenance = { origin: 'user' };
  await assert.rejects(routes.save(changed), { code: 'INVALID_ASSIGNMENT' });
  await assert.rejects(routes.save({ ...route, externalThreadId: 'retargeted' }), {
    code: 'INVALID_ASSIGNMENT',
  });
  assert.deepEqual(await routes.load('route'), route);
});
