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
/** Server-reported durations in seconds; absent fields are unknown, never client estimates. */
export interface ModelTiming {
  totalSeconds?: number;
  loadSeconds?: number;
  inputSeconds?: number;
  outputSeconds?: number;
}
/** A discoverable model identifier, without connection credentials. */
export interface AvailableModel {
  id: string;
  name?: string;
}
export type ModelFinish = 'stop' | 'tools' | 'length' | 'failed';
/** A complete normalized response, including private host-owned continuation. */
export type ModelCompletion = {
  message: ModelMessage & { role: 'assistant' };
  model: string;
  usage?: ModelUsage;
  timing?: ModelTiming;
  finish: ModelFinish;
};
/**
 * Public response observations, not durable receipts or authority to dispatch a tool.
 * Text is provisional until a validated response terminal; reasoning and private
 * continuation never appear here. Usage is emitted only when actually reported.
 */
export type ModelStreamEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'usage'; usage: ModelUsage }
  /** An observed wire terminal, including incomplete output, never goal acceptance. */
  | { type: 'response.completed'; model: string; finish: ModelFinish };
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
  /** Tools-free response grammar is sent natively in schema mode; omitted means instruction guidance. */
  readonly structuredOutputMode?: 'schema' | 'instruction';
  /** Lists model identifiers when the transport provides a catalogue. */
  listModels?(signal: AbortSignal): Promise<AvailableModel[]>;
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
    /** Best-effort observer: implementations isolate callback errors from the request outcome. */
    onEvent?: (event: ModelStreamEvent) => void;
  }): Promise<ModelCompletion>;
}
