import type { ModelMessage, ModelUsage } from '../../agent/contracts/model.ts';

/** A portable conversation whose identity does not change when its model changes. */
export interface Session {
  id: string;
  runId?: string;
  parentId?: string;
  agentId?: string;
  modelId: string;
  instructions: string;
  context?: string;
  messageCount: number;
  preview?: string;
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

/** A selected conversation loaded for execution, rather than a list projection. */
export interface SessionConversation extends Session {
  messages: SessionMessage[];
}

/** A bounded chronological page; cursors are stable message positions in this session. */
export interface SessionHistory {
  messages: SessionMessage[];
  start: number;
  total: number;
}

/** Selects recent history by default, or a window before/after a saved position. */
export interface SessionHistoryQuery {
  sessionId: string;
  before?: number;
  after?: number;
  limit?: number;
}

/** Stores metadata and messages independently, with atomic append and migration. */
export interface SessionStore {
  /** Reads metadata without fetching messages. */
  get(id: string): Promise<Session | undefined>;
  /** Selects metadata in storage by owner or current status. */
  list(input?: { runId?: string; status?: string }): Promise<Session[]>;
  /** Reads one bounded window. */
  history(input: SessionHistoryQuery): Promise<SessionHistory>;
  /** Loads one selected conversation for execution or copying. */
  load(id: string): Promise<SessionConversation | undefined>;
  /** Atomically commits metadata and only the supplied new messages. */
  append(input: { session: Session; messages: SessionMessage[] }): Promise<void>;
  /** Replaces a conversation for migration or interrupted-exchange repair. */
  replace(session: SessionConversation): Promise<void>;
  /** Changes metadata without overwriting unrelated concurrent fields. */
  patch(input: { id: string; changes: Partial<Omit<Session, 'id'>> }): Promise<Session | undefined>;
  /** Deletes metadata and its transcript together. */
  delete(id: string): Promise<void>;
  /** Idempotently moves histories saved before message separation. */
  migrate(): Promise<void>;
}

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
  context?: string;
  runId?: string;
  parentId?: string;
  agentId?: string;
  messages?: ModelMessage[];
  sourceSessionId?: string;
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
  /** Reads conversation metadata without loading its transcript. */
  get(input: { id: string }): Promise<Session | undefined>;
  /** Reads a bounded page of portable messages. */
  history(input: SessionHistoryQuery): Promise<SessionHistory>;
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
