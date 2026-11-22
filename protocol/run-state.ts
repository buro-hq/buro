import type { ContextMaterial, Goal, GoalOutcome, Role, Run } from './domain.ts';
import type { AssignmentResource, ResourceSnapshot } from './resources.ts';
import type { WorkflowIdentity } from './workflow-roles.ts';
import type { PlanningPolicy } from './planning-policy.ts';

/** Scalar lifecycle only. Growing history, grants and file contents live in separate records. */
export type RunCurrent = {
  version: 1;
  id: string;
  goalId: string;
  revision: number;
  admissionId: string;
  attemptId: string;
  title: string;
  summary: string;
  status: NonNullable<Run['status']>;
  phase: NonNullable<Run['phase']>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelRequested: boolean;
};
export type RunAdmissionPolicy = NonNullable<Run['executionPolicySnapshot']>;
/** Complete initial task and captured grants; immutable after actual admission. */
export type RunAdmission = {
  version: 1;
  id: string;
  runId: string;
  attemptId: string;
  createdAt: string;
  goal: Goal;
  goalText: string;
  policy: RunAdmissionPolicy;
  resources: ResourceSnapshot;
  workflow: WorkflowIdentity;
  planningPolicy: PlanningPolicy;
  roleSnapshots: Role[];
  roleResources: Record<string, AssignmentResource>;
  contextMaterials: ContextMaterial[];
  checkIds: string[];
  repairEnvironment: boolean;
  timePolicy: { kind: 'inactivity'; idleTimeoutMs: number };
  outcome: GoalOutcome;
  parentRunId?: string;
};
export type RunAttempt = {
  version: 1;
  id: string;
  runId: string;
  admissionId: string;
  ordinal: number;
  reason: 'initial' | 'repair' | 'recheck';
  createdAt: string;
  priorAttemptId?: string;
};
/** The observed workspace returned by preparation. Immutable identity, never a dispatch grant. */
export type RunWorkspaceBinding = {
  version: 1;
  runId: string;
  admissionId: string;
  attemptId: string;
  path: string;
  baseCommit: string;
  createdAt: string;
};
export type RunTimelineEntry = {
  runId: string;
  sequence: number;
  at: string;
  type: string;
  text?: string;
  threadId?: string;
  commandId?: string;
  durationMs?: number;
};
export type RunTimelineCursor = {
  version: 1;
  projectId: string;
  runId: string;
  after: number;
  watermark: number;
};
export type RunTimelineQuery = { runId: string; limit: number; cursor?: RunTimelineCursor };
export type RunTimelinePage = {
  entries: RunTimelineEntry[];
  watermark: number;
  next?: RunTimelineCursor;
};
