import type { ContextMaterial, Role } from './domain.ts';
import type { AssignmentResource, ResourceSnapshot } from './resources.ts';
import type { WorkflowIdentity } from './workflow-roles.ts';
import type { RunAdmissionPolicy, RunTimelineEntry } from './run-state.ts';
import type { WorkerTask } from './worker-tasks.ts';

/** Exact current delegation context; no session history or mutable Run aggregate. */
export type RunDelegationContext = {
  contextSource: 'initial-admission' | 'continuation-attempt';
  title: string;
  goalText: string;
  contextMaterials: ContextMaterial[];
  checkIds: string[];
  policy: RunAdmissionPolicy;
  resources: ResourceSnapshot;
  coordinator: { role: Role; resource: AssignmentResource };
  workflow: WorkflowIdentity;
  repairEnvironment: boolean;
};
/** Immutable worker grant; independent of the model's mutable working plan. */
export type RunWorkerAssignment = {
  version: 1;
  id: string;
  runId: string;
  admissionId: string;
  attemptId: string;
  role: Role;
  origin: 'created' | 'reused';
  previousAssignmentId?: string;
  instructions?: string;
  paths: string[];
  task?: WorkerTask;
  resource: AssignmentResource;
};

export function runWorkerAssignmentTimeline(
  assignment: RunWorkerAssignment,
  at: string,
): Omit<RunTimelineEntry, 'sequence'>[] {
  return [
    {
      runId: assignment.runId,
      at,
      type: assignment.origin === 'created' ? 'role.proposed' : 'role.reused',
      text: `${assignment.role.id}: ${assignment.role.title}`,
    },
    {
      runId: assignment.runId,
      at,
      type: 'agent.resource-selected',
      text: `${assignment.role.id}: ${assignment.resource.resource.model || assignment.resource.resource.id}. ${assignment.resource.reason}`,
    },
    { runId: assignment.runId, at, type: 'worker.delegated', text: assignment.role.id },
  ];
}
