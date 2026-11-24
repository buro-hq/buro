import type { ModelProvider, ModelMessage } from '../../agent/contracts/model.ts';

/** Private transport state belongs to its model adapter, not public history. */
export interface AdapterState {
  id: string;
  sessionId: string;
  messageId: string;
  modelId: string;
  providerRevision: string;
  continuation: unknown;
}

/** A selected model and transport, independent of agent names. */
export interface Model {
  id: string;
  name: string;
  provider: ModelProvider;
  model: string;
  contextTokens: number;
  outputTokens: number;
}

/** Public metadata without transports or credential resolvers. */
export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
  model: string;
  contextTokens: number;
  outputTokens: number;
}

/** Model routing and adapter-owned conversation context. */
export interface Models {
  /** Registers a model and optionally selects the application default. */
  register(input: Model & { default?: boolean }): void;
  /** Resolves an explicit ID, or the default when omitted. */
  get(input?: { id?: string }): Model | undefined;
  /** Lists safe selector metadata. */
  list(): ModelInfo[];
  /** Changes the default for new sessions. */
  select(input: { id: string }): boolean;
  /** Removes a model from future routing; stored conversations remain. */
  remove(input: { id: string }): void;
  /** Saves a response's private adapter state. */
  remember(input: {
    sessionId: string;
    messageId: string;
    modelId: string;
    providerRevision: string;
    continuation: unknown;
  }): Promise<void>;
  /** Attaches state owned by the selected adapter to a detached request view. */
  context(input: {
    sessionId: string;
    modelId: string;
    providerRevision: string;
    messages: (ModelMessage & { id?: string })[];
  }): Promise<ModelMessage[]>;
}
