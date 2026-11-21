import { createHash } from 'node:crypto';
import { DomainError } from '../../core/ports.ts';
import type { ModelProvider } from '../../agent/contracts/model.ts';
import { DeepSeekProvider as NeutralDeepSeekProvider } from '../../agent/providers/deepseek.ts';
import { endpointURL, type HttpOptions } from './http.ts';
import { providerFailure, providerOperation } from './provider-failures.ts';
type Options = HttpOptions & {
  id: string;
  apiKey: () => string | undefined;
  thinking?: 'enabled' | 'disabled';
};
/** The host supplies identity and credentials; protocol parsing is independently reusable. */
export class DeepSeekProvider implements ModelProvider {
  readonly id: string;
  readonly revision: string;
  readonly local = false;
  private transport: NeutralDeepSeekProvider;
  constructor(options: Options) {
    let endpoint: URL;
    try {
      endpoint = endpointURL(options.endpoint);
    } catch (error) {
      throw providerFailure(error);
    }
    if (
      endpoint.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    )
      throw new DomainError('INVALID_ENDPOINT', 'Remote DeepSeek endpoints require HTTPS.');
    this.id = options.id;
    this.revision = createHash('sha256')
      .update(JSON.stringify(['deepseek-chat-v2', endpoint.href, options.thinking ?? 'disabled']))
      .digest('hex');
    this.transport = new NeutralDeepSeekProvider({
      ...options,
      id: this.id,
      revision: this.revision,
      local: this.local,
      fetch: options.fetch || fetch,
    });
  }
  listModels(signal: AbortSignal) {
    return providerOperation(() => this.transport.listModels(signal));
  }
  complete(input: Parameters<ModelProvider['complete']>[0]) {
    return providerOperation(() => this.transport.complete(input));
  }
}
