import test from 'node:test';
import assert from 'node:assert/strict';
import type { Role } from '../protocol/domain.ts';
import type { RuntimeResource, ResourceSnapshot } from '../protocol/resources.ts';
import { sessionResource } from '../protocol/resources.ts';
import {
  roleResourcePool,
  resolveRoleResource,
  validateRoleResource,
  roleResourceEligibility,
  roleResourceContext,
} from '../core/role-routing.ts';
import { resolveWorkerResource } from '../core/assignment-resources.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';

const runtime = (
  id: string,
  mechanics: Parameters<typeof fixtureCapabilities>[0] = {},
): RuntimeResource => ({
  id,
  client: 'codex',
  model: id + '-model',
  configurationRevision: id + '-v1',
  local: true,
  capabilities: fixtureCapabilities({ structuredTurns: true, ...mechanics }),
});
const weak = runtime('small');
const strong = runtime('strong', {
  strictPlannedWrites: true,
  readOnlySessions: true,
  immutableReview: true,
});
const reviewer = runtime('review-native', { readOnlySessions: true, immutableReview: true });
const snapshot = (): ResourceSnapshot => ({
  profileId: 'team',
  policy: 'local-only',
  coordinator: weak,
  worker: weak,
  reviewer,
  workerPool: [weak, strong],
});
const role = (id = 'builder', preference: Role['runtimePreference'] = { mode: 'auto' }): Role => ({
  id,
  version: 2,
  title: id,
  description: 'Role',
  instructions: 'Task',
  kind: 'general',
  runtimePreference: preference,
  createdAt: 'now',
  updatedAt: 'now',
});

test('role pool is the unique complete saved profile union and cannot create outside connections', () => {
  const saved = snapshot();
  assert.deepEqual(
    roleResourcePool(saved).map((r) => r.id),
    ['small', 'review-native', 'strong'],
  );
  delete saved.workerPool;
  assert.deepEqual(
    roleResourcePool(saved).map((r) => r.id),
    ['small', 'review-native'],
  );
  assert.throws(
    () =>
      resolveRoleResource(saved, role(), {
        purpose: 'coordination',
        proposal: { runtimeId: 'outside' },
      }),
    { code: 'RUNTIME_NOT_ALLOWED' },
  );
  const divergent = snapshot();
  divergent.coordinator = { ...weak, configurationRevision: 'another' };
  assert.throws(() => roleResourcePool(divergent), { code: 'INVALID_RESOURCE_POOL' });
  const remote = snapshot();
  remote.reviewer = { ...reviewer, local: false };
  assert.throws(() => roleResourcePool(remote), { code: 'DATA_POLICY_BLOCKED' });
});

test('auto uses profile defaults when eligible and records an automatic authorized alternative when mechanics require it', () => {
  const saved = snapshot();
  const normal = resolveRoleResource(saved, role(), {
    purpose: 'implementation',
    requirements: { structuredTurns: true },
  });
  assert.equal(normal.resource.id, weak.id);
  assert.equal(normal.source, 'profile');
  const strict = resolveRoleResource(saved, role(), {
    purpose: 'implementation',
    requirements: { structuredTurns: true, strictPlannedWrites: true },
  });
  assert.equal(strict.resource.id, strong.id);
  assert.equal(strict.source, 'automatic');
  assert.match(strict.reason, /automatically selected/);
  assert.deepEqual(
    validateRoleResource(saved, role(), strict, {
      purpose: 'implementation',
      requirements: { structuredTurns: true, strictPlannedWrites: true },
    }),
    strict,
  );
  assert.equal(
    resolveWorkerResource(saved, role(), {}, { strictPlannedWrites: true }).resource.id,
    strong.id,
  );
});

test('prefer may choose an eligible alternative with a reason while fixed ineligible or absent never falls back', () => {
  const saved = snapshot();
  const context = {
    purpose: 'implementation' as const,
    requirements: { strictPlannedWrites: true as const },
  };
  const preferred = resolveRoleResource(
    saved,
    role('builder', { mode: 'prefer', runtimeId: weak.id }),
    context,
  );
  assert.equal(preferred.resource.id, strong.id);
  assert.equal(preferred.source, 'automatic');
  assert.match(preferred.reason, /Preferred runtime small is unavailable/);
  for (const id of [weak.id, 'outside'])
    assert.throws(
      () => resolveRoleResource(saved, role('builder', { mode: 'fixed', runtimeId: id }), context),
      { code: 'FIXED_RUNTIME_UNAVAILABLE' },
    );
  assert.throws(
    () =>
      resolveRoleResource(saved, role('builder', { mode: 'prefer', runtimeId: reviewer.id }), {
        purpose: 'implementation',
        proposal: { runtimeId: strong.id },
      }),
    { code: 'RUNTIME_REASON_REQUIRED' },
  );
});

test('an explicitly proposed ineligible worker is rejected for plan correction before assignment acceptance', () => {
  assert.throws(
    () =>
      resolveWorkerResource(
        snapshot(),
        role(),
        { runtimeId: weak.id, runtimeReason: 'Try the small model' },
        { strictPlannedWrites: true },
      ),
    { code: 'BACKEND_CAPABILITY_UNAVAILABLE' },
  );
  assert.equal(
    resolveWorkerResource(
      snapshot(),
      role(),
      { runtimeId: strong.id, runtimeReason: 'Supports strict edits' },
      { strictPlannedWrites: true },
    ).resource.id,
    strong.id,
  );
});

test('coordinator and reviewer preferences route independently by actual operation requirements without role-kind inference', () => {
  const saved = snapshot();
  const coordinator = resolveRoleResource(
    saved,
    role('coordinator', { mode: 'fixed', runtimeId: strong.id }),
    roleResourceContext('coordinator', true),
  );
  const review = resolveRoleResource(
    saved,
    role('reviewer', { mode: 'fixed', runtimeId: reviewer.id }),
    roleResourceContext('reviewer', true),
  );
  assert.equal(coordinator.resource.id, strong.id);
  assert.equal(review.resource.id, reviewer.id);
  assert.equal(roleResourceContext('custom-review-description', false).purpose, 'implementation');
  for (const id of ['local_preview', 'delivery_pr', 'production_delivery'])
    assert.deepEqual(roleResourceContext(id, true), {
      purpose: 'delivery',
      requirements: { structuredTurns: true, readOnlySessions: true },
    });
  assert.equal(
    sessionResource(saved, 'coordination', 'fallback', coordinator).runtimeId,
    strong.id,
  );
  assert.deepEqual(sessionResource(saved, 'coordination', 'fallback', coordinator).selection, {
    source: 'fixed',
    reason: coordinator.reason,
  });
});

test('eligibility reasons and decisions depend on mechanics instead of the client label', () => {
  const saved = snapshot();
  saved.worker = { ...weak, client: 'managed' };
  saved.coordinator = saved.worker;
  saved.workerPool = [saved.worker, strong];
  const choices = roleResourceEligibility(saved, { immutableReview: true, readOnlySessions: true });
  assert.equal(choices.find((c) => c.resource.id === weak.id)?.eligible, false);
  assert.match(choices.find((c) => c.resource.id === weak.id)!.reason, /read-only|isolated source/);
  assert.equal(choices.find((c) => c.resource.id === reviewer.id)?.eligible, true);
  const decision = resolveRoleResource(saved, role(), {
    purpose: 'implementation',
    requirements: { strictPlannedWrites: true },
  });
  assert.equal(decision.resource.id, strong.id);
  const altered = structuredClone(decision);
  altered.resource.capabilities.revision = 'forged';
  assert.throws(
    () =>
      validateRoleResource(saved, role(), altered, {
        purpose: 'implementation',
        requirements: { strictPlannedWrites: true },
      }),
    { code: 'INVALID_ASSIGNMENT' },
  );
  assert.throws(
    () =>
      validateRoleResource(saved, { ...role(), version: 3 }, decision, {
        purpose: 'implementation',
        requirements: { strictPlannedWrites: true },
      }),
    { code: 'INVALID_ASSIGNMENT' },
  );
});

test('coordination supports either tools-free planning or read-only inspection without requiring both', () => {
  const saved = snapshot();
  const toolsFree = runtime('tools-free', { toolsFreeTurns: true, readOnlySessions: false });
  saved.coordinator = toolsFree;
  const selected = resolveRoleResource(
    saved,
    role('coordinator'),
    roleResourceContext('coordinator', false),
  );
  assert.equal(selected.resource.id, toolsFree.id);
  const unsupported = runtime('unsupported');
  saved.coordinator = unsupported;
  assert.equal(
    roleResourceEligibility(saved, { structuredTurns: true }, 'coordination').find(
      (choice) => choice.resource.id === unsupported.id,
    )!.eligible,
    false,
  );
  assert.throws(
    () =>
      resolveRoleResource(
        saved,
        role('coordinator', { mode: 'fixed', runtimeId: unsupported.id }),
        roleResourceContext('coordinator', false),
      ),
    { code: 'FIXED_RUNTIME_UNAVAILABLE' },
  );
});
