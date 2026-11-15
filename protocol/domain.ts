/** Public data contracts. This module has no Node, Cordis, React or transport imports. */
import type { EnvironmentConfig } from './environment.ts';
import type { ContextMaterial } from './context.ts';
export type { ContextMaterial } from './context.ts';
import type {
  DeliveryConfig,
  GoalOutcome,
  ProjectComponent,
  ProjectResearch,
  RunDelivery,
  RunPreview,
} from './operations.ts';
export type {
  ProjectResearch,
  ProjectComponent,
  GoalOutcome,
  RunDelivery,
  RunPreview,
} from './operations.ts';
export type Project = {
  id: string;
  name: string;
  root: string;
  managed?: boolean;
  dataDirectory?: string;
};
export type ProjectCommand = { id: string; title: string; command: string; timeoutMs: number };
export type ProjectProfile = {
  version: 1;
  revision: number;
  context: string;
  allowedPaths: string[];
  protectedPaths: string[];
  checks: ProjectCommand[];
  defaultCheckIds: string[];
  environment?: EnvironmentConfig;
  checkConcurrency?: number;
  setup: ProjectCommand[];
  dependencies: 'none' | 'link-node-modules';
  maxWorkers: number;
  maxRepairs: number;
  turnTimeoutMs: number;
  baseBranch?: string;
  components?: ProjectComponent[];
  delivery?: DeliveryConfig;
};
export type RepositoryInfo = {
  root: string;
  name: string;
  branch: string;
  head: string;
  dirty: boolean;
  dirtyFiles: string[];
  profile: ProjectProfile;
  projectId?: string;
  warnings: string[];
};
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const roleIdPattern = /^[a-z][a-z0-9_-]{0,63}$/;
export type RoleKind = 'implementation' | 'testing' | 'review' | 'coordination' | 'general';
export type Role = {
  id: string;
  version: number;
  title: string;
  description: string;
  instructions: string;
  kind: RoleKind;
  model?: string;
  createdAt: string;
  updatedAt: string;
};
export type Goal = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  criteria: string;
  status: 'draft' | 'running' | 'completed' | 'failed';
  createdAt: string;
  revision?: number;
  repairEnvironment?: boolean;
  parentRunId?: string;
  outcome?: GoalOutcome;
  runId?: string;
  materialIds?: string[];
};
export type RunEvent = {
  at: string;
  type: string;
  threadId?: string;
  text?: string;
  commandId?: string;
  durationMs?: number;
};
export type Command = {
  id: string;
  threadId: string;
  command: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number | null;
  output?: string;
};
export type Agent = {
  threadId: string;
  name: string;
  agentPath: string;
  startedAt: string;
  completedAt: string;
  messages: string[];
  commands: number;
  status: string;
  assignment?: { paths: string[] };
};
export type FileChange = { path: string; before: string; after: string };
export type Check = {
  name: string;
  passed: boolean;
  error?: string;
  output?: string;
  command?: string;
  exitCode?: number | null;
  durationMs?: number;
};
export type ProjectVerification = {
  id: string;
  profileRevision: number;
  createdAt: string;
  workspace: string;
  base: string;
  passed: number;
  total: number;
  results: Check[];
};
export type RunContinuation = {
  mode: 'repair' | 'recheck';
  instructions: string;
  requestedAt: string;
};
export type RunIssue = {
  code: 'BASELINE_CHECKS_FAILED' | 'EXECUTION_FAILED';
  message: string;
  checks: string[];
};
export type Run = {
  contextMaterials?: ContextMaterial[];
  id: string;
  key: string;
  title: string;
  summary: string;
  createdAt: string;
  completedAt?: string;
  updatedAt?: string;
  planSavedAt?: string;
  threadId: string;
  status?:
    | 'queued'
    | 'running'
    | 'canceling'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'needs-attention';
  phase?:
    | 'preparing'
    | 'queued'
    | 'planning'
    | 'implementation'
    | 'checking'
    | 'review'
    | 'repair'
    | 'done';
  goalId?: string;
  workspace?: string;
  commit?: string;
  checkIds?: string[];
  repairEnvironment?: boolean;
  timePolicy?: { kind: 'inactivity'; idleTimeoutMs: number };
  cancelRequested?: boolean;
  review?: {
    verdict: 'approved' | 'changes_requested';
    blockingFindings: string[];
    summary: string;
  };
  roleOrigins?: Record<string, 'created' | 'reused'>;
  roleAssignments?: Record<string, string[]>;
  roleSnapshots?: Role[];
  executionPolicySnapshot?: ExecutionPolicyView & {
    turnTimeoutMs: number;
    context?: string;
    profile?: ProjectProfile;
  };
  continuation?: RunContinuation;
  issue?: RunIssue;
  attempts?: {
    at: string;
    status: string;
    result: string;
    policy?: Run['executionPolicySnapshot'];
    goalText: string;
    contextMaterials?: ContextMaterial[];
    repairEnvironment?: boolean;
    timePolicy?: Run['timePolicy'];
  }[];
  baseCommit?: string;
  baseBranch?: string;
  parentRunId?: string;
  outcome?: GoalOutcome;
  delivery?: RunDelivery;
  deliveryHistory?: RunDelivery[];
  preview?: RunPreview;
  appliedAt?: string;
  appliedBranch?: string;
  agents: Agent[];
  resultAgents?: Agent[];
  events: RunEvent[];
  commands: Command[];
  plan: { step: string; owner: string }[];
  changedFiles: FileChange[];
  baseline: { passed: number; total: number; results: Check[] };
  acceptance: { passed: number; total: number; results: Check[] };
  specsUnchanged: boolean;
  scopePreserved: boolean;
  independentReviewer: boolean;
  goalText: string;
  result: string;
  sourceHash: string;
};
export type DomainEvent = {
  version: 1;
  id: string;
  projectId: string;
  seq: number;
  at: string;
  change:
    | { type: 'goal.created'; goal: Goal }
    | { type: 'goal.updated'; goal: Goal }
    | { type: 'goal.deleted'; id: string }
    | { type: 'role.saved'; role: Role }
    | { type: 'context.materials.added'; materials: ContextMaterial[] }
    | { type: 'context.material.removed'; id: string }
    | { type: 'project.research.changed'; research: ProjectResearch }
    | {
        type: 'project.configured';
        profile: ProjectProfile;
        executionPolicy: ExecutionPolicyView;
        research?: ProjectResearch;
      }
    | { type: 'project.verified'; verification: ProjectVerification }
    | { type: 'run.changed'; run: Run; goal: Goal; roles?: Role[] };
};
export type ExecutionPolicyView = {
  allowedPaths: string[];
  protectedPaths?: string[];
  checks: { id: string; title: string }[];
  defaultCheckIds: string[];
  maxWorkers: number;
  maxRepairs: number;
};
export type Snapshot = {
  contextMaterials?: ContextMaterial[];
  version: 1;
  project: Project;
  revision: number;
  sequence: number;
  roles: Role[];
  goals: Goal[];
  runs: Run[];
  capabilities: string[];
  executionPolicy?: ExecutionPolicyView;
  profile?: ProjectProfile;
  verification?: ProjectVerification;
  research?: ProjectResearch;
};
export type CreateGoal = {
  materialIds?: string[];
  projectId: string;
  title: string;
  body: string;
  criteria: string;
  repairEnvironment?: boolean;
  parentRunId?: string;
  outcome?: GoalOutcome;
};
export type SaveRole = {
  projectId: string;
  id: string;
  title: string;
  description: string;
  instructions: string;
  kind: RoleKind;
  model?: string;
  expectedVersion: number;
};

export type ProjectStorageInfo = {
  stateBytes: number;
  eventCount: number;
  compactedEvents: number;
  runCount: number;
  receiptCount: number;
  removedTempFiles?: number;
  reclaimedBytes?: number;
};
