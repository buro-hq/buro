import type { ToolDefinition } from '../../agent/contracts/model.ts';

/** Access applies to a concrete invocation, independently of an agent's display name. */
export interface ToolContext {
  sessionId: string;
  runId?: string;
  projectId?: string;
  workspace: string;
  readOnly?: boolean;
  signal: AbortSignal;
}

/** An observed tool outcome; ordinary command or input errors return feedback to the model. */
export interface ToolResult {
  content: string;
  isError?: boolean;
  exitCode?: number;
}

/** A tool's description and execution belong to the same independently registered module. */
export interface Tool {
  definition: ToolDefinition;
  effect: 'read' | 'write' | 'command';
  /** Executes validated input in the invocation's workspace. */
  execute(input: { arguments: unknown; context: ToolContext }): Promise<ToolResult>;
}

/** Public tool discovery and dispatch, independent of its registry implementation. */
export interface Tools {
  /** Registers or replaces a tool. */
  register(tool: Tool): void;
  /** Describes tools available to this invocation. */
  definitions(input?: { names?: string[]; readOnly?: boolean }): ToolDefinition[];
  /** Executes one advertised action and returns expected failures as feedback. */
  execute(input: { name: string; arguments: unknown; context: ToolContext; names?: string[] }): Promise<ToolResult>;
}

/** An expected tool failure that should be shown to the agent as feedback. */
export class ToolFailure extends Error {}
