import type { ExecutionPolicyView, ProjectProfile, Role, Run } from '../protocol/domain.ts';
import type { EffectivePolicy, RunStop, RunStopAction } from '../protocol/autonomy.ts';
import type { RuntimeResource, ResourceSnapshot } from '../protocol/resources.ts';
import { DEFAULT_MANAGED_RUN_BUDGET_POLICY } from '../protocol/run-budget.ts';
import { resolveRoleResource } from './role-routing.ts';
import {
  operationIds,
  projectOperationCatalog,
  savedOperationContext,
  type ServiceOperation,
} from './operation-catalog.ts';
import { DomainError } from './ports.ts';
import { withEnvironmentRepair } from './environment-repair.ts';

type PolicyInput = {
  policy: ExecutionPolicyView;
  profile?: ProjectProfile;
  resources?: ResourceSnapshot;
  roles?: Role[];
};
const resourcesOf = (resources?: ResourceSnapshot) =>
  resources
    ? [resources.coordinator, resources.worker, resources.reviewer, ...(resources.workerPool || [])]
    : [];
const assignment = (
  roleId: string,
  resource: RuntimeResource,
  operation?: ServiceOperation,
): EffectivePolicy['routing']['assignments'][number] => ({
  roleId,
  ...(operation ? { operationId: operation.id, operationLabel: operation.label } : {}),
  runtimeId: resource.id,
  ...(resource.providerId ? { providerId: resource.providerId } : {}),
  ...(resource.model ? { model: resource.model } : {}),
  configurationRevision: resource.configurationRevision,
  capabilityRevision: resource.capabilities.revision,
  tools: resource.capabilities.hostToolLifecycle ? 'host-managed' : 'backend-managed',
  usage: resource.capabilities.usage,
});

function effectivePolicy(input: PolicyInput, run?: Run): EffectivePolicy {
  const { policy, profile, resources } = input;
  const assignments = new Map<string, EffectivePolicy['routing']['assignments'][number]>();
  const boundProfile =
    profile && run?.delivery?.config ? { ...profile, delivery: run.delivery.config } : profile;
  const operations = projectOperationCatalog(boundProfile, policy.scope.mode === 'strict');
  const key = (operationId: string, roleId: string) => JSON.stringify([operationId, roleId]);
  const add = (operationId: string, roleId: string, resource: RuntimeResource) => {
    const operation = savedOperationContext(run, operationId) || operations.get(operationId);
    assignments.set(key(operationId, roleId), assignment(roleId, resource, operation));
  };
  if (resources) {
    add(operationIds.coordination, 'coordinator', resources.coordinator);
    add(operationIds.implementation, 'worker', resources.worker);
    add(operationIds.review, 'reviewer', resources.reviewer);
  }
  const unavailable: NonNullable<EffectivePolicy['routing']['unavailable']> = [];
  if (resources && !run) {
    for (const operation of operations.list()) {
      if (operation.roles.kind !== 'fixed') continue;
      const roleId = operation.roles.roleId;
      const role = input.roles?.find((role) => role.id === roleId);
      if (!role) continue;
      try {
        const decision = resolveRoleResource(resources, role, operation);
        add(operation.id, role.id, decision.resource);
      } catch (error) {
        assignments.delete(key(operation.id, role.id));
        unavailable.push({
          roleId: role.id,
          operationId: operation.id,
          operationLabel: operation.label,
          code: error instanceof DomainError ? error.code : 'POLICY_PROJECTION_UNAVAILABLE',
          message:
            error instanceof DomainError
              ? error.message
              : 'The service could not resolve this operation’s model selection.',
        });
      }
    }
  }
  for (const [roleId, decision] of Object.entries(run?.assignmentResources || {}))
    add(operationIds.implementation, roleId, decision.resource);
  for (const [roleId, operationId] of [
    ['coordinator', operationIds.coordination],
    ['reviewer', operationIds.review],
  ]) {
    const decision = run?.roleResources?.[roleId];
    if (decision) add(operationId, roleId, decision.resource);
  }
  for (const [operationId, roles] of Object.entries(run?.operationResources || {}))
    for (const [roleId, decision] of Object.entries(roles))
      add(operationId, roleId, decision.resource);
  for (const session of [
    run?.coordinatorSession,
    ...(run?.agents || []).map((agent) => agent.session),
  ]) {
    if (!session) continue;
    const operationId =
      session === run?.coordinatorSession ? operationIds.coordination : operationIds.implementation;
    if (assignments.has(key(operationId, session.roleId))) continue;
    const resource = resourcesOf(resources).find(
      (item) =>
        item.id === session.runtimeId &&
        item.configurationRevision === session.configurationRevision,
    );
    if (resource) add(operationId, session.roleId, resource);
  }
  const all = [...assignments.values()];
  const observed = run?.managedBudget;
  const managed =
    observed !== undefined ||
    resourcesOf(resources).some((resource) => resource.capabilities.hostToolLifecycle);
  const hasUnknownBackend = all.some((item) => item.usage === 'unknown');
  const unknownRequests = observed?.observed.unknownUsageRequests || 0;
  const workerResources =
    run?.assignmentResources && Object.keys(run.assignmentResources).length
      ? Object.values(run.assignmentResources).map((decision) => decision.resource)
      : resources?.workerPool || (resources ? [resources.worker] : []);
  const intermediate =
    policy.scope.mode === 'strict'
      ? 'deferred'
      : workerResources.some((resource) => resource.capabilities.hostToolLifecycle)
        ? 'available'
        : 'unavailable';
  return {
    version: 1,
    source: run ? 'saved-run' : 'project',
    origin: profile
      ? { kind: 'project-profile', revision: profile.revision }
      : { kind: 'service-settings' },
    files: structuredClone(policy.scope),
    routing: {
      dataPolicy: resources?.policy || 'unknown',
      ...(resources ? { profileId: resources.profileId } : {}),
      assignments: all,
      ...(unavailable.length ? { unavailable } : {}),
    },
    checks: {
      source: 'immutable-snapshot',
      intermediate,
      checkIds: [...(run?.checkIds || policy.defaultCheckIds)],
    },
    usage: managed
      ? {
          mode: 'bounded-managed',
          origin: run
            ? 'saved-run'
            : profile?.managedBudget
              ? 'project-profile'
              : 'service-default',
          policy: structuredClone(
            observed?.policy || profile?.managedBudget || DEFAULT_MANAGED_RUN_BUDGET_POLICY,
          ),
          coverage: hasUnknownBackend || unknownRequests ? 'partial' : 'managed-api',
          ...(observed ? { unknownUsageRequests: unknownRequests } : {}),
        }
      : { mode: 'unknown', origin: run ? 'saved-run' : 'service-default', coverage: 'unknown' },
  };
}

export function effectiveProjectPolicy(input: PolicyInput): EffectivePolicy {
  return effectivePolicy(input);
}

export function effectiveRunPolicy(run: Run): EffectivePolicy | undefined {
  const policy =
    run.executionPolicySnapshot &&
    withEnvironmentRepair(run.executionPolicySnapshot, !!run.repairEnvironment);
  return policy
    ? effectivePolicy({ policy, profile: policy.profile, resources: run.resources }, run)
    : undefined;
}

export type RunAutonomyContext = {
  goalExists: boolean;
  projectBusy: boolean;
  resumeSupported: boolean;
  startSupported: boolean;
  settingsSupported: boolean;
  goalUnsettled?: boolean;
  lastErrorCode?: string;
};
const capabilityCodes = new Set([
  'BACKEND_CAPABILITY_UNAVAILABLE',
  'BACKEND_CAPABILITIES_CHANGED',
  'TOOL_POLICY_UNSUPPORTED',
  'TURN_UNSUPPORTED',
  'RESUME_UNSUPPORTED',
  'VERIFICATION_UNAVAILABLE',
  'PLANNING_UNSUPPORTED',
  'FIXED_RUNTIME_UNAVAILABLE',
]);
const capacityCodes = new Set([
  'MODEL_RATE_LIMITED',
  'MODEL_UNAVAILABLE',
  'MODEL_CONTEXT_EXHAUSTED',
  'MODEL_INCOMPLETE',
  'SESSION_BUSY',
]);
const budgetCodes = new Set([
  'RUN_BUDGET_EXHAUSTED',
  'RUN_BUDGET_RESERVE_UNAVAILABLE',
  'RUN_BUDGET_USAGE_EXCEEDED',
  'INVALID_RUN_BUDGET',
  'MODEL_BUDGET_EXHAUSTED',
  'TOOL_BUDGET_EXHAUSTED',
]);
const configurationCodes = new Set([
  'MODEL_AUTH_FAILED',
  'MODEL_AUTH_REQUIRED',
  'MODEL_BILLING_BLOCKED',
  'MODEL_NOT_FOUND',
  'RUNTIME_CONFIG_CHANGED',
  'EXECUTION_ACTIONS_CHANGED',
  'EXECUTION_ACTIONS_EMPTY',
  'TOOL_CONFIGURATION_CHANGED',
  'TOOL_CONTRIBUTION_CHANGED',
  'INVALID_TOOL_BROKER',
  'RUNTIME_UNAVAILABLE',
  'RESOURCE_PROFILE_UNAVAILABLE',
  'ENVIRONMENT_UNAVAILABLE',
  'VERIFICATION_VIEW_UNAVAILABLE',
  'SESSION_MISMATCH',
  'DATA_POLICY_BLOCKED',
  'INVALID_PLANNING_POLICY',
  'RESOURCE_PROFILE_REQUIRED',
]);
const unknownCodes = new Set([
  'RECONCILIATION_REQUIRED',
  'RUN_RECONCILIATION_REQUIRED',
  'SESSION_RECONCILIATION_REQUIRED',
  'GENERATION_RECONCILIATION_REQUIRED',
  'ACTION_RECONCILIATION_REQUIRED',
  'WORKER_CHECK_RECONCILIATION_REQUIRED',
  'WORKSPACE_CHECKPOINT_RECONCILIATION_REQUIRED',
]);

function stopForRun(run: Run, context: RunAutonomyContext): RunStop | undefined {
  if (!run.status || !['failed', 'interrupted', 'needs-attention'].includes(run.status))
    return undefined;
  const uncertain = !!(run.reconciliation || run.pendingTurn);
  const previousCode = run.stop?.code;
  const code =
    run.reconciliation?.code ||
    (run.pendingTurn ? 'RUN_RECONCILIATION_REQUIRED' : undefined) ||
    context.lastErrorCode ||
    previousCode ||
    run.issue?.budgetCode ||
    (run.issue?.code !== 'EXECUTION_FAILED' ? run.issue?.code : undefined) ||
    (run.status === 'interrupted' ? 'USER_INTERRUPTED' : 'EXECUTION_FAILED');
  let category: RunStop['category'] = 'configuration';
  let message = 'Work stopped. The saved history and available workspace are preserved.';
  if (uncertain || unknownCodes.has(code)) {
    category = 'unknown';
    message =
      'An earlier operation has an unknown outcome. Work is preserved; execution cannot continue until it is reconciled.';
  } else if (budgetCodes.has(code) || run.issue?.code === 'MANAGED_BUDGET_BLOCKED') {
    category = 'user-policy';
    message =
      'This run reached a configured or built-in usage limit. Its existing usage and work are preserved.';
  } else if (capabilityCodes.has(code)) {
    category = 'capability';
    message =
      'The selected backend cannot provide the capability required for the next step. Choose suitable project resources for a new run.';
  } else if (capacityCodes.has(code)) {
    category = 'capacity';
    message =
      'The model request could not complete with the available capacity. Work is preserved; no automatic retry is scheduled.';
  } else if (configurationCodes.has(code)) {
    category = 'configuration';
    message =
      'The selected model or execution environment needs attention. Check project settings; saved work is preserved.';
  } else if (run.status === 'interrupted') {
    category = 'user-policy';
    message = 'Work was stopped. Continue from the saved workspace when ready.';
  } else if (code === 'OPERATOR_INPUT_REQUIRED') {
    category = 'user-policy';
    message = run.issue?.message || 'The coordinator needs your answer before continuing.';
  } else if (!run.scopePreserved) {
    category = 'user-policy';
    message =
      'Changes crossed a protected or strict file boundary. Review the saved changes before continuing repairs.';
  } else if (
    code === 'BASELINE_CHECKS_FAILED' ||
    run.acceptance.results.some((check) => !check.passed) ||
    run.review?.verdict === 'changes_requested'
  ) {
    category = 'checks';
    message =
      'Checks or independent review found a problem. Continue repairs or rerun checks on the saved workspace.';
  }
  const actions: RunStopAction[] = [];
  const settled = category !== 'unknown';
  const budgetBlocked = run.managedBudget?.status === 'exceeded';
  const resumable =
    settled &&
    category !== 'capability' &&
    !budgetBlocked &&
    !context.projectBusy &&
    context.goalExists &&
    context.resumeSupported &&
    !context.goalUnsettled &&
    !!run.workspace &&
    !!run.baseCommit;
  if (resumable) {
    // A work allowance can be exhausted while the reserved review allowance remains usable.
    if (
      category !== 'user-policy' ||
      !(budgetCodes.has(code) || run.issue?.code === 'MANAGED_BUDGET_BLOCKED')
    )
      actions.push('repair');
    const budget = run.managedBudget;
    const reviewAvailable =
      !budget ||
      (budget.used.requests < budget.policy.maxRequests &&
        budget.used.reservedOutputTokens < budget.policy.maxReservedOutputTokens);
    if (reviewAvailable) actions.push('recheck');
  }
  if (context.goalExists && !context.projectBusy) actions.push('edit-goal');
  if (
    settled &&
    !context.goalUnsettled &&
    context.startSupported &&
    context.goalExists &&
    !context.projectBusy
  )
    actions.push('new-run');
  if (context.settingsSupported) actions.push('project-settings');
  return {
    version: 1,
    category,
    code,
    message,
    ...(context.goalUnsettled
      ? {
          detail:
            'Another run of this goal has an unknown operation. Reconcile it before continuing.',
        }
      : run.issue?.message && run.issue.message !== message
        ? { detail: run.issue.message }
        : {}),
    savedProgress: { workspace: !!run.workspace, history: true },
    automaticRecovery: category === 'unknown' ? 'requires-reconciliation' : 'not-scheduled',
    actions,
  };
}

/** Pure service projection; it never edits permissions, counters, receipts or history. */
export function projectRunAutonomy(run: Run, context: RunAutonomyContext) {
  return { effectivePolicy: effectiveRunPolicy(run), stop: stopForRun(run, context) };
}
