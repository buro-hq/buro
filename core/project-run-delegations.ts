import { validateRoleResource } from './role-routing.ts';
import { operationIds, serviceOperationContext } from './operation-catalog.ts';
import type { RunDelegationContext, RunWorkerAssignment } from '../protocol/run-delegation.ts';
import { RunDelegationContextSchema, RunWorkerAssignmentSchema } from '../protocol/schema.ts';
import { WorkerProposalSchema, type WorkerProposal } from '../protocol/execution.ts';
import { DomainError } from './ports.ts';
import { resolveWorkerRole } from './execution-ports.ts';
import { withEnvironmentRepair } from './environment-repair.ts';
import { resolveWorkerResource } from './assignment-resources.ts';
import { validateAssignmentResource } from './assignment-routing.ts';
import { validateProjectRole } from './project-entities.ts';
import { validateWorkerTask } from './worker-envelope.ts';
import type { RunCurrent } from '../protocol/run-state.ts';
import type { RunTransactionStorage } from './project-runs.ts';

const invalid = () =>
  new DomainError(
    'INVALID_DELEGATION_CONTEXT',
    'The saved delegation context or assignment is invalid.',
  );
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export type DelegateRunWorker = {
  runId: string;
  assignmentId: string;
  now: string;
  worker: WorkerProposal;
  expectedRoleVersion: number | null;
  expectedInput: RunDelegationContext;
  expectedAttemptId: string;
};

/** A delegation issues one immutable grant; a working plan never grants effects. */
export function delegateRunWorker(
  input: DelegateRunWorker,
  current: RunCurrent,
  storage: RunTransactionStorage,
): RunWorkerAssignment {
  if (input.expectedAttemptId !== current.attemptId)
    throw new DomainError('STALE_RUN_ATTEMPT', 'This attempt no longer owns the run.');
  if (current.cancelRequested || current.status === 'canceling')
    throw new DOMException('Interrupted', 'AbortError');
  if (current.status !== 'running' || current.completedAt !== undefined)
    throw new DomainError('INVALID_STATE', 'Only a running attempt may delegate work.');
  if (storage.unresolvedForGoal(current.goalId))
    throw new DomainError(
      'RUN_RECONCILIATION_REQUIRED',
      'Reconcile unknown operations before delegation.',
    );
  if (!storage.workspace(current.id))
    throw new DomainError('NO_WORKSPACE', 'Delegation requires the saved workspace.');
  const context = validateRunDelegationContext(storage.delegationContext(current.id));
  if (JSON.stringify(context) !== JSON.stringify(validateRunDelegationContext(input.expectedInput)))
    throw new DomainError(
      'DELEGATION_CONTEXT_CHANGED',
      'The task or admission changed while deciding.',
    );
  const parsed = WorkerProposalSchema.safeParse(input.worker);
  if (!parsed.success)
    throw new DomainError('INVALID_ASSIGNMENT', 'The proposed worker is invalid.');
  const worker = parsed.data;
  const policy = withEnvironmentRepair(context.policy, context.repairEnvironment);
  const existing = storage.assignment(current.id, worker.roleId);
  if (existing) {
    const grant = validateRunWorkerAssignment(existing);
    const resource = validateAssignmentResource(
      context.resources,
      grant.role,
      resolveWorkerResource(
        context.resources,
        grant.role,
        worker,
        policy.scope.mode === 'strict' ? { strictPlannedWrites: true } : {},
      ),
      policy.scope.mode === 'strict' ? { strictPlannedWrites: true } : {},
    );
    if (
      input.expectedRoleVersion !== grant.role.version ||
      JSON.stringify(worker.paths) !== JSON.stringify(grant.paths) ||
      JSON.stringify(worker.assignment ? validateWorkerTask(worker.assignment) : undefined) !==
        JSON.stringify(grant.task ? validateWorkerTask(grant.task) : undefined) ||
      JSON.stringify(resource) !== JSON.stringify(grant.resource) ||
      (worker.action === 'create' &&
        ['title', 'description', 'instructions', 'kind'].some(
          (key) => worker[key as 'title'] !== grant.role[key as 'title'],
        ))
    )
      throw new DomainError(
        'ASSIGNMENT_EXISTS',
        'This role already has a different immutable assignment. Delegate a distinct role instead.',
      );
    return grant;
  }
  if (
    policy.maxWorkers !== undefined &&
    storage.assignments(current.id).length >= policy.maxWorkers
  )
    throw new DomainError('INVALID_ASSIGNMENT', 'The captured team allowance is exhausted.');
  const value = storage.role(worker.roleId);
  const role = value ? validateProjectRole(value) : undefined;
  if ((role?.version ?? null) !== input.expectedRoleVersion)
    throw new DomainError('ROLE_CHANGED', 'The role changed during the delegation decision.');
  let assignedRole: ReturnType<typeof resolveWorkerRole>;
  try {
    assignedRole = resolveWorkerRole(
      worker,
      role ? [role] : [],
      policy,
      input.now,
      context.workflow,
    );
  } catch (error) {
    throw new DomainError(
      'INVALID_ASSIGNMENT',
      error instanceof Error ? error.message : String(error),
    );
  }
  const resource = resolveWorkerResource(
    context.resources,
    assignedRole,
    worker,
    policy.scope.mode === 'strict' ? { strictPlannedWrites: true } : {},
  );
  const assignment = validateRunWorkerAssignment({
    version: 1,
    id: input.assignmentId,
    runId: current.id,
    admissionId: current.admissionId,
    attemptId: current.attemptId,
    role: assignedRole,
    origin: worker.action === 'create' ? 'created' : 'reused',
    paths: worker.paths,
    ...(worker.assignment == null ? {} : { task: worker.assignment }),
    resource,
  });
  if (assignment.origin === 'created') storage.appendRole(assignedRole, 0);
  storage.insertAssignment(assignment);
  return assignment;
}
export function validateRunDelegationContext(value: unknown): RunDelegationContext {
  const parsed = RunDelegationContextSchema.safeParse(value);
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
  if (
    !parsed.data.checkIds.length ||
    parsed.data.checkIds.some((id) => !parsed.data.policy.checks.some((check) => check.id === id))
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
