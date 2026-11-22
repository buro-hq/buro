import type { AgentSession, ContextMaterial, Role } from './domain.ts';
import type { AssignmentResource, ResourceSnapshot } from './resources.ts';
import type { WorkflowIdentity } from './workflow-roles.ts';
import type { PlanningPolicy } from './planning-policy.ts';
import type { RunAdmissionPolicy, RunTimelineEntry } from './run-state.ts';
import type { WorkerTask } from './worker-tasks.ts';

/** Dispatch grant only; observed model/result fields do not change session authority. */
export type RunPlannerSessionGrant = Pick<
  AgentSession,
  | 'id'
  | 'roleId'
  | 'roleVersion'
  | 'runtimeId'
  | 'providerId'
  | 'model'
  | 'configurationRevision'
  | 'selection'
  | 'parentId'
>;
export type RunPlannerHandoff = {
  threadId: string;
  sessionId: string;
  sessionGrant: RunPlannerSessionGrant;
};
/** Exact current planning inputs; no session history or mutable Run aggregate. */
export type RunPlanningInput = {
  contextSource: 'initial-admission' | 'legacy-continuation';
  title: string;
  goalText: string;
  contextMaterials: ContextMaterial[];
  checkIds: string[];
  policy: RunAdmissionPolicy;
  resources: ResourceSnapshot;
  coordinator: { role: Role; resource: AssignmentResource };
  workflow: WorkflowIdentity;
  planningPolicy: PlanningPolicy;
  repairEnvironment: boolean;
  readOnlyPlanner?: RunPlannerHandoff;
};
/** Immutable accepted plan. Adapters store its header, steps and assignments separately. */
export type RunPlan = {
  version: 1;
  id: string;
  runId: string;
  admissionId: string;
  attemptId: string;
  createdAt: string;
  summary: string;
  steps: { step: string; owner: string }[];
  context: RunPlanningInput;
  readOnlyPlanner?: RunPlannerHandoff;
};
/** Original plan assignment. Later current-task refinements retain their existing owner for now. */
export type RunWorkerAssignment = {
  version: 1;
  id: string;
  planId: string;
  runId: string;
  admissionId: string;
  attemptId: string;
  role: Role;
  origin: 'created' | 'reused';
  paths: string[];
  task?: WorkerTask;
  resource: AssignmentResource;
};

/** Exact public history for one accepted decision; never caller-supplied execution evidence. */
export function runPlanTimeline(
  plan: RunPlan,
  assignments: RunWorkerAssignment[],
): Omit<RunTimelineEntry, 'sequence'>[] {
  return [
    ...assignments.flatMap((assignment) => [
      {
        runId: plan.runId,
        at: plan.createdAt,
        type: assignment.origin === 'created' ? 'role.proposed' : 'role.reused',
        text: `${assignment.role.id}: ${assignment.role.title}`,
      },
      {
        runId: plan.runId,
        at: plan.createdAt,
        type: 'agent.resource-selected',
        text: `${assignment.role.id}: ${assignment.resource.resource.model || assignment.resource.resource.id}. ${assignment.resource.reason}`,
      },
    ]),
    { runId: plan.runId, at: plan.createdAt, type: 'plan.saved', text: plan.summary },
  ];
}
