import { createHash } from 'node:crypto';
import { DomainError } from '../../core/ports.ts';
import { recordTurnOutcome } from '../../core/run-reconciliation.ts';
import {
  endpointIsLocal,
  modelEndpointURL,
  type EndpointTrust,
} from '../../protocol/endpoint-trust.ts';
import type { ModelContext, ModelMessage, ModelProvider } from '../../agent/contracts/model.ts';
import { OllamaProvider as NeutralOllamaProvider } from '../../agent/providers/ollama.ts';
import { providerOperation } from './provider-failures.ts';
import type { HttpOptions } from './http.ts';
import type { ModelSamplingSettings } from '../../agent/providers/sampling.ts';

type Options = HttpOptions & {
  id: string;
  think?: boolean | string;
  trust?: EndpointTrust;
  sampling?: ModelSamplingSettings;
};
/** Buro owns identity, data policy and preflight; portable code owns the actual model protocol. */
export class OllamaProvider implements ModelProvider {
  readonly structuredToolMode = 'separate-turn' as const;
  readonly structuredOutputMode = 'schema' as const;
  readonly id: string;
  readonly revision: string;
  readonly local: boolean;
  private options: Options;
  private transport: NeutralOllamaProvider;
  constructor(options: Options) {
    let url: URL;
    try {
      url = modelEndpointURL(options.endpoint);
      this.local = endpointIsLocal(url, options.trust);
    } catch (error) {
      throw new DomainError(
        'INVALID_ENDPOINT',
        error instanceof Error ? error.message : 'Invalid model endpoint.',
      );
    }
    this.options = {
      ...options,
      endpoint: url.href,
      ...(options.sampling ? { sampling: { ...options.sampling } } : {}),
    };
    this.id = options.id;
    this.revision = createHash('sha256')
      .update(
        JSON.stringify([
          'ollama-native-v2',
          url.href,
          options.think ?? 'model-default',
          ...(options.trust && options.trust !== 'auto' ? [options.trust] : []),
          ...(options.sampling ? ['sampling', options.sampling] : []),
        ]),
      )
      .digest('hex');
    this.transport = new NeutralOllamaProvider({
      ...this.options,
      id: this.id,
      revision: this.revision,
      local: this.local,
      fetch: options.fetch || fetch,
    });
  }
  contextMessages(messages: readonly ModelMessage[], context?: ModelContext) {
    return this.transport.contextMessages(messages, context);
  }
  listModels(signal: AbortSignal) {
    return providerOperation(() => this.transport.listModels(signal));
  }
  inspect(model: string, signal: AbortSignal) {
    return providerOperation(() => this.transport.inspect(model, signal));
  }
  async complete(input: Parameters<ModelProvider['complete']>[0]) {
    // A metadata request cannot have dispatched a generation. Its own network outcome
    // never poisons a generation journal before api/chat has actually been called.
    const info = await providerOperation(
      () => this.transport.inspect(input.model, input.signal),
      'not-dispatched',
    );
    const reject = (code: string, message: string): never => {
      throw recordTurnOutcome(new DomainError(code, message), 'not-dispatched');
    };
    if (info.remote)
      reject(
        'MODEL_REMOTE_ROUTE',
        'Cloud-backed Ollama models are not enabled by this local-model adapter.',
      );
    if (
      this.options.think !== undefined &&
      info.thinkingValues.length &&
      !info.thinkingValues.includes(this.options.think)
    )
      reject('MODEL_UNSUPPORTED', 'This model does not support the selected thinking setting.');
    if (input.tools.length && !info.capabilities.includes('tools'))
      reject('MODEL_UNSUPPORTED', 'The installed Ollama model does not advertise tool calling.');
    if (info.contextTokens && input.contextTokens > info.contextTokens)
      reject('MODEL_CONTEXT_EXHAUSTED', 'The configured context exceeds this model capability.');
    return providerOperation(() => this.transport.complete(input));
  }
}
