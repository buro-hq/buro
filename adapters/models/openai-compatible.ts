import { createHash } from 'node:crypto';
import type { ModelProvider } from '../../agent/contracts/model.ts';
import { OpenAICompatibleProvider as Transport } from '../../agent/providers/openai-compatible.ts';
import {
  OpenAICompatibleConnectionConfigSchema,
  type OpenAICompatibleConnectionConfig,
} from '../../protocol/resource-builtins.ts';
import { endpointIsLocal, modelEndpointURL } from '../../protocol/endpoint-trust.ts';
import { DomainError } from '../../core/ports.ts';
import { providerOperation } from './provider-failures.ts';
import type { HttpOptions } from './http.ts';

type Options = HttpOptions &
  Partial<OpenAICompatibleConnectionConfig> & {
    id: string;
    apiKey?: () => string | undefined;
  };
/** OpenAI Chat Completions protocol, with host-owned trust and credential references. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly structuredToolMode = 'separate-turn' as const;
  readonly structuredOutputMode: 'schema' | 'instruction';
  readonly id: string;
  readonly revision: string;
  readonly local: boolean;
  private transport: Transport;
  constructor(options: Options) {
    const { id, fetch: injectedFetch, gate, apiKey, ...input } = options;
    const parsed = OpenAICompatibleConnectionConfigSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(
        'INVALID_ENDPOINT',
        'Invalid OpenAI-compatible connection configuration.',
      );
    const config = parsed.data;
    if (config.apiKeyEnv && !apiKey)
      throw new DomainError('MODEL_AUTH_REQUIRED', 'The configured API credential is unavailable.');
    const endpoint = modelEndpointURL(config.endpoint);
    this.id = id;
    this.local = endpointIsLocal(endpoint, config.trust);
    this.structuredOutputMode = config.responseFormat === 'json_schema' ? 'schema' : 'instruction';
    this.revision = createHash('sha256')
      .update(JSON.stringify(['openai-compatible-v1', { ...config, endpoint: endpoint.href }]))
      .digest('hex');
    this.transport = new Transport({
      ...config,
      id,
      revision: this.revision,
      local: this.local,
      apiKey,
      fetch: injectedFetch || fetch,
      gate,
    });
  }
  listModels(signal: AbortSignal) {
    return providerOperation(() => this.transport.listModels(signal));
  }
  complete(input: Parameters<ModelProvider['complete']>[0]) {
    return providerOperation(() => this.transport.complete(input));
  }
}
