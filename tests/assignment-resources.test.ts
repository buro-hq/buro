import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkerResource, workerResourcePool } from '../core/assignment-resources.ts';
import { validateAssignmentResource } from '../core/assignment-routing.ts';
import { ResourceSelection } from '../core/resource-selection.ts';
import { RoleService } from '../core/services.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import {
  ResourceConfigurationSchema,
  defaultResources,
} from '../adapters/files/resource-configuration.ts';
import {
  ResourceProfileSchema,
  ResourceSnapshotSchema,
  type ResourceProfile,
  type ResourceSnapshot,
  type RuntimeResource,
} from '../protocol/resources.ts';
import { RoleInputSchema } from '../protocol/schema.ts';
import { TeamPlanSchema, teamOutputSchema } from '../protocol/execution.ts';
import type { Role } from '../protocol/domain.ts';
import type { ProjectRegistry } from '../core/ports.ts';

const local: RuntimeResource = {
  capabilities: fixtureCapabilities({ structuredTurns: true }),
  id: 'small',
  backendId: 'managed',
  providerId: 'ollama',
  model: 'small-model',
  configurationRevision: 'local-v1',
  local: true,
};
const cloud: RuntimeResource = {
  capabilities: fixtureCapabilities({ structuredTurns: true }),
  id: 'reasoner',
  backendId: 'managed',
  providerId: 'deepseek',
  model: 'reasoner-model',
  configurationRevision: 'cloud-v1',
  local: false,
};
const snapshot = (): ResourceSnapshot => ({
  profileId: 'team',
  policy: 'hybrid',
  coordinator: cloud,
  worker: local,
  reviewer: cloud,
  workerPool: [local, cloud],
});
const role = (extra: Partial<Role> = {}): Role => ({
  id: 'builder',
  version: 3,
  title: 'Builder',
  description: 'Implements changes',
  instructions: 'Stay within the assignment',
  kind: 'implementation',
  createdAt: 'now',
  updatedAt: 'now',
  ...extra,
});

test('the full frozen profile union authorizes role choices without client-name or legacy model-string selection', () => {
  const saved = snapshot();
  delete saved.workerPool;
  assert.deepEqual(workerResourcePool(saved), [cloud, local]);
  assert.equal(resolveWorkerResource(saved, role({ model: cloud.model })).resource.id, local.id);
  assert.equal(resolveWorkerResource(saved, role(), { runtimeId: cloud.id }).resource.id, cloud.id);
  assert.throws(() => resolveWorkerResource(saved, role(), { runtimeId: 'unlisted' }), {
    code: 'RUNTIME_NOT_ALLOWED',
  });
});

test('auto proposals resolve to canonical frozen resources and cannot mutate their source snapshot', () => {
  const saved = snapshot();
  const assigned = resolveWorkerResource(saved, role(), {
    runtimeId: cloud.id,
    runtimeReason: 'Complex integration needs the reasoner.',
  });
  assert.deepEqual(assigned, {
    resource: cloud,
    roleVersion: 3,
    preference: { mode: 'auto' },
    source: 'coordinator',
    reason: 'Complex integration needs the reasoner.',
  });
  assigned.resource.model = 'changed';
  assert.equal(saved.workerPool![1].model, cloud.model);
  assert.equal(resolveWorkerResource(saved, role(), { runtimeId: null }).source, 'profile');
  assert.throws(() => resolveWorkerResource(saved, role(), { runtimeId: 'unlisted' }), {
    code: 'RUNTIME_NOT_ALLOWED',
  });
});

test('a saved assignment cannot replace the capabilities of its frozen resource', () => {
  const saved = snapshot();
  const decision = resolveWorkerResource(saved, role());
  assert.equal(validateAssignmentResource(saved, role(), decision).resource.id, local.id);
  decision.resource.capabilities = { ...decision.resource.capabilities, readOnlySessions: true };
  assert.throws(() => validateAssignmentResource(saved, role(), decision), {
    code: 'INVALID_ASSIGNMENT',
  });
});

test('fixed worker preferences reject conflicting or unavailable proposals without fallback', () => {
  const pinned = role({ runtimePreference: { mode: 'fixed', runtimeId: cloud.id } });
  assert.equal(resolveWorkerResource(snapshot(), pinned).source, 'fixed');
  assert.equal(
    resolveWorkerResource(snapshot(), pinned, { runtimeId: cloud.id }).resource.id,
    cloud.id,
  );
  assert.throws(() => resolveWorkerResource(snapshot(), pinned, { runtimeId: local.id }), {
    code: 'ROLE_RUNTIME_FIXED',
  });
  const saved = snapshot();
  delete saved.workerPool;
  saved.coordinator = local;
  saved.reviewer = local;
  assert.throws(() => resolveWorkerResource(saved, pinned), { code: 'FIXED_RUNTIME_UNAVAILABLE' });
});

test('preferred workers are the default; overrides require a reason and missing preferences fall back explicitly', () => {
  const preferred = role({ runtimePreference: { mode: 'prefer', runtimeId: cloud.id } });
  assert.equal(resolveWorkerResource(snapshot(), preferred).source, 'preferred');
  assert.throws(
    () =>
      resolveWorkerResource(snapshot(), preferred, { runtimeId: local.id, runtimeReason: '  ' }),
    { code: 'RUNTIME_REASON_REQUIRED' },
  );
  const overridden = resolveWorkerResource(snapshot(), preferred, {
    runtimeId: local.id,
    runtimeReason: 'A focused local edit.',
  });
  assert.equal(overridden.source, 'coordinator');
  assert.equal(overridden.resource.id, local.id);
  const saved = snapshot();
  delete saved.workerPool;
  saved.coordinator = local;
  saved.reviewer = local;
  const fallback = resolveWorkerResource(saved, preferred);
  assert.equal(fallback.resource.id, local.id);
  assert.equal(fallback.source, 'profile');
  assert.match(fallback.reason, /outside the saved profile pool/);
});

test('frozen pools reject duplicate, divergent and remote local-only entries', () => {
  for (const saved of [
    { ...snapshot(), workerPool: [local, local] },
    { ...snapshot(), workerPool: [cloud] },
    { ...snapshot(), workerPool: [{ ...local, configurationRevision: 'changed' }] },
    { ...snapshot(), policy: 'local-only' as const },
  ])
    assert.throws(() => workerResourcePool(saved));
  const saved = {
    ...snapshot(),
    policy: 'local-only' as const,
    coordinator: local,
    reviewer: local,
    workerPool: [local],
  };
  assert.equal(resolveWorkerResource(saved, role()).resource.id, local.id);
});

test('profiles validate pool bounds and references; selection freezes all candidates and enforces local-only before dispatch', () => {
  const profile = {
    id: 'team',
    name: 'Team',
    policy: 'hybrid' as const,
    coordinator: local.id,
    worker: local.id,
    reviewer: local.id,
    workerPool: [local.id, cloud.id],
  };
  for (const workerPool of [
    [],
    [local.id, local.id],
    [cloud.id],
    Array.from({ length: 17 }, (_, i) => (i ? 'worker-' + i : local.id)),
  ])
    assert.equal(ResourceProfileSchema.safeParse({ ...profile, workerPool }).success, false);
  const configuration = defaultResources();
  assert.equal(
    ResourceConfigurationSchema.safeParse({
      ...configuration,
      profiles: [{ ...configuration.profiles[0], workerPool: ['codex', 'missing'] }],
    }).success,
    false,
  );
  const projects = {
    get: () => ({ snapshot: () => ({ profile: {} }) }),
  } as unknown as ProjectRegistry;
  const runtimes = structuredClone([local, cloud]);
  const profiles: ResourceProfile[] = [structuredClone(profile)];
  const selection = new ResourceSelection({
    projects,
    profiles,
    runtimes,
    defaultProfile: () => profile.id,
  });
  const frozen = selection.forProject('p');
  runtimes[1].model = 'new-model';
  assert.equal(frozen.workerPool![1].model, cloud.model);
  profiles[0].policy = 'local-only';
  assert.throws(() => selection.forProject('p'), { code: 'DATA_POLICY_BLOCKED' });
  assert.equal(ResourceSnapshotSchema.parse(frozen).workerPool?.length, 2);
});

test('legacy plans remain valid while native model output requires explicit automatic selection and a reason field', () => {
  const worker = {
    roleId: 'builder',
    action: 'reuse',
    title: '',
    description: '',
    instructions: '',
    kind: 'implementation',
    paths: ['src/'],
  };
  assert.equal(
    TeamPlanSchema.parse({
      summary: 'Plan',
      steps: [
        { step: 'Implement', owner: 'builder' },
        { step: 'Review', owner: 'reviewer' },
      ],
      team: [worker],
    }).team[0].runtimeId,
    undefined,
  );
  const item = (teamOutputSchema as any).properties.team.items;
  assert.ok(item.required.includes('runtimeId'));
  assert.ok(item.required.includes('runtimeReason'));
  assert.ok(JSON.stringify(item.properties.runtimeId).includes('null'));
});

test('role edits preserve saved preferences, explicit auto clears them, and service roles accept the same choices', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assignment-role-'));
  const store = await FileProjectStore.open({
    directory,
    project: { id: 'p', name: 'Roles', root: directory },
    roles: [],
  });
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const service = new RoleService({
    projects: new ProjectStoreRegistry([store]),
    now: () => 'now',
    id: () => 'id',
  });
  const input = RoleInputSchema.parse({
    projectId: 'p',
    id: 'builder',
    title: 'Builder',
    description: 'Builds',
    instructions: 'Follow scope',
    kind: 'implementation',
    expectedVersion: 0,
    runtimePreference: { mode: 'fixed', runtimeId: cloud.id },
  });
  await service.save('create', 'create', input);
  const { runtimePreference, ...legacy } = input;
  await service.save('legacy', 'legacy', { ...legacy, expectedVersion: 1, title: 'Updated' });
  assert.deepEqual(store.snapshot().roles[0].runtimePreference, runtimePreference);
  await service.save('auto', 'auto', {
    ...legacy,
    expectedVersion: 2,
    runtimePreference: { mode: 'auto' },
  });
  assert.deepEqual(store.snapshot().roles[0].runtimePreference, { mode: 'auto' });
  for (const id of [
    'coordinator',
    'reviewer',
    'local_preview',
    'delivery_pr',
    'production_delivery',
  ])
    assert.deepEqual(
      (await service.save('pin-' + id, 'pin-' + id, { ...input, id })).runtimePreference,
      input.runtimePreference,
    );
  await store.close();
  const restored = await FileProjectStore.open({
    directory,
    project: { id: 'p', name: 'Roles', root: directory },
  });
  t.after(() => restored.close());
  assert.deepEqual(restored.snapshot().roles[0].runtimePreference, { mode: 'auto' });
});
