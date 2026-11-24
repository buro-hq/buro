import type { ModelCompletion, ModelMessage, ModelProvider } from '../../agent/contracts/model.ts';
import type { BackendRequest, SessionBackend } from './backend.ts';

/** Reuses portable model transports without giving them filesystem or process responsibilities. */
export class ModelBackend implements SessionBackend {
  readonly id: string;
  readonly revision: string;
  private provider: ModelProvider;

  /** Keeps the transport private to the backend implementation. */
  constructor(input: { provider: ModelProvider }) {
    this.provider = input.provider;
    this.id = input.provider.id;
    this.revision = input.provider.revision;
  }

  /** Delegates provider-specific request projection. */
  contextMessages(messages: readonly ModelMessage[]): ModelMessage[] {
    return this.provider.contextMessages?.(messages) ?? structuredClone([...messages]);
  }

  /** Sends only portable request fields to the model provider. */
  async complete(input: BackendRequest): Promise<ModelCompletion> {
    const {
      sessionId: _sessionId,
      workspace: _workspace,
      readOnly: _readOnly,
      executeTool: _executeTool,
      ...request
    } = input;
    return this.provider.complete(request);
  }
}
