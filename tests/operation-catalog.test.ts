import test from 'node:test';
import assert from 'node:assert/strict';
import {
  operationIds,
  projectOperationCatalog,
  projectRoleResourceChoices,
  serviceOperationContext,
  OperationCatalog,
} from '../core/operation-catalog.ts';
import { resolveRoleResource } from '../core/role-routing.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import type { ProjectProfile, Role } from '../protocol/domain.ts';
import type { ResourceSnapshot, RuntimeResource } from '../protocol/resources.ts';

const role = (id: string): Role => ({
  id,
  version: 1,
  title: id,
  description: 'Any descriptive text',
  instructions: 'Instructions',
  kind: 'general',
  createdAt: 'now',
  updatedAt: 'now',
});
const resource = (id: string, readOnly: boolean): RuntimeResource => ({
  id,
  backendId: 'arbitrary-backend',
  local: true,
  configurationRevision: id + '-v1',
  capabilities: fixtureCapabilities({
    structuredTurns: true,
    toolsFreeTurns: !readOnly,
    readOnlySessions: readOnly,
    immutableReview: readOnly,
    strictPlannedWrites: !readOnly,
  }),
});
const resources = (): ResourceSnapshot => {
  const writer = resource('writer', false),
    inspector = resource('inspector', true);
  return {
    profileId: 'team',
    policy: 'local-only',
    coordinator: writer,
    worker: writer,
    reviewer: inspector,
    workerPool: [writer, inspector],
  };
};
const profile = () =>
  ({
    scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: [] },
    delivery: {
      remote: 'origin',
      pullRequests: true,
      environments: [
        {
          id: 'staging',
          name: 'Staging',
          enabled: true,
          command: 'deploy',
          url: '',
          requireConfirmation: false,
          roleId: 'builder',
        },
      ],
    },
  }) as ProjectProfile;

test('the same role has independent implementation and configured deployment eligibility', () => {
  const rows = projectRoleResourceChoices({
    profile: profile(),
    roles: [role('builder')],
    resources: resources(),
  });
  const builder = rows.filter((row) => row.roleId === 'builder');
  assert.deepEqual(
    builder.map((row) => row.operationId),
    [operationIds.deploy('staging'), operationIds.implementation],
  );
  const implementation = builder.find((row) => row.operationId === operationIds.implementation)!;
  const deployment = builder.find((row) => row.operationId === operationIds.deploy('staging'))!;
  assert.equal(
    implementation.choices.find((choice) => choice.resource.id === 'writer')!.eligible,
    true,
  );
  assert.equal(
    implementation.choices.find((choice) => choice.resource.id === 'inspector')!.eligible,
    false,
  );
  assert.equal(
    deployment.choices.find((choice) => choice.resource.id === 'writer')!.eligible,
    false,
  );
  assert.equal(
    deployment.choices.find((choice) => choice.resource.id === 'inspector')!.eligible,
    true,
  );
  assert.equal(
    new Set(rows.map((row) => JSON.stringify([row.operationId, row.roleId]))).size,
    rows.length,
  );
});

test('role kinds, names and backend labels do not invent operational contexts', () => {
  const sample = role('builder');
  sample.kind = 'testing';
  sample.title = 'Reviewer';
  const snapshot = resources();
  const actual = projectRoleResourceChoices({
    profile: profile(),
    roles: [sample],
    resources: snapshot,
  });
  const renamed = structuredClone(snapshot);
  for (const item of [
    renamed.coordinator,
    renamed.worker,
    renamed.reviewer,
    ...renamed.workerPool!,
  ])
    item.backendId = 'codex';
  const same = projectRoleResourceChoices({
    profile: profile(),
    roles: [{ ...sample, kind: 'implementation', title: 'Worker' } as Role],
    resources: renamed,
  });
  assert.deepEqual(
    actual.map(({ operationId, roleId, purpose, requirements, choices }) => ({
      operationId,
      roleId,
      purpose,
      requirements,
      eligible: choices.map(({ eligible }) => eligible),
    })),
    same.map(({ operationId, roleId, purpose, requirements, choices }) => ({
      operationId,
      roleId,
      purpose,
      requirements,
      eligible: choices.map(({ eligible }) => eligible),
    })),
  );
  assert.equal(
    actual.some((row) => row.roleId === 'builder' && row.operationId === operationIds.review),
    false,
  );
});

test('coordinator and reviewer names can serve configured delivery without acquiring workflow authority', () => {
  const configured = profile();
  configured.delivery!.environments[0].roleId = 'coordinator';
  const selected = resources(),
    teamRole = role('coordinator');
  const coordination = resolveRoleResource(
    selected,
    teamRole,
    serviceOperationContext(operationIds.coordination, configured),
  );
  const delivery = resolveRoleResource(
    selected,
    teamRole,
    serviceOperationContext(operationIds.deploy('staging'), configured),
  );
  assert.equal(coordination.resource.id, 'writer');
  assert.equal(delivery.resource.id, 'inspector');
  const rows = projectRoleResourceChoices({
    profile: configured,
    roles: [teamRole],
    resources: selected,
  });
  assert.equal(rows.filter((row) => row.roleId === 'coordinator').length, 2);
});

test('service operations are captured, explicit and unavailable IDs do not fall back by role or purpose', () => {
  const operation = serviceOperationContext(operationIds.preview);
  const input = structuredClone(operation);
  const catalog = new OperationCatalog([input]);
  input.roles = { kind: 'fixed', roleId: 'changed' };
  input.requirements.readOnlySessions = undefined;
  assert.deepEqual(catalog.get(operationIds.preview).roles, {
    kind: 'fixed',
    roleId: 'local_preview',
  });
  assert.equal(catalog.get(operationIds.preview).requirements.readOnlySessions, true);
  assert.throws(() => catalog.get('local_preview'), { code: 'OPERATION_UNAVAILABLE' });
  assert.throws(() => projectOperationCatalog(profile()).get(operationIds.deploy('unknown')), {
    code: 'OPERATION_UNAVAILABLE',
  });
  assert.throws(() => new OperationCatalog([operation, operation]), { code: 'OPERATION_EXISTS' });
});
