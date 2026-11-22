import type { Goal, RunIssue, Role } from './domain.ts';
import type { RunAdmissionPolicy, RunAttempt, RunTimelineEntry } from './run-state.ts';
import type { ResourceSnapshot, AssignmentResource } from './resources.ts';
import type { WorkflowIdentity } from './workflow-roles.ts';
import type { PlanningPolicy } from './planning-policy.ts';
import type { ContextMaterial } from './context.ts';

/** Complete immutable inputs for one attempt; no session or prior-attempt histories. */
export type RunAttemptContext = {
  version: 1;
  attemptId: string;
  runId: string;
  admissionId: string;
  goal: Goal;
  goalText: string;
  policy: RunAdmissionPolicy;
  policySource: 'admission' | 'retained-attempt' | 'project-profile' | 'configured-host';
  resources: ResourceSnapshot;
  workflow: WorkflowIdentity;
  planningPolicy: PlanningPolicy;
  roleSnapshots: Role[];
  roleResources: Record<string, AssignmentResource>;
  contextMaterials: ContextMaterial[];
  checkIds: string[];
  repairEnvironment: boolean;
  timePolicy: { kind: 'inactivity'; idleTimeoutMs: number };
  continuation?: {
    mode: 'repair' | 'recheck';
    instructions: string;
    requestedAt: string;
    useCurrentProfile: boolean;
  };
  workspaceOriginAttemptId?: string;
  inheritedPlanId?: string;
  planOriginAttemptId?: string;
  taskMode: 'original' | 'full-goal';
  taskChanged: boolean;
};
export type CurrentRunAttempt = { attempt: RunAttempt; context: RunAttemptContext };
export type RunAttemptStop = {
  version: 1;
  id: string;
  runId: string;
  attemptId: string;
  createdAt: string;
  status: 'failed' | 'interrupted' | 'needs-attention';
  text: string;
  issue?: RunIssue;
  errorCode?: string;
};
export function runAttemptStopTimeline(stop: RunAttemptStop): Omit<RunTimelineEntry, 'sequence'>[] {
  return [{ runId: stop.runId, at: stop.createdAt, type: 'run.' + stop.status, text: stop.text }];
}
export function runAttemptContinuationTimeline(
  context: RunAttemptContext,
): Omit<RunTimelineEntry, 'sequence'>[] {
  const continuation = context.continuation!;
  return [
    ...(context.taskChanged
      ? [
          {
            runId: context.runId,
            at: continuation.requestedAt,
            type: 'agent.tasks-invalidated',
            text: 'The goal changed; workers receive the complete updated goal.',
          },
        ]
      : []),
    {
      runId: context.runId,
      at: continuation.requestedAt,
      type: 'run.resume-requested',
      text: `${continuation.mode === 'recheck' ? 'Rechecking' : 'Continuing with repair'} in the saved workspace. ${continuation.useCurrentProfile ? 'Using the current profile.' : 'Keeping the original profile.'} ${continuation.instructions}`,
    },
  ];
}
