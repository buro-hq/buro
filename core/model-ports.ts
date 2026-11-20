import type { RuntimePurpose } from '../protocol/resources.ts';
import type { ManagedWorkSegments } from './work-segments.ts';
import type { ManagedWorkerStepChecks } from './worker-step-checks.ts';

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export type ModelToolCall = { id: string; name: string; arguments: unknown };
/** Private conversation/checkpoint data, never a public domain event. */
export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
  toolName?: string;
  continuation?: unknown;
};
export type ModelUsage = { inputTokens?: number; outputTokens?: number };
export type ModelContext = {
  phase: 'work' | 'final';
  /** Core-owned completion-note indexes from the private checkpoint, never model-generated tags. */
  intermediateMessageIndexes?: readonly number[];
};
export interface ModelProvider {
  readonly id: string;
  readonly revision: string;
  readonly local: boolean;
  readonly structuredToolMode?: 'combined' | 'separate-turn';
  /** Provider-specific request view; the core supplies a clone of the full private history. */
  contextMessages?(messages: readonly ModelMessage[], context?: ModelContext): ModelMessage[];
  complete(input: {
    requestId: string;
    model: string;
    messages: ModelMessage[];
    tools: ToolDefinition[];
    schema: unknown;
    maxOutputTokens: number;
    contextTokens: number;
    signal: AbortSignal;
    onProgress: () => void;
  }): Promise<{
    message: ModelMessage & { role: 'assistant' };
    model: string;
    usage?: ModelUsage;
    finish: 'stop' | 'tools' | 'length' | 'failed';
  }>;
}
export type ToolScope = {
  projectId: string;
  runId?: string;
  ownerRunId?: string;
  sessionId: string;
  workspace: string;
  readOnly: boolean;
  allowedPaths: string[];
  protectedPaths: string[];
  materials: string[];
  commands: { id: string; command: string; timeoutMs: number }[];
  baseCommit?: string;
};
export type ToolResult = { content: string; isError?: boolean; exitCode?: number | null };
export interface ToolBroker {
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
    maxRequestsPerTurn: number;
    maxToolCallsPerTurn: number;
    maxSessionRequests: number;
  };
  providerId: string;
  providerRevision: string;
  requestedModel: string;
  reportedModel?: string;
  /** Service-owned immutable routing purpose; absent legacy values use the work allowance. */
  purpose?: RuntimePurpose;
  scope: ToolScope;
  assignment?: { roleId: string; allowedPaths: string[]; protectedPaths: string[] };
  scopeRevisions?: { revision: number; scope: ToolScope; instructions: string }[];
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
  generation?: { requestId: string; outcome: 'pending' | 'completed' | 'unknown' };
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
};
export interface ManagedSessionStore {
  load(id: string): Promise<ManagedSession | undefined>;
  save(session: ManagedSession): Promise<void>;
}
