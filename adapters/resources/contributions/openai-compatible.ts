import type { ProviderContribution } from '../../../core/resource-contributions.ts';
import { OpenAICompatibleConnectionConfigSchema } from '../../../protocol/resource-builtins.ts';
import { endpointIsLocal, modelEndpointURL } from '../../../protocol/endpoint-trust.ts';
import { OpenAICompatibleProvider } from '../../models/openai-compatible.ts';

export function openAICompatibleContribution(): ProviderContribution {
  return {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    revision: 'openai-compatible-contribution-v1',
    defaultConfig: OpenAICompatibleConnectionConfigSchema.parse({}),
    parse: (config) => OpenAICompatibleConnectionConfigSchema.parse(config),
    describe: (input) => {
      const config = OpenAICompatibleConnectionConfigSchema.parse(input);
      const endpoint = modelEndpointURL(config.endpoint);
      return {
        local: endpointIsLocal(endpoint, config.trust),
        endpoint: endpoint.href,
        capacityKey: `openai-compatible:${endpoint.href}`,
        capacity: config.capacity,
        credentialReferences: config.apiKeyEnv ? [config.apiKeyEnv] : [],
        modelListing: true,
      };
    },
    create: ({ id, config: input, fetch, gate, credentials }) => {
      const config = OpenAICompatibleConnectionConfigSchema.parse(input);
      const provider = new OpenAICompatibleProvider({
        ...config,
        id,
        fetch,
        gate,
        ...(config.apiKeyEnv ? { apiKey: () => credentials(config.apiKeyEnv!) } : {}),
      });
      return { provider, listModels: (signal) => provider.listModels(signal) };
    },
  };
}
