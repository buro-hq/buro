import { ResourceContributionCatalog } from '../../core/resource-contributions.ts';
import { DomainError } from '../../core/ports.ts';
import {
  OllamaConnectionConfigSchema,
  DeepSeekConnectionConfigSchema,
  ManagedRuntimeConfigSchema,
  NativeRuntimeConfigSchema,
} from '../../protocol/resource-builtins.ts';
import { endpointIsLocal, modelEndpointURL } from '../../protocol/endpoint-trust.ts';

/** Explicit semantic registrations for persistence tests; never launches a provider or process. */
export function testResourceContributions() {
  const catalog = new ResourceContributionCatalog();
  const unused = (): never => {
    throw Error('Persistence fixture cannot create execution adapters.');
  };
  catalog.registerProvider({
    id: 'ollama',
    label: 'Ollama',
    revision: 'fixture-ollama-v1',
    defaultConfig: {},
    parse: (value) => OllamaConnectionConfigSchema.parse(value),
    describe: (value) => {
      const config = OllamaConnectionConfigSchema.parse(value);
      return {
        local: endpointIsLocal(modelEndpointURL(config.endpoint), config.trust),
        endpoint: config.endpoint,
        capacityKey: `ollama:${modelEndpointURL(config.endpoint).href}`,
        capacity: config.capacity,
        credentialReferences: [],
        modelListing: true,
      };
    },
    describeModel: (value, model) => {
      const config = OllamaConnectionConfigSchema.parse(value);
      const cloud = /(?:[:_-]cloud)(?:$|:)/i.test(model);
      return {
        local: !cloud && endpointIsLocal(modelEndpointURL(config.endpoint), config.trust),
        supported: !cloud,
        ...(cloud ? { reason: 'Cloud-backed models are not enabled by this provider.' } : {}),
      };
    },
    create: unused,
  });
  catalog.registerProvider({
    id: 'deepseek',
    label: 'DeepSeek',
    revision: 'fixture-deepseek-v1',
    defaultConfig: {},
    parse: (value) => DeepSeekConnectionConfigSchema.parse(value),
    describe: (value) => {
      const config = DeepSeekConnectionConfigSchema.parse(value);
      return {
        local: false,
        endpoint: config.endpoint,
        capacityKey: `deepseek:${modelEndpointURL(config.endpoint).href}`,
        capacity: config.capacity,
        credentialReferences: [config.apiKeyEnv],
        modelListing: true,
      };
    },
    create: unused,
  });
  catalog.registerBackend({
    id: 'codex',
    label: 'Codex',
    revision: 'fixture-codex-v1',
    defaultConfig: {},
    parse: (value) => NativeRuntimeConfigSchema.parse(value),
    dependencies: () => [],
    describe: () => ({ local: false }),
    create: unused,
  });
  catalog.registerBackend({
    id: 'managed',
    label: 'Managed',
    revision: 'fixture-managed-v1',
    defaultConfig: {},
    parse: (value) => ManagedRuntimeConfigSchema.parse(value),
    dependencies: (value) => [ManagedRuntimeConfigSchema.parse(value).connectionId],
    describe: (value, providers) => {
      const config = ManagedRuntimeConfigSchema.parse(value);
      const provider = providers.get(config.connectionId)!;
      const model = provider.describeModel!(config.model);
      if (!model.supported)
        throw new DomainError(
          'MODEL_REMOTE_ROUTE',
          'Cloud-backed Ollama models are not enabled by this local-model adapter.',
        );
      return { local: model.local };
    },
    create: unused,
  });
  return catalog.seal();
}
