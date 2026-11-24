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
  access?: SessionAccess;
}

/** Explicit access inherited by collaborators, unrelated to agent names or instructions. */
export interface SessionAccess {
  readOnly?: boolean;
  tools?: string[];
}

/** Shared conversation content with adapter provenance for private continuation data. */
export interface SessionMessage extends Omit<ModelMessage, 'continuation'> {
  id?: string;
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
  access?: SessionAccess;
}

/** Waiting may be unavailable without failing the caller's conversation. */
export interface SessionWaitResult {
  ok: boolean;
  session?: Session;
  error?: string;
  interrupted?: boolean;
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
  /** Waits for an active turn, then returns the saved conversation. */
  wait(input: { id: string; callerId?: string; signal?: AbortSignal }): Promise<SessionWaitResult>;
  /** Lists conversations, optionally by attempt. */
  list(input?: { runId?: string }): Promise<Session[]>;
  /** Marks turns abandoned by a previous server process interrupted. */
  recover(): Promise<void>;
  /** Removes an inactive conversation. */
  delete(input: { id: string }): Promise<boolean>;
  /** Executes a model/tool turn. */
  run(input: SessionTurn): Promise<SessionResult>;
  /** Changes the next model while keeping the conversation. */
  switchModel(input: { sessionId: string; modelId: string }): Promise<boolean>;
  /** Requests cancellation. */
  interrupt(input: { sessionId: string }): void;
  /** Cancels and joins active conversations before their owner or storage closes. */
  close(input?: { runId?: string }): Promise<void>;
}
