import { OpenAICompatibleProvider } from '../../agent/providers/openai-compatible.ts';
import { OllamaProvider } from '../../agent/providers/ollama.ts';
import { RequestGate } from '../../agent/providers/http.ts';
import type { ModelTransport } from './model-configuration.ts';

/** Supplies the existing portable transports; callers can register additional implementations. */
export function modelTransports(input: { fetch?: typeof fetch } = {}): ModelTransport[] {
  const request = input.fetch ?? fetch;
  return [
    {
      id: 'openai-compatible',
      create({ configuration: config, apiKey }) {
        return new OpenAICompatibleProvider({
          id: config.id,
          revision: config.revision,
          local: config.local,
          endpoint: config.endpoint,
          fetch: request,
          apiKey: apiKey ? () => apiKey : undefined,
          gate: new RequestGate(config.capacity ?? (config.local ? 1 : 2)),
          enableThinking: config.local ? config.thinking : undefined,
          reasoningEffort: config.reasoningEffort,
          reasoningBudgetTokens: config.reasoningBudgetTokens,
          sampling: config.sampling,
        });
      },
    },
    {
      id: 'ollama',
      create({ configuration: config }) {
        return new OllamaProvider({
          id: config.id,
          revision: config.revision,
          local: config.local,
          endpoint: config.endpoint,
          fetch: request,
          gate: new RequestGate(config.capacity ?? 1),
          think: config.thinking,
          sampling: config.sampling,
        });
      },
    },
  ];
}
