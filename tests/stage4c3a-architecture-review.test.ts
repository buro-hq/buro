import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RoleTemplateCatalog,
  WorkflowCatalog,
  createWorkflowRoleResolver,
} from '../core/workflow-roles.ts';
import { operationIds, serviceOperationContext } from '../core/operation-catalog.ts';
import type { Role } from '../protocol/domain.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeRouter } from '../core/runtime-router.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import { resolveRoleResource } from '../core/role-routing.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { ResourceSnapshot, RuntimeResource } from '../protocol/resources.ts';

function templates(revision: string, instructions: string) {
  const catalog = new RoleTemplateCatalog();
  catalog.register({
    id: 'coordinator-template',
    revision,
    title: 'Coordinator',
    description: 'Resolve the actual coordination role.',
    instructions,
    kind: 'general',
  });
  return catalog.seal();
}

test('a selected workflow resolver cannot be retargeted by replacing its caller-owned template options', () => {
  const workflows = new WorkflowCatalog();
  workflows.register({
    id: 'custom',
    revision: 'workflow-v1',
    templateFor: (operation) => {
      assert.equal(operation.id, operationIds.coordination);
      assert.ok(Object.isFrozen(operation));
      assert.ok(Object.isFrozen(operation.requirements));
      return 'coordinator-template';
    },
  });
  const options = {
    workflows: workflows.seal(),
    templates: templates('template-v1', 'Original selected instructions.'),
    workflowId: 'custom',
  };
  const resolver = createWorkflowRoleResolver(options);
  options.templates = templates('template-v2', 'A later replacement must not be consulted.');
  const doc = { roleVersions: [] as Role[] };
  const result = resolver.ensureRole(
    doc,
    serviceOperationContext(operationIds.coordination),
    '2026-11-22T00:00:00Z',
  );
  assert.equal(result.created, true);
  assert.equal(result.role.instructions, 'Original selected instructions.');
  assert.deepEqual(result.role.provenance, {
    origin: 'workflow',
    workflow: { id: 'custom', revision: 'workflow-v1' },
    template: { id: 'coordinator-template', revision: 'template-v1' },
  });
  assert.deepEqual(doc.roleVersions, [result.role]);
});

test('an admitted research route cannot omit both its original role decision and grant', async (t) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-research-route-review-')),
  );
  const registry = new RuntimeCatalog();
  const capabilities = fixtureCapabilities({
    structuredTurns: true,
    readOnlySessions: true,
    resumeSessions: true,
  });
  const resources: RuntimeResource[] = ['first', 'pinned'].map((id) => ({
    id,
    backendId: 'synthetic',
    local: true,
    configurationRevision: id + '-v1',
    capabilities,
  }));
  const pool: ResourceSnapshot = {
    profileId: 'team',
    policy: 'local-only',
    coordinator: resources[0],
    worker: resources[0],
    reviewer: resources[0],
    workerPool: resources,
  };
  const role: Role = {
    id: 'coordinator',
    version: 1,
    title: 'Coordinator',
    description: 'A pinned research role',
    instructions: 'Keep the saved pin.',
    kind: 'general',
    provenance: { origin: 'user' },
    runtimePreference: { mode: 'fixed', runtimeId: 'pinned' },
    createdAt: 'now',
    updatedAt: 'now',
  };
  const decision = resolveRoleResource(pool, role, serviceOperationContext(operationIds.research));
  assert.equal(decision.resource.id, 'pinned');
  let resumes = 0;
  for (const resource of resources)
    registry.register({
      id: resource.id,
      capabilities,
      start: async () => ({ threadId: 'unused' }),
      resume: async ({ threadId }) => {
        resumes++;
        return { threadId };
      },
      turn: async () => {
        throw Error('An invalid route cannot start a model turn.');
      },
      submit: async () => ({ turnId: 'unused' }),
      interrupt: async () => {},
      release: async () => {},
      dispose: async () => {},
    });
  const routes = new FileRuntimeRoutes(path.join(directory, 'routes'));
  const researchId = 'research-owner';
  await routes.save({
    id: 'forged-route',
    projectId: 'p',
    runId: researchId,
    workspace: directory,
    resource: resources[0],
    requirements: { structuredTurns: true, readOnlySessions: true },
    readOnly: true,
    purpose: 'research',
    operationId: operationIds.research,
    externalThreadId: 'first-native-thread',
    status: 'ready',
  });
  const router = new RuntimeRouter({
    registry,
    resources,
    routes,
    projects: {
      get: () => ({
        snapshot: () => ({
          project: { id: 'p', name: 'P', root: directory },
          runs: [],
          roles: [role],
          research: { id: researchId, resources: pool, roleSnapshot: role, roleResource: decision },
        }),
      }),
    } as unknown as ProjectRegistry,
    selection: { forProject: () => structuredClone(pool) },
    id: () => 'unused',
  });
  t.after(async () => {
    await router.dispose();
    await registry.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    router.resume({
      projectId: 'p',
      runId: researchId,
      threadId: 'forged-route',
      workspace: directory,
      purpose: 'research',
      operationId: operationIds.research,
      readOnly: true,
      instructions: 'Do not move the saved research pin.',
    }),
    { code: 'INVALID_ASSIGNMENT' },
  );
  assert.equal(resumes, 0);
});
