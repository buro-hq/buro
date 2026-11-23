import type { ModelCompletion, ModelMessage, ModelToolCall, ToolDefinition } from './model.ts';

/** A detached scheduling view. The host retains the canonical request and its authority. */
export type AgentLoopRequest = {
  id: string;
  model: {
    id: string;
    providerId: string;
    contextTokens: number;
    maxOutputTokens: number;
  };
  messages: ModelMessage[];
  tools: ToolDefinition[];
};

/**
 * Returned only after the host has durably admitted or rejected the entire action batch.
 * Actions require a complete tools response. An incomplete response without
 * actions remains the host's advance decision, never an implicit SDK retry.
 */
export type AgentLoopBatch = {
  id: string;
  response: ModelCompletion;
  actions: { id: string; call: ModelToolCall }[];
  /** The host durably rejected every proposed tool, without admitting any action. */
  disposition?: 'tools-rejected';
};

export type AgentLoopActionResult = { content: string; isError?: boolean };
export type AgentLoopDecision = { kind: 'continue' } | { kind: 'yield' } | { kind: 'complete' };
export type AgentLoopResult = { kind: 'yield' } | { kind: 'complete' };

/**
 * The host is the sole request, action and lifecycle authority. Opaque IDs bind
 * callbacks to its saved records; scheduler copies never grant permission.
 */
export interface AgentLoopHost {
  prepare(): Promise<AgentLoopRequest>;
  generate(requestId: string): Promise<AgentLoopBatch>;
  /** Executes the original saved arguments, never arguments supplied by a scheduler. */
  execute(batchId: string, actionId: string): Promise<AgentLoopActionResult>;
  /** Called after every action has settled; the host decides whether context rotates. */
  advance(batchId: string): Promise<AgentLoopDecision>;
}

/**
 * Schedules one context window with sequential actions and no lifetime limit of
 * its own. A yield ends the scheduler window, not the host's logical turn.
 *
 * Host failures are rethrown unchanged after in-flight callbacks have settled.
 * Internal scheduler cancellation must never abort the supplied parent signal
 * or turn a host failure into model-visible tool feedback. Parent cancellation
 * stops further callbacks and still drains a callback already in flight.
 */
export interface AgentLoopRunner {
  run(host: AgentLoopHost, signal: AbortSignal): Promise<AgentLoopResult>;
}
