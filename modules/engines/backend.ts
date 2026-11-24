import type {
  ModelCompletion,
  ModelMessage,
  ModelProvider,
  ModelToolCall,
} from '../../agent/contracts/model.ts';
import type { ToolResult } from '../tools/tool.ts';

type ModelRequest = Parameters<ModelProvider['complete']>[0];

/** A request can target a model API or a native agent process in the same conversation. */
export interface BackendRequest extends ModelRequest {
  sessionId: string;
  workspace: string;
  readOnly?: boolean;
  /** Dispatches a native backend's tools through the host's history and access boundary. */
  executeTool(call: ModelToolCall): Promise<ToolResult>;
}

/** Native execution context stays out of portable HTTP model transport contracts. */
export interface SessionBackend {
  readonly id: string;
  readonly revision: string;
  /** Projects adapter-owned context without changing shared history. */
  contextMessages?(messages: readonly ModelMessage[]): ModelMessage[];
  /** Completes a host request, optionally calling registered tools through the callback. */
  complete(input: BackendRequest): Promise<ModelCompletion>;
}
