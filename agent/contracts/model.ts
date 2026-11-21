/** Model transport contracts independent of any application, framework or platform. */
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
  /** Host-owned completion-note indexes from the private checkpoint, never model-generated tags. */
  intermediateMessageIndexes?: readonly number[];
};
export interface ModelProvider {
  readonly id: string;
  readonly revision: string;
  readonly local: boolean;
  readonly structuredToolMode?: 'combined' | 'separate-turn';
  /** Provider-specific request view; the host supplies a clone of the full private history. */
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
