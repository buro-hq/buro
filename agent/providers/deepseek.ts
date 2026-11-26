import { ProviderFailure } from '../contracts/provider-errors.ts';
import { endpointURL, type HttpOptions } from './http.ts';
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './openai-compatible.ts';

export type DeepSeekOptions = HttpOptions
  & Pick<OpenAICompatibleOptions, 'sampling' | 'reasoningBudgetTokens' | 'reasoningEffort' | 'maxResponseBytes'> & {
    id: string;
    revision: string;
    local: boolean;
    apiKey: () => string | undefined;
    thinking?: 'enabled' | 'disabled';
  };

/** DeepSeek keeps its required authentication and API dialect over the shared SSE transport. */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  protected override readonly authRequiredMessage =
    'Set the private DeepSeek API key before using this connection.';

  constructor(options: DeepSeekOptions) {
    const endpoint = endpointURL(options.endpoint);
    if (
      endpoint.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    )
      throw new ProviderFailure('INVALID_ENDPOINT', 'Remote DeepSeek endpoints require HTTPS.', {
        outcome: 'not-dispatched',
      });

    super({
      ...options,
      endpoint: endpoint.href,
      apiKey: () => options.apiKey(),
      responseFormat: 'json_object',
      structuredToolMode: 'combined',
      thinking: options.thinking ?? 'disabled',
    });
  }
}
