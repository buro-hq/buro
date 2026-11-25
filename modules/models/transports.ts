import { OpenAICompatibleProvider } from '../../agent/providers/openai-compatible.ts';
import { OllamaProvider } from '../../agent/providers/ollama.ts';
import { DeepSeekProvider } from '../../agent/providers/deepseek.ts';
import { RequestGate } from '../../agent/providers/http.ts';
import type { ModelTransport } from './model-configuration.ts';
import { ModelBackend } from '../engines/model-backend.ts';
import { CodexBackend } from '../engines/codex-backend.ts';

/** Supplies the existing portable transports; callers can register additional implementations. */
export function modelTransports(
  input: { fetch?: typeof fetch; privatePaths?: string[] } = {},
): ModelTransport[] {
  const request = input.fetch ?? fetch;
  return [
    {
      id: 'openai-compatible',
      name: 'OpenAI compatible',
      create({ configuration: config, apiKey }) {
        return new ModelBackend({
          retries: config.retries,
          provider: new OpenAICompatibleProvider({
            id: config.id,
            revision: config.revision,
            local: config.local,
            endpoint: config.endpoint ?? '',
            fetch: request,
            apiKey: apiKey ? () => apiKey : undefined,
            gate: new RequestGate(config.capacity ?? (config.local ? 1 : 2)),
            enableThinking: config.local ? config.thinking : undefined,
            reasoningEffort: config.reasoningEffort,
            reasoningBudgetTokens: config.reasoningBudgetTokens,
            sampling: config.sampling,
          }),
        });
      },
    },
    {
      id: 'ollama',
      name: 'Ollama',
      create({ configuration: config }) {
        return new ModelBackend({
          retries: config.retries,
          provider: new OllamaProvider({
            id: config.id,
            revision: config.revision,
            local: config.local,
            endpoint: config.endpoint ?? '',
            fetch: request,
            gate: new RequestGate(config.capacity ?? 1),
            think: config.thinking,
            sampling: config.sampling,
          }),
        });
      },
    },
    {
      id: 'codex',
      name: 'Codex',
      create({ configuration: config, apiKey }) {
        return new CodexBackend({
          id: config.id,
          revision: config.revision,
          apiKey,
          reasoningEffort: config.reasoningEffort,
          capacity: config.capacity,
          privatePaths: input.privatePaths,
        });
      },
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      create({ configuration: config, apiKey }) {
        return new ModelBackend({
          retries: config.retries,
          provider: new DeepSeekProvider({
            id: config.id,
            revision: config.revision,
            local: config.local,
            endpoint: config.endpoint ?? '',
            fetch: request,
            apiKey: () => apiKey,
            gate: new RequestGate(config.capacity ?? 2),
            thinking: config.thinking === false ? 'disabled' : 'enabled',
            reasoningEffort: config.reasoningEffort,
            reasoningBudgetTokens: config.reasoningBudgetTokens,
            sampling: config.sampling,
          }),
        });
      },
    },
  ];
}
