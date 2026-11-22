import type { ProviderContribution } from '../../../core/resource-contributions.ts';
import { DeepSeekConnectionConfigSchema } from '../../../protocol/resource-builtins.ts';
import { modelEndpointURL } from '../../../protocol/endpoint-trust.ts';
import { DeepSeekProvider } from '../../models/deepseek.ts';

export function deepseekContribution(): ProviderContribution {
  return {
    id: 'deepseek',
    label: 'DeepSeek',
    revision: 'deepseek-contribution-v1',
    editor: 'deepseek',
    defaultConfig: DeepSeekConnectionConfigSchema.parse({}),
    parse: (config) => DeepSeekConnectionConfigSchema.parse(config),
    describe: (input) => {
      const config = DeepSeekConnectionConfigSchema.parse(input);
      const endpoint = modelEndpointURL(config.endpoint);
      return {
        local: false,
        endpoint: endpoint.href,
        capacityKey: `deepseek:${endpoint.href}`,
        capacity: config.capacity,
        credentialReferences: [config.apiKeyEnv],
        modelListing: true,
      };
    },
    create: ({ id, config: input, fetch, gate, credentials }) => {
      const config = DeepSeekConnectionConfigSchema.parse(input);
      const provider = new DeepSeekProvider({
        ...config,
        id,
        fetch,
        gate,
        apiKey: () => credentials(config.apiKeyEnv),
      });
      return { provider, listModels: (signal) => provider.listModels(signal) };
    },
  };
}
