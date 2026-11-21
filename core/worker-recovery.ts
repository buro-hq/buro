import type { Agent, Role, Run } from '../protocol/domain.ts';
import type { WorkerTask } from '../protocol/worker-tasks.ts';
import { WorkerRefinementSchema } from '../protocol/worker-tasks.ts';
import { DomainError } from './ports.ts';
import { validateWorkerTask } from './worker-envelope.ts';
import { WorkScopeSchema } from '../protocol/work-scope.ts';
import { planPathAllowed } from './execution-ports.ts';
import { withEnvironmentRepair } from './environment-repair.ts';

/** Only a completely known, scope-checked managed failure can request one new assignment. */
export function workerFailureForReplan(run: Run, roles: Role[], error: unknown) {
  if (
    run.workerReplan ||
    run.cancelRequested ||
    !(error instanceof DomainError) ||
    !['MODEL_INCOMPLETE', 'MODEL_CONTEXT_EXHAUSTED'].includes(error.code)
  )
    return undefined;
  const agent = run.agents.at(-1);
  const role = roles.find((role) => role.id === agent?.session?.roleId);
  const saved = agent?.assignment;
  const task = role && run.workerTasks?.[role.id];
  const policyScope = WorkScopeSchema.safeParse(
    run.executionPolicySnapshot
      ? withEnvironmentRepair(run.executionPolicySnapshot, !!run.repairEnvironment).scope
      : undefined,
  );
  const envelopeScope = WorkScopeSchema.safeParse(saved?.envelope?.scope);
  if (
    !agent ||
    !role ||
    !task ||
    agent.status !== 'failed' ||
    !agent.completedAt ||
    agent.session?.roleVersion !== role.version ||
    saved?.knownFailure?.code !== error.code ||
    saved.knownFailure.scopeVerified !== true ||
    saved.envelope?.runId !== run.id ||
    saved.envelope.role.id !== role.id ||
    saved.envelope.role.version !== role.version ||
    saved.envelope.task.source !== 'coordinator' ||
    JSON.stringify(saved.paths) !== JSON.stringify(run.roleAssignments?.[role.id]) ||
    !policyScope.success ||
    !envelopeScope.success ||
    envelopeScope.data.mode !== policyScope.data.mode ||
    JSON.stringify(envelopeScope.data.plannedPaths) !== JSON.stringify(saved.paths) ||
    JSON.stringify(envelopeScope.data.protectedPaths) !==
      JSON.stringify(policyScope.data.protectedPaths) ||
    envelopeScope.data.plannedPaths.some((file) => !planPathAllowed(file, policyScope.data)) ||
    JSON.stringify(validateWorkerTask(task)) !==
      JSON.stringify(
        validateWorkerTask({
          objective: saved.envelope.task.objective,
          inputs: saved.envelope.task.inputs,
          expectedResult: saved.envelope.task.expectedResult,
          criteria: saved.envelope.task.criteria,
        }),
      )
  )
    return undefined;
  return { role, agent, task };
}

/** The coordinator can focus the objective/inputs, but cannot weaken the saved result contract. */
export function refineWorkerTask(original: WorkerTask, proposed: unknown): WorkerTask {
  const parsed = WorkerRefinementSchema.safeParse(proposed);
  if (!parsed.success)
    throw new DomainError('INVALID_WORKER_REPLAN', 'The worker refinement is invalid.');
  const task = validateWorkerTask({
    ...original,
    objective: parsed.data.objective,
    inputs: parsed.data.inputs,
  });
  if (task.inputs.some((input) => !original.inputs.includes(input)))
    throw new DomainError(
      'INVALID_WORKER_REPLAN',
      'A refinement cannot add file inputs to the saved worker task.',
    );
  return task;
}

function latestAgent(run: Run, role: Role): Agent | undefined {
  return [...run.agents].reverse().find((agent) => agent.session?.roleId === role.id);
}

export function pendingWorkerRoles(run: Run, roles: Role[]) {
  return roles.filter((role) => {
    const agent = latestAgent(run, role);
    return !(
      agent?.status === 'completed' &&
      agent.session?.roleVersion === role.version &&
      agent.session.result?.status === 'success'
    );
  });
}
