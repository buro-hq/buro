import type {
  ModelCompletion,
  ModelProvider,
  AvailableModel,
} from '../../agent/contracts/model.ts';
import type { BackendRequest, SessionBackend } from './backend.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { isProviderFailure } from '../../agent/contracts/provider-errors.ts';
import { observer } from '../../agent/providers/http.ts';

/** Reuses portable model transports without giving them filesystem or process responsibilities. */
export class ModelBackend implements SessionBackend {
  readonly id: string;
  readonly revision: string;
  readonly inputUsageScope = 'prompt' as const;
  private provider: ModelProvider;
  private retries: number;
  private retryDelayMs: number;

  /** Keeps the transport private to the backend implementation. */
  constructor(input: { provider: ModelProvider; retries?: number; retryDelayMs?: number }) {
    this.provider = input.provider;
    this.id = input.provider.id;
    this.revision = input.provider.revision;
    this.retries = input.retries ?? 2;
    this.retryDelayMs = input.retryDelayMs ?? 250;
    const hasWholeRetries = Number.isSafeInteger(this.retries);
    const hasNonnegativeRetries = this.retries >= 0;
    if (!hasWholeRetries || !hasNonnegativeRetries)
      throw new Error('HTTP retries must be a nonnegative integer.');
  }

  /** Delegates optional transport metadata discovery. */
  async listModels(input: { signal: AbortSignal }): Promise<AvailableModel[]> {
    if (!this.provider.listModels)
      return [];

    return this.provider.listModels(input.signal);
  }

  /** Sends only portable request fields to the model provider. */
  async complete(input: BackendRequest): Promise<ModelCompletion> {
    const {
      sessionId: _sessionId,
      workspace: _workspace,
      readOnly: _readOnly,
      executeTool: _executeTool,
      onRetry,
      ...request
    } = input;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.provider.complete({
          ...request,
          messages: structuredClone(request.messages),
          tools: structuredClone(request.tools),
          schema: structuredClone(request.schema),
        });
      } catch (error) {
        const wasAborted = request.signal.aborted;
        const retriesExhausted = attempt >= this.retries;
        const isTemporaryFailure = isProviderFailure(error) &&
          ['MODEL_STREAM_INTERRUPTED', 'MODEL_UNAVAILABLE', 'MODEL_RESPONSE_LIMIT', 'MODEL_INVALID_RESPONSE'].includes(error.code);
        if (wasAborted || retriesExhausted || !isTemporaryFailure)
          throw error;

        const delayMs = Math.min(30000, this.retryDelayMs * 2 ** attempt);
        observer(() => onRetry?.({
          attempt: attempt + 1,
          errorCode: error.code,
          delayMs,
        }));
        await delay(delayMs, undefined, {
          signal: request.signal,
        });
      }
    }
  }
}
