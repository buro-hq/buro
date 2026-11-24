import type { ModelMessage, ModelUsage } from '../../agent/contracts/model.ts';
import type { RecordStore } from '../storage/record-store.ts';

/** A portable conversation whose identity does not change when its model changes. */
export interface Session {
  id: string;
  runId?: string;
  parentId?: string;
  agentId?: string;
  modelId: string;
  instructions: string;
  messages: SessionMessage[];
  status: string;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
  usage?: ModelUsage;
}

/** Shared conversation content with adapter provenance for private continuation data. */
export interface SessionMessage extends Omit<ModelMessage, 'continuation'> {
  modelId?: string;
}

/** Stores conversations without embedding run admission or workflow state. */
export interface SessionStore extends RecordStore<Session> {}

/** A completed turn or an expected inability to proceed. */
export interface SessionResult {
  ok: boolean;
  sessionId: string;
  text?: string;
  error?: string;
  interrupted?: boolean;
}

/** Describes a new portable conversation. */
export interface SessionInput {
  modelId?: string;
  instructions?: string;
  runId?: string;
  parentId?: string;
  agentId?: string;
  messages?: ModelMessage[];
}

/** Options apply to one invocation, not a role or a frozen workflow. */
export interface SessionTurn {
  sessionId: string;
  input: string;
  modelId?: string;
  workspace: string;
  projectId?: string;
  readOnly?: boolean;
  tools?: string[];
  schema?: unknown;
  signal?: AbortSignal;
  maxRequests?: number;
}

/** A public conversation API independent of a particular loop implementation. */
export interface Sessions {
  /** Creates an idle conversation. */
  create(input?: SessionInput): Promise<SessionResult>;
  /** Reads public history. */
  get(input: { id: string }): Promise<Session | undefined>;
  /** Lists conversations, optionally by attempt. */
  list(input?: { runId?: string }): Promise<Session[]>;
  /** Removes an inactive conversation. */
  delete(input: { id: string }): Promise<boolean>;
  /** Executes a model/tool turn. */
  run(input: SessionTurn): Promise<SessionResult>;
  /** Changes the next model while keeping the conversation. */
  switchModel(input: { sessionId: string; modelId: string }): Promise<boolean>;
  /** Requests cancellation. */
  interrupt(input: { sessionId: string }): void;
}
