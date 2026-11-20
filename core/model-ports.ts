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
export interface ModelProvider {
  readonly id: string;
  readonly revision: string;
  readonly local: boolean;
  readonly structuredToolMode?: 'combined' | 'separate-turn';
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
  scope: ToolScope;
  assignment?: { roleId: string; allowedPaths: string[]; protectedPaths: string[] };
  scopeRevisions?: { revision: number; scope: ToolScope; instructions: string }[];
  messages: ModelMessage[];
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
