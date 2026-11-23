import type { ResourceContributionCatalog } from '../../../core/resource-contributions.ts';
import type { RuntimeHost, RuntimeHostOptions } from '../runtime-host.ts';
import { ollamaContribution } from './ollama.ts';
import { deepseekContribution } from './deepseek.ts';
import { openAICompatibleContribution } from './openai-compatible.ts';
import { codexContribution } from './codex.ts';
import { managedContribution } from './managed.ts';

export function registerBuiltinResources(
  catalog: ResourceContributionCatalog,
  options: RuntimeHostOptions,
  host: RuntimeHost,
) {
  catalog.registerProvider(ollamaContribution());
  catalog.registerProvider(deepseekContribution());
  catalog.registerProvider(openAICompatibleContribution());
  catalog.registerBackend(codexContribution(options));
  catalog.registerBackend(managedContribution(options, host));
}
