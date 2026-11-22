import { ResourceConfigurationSchema } from '../../adapters/files/resource-configuration.ts';
import {
  OllamaConnectionConfigSchema,
  DeepSeekConnectionConfigSchema,
  NativeRuntimeConfigSchema,
} from '../../protocol/resource-builtins.ts';

/** Explicit configured machine for synthetic tests, never a production startup default. */
export function fixtureResources() {
  return ResourceConfigurationSchema.parse({
    version: 1,
    defaultProfile: 'codex',
    connections: [
      { id: 'ollama', provider: 'ollama', config: OllamaConnectionConfigSchema.parse({}) },
      { id: 'deepseek', provider: 'deepseek', config: DeepSeekConnectionConfigSchema.parse({}) },
    ],
    runtimes: [{ id: 'codex', backend: 'codex', config: NativeRuntimeConfigSchema.parse({}) }],
    profiles: [
      {
        id: 'codex',
        name: 'Codex',
        policy: 'hybrid',
        coordinator: 'codex',
        worker: 'codex',
        reviewer: 'codex',
      },
    ],
  });
}
