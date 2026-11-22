import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveProjectPolicy,
  effectiveRunPolicy,
  projectRunAutonomy,
} from '../core/autonomy-policy.ts';
import { EffectivePolicySchema, RunStopSchema } from '../protocol/autonomy.ts';
import type { ProjectProfile, Role, Run } from '../protocol/domain.ts';
import type { AssignmentResource, RuntimeResource } from '../protocol/resources.ts';
import { createManagedRunBudget, managedBudgetSummary } from '../core/run-budget.ts';
import { DEFAULT_MANAGED_RUN_BUDGET_POLICY } from '../protocol/run-budget.ts';
import { sampleRun } from './fixtures/sample-run.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';

const managed: RuntimeResource = {
  id: 'local-model',
  backendId: 'managed',
  providerId: 'ollama',
  model: 'fixture',
  local: true,
  configurationRevision: 'model-v1',
  capabilities: fixtureCapabilities({ hostToolLifecycle: true, usage: 'reported' }),
};
const native: RuntimeResource = {
  id: 'native-instance',
  backendId: 'codex',
  local: false,
  configurationRevision: 'native-v1',
  capabilities: fixtureCapabilities(),
};
const profile: ProjectProfile = {
  version: 1,
  revision: 4,
  context: '',
  scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
  checks: [{ id: 'unit', title: 'Unit', command: 'node --test', timeoutMs: 10000 }],
  defaultCheckIds: ['unit'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 2,
  turnTimeoutMs: 10000,
};
const context = {
  goalExists: true,
  projectBusy: false,
  resumeSupported: true,
  startSupported: true,
  settingsSupported: true,
};
function run(): Run {
  return {
    ...sampleRun(),
    status: 'needs-attention',
    workspace: '/owned/workspace',
    baseCommit: 'a'.repeat(40),

    executionPolicySnapshot: {
      scope: structuredClone(profile.scope),
      checks: profile.checks,
      defaultCheckIds: ['unit'],
      maxWorkers: 2,
      turnTimeoutMs: 10000,
      profile: structuredClone(profile),
    },
    resources: {
      profileId: 'mixed',
      policy: 'hybrid',
      coordinator: managed,
      worker: managed,
      reviewer: native,
      workerPool: [managed, native],
    },
  };
}

test('policy projection freezes actual saved scope, source revision and finite managed limits without losing unknown coverage', () => {
  const saved = run();
  saved.managedBudget = managedBudgetSummary(
    createManagedRunBudget({
      projectId: 'p',
      ownerRunId: saved.id,
      coverage: 'managed-api',
      policy: { ...DEFAULT_MANAGED_RUN_BUDGET_POLICY, maxRequests: 12 },
    }),
  );
  const before = structuredClone(saved);
  const policy = EffectivePolicySchema.parse(effectiveRunPolicy(saved));
  assert.equal(policy.source, 'saved-run');
  assert.deepEqual(policy.origin, { kind: 'project-profile', revision: 4 });
  assert.equal(policy.usage.mode, 'managed');
  assert.equal(policy.usage.policy!.maxRequests, 12);
  assert.equal(policy.usage.coverage, 'partial');
  assert.deepEqual(saved, before);
  policy.files.plannedPaths.push('tests/');
  policy.usage.policy!.maxRequests = 100;
  assert.deepEqual(saved, before, 'Projection values cannot revise a saved grant or budget.');
  const current = effectiveProjectPolicy({
    policy: { ...saved.executionPolicySnapshot!, scope: { ...profile.scope, mode: 'strict' } },
    profile: { ...profile, revision: 5 },
    resources: saved.resources,
  });
  assert.equal(current.files.mode, 'strict');
  assert.equal(current.checks.intermediate, 'deferred');
  assert.equal(effectiveRunPolicy(saved)!.files.mode, 'advisory');
  assert.equal(effectiveRunPolicy(saved)!.origin.revision, 4);
});

test('actual common role decisions win over defaults and historical sessions without interpreting backend names', () => {
  const saved = run();
  const decision: AssignmentResource = {
    resource: native,
    roleVersion: 2,
    preference: { mode: 'fixed', runtimeId: native.id },
    source: 'fixed',
    reason: 'User choice',
  };
  saved.roleResources = { coordinator: decision };
  saved.coordinatorSession = {
    id: 'older',
    roleId: 'coordinator',
    roleVersion: 1,
    runtimeId: managed.id,
    configurationRevision: managed.configurationRevision,
  };
  assert.equal(
    effectiveRunPolicy(saved)!.routing.assignments.find((item) => item.roleId === 'coordinator')!
      .runtimeId,
    native.id,
  );
  const nativeNamedManaged = { ...native, id: 'managed', backendId: 'managed' as const };
  const resources = {
    profileId: 'native',
    policy: 'hybrid' as const,
    coordinator: nativeNamedManaged,
    worker: nativeNamedManaged,
    reviewer: nativeNamedManaged,
  };
  const policy = effectiveProjectPolicy({ policy: saved.executionPolicySnapshot!, resources });
  assert.equal(policy.usage.mode, 'unknown');
  assert.equal(policy.checks.intermediate, 'unavailable');
  assert.equal(policy.routing.assignments[0].tools, 'backend-managed');
  assert.equal(policy.routing.assignments[0].usage, 'unknown');
});

test('project policy resolves the current fixed role preference and reports an unavailable pin without a silent fallback', () => {
  const saved = run();
  const eligible = {
    ...managed,
    capabilities: fixtureCapabilities({
      structuredTurns: true,
      readOnlySessions: true,
      hostToolLifecycle: true,
      usage: 'reported',
    }),
  };
  const alternate = {
    ...eligible,
    id: 'alternate',
    model: 'alternate-model',
    configurationRevision: 'alternate-v1',
  };
  const resources = {
    ...saved.resources!,
    coordinator: eligible,
    worker: eligible,
    reviewer: eligible,
    workerPool: [eligible, alternate],
  };
  const role: Role = {
    provenance: { origin: 'user' },
    id: 'coordinator',
    version: 2,
    title: 'Coordinator',
    description: 'Plans work',
    instructions: 'Use actual evidence.',
    kind: 'coordination',
    createdAt: 'now',
    updatedAt: 'now',
    runtimePreference: { mode: 'fixed', runtimeId: alternate.id },
  };
  const selected = effectiveProjectPolicy({
    policy: saved.executionPolicySnapshot!,
    profile,
    resources,
    roles: [role],
  });
  assert.equal(
    selected.routing.assignments.find((item) => item.roleId === role.id)?.runtimeId,
    alternate.id,
  );
  const unavailable = EffectivePolicySchema.parse(
    effectiveProjectPolicy({
      policy: saved.executionPolicySnapshot!,
      profile,
      resources,
      roles: [{ ...role, runtimePreference: { mode: 'fixed', runtimeId: 'missing' } }],
    }),
  );
  assert.equal(
    unavailable.routing.assignments.some((item) => item.roleId === role.id),
    false,
  );
  assert.equal(unavailable.routing.unavailable?.[0].code, 'FIXED_RUNTIME_UNAVAILABLE');
  assert.match(unavailable.routing.unavailable![0].message, /missing/);
});

test('a dependency-repair run projects its actual strict dependency grant without rewriting saved settings', () => {
  const saved = run();
  saved.executionPolicySnapshot!.scope.mode = 'strict';
  saved.repairEnvironment = true;
  const before = structuredClone(saved.executionPolicySnapshot);
  const projected = effectiveRunPolicy(saved)!;
  assert.ok(projected.files.plannedPaths.includes('package.json'));
  assert.ok(projected.files.plannedPaths.includes('pnpm-lock.yaml'));
  assert.deepEqual(saved.executionPolicySnapshot, before);
  saved.repairEnvironment = false;
  assert.equal(effectiveRunPolicy(saved)!.files.plannedPaths.includes('package.json'), false);
});

test('unknown operation projections never offer execution or erase the original operation and saved history', () => {
  for (const pending of [false, true]) {
    const saved = run();
    if (pending)
      saved.pendingTurn = {
        version: 1,
        id: 'original-operation',
        threadId: 'original-session',
        runtimeId: 'local-model',
        startedAt: 'now',
      };
    else
      saved.reconciliation = {
        version: 1,
        status: 'required',
        code: 'ACTION_RECONCILIATION_REQUIRED',
        detectedAt: 'now',
        operationId: 'original-operation',
      };
    const before = structuredClone(saved);
    const stop = RunStopSchema.parse(projectRunAutonomy(saved, context).stop);
    assert.equal(stop.category, 'unknown');
    assert.equal(stop.automaticRecovery, 'requires-reconciliation');
    assert.deepEqual(stop.actions, ['edit-goal', 'project-settings']);
    assert.deepEqual(saved, before);
    assert.equal(RunStopSchema.safeParse({ ...stop, actions: ['repair'] }).success, false);
  }
});

test('service stop actions reflect capability, saved workspace and project capacity', () => {
  const saved = run();
  const capability = projectRunAutonomy(saved, {
    ...context,
    lastErrorCode: 'BACKEND_CAPABILITY_UNAVAILABLE',
  }).stop!;
  assert.equal(capability.category, 'capability');
  assert.deepEqual(capability.actions, ['edit-goal', 'new-run', 'project-settings']);
  const capacity = projectRunAutonomy(saved, {
    ...context,
    lastErrorCode: 'MODEL_RATE_LIMITED',
  }).stop!;
  assert.equal(capacity.category, 'capacity');
  assert.equal(capacity.automaticRecovery, 'not-scheduled');
  assert.ok(capacity.actions.includes('repair'));
  assert.ok(capacity.actions.includes('recheck'));
  assert.deepEqual(projectRunAutonomy(saved, { ...context, projectBusy: true }).stop!.actions, [
    'project-settings',
  ]);
  saved.workspace = undefined;
  assert.deepEqual(projectRunAutonomy(saved, context).stop!.actions, [
    'edit-goal',
    'new-run',
    'project-settings',
  ]);
  saved.status = 'running';
  assert.equal(projectRunAutonomy(saved, context).stop, undefined);
});

test('a coordinator question preserves its text and offers repair or recheck without a formal plan', () => {
  const saved = run();
  saved.plan = [];
  saved.planSavedAt = undefined;
  saved.roleSnapshots = [];
  saved.status = 'needs-attention';
  saved.issue = {
    code: 'OPERATOR_INPUT_REQUIRED',
    message: 'Which behavior should be preserved?',
    checks: [],
  };
  const stop = projectRunAutonomy(saved, context).stop!;
  assert.equal(stop.category, 'user-policy');
  assert.equal(stop.message, saved.issue.message);
  assert.ok(stop.actions.includes('repair'));
  assert.ok(stop.actions.includes('recheck'));
});

test('another unresolved run of the same goal blocks conflicting actions without fabricating an owning-run marker', () => {
  const saved = run();
  const before = structuredClone(saved);
  const stop = projectRunAutonomy(saved, {
    ...context,
    goalUnsettled: true,
    lastErrorCode: 'MODEL_RATE_LIMITED',
  }).stop!;
  assert.equal(stop.category, 'capacity');
  assert.equal(stop.code, 'MODEL_RATE_LIMITED');
  assert.deepEqual(stop.actions, ['edit-goal', 'project-settings']);
  assert.equal(
    stop.detail,
    'Another run of this goal has an unknown operation. Reconcile it before continuing.',
  );
  assert.deepEqual(saved, before);
});

test('a stopped managed budget retains exact counters and only offers a still usable review allowance', () => {
  const saved = run();
  saved.managedBudget = managedBudgetSummary(
    createManagedRunBudget({ projectId: 'p', ownerRunId: saved.id, coverage: 'managed-api' }),
  );
  saved.issue = {
    code: 'MANAGED_BUDGET_BLOCKED',
    budgetCode: 'RUN_BUDGET_EXHAUSTED',
    message: 'Limit reached',
    checks: [],
  };
  const before = structuredClone(saved.managedBudget);
  const stop = projectRunAutonomy(saved, context).stop!;
  assert.equal(stop.category, 'user-policy');
  assert.equal(stop.actions.includes('repair'), false);
  assert.equal(stop.actions.includes('recheck'), true);
  assert.deepEqual(saved.managedBudget, before);
  saved.managedBudget.status = 'exceeded';
  const blocked = projectRunAutonomy(saved, context).stop!;
  assert.equal(blocked.actions.includes('recheck'), false);
  assert.equal(blocked.actions.includes('repair'), false);
  assert.equal(blocked.actions.includes('new-run'), true);
});

test('an accounting integrity failure is not described as a built-in task quota', () => {
  const saved = run();
  saved.issue = {
    code: 'MANAGED_BUDGET_BLOCKED',
    budgetCode: 'RUN_BUDGET_USAGE_EXCEEDED',
    message: 'Provider exceeded its output reservation',
    checks: [],
  };
  const stop = projectRunAutonomy(saved, context).stop!;
  assert.equal(stop.category, 'configuration');
  assert.match(stop.message, /usage is inconsistent/);
  assert.doesNotMatch(stop.message, /limit/);
});
