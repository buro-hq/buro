import { validateRoleResource } from './role-routing.ts';
import { operationIds, serviceOperationContext } from './operation-catalog.ts';
import type { AgentSession } from '../protocol/domain.ts';
import type {
  RunPlanningInput,
  RunPlan,
  RunWorkerAssignment,
  RunPlannerSessionGrant,
} from '../protocol/run-plan.ts';
import {
  RunPlanningInputSchema,
  RunPlannerSessionGrantSchema,
  RunPlanSchema,
  RunWorkerAssignmentSchema,
} from '../protocol/schema.ts';
import { TeamPlanSchema, type TeamPlan } from '../protocol/execution.ts';
import { DomainError } from './ports.ts';
import { resolveTeam } from './execution-ports.ts';
import { withEnvironmentRepair } from './environment-repair.ts';
import { resolveWorkerResource } from './assignment-resources.ts';
import { validateAssignmentResource } from './assignment-routing.ts';
import { validateProjectRole } from './project-entities.ts';
import { validateWorkerTask } from './worker-envelope.ts';
import { assertPlanningPolicy } from './planning-policy.ts';
import type { RunCurrent } from '../protocol/run-state.ts';
import type { RunTransactionStorage } from './project-runs.ts';

const invalid = () => new DomainError('INVALID_RUN_PLAN', 'The saved planning state is invalid.');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function plannerSessionGrant(session: AgentSession): RunPlannerSessionGrant {
  const {
    id,
    roleId,
    roleVersion,
    runtimeId,
    providerId,
    model,
    configurationRevision,
    selection,
    parentId,
  } = session;
  const parsed = RunPlannerSessionGrantSchema.safeParse({
    id,
    roleId,
    roleVersion,
    runtimeId,
    providerId,
    model,
    configurationRevision,
    selection,
    parentId,
  });
  if (!parsed.success) throw invalid();
  return copy(parsed.data);
}
export type AcceptRunPlan = {
  runId: string;
  planId: string;
  now: string;
  plan: TeamPlan;
  expectedRoleVersions: Record<string, number | null>;
  expectedInput: RunPlanningInput;
  expectedAttemptId?: string;
};
export function validateRunPlanningInput(value: unknown): RunPlanningInput {
  const parsed = RunPlanningInputSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  const context = parsed.data;
  if (context.coordinator.role.id !== 'coordinator') throw invalid();
  const operation = serviceOperationContext(
    operationIds.coordination,
    context.policy.profile,
    context.policy.scope.mode === 'strict',
  );
  validateRoleResource(
    context.resources,
    validateProjectRole(context.coordinator.role),
    context.coordinator.resource,
    operation,
  );
  assertPlanningPolicy(context.planningPolicy, context.coordinator.resource.resource);
  if (
    !parsed.data.checkIds.length ||
    parsed.data.checkIds.some((id) => !parsed.data.policy.checks.some((check) => check.id === id))
  )
    throw invalid();
  if (
    parsed.data.readOnlyPlanner &&
    (parsed.data.readOnlyPlanner.sessionId !== parsed.data.readOnlyPlanner.sessionGrant.id ||
      parsed.data.readOnlyPlanner.sessionGrant.roleId !== 'coordinator' ||
      parsed.data.readOnlyPlanner.sessionGrant.roleVersion !== context.coordinator.role.version ||
      parsed.data.readOnlyPlanner.sessionGrant.runtimeId !==
        context.coordinator.resource.resource.id ||
      parsed.data.readOnlyPlanner.sessionGrant.providerId !==
        context.coordinator.resource.resource.providerId ||
      parsed.data.readOnlyPlanner.sessionGrant.model !==
        context.coordinator.resource.resource.model ||
      parsed.data.readOnlyPlanner.sessionGrant.configurationRevision !==
        context.coordinator.resource.resource.configurationRevision ||
      JSON.stringify(parsed.data.readOnlyPlanner.sessionGrant.selection) !==
        JSON.stringify({
          source: context.coordinator.resource.source,
          reason: context.coordinator.resource.reason,
        }))
  )
    throw invalid();
  return copy(parsed.data);
}
export function validateRunPlan(value: unknown): RunPlan {
  const parsed = RunPlanSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  validateRunPlanningInput(parsed.data.context);
  if (
    JSON.stringify(parsed.data.readOnlyPlanner) !==
    JSON.stringify(parsed.data.context.readOnlyPlanner)
  )
    throw invalid();
  return copy(parsed.data);
}
export function validateRunWorkerAssignment(value: unknown): RunWorkerAssignment {
  const parsed = RunWorkerAssignmentSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  validateProjectRole(parsed.data.role);
  if (parsed.data.task) validateWorkerTask(parsed.data.task);
  return copy(parsed.data);
}
export function acceptRunPlan(
  input: AcceptRunPlan,
  current: RunCurrent,
  storage: RunTransactionStorage,
) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    (Reflect.ownKeys(input).length !== 6 && Reflect.ownKeys(input).length !== 7) ||
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(input, key)!),
    ) ||
    !['runId', 'planId', 'now', 'plan', 'expectedRoleVersions', 'expectedInput'].every((key) =>
      Object.hasOwn(input, key),
    ) ||
    !input.planId ||
    typeof input.planId !== 'string' ||
    !input.now ||
    typeof input.now !== 'string'
  )
    throw invalid();
  if (input.expectedAttemptId !== undefined && input.expectedAttemptId !== current.attemptId)
    throw new DomainError('STALE_RUN_ATTEMPT', 'This attempt no longer owns the run.');
  if (
    input.expectedAttemptId === undefined &&
    storage.attempt(current.attemptId)?.reason !== 'initial'
  )
    throw new DomainError(
      'ATTEMPT_OWNERSHIP_REQUIRED',
      'This continuation requires its exact attempt owner.',
    );
  if (current.cancelRequested || current.status === 'canceling')
    throw new DOMException('Interrupted', 'AbortError');
  if (
    current.status !== 'running' ||
    current.phase !== 'planning' ||
    current.completedAt !== undefined
  )
    throw new DomainError('INVALID_STATE', 'Only a running planner can save its plan.');
  if (storage.unresolvedForGoal(current.goalId))
    throw new DomainError(
      'RUN_RECONCILIATION_REQUIRED',
      'Reconcile unknown operations before accepting a plan.',
    );
  if (!storage.workspace(current.id))
    throw new DomainError('NO_WORKSPACE', 'A plan requires its saved prepared workspace.');
  if (storage.plan(current.id))
    throw new DomainError('PLAN_EXISTS', 'This run already has an accepted plan.');
  const context = validateRunPlanningInput(storage.planningInput(current.id));
  if (JSON.stringify(context) !== JSON.stringify(validateRunPlanningInput(input.expectedInput)))
    throw new DomainError(
      'PLANNING_CONTEXT_CHANGED',
      'The task or planning authority changed while the model planned.',
    );
  const readonly = context.planningPolicy.strategy === 'read-only-inspection';
  if (readonly && !context.readOnlyPlanner)
    throw new DomainError(
      'PLANNING_HANDOFF_UNAVAILABLE',
      'This authority cannot seal a real read-only planner session yet.',
    );
  const parsed = TeamPlanSchema.safeParse(input.plan);
  if (!parsed.success)
    throw new DomainError(
      'INVALID_PLAN',
      'The proposed plan is invalid: ' +
        parsed.error.issues
          .slice(0, 8)
          .map((issue) => issue.path.join('.') + ': ' + issue.message.slice(0, 500))
          .join('; '),
    );
  const plan = parsed.data;
  const expected = input.expectedRoleVersions;
  if (
    !expected ||
    typeof expected !== 'object' ||
    Array.isArray(expected) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(expected)) ||
    Reflect.ownKeys(expected).some(
      (key) =>
        typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(expected, key)!),
    ) ||
    Object.keys(expected).length !== plan.team.length ||
    Object.keys(expected).some((id) => !plan.team.some((worker) => worker.roleId === id)) ||
    Object.values(expected).some(
      (version) => version !== null && (!Number.isSafeInteger(version) || version < 1),
    )
  )
    throw invalid();
  const catalog = plan.team.flatMap((worker) => {
    const saved = storage.role(worker.roleId);
    const role = saved === undefined ? undefined : validateProjectRole(saved);
    if ((role?.version ?? null) !== expected[worker.roleId])
      throw new DomainError(
        'ROLE_CHANGED',
        `Role ${worker.roleId} changed during planning. Choose from the updated catalog.`,
      );
    return role ? [role] : [];
  });
  const policy = withEnvironmentRepair(context.policy, context.repairEnvironment);
  let team: ReturnType<typeof resolveTeam>;
  try {
    team = resolveTeam(plan, catalog, policy, input.now, context.workflow);
  } catch (error) {
    throw new DomainError('INVALID_PLAN', error instanceof Error ? error.message : String(error));
  }
  const assignments = team.roles.map((role) => {
    const worker = plan.team.find((worker) => worker.roleId === role.id)!;
    const resource = resolveWorkerResource(
      context.resources,
      role,
      worker,
      policy.scope.mode === 'strict' ? { strictPlannedWrites: true } : {},
    );
    validateAssignmentResource(
      context.resources,
      role,
      resource,
      policy.scope.mode === 'strict' ? { strictPlannedWrites: true } : {},
    );
    return validateRunWorkerAssignment({
      version: 1,
      id: input.planId + ':' + role.id,
      planId: input.planId,
      runId: current.id,
      admissionId: current.admissionId,
      attemptId: current.attemptId,
      role,
      origin: team.origins[role.id],
      paths: worker.paths,
      ...(worker.assignment != null ? { task: validateWorkerTask(worker.assignment) } : {}),
      resource,
    });
  });
  const accepted = validateRunPlan({
    version: 1,
    id: input.planId,
    runId: current.id,
    admissionId: current.admissionId,
    attemptId: current.attemptId,
    createdAt: input.now,
    summary: plan.summary,
    steps: plan.steps,
    context,
    ...(readonly ? { readOnlyPlanner: context.readOnlyPlanner } : {}),
  });
  // All proposal, role, scope and resource checks precede the first persisted mutation.
  for (const assignment of assignments)
    if (assignment.origin === 'created') storage.appendRole(assignment.role, 0);
  storage.insertPlan(accepted, assignments);
  if (readonly) storage.sealPlanningSession(current.id, context.readOnlyPlanner!);
  return { plan: accepted, assignments };
}
