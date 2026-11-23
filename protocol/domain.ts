/** Public data contracts. This module has no Node, Cordis, React or transport imports. */
import type {
  RunCurrent,
  RunAdmission,
  RunTimelineEntry,
  RunWorkspaceBinding,
} from './run-state.ts';
import type { EnvironmentConfig } from './environment.ts';
import type { RoleProvenance, WorkflowIdentity } from './workflow-roles.ts';
import type { ContextMaterial } from './context.ts';
import type {
  AssignmentResource,
  AssignmentSelection,
  RuntimePreference,
  SavedOperationContext,
} from './resources.ts';
import type { WorkScope, ScopeObservation } from './work-scope.ts';
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
/** Service discovery is valid before the first project is connected. */
export type ServiceInfo = { version: 1; projects: Project[]; capabilities: string[] };
export type ResourceConfigurationChange = {
  topic: 'resources';
  revision: string;
  appliesTo: 'new-runs' | 'service-restart';
};
export type ProjectCommand = {
  id: string;
  title: string;
  command: string;
  timeoutMs: number;
  outputPaths?: string[];
};
export type ProjectProfile = {
  managedBudget?: import('./run-budget.ts').ManagedRunBudgetPolicy;
  resourceProfile?: string;
  version: 1;
  revision: number;
  context: string;
  scope: WorkScope;
  checks: ProjectCommand[];
  defaultCheckIds: string[];
  environment?: EnvironmentConfig;
  checkConcurrency?: number;
  setup: ProjectCommand[];
  dependencies: 'none' | 'link-node-modules';
  maxWorkers?: number;
  turnTimeoutMs: number;
  baseBranch?: string;
  components?: ProjectComponent[];
  delivery?: DeliveryConfig;
};
export type RepositoryInfo = {
  checkRecipes?: import('./check-recipes.ts').CheckRecipeSource[];
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
  provenance: RoleProvenance;
  id: string;
  version: number;
  title: string;
  description: string;
  instructions: string;
  kind: RoleKind;
  model?: string;
  runtimePreference?: RuntimePreference;
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
  revision: number;
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
  session?: AgentSession;
  threadId: string;
  name: string;
  agentPath: string;
  startedAt: string;
  completedAt: string;
  messages: string[];
  commands: number;
  status: string;
  assignment?: {
    grantId?: string;
    paths: string[];
    envelope?: import('./worker-tasks.ts').WorkerEnvelopeV1;
    knownFailure?: {
      code: 'MODEL_INCOMPLETE' | 'MODEL_CONTEXT_EXHAUSTED' | 'MODEL_RESPONSE_LOST';
      scopeVerified: true;
    };
  };
};
export type AgentSession = {
  id: string;
  roleId: string;
  roleVersion: number;
  runtimeId: string;
  providerId?: string;
  model?: string;
  reportedModel?: string;
  configurationRevision?: string;
  selection?: AssignmentSelection;
  parentId?: string;
  result?: {
    status: 'success' | 'fail';
    summary: string;
    artifacts: string[];
    notesForNextAgent: string;
  };
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
export type ResearchAcknowledgement = {
  id: string;
  reviewedProfileRevision: number;
  appliedProfileRevision?: number;
};
export type RunContinuation = {
  mode: 'repair' | 'recheck';
  instructions: string;
  requestedAt: string;
};
export type RunIssue = {
  code:
    | 'BASELINE_CHECKS_FAILED'
    | 'EXECUTION_FAILED'
    | 'MANAGED_BUDGET_BLOCKED'
    | 'OPERATOR_INPUT_REQUIRED'
    | 'RECONCILIATION_REQUIRED';
  budgetCode?: import('./run-budget.ts').ManagedBudgetErrorCode;
  message: string;
  checks: string[];
};
export type Run = {
  attemptId?: string;
  workflow?: WorkflowIdentity;
  verificationView?: import('./verification.ts').VerificationView;
  verificationEvidence?: import('./verification.ts').VerificationEvidence;
  reconciliation?: import('./reconciliation.ts').RunReconciliation;
  pendingTurn?: import('./reconciliation.ts').PendingRunTurn;
  effectivePolicy?: import('./autonomy.ts').EffectivePolicy;
  stop?: import('./autonomy.ts').RunStop;
  managedBudget?: import('./run-budget.ts').ManagedRunBudgetSummary;
  workerTasks?: Record<string, import('./worker-tasks.ts').WorkerTask>;
  workerReplan?: import('./worker-tasks.ts').WorkerReplan;
  resources?: import('./resources.ts').ResourceSnapshot;
  assignmentResources?: Record<string, AssignmentResource>;
  roleResources?: Record<string, AssignmentResource>;
  operationResources?: Record<string, Record<string, AssignmentResource>>;
  operationContexts?: Record<string, SavedOperationContext>;
  delegation?: 'buro';
  coordinatorSession?: AgentSession;
  contextMaterials?: ContextMaterial[];
  id: string;
  key: string;
  title: string;
  summary: string;
  createdAt: string;
  completedAt?: string;
  updatedAt?: string;
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
  scopeObservation?: ScopeObservation;
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
    | { type: 'project.research.changed'; research: ProjectResearch; roles?: Role[] }
    | {
        type: 'project.configured';
        profile: ProjectProfile;
        executionPolicy: ExecutionPolicyView;
        researchAcknowledgement?: ResearchAcknowledgement;
      }
    | { type: 'project.verified'; verification: ProjectVerification }
    | {
        type: 'run.admitted';
        view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>;
        current: RunCurrent;
        admission: RunAdmission;
        goal: Goal;
        roles?: Role[];
      }
    | { type: 'run.cancel-requested'; current: RunCurrent }
    | {
        type: 'run.workspace-bound';
        current: RunCurrent;
        binding: RunWorkspaceBinding;
        entry: {
          runId: string;
          at: string;
          type: 'workspace.prepared';
          text: 'Workspace prepared';
        };
        view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>;
      }
    | {
        type: 'run.lifecycle-changed';
        current: RunCurrent;
        entry?: Omit<RunTimelineEntry, 'sequence'>;
        view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>;
      }
    | {
        type: 'run.worker-delegated';
        current: RunCurrent;
        assignment: import('./run-delegation.ts').RunWorkerAssignment;
        context: import('./run-delegation.ts').RunDelegationContext;
        entries: Omit<RunTimelineEntry, 'sequence'>[];
        view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>;
      }
    | {
        type: 'run.attempt-stopped';
        current: RunCurrent;
        stop: import('./run-attempt.ts').RunAttemptStop;
        goal: Goal;
        entries: Omit<RunTimelineEntry, 'sequence'>[];
        view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>;
      }
    | {
        type: 'run.attempt-continued';
        current: RunCurrent;
        attempt: import('./run-state.ts').RunAttempt;
        context: import('./run-attempt.ts').RunAttemptContext;
        goal: Goal;
        entries: Omit<RunTimelineEntry, 'sequence'>[];
        view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>;
      }
    | { type: 'run.changed'; run: Run; goal: Goal; roles?: Role[] };
};
export type ExecutionPolicyView = {
  scope: WorkScope;
  checks: { id: string; title: string }[];
  defaultCheckIds: string[];
  maxWorkers?: number;
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
  effectivePolicy?: import('./autonomy.ts').EffectivePolicy;
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
  runtimePreference?: RuntimePreference;
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
