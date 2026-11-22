import type { ProviderContribution } from '../../../core/resource-contributions.ts';
import { OllamaConnectionConfigSchema } from '../../../protocol/resource-builtins.ts';
import { endpointIsLocal, modelEndpointURL } from '../../../protocol/endpoint-trust.ts';
import { OllamaProvider } from '../../models/ollama.ts';

export function ollamaContribution(): ProviderContribution {
  return {
    id: 'ollama',
    label: 'Ollama',
    revision: 'ollama-contribution-v1',
    editor: 'ollama',
    defaultConfig: OllamaConnectionConfigSchema.parse({}),
    parse: (config) => OllamaConnectionConfigSchema.parse(config),
    describeModel: (input, model) => {
      const config = OllamaConnectionConfigSchema.parse(input);
      const remote = /(?:[:_-]cloud)(?:$|:)/i.test(model);
      return {
        supported: !remote,
        local: !remote && endpointIsLocal(modelEndpointURL(config.endpoint), config.trust),
        ...(remote
          ? { reason: 'Cloud-backed Ollama models are not supported by this provider.' }
          : {}),
      };
    },
    describe: (input) => {
      const config = OllamaConnectionConfigSchema.parse(input);
      const endpoint = modelEndpointURL(config.endpoint);
      return {
        local: endpointIsLocal(endpoint, config.trust),
        endpoint: endpoint.href,
        capacityKey: `ollama:${endpoint.href}`,
        capacity: config.capacity,
        credentialReferences: [],
        modelListing: true,
      };
    },
    create: ({ id, config: input, fetch, gate }) => {
      const config = OllamaConnectionConfigSchema.parse(input);
      const provider = new OllamaProvider({ id, ...config, fetch, gate });
      return { provider, listModels: (signal) => provider.listModels(signal) };
    },
  };
}
