import type { WorkScope } from '../protocol/work-scope.ts';
import type { RuntimePurpose } from '../protocol/resources.ts';
import type { ManagedWorkSegments } from './work-segments.ts';
import type { ManagedWorkerStepChecks } from './worker-step-checks.ts';
import type {
  ModelMessage,
  ModelCompletion,
  ModelToolCall,
  ModelUsage,
  ToolDefinition,
} from '../agent/contracts/model.ts';
export type ToolScope = {
  projectId: string;
  runId?: string;
  ownerRunId?: string;
  sessionId: string;
  workspace: string;
  /** Host-issued frozen source view, valid only for its active read-only review session. */
  verificationViewId?: string;
  verificationTree?: string;
  readOnly: boolean;
  writeScope: WorkScope;
  materials: string[];
  commands: { id: string; command: string; timeoutMs: number }[];
  baseCommit?: string;
};
export type ToolResult = { content: string; isError?: boolean; exitCode?: number | null };
export type ToolEffect = 'read' | 'write' | 'command';
/** A completed model proposal rejected before any tool intent, reservation or dispatch. */
export type RejectedToolBatch = {
  requestId: string;
  turnId: string;
  scopeRevision: number;
  requestedAtRequest: number;
  availableTools: string[];
  response: ModelCompletion;
};
export interface ToolBroker {
  readonly revision: string;
  effect(name: string): ToolEffect;
  definitions(scope: ToolScope): ToolDefinition[];
  execute(
    call: ModelToolCall,
    scope: ToolScope,
    options: { actionId: string; signal: AbortSignal; onCommandStart?: (command: string) => void },
  ): Promise<ToolResult>;
}
export type ManagedSession = {
  version: 1;
  id: string;
  runtimeId: string;
  limits: {
    contextTokens: number;
    maxOutputTokens: number;
    maxRequestsPerTurn?: number;
    maxToolCallsPerTurn?: number;
    maxSessionRequests?: number;
    maxFeedbackSteps?: number;
  };
  providerId: string;
  providerRevision: string;
  toolRevision: string;
  requestedModel: string;
  reportedModel?: string;
  /** Service-owned immutable routing purpose; generic runtime starts may omit it. */
  purpose?: RuntimePurpose;
  scope: ToolScope;
  assignment?: { roleId: string; scope: WorkScope };
  scopeRevisions: { revision: number; scope: ToolScope; instructions: string }[];
  /** Service-owned per-turn authority; persisted before generation and never model-controlled. */
  turnAuthorities?: {
    turnId: string;
    toolPolicy: 'none' | 'normal';
    startedAtRequest: number;
    scopeRevision: number;
  }[];
  messages: ModelMessage[];
  intermediateNotes?: number[];
  /** Atomic private archive and active context; never part of a public session DTO. */
  workSegments?: ManagedWorkSegments;
  workerStepChecks?: ManagedWorkerStepChecks;
  /** Segmented sessions fail closed after an unknown generation, including a lost closing reply. */
  generation?: {
    requestId: string;
    outcome: 'pending' | 'completed' | 'unknown';
    /** Private normalized response, durable before usage settlement or tool dispatch. */
    response?: {
      message: ModelMessage & { role: 'assistant' };
      model: string;
      usage?: ModelUsage;
      finish: 'stop' | 'tools' | 'length' | 'failed';
    };
    /** Exact batch admitted atomically with these new tool intents; absent means unadmitted. */
    admittedActionIds?: string[];
    rejectionCode?: string;
  };
  status: 'ready' | 'running' | 'interrupted' | 'failed';
  cancelRequested?: boolean;
  requests: number;
  usage: { requestsWithUsage: number; inputTokens: number; outputTokens: number };
  actions: {
    id: string;
    turnId: string;
    call: ModelToolCall;
    status: 'pending' | 'completed' | 'unknown';
    result?: ToolResult;
  }[];
  rejectedToolBatches?: RejectedToolBatch[];
};
export interface ManagedSessionStore {
  load(id: string): Promise<ManagedSession | undefined>;
  save(session: ManagedSession): Promise<void>;
}
