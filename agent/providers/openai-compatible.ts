import type { ModelProvider, ModelToolCall } from '../contracts/model.ts';
import {
  RequestGate,
  observer,
  encodeJSON,
  endpointURL,
  json,
  object,
  parseJSON,
  request,
  sse,
  tokenCount,
  type HttpOptions,
} from './http.ts';
import { ProviderFailure } from '../contracts/provider-errors.ts';
import { samplingParameters, type ModelSamplingSettings } from './sampling.ts';

export type OpenAICompatibleOptions = HttpOptions & {
  id: string;
  revision: string;
  local: boolean;
  apiKey?: () => string | undefined;
  responseFormat?: 'json_schema' | 'json_object' | 'instruction';
  maxTokenField?: 'max_tokens' | 'max_completion_tokens';
  reasoningEffort?: 'low' | 'medium' | 'high';
  enableThinking?: boolean;
  thinking?: 'enabled' | 'disabled';
  structuredToolMode?: 'combined' | 'separate-turn';
  sampling?: ModelSamplingSettings;
};
type Options = OpenAICompatibleOptions;
const failure = (
  code: string,
  message: string,
  outcome: 'not-dispatched' | 'rejected' | 'unknown' = 'unknown',
) => new ProviderFailure(code, message, { outcome });
export class OpenAICompatibleProvider implements ModelProvider {
  protected readonly authRequiredMessage: string =
    'Set the configured API key before using this connection.';
  readonly structuredToolMode: 'combined' | 'separate-turn';
  readonly structuredOutputMode: 'schema' | 'instruction';
  readonly id: string;
  readonly revision: string;
  readonly local: boolean;
  private options: Options;
  private gate: NonNullable<HttpOptions['gate']>;
  constructor(options: Options) {
    const endpoint = endpointURL(options.endpoint);
    this.options = {
      ...options,
      endpoint: endpoint.href,
      ...(options.sampling ? { sampling: { ...options.sampling } } : {}),
    };
    this.id = options.id;
    this.revision = options.revision;
    this.local = options.local;
    this.structuredToolMode = options.structuredToolMode ?? 'separate-turn';
    this.structuredOutputMode =
      (options.responseFormat ?? 'json_schema') === 'json_schema' ? 'schema' : 'instruction';
    this.gate = options.gate || new RequestGate(2);
  }
  private headers(): Record<string, string> {
    if (!this.options.apiKey) return { 'Content-Type': 'application/json' };
    let key: string | undefined;
    try {
      key = this.options.apiKey();
    } catch (cause) {
      throw new ProviderFailure(
        'MODEL_AUTH_REQUIRED',
        'The configured API credential is unavailable.',
        { outcome: 'not-dispatched', cause },
      );
    }
    if (typeof key !== 'string' || !key.trim() || /[\r\n\0]/.test(key))
      throw failure('MODEL_AUTH_REQUIRED', this.authRequiredMessage, 'not-dispatched');
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
  }
  async listModels(signal: AbortSignal) {
    return this.gate.run(signal, async () => {
      const body = object(
        await json(await request(this.options, 'models', { signal, headers: this.headers() })),
      );
      if (!Array.isArray(body.data))
        throw failure('MODEL_INVALID_RESPONSE', 'Model endpoint did not return a model list.');
      return body.data
        .map((raw) => object(raw))
        .filter((model) => typeof model.id === 'string')
        .map((model) => ({ id: model.id as string }));
    });
  }
  async complete(input: Parameters<ModelProvider['complete']>[0]) {
    return this.gate.run(input.signal, async () => {
      const emit = (event: import('../contracts/model.ts').ModelStreamEvent) => {
        if (input.onEvent) observer(() => input.onEvent?.(structuredClone(event)));
      };
      const messages = input.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: encodeJSON(call.arguments) },
              })),
            }
          : {}),
        ...(typeof object(message.continuation).reasoningContent === 'string'
          ? { reasoning_content: object(message.continuation).reasoningContent }
          : {}),
      }));
      const response = await request(this.options, 'chat/completions', {
        method: 'POST',
        signal: input.signal,
        headers: this.headers(),
        body: encodeJSON({
          model: input.model,
          messages,
          ...(input.tools.length
            ? { tools: input.tools.map((tool) => ({ type: 'function', function: tool })) }
            : {}),
          ...(input.schema != null &&
          (!input.tools.length || this.structuredToolMode === 'combined') &&
          this.options.responseFormat !== 'instruction'
            ? {
                response_format:
                  this.options.responseFormat === 'json_object'
                    ? { type: 'json_object' }
                    : {
                        type: 'json_schema',
                        json_schema: { name: 'response', strict: true, schema: input.schema },
                      },
              }
            : {}),
          [this.options.maxTokenField ?? 'max_tokens']: input.maxOutputTokens,
          ...samplingParameters(this.options.sampling),
          ...(this.options.thinking ? { thinking: { type: this.options.thinking } } : {}),
          ...(this.options.reasoningEffort
            ? { reasoning_effort: this.options.reasoningEffort }
            : {}),
          ...(this.options.enableThinking !== undefined
            ? { chat_template_kwargs: { enable_thinking: this.options.enableThinking } }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      let content = '',
        reasoning = '',
        done = false,
        finish = '',
        reportedModel = input.model;
      let inputTokens: number | undefined, outputTokens: number | undefined;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const data of sse(response, input.onProgress)) {
        if (data.trim() === '[DONE]') {
          done = true;
          break;
        }
        const chunk = object(parseJSON(data));
        if (chunk.error)
          throw failure('MODEL_REQUEST_REJECTED', 'Model endpoint returned a generation error.');
        if (typeof chunk.model === 'string') reportedModel = chunk.model;
        const usage = object(chunk.usage);
        inputTokens = tokenCount(usage.prompt_tokens) ?? inputTokens;
        outputTokens = tokenCount(usage.completion_tokens) ?? outputTokens;
        const choices = Array.isArray(chunk.choices) ? chunk.choices.map(object) : [];
        const choice = choices.find((item) => item.index === 0);
        if (!choice) continue;
        const delta = object(choice.delta);
        if (typeof delta.content === 'string') {
          content += delta.content;
          emit({ type: 'text.delta', text: delta.content });
        }
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        else if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
        if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
        if (Array.isArray(delta.tool_calls))
          for (const raw of delta.tool_calls) {
            const part = object(raw),
              fn = object(part.function),
              index = tokenCount(part.index);
            if (index === undefined)
              throw failure('MODEL_INVALID_RESPONSE', 'A streamed tool call is missing its index.');
            const current = calls.get(index) || { id: '', name: '', arguments: '' };
            if (typeof part.id === 'string') {
              if (current.id && current.id !== part.id)
                throw failure('MODEL_INVALID_RESPONSE', 'A streamed tool call changed its ID.');
              current.id = part.id;
            }
            if (typeof fn.name === 'string') current.name += fn.name;
            if (typeof fn.arguments === 'string') current.arguments += fn.arguments;
            calls.set(index, current);
          }
      }
      if (!done || !finish)
        throw failure(
          'MODEL_STREAM_INTERRUPTED',
          'Model endpoint generation ended without a terminal response.',
        );
      const toolCalls: ModelToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => {
          if (!call.id || !call.name)
            throw failure(
              'MODEL_INVALID_RESPONSE',
              'An incomplete streamed tool call was returned.',
            );
          return { id: call.id, name: call.name, arguments: parseJSON(call.arguments || '{}') };
        });
      if (!toolCalls.length && finish === 'stop' && !content.trim())
        throw failure(
          'MODEL_INVALID_RESPONSE',
          'Model endpoint completed without an assistant answer.',
        );
      const completion = {
        model: reportedModel,
        finish:
          finish === 'length'
            ? ('length' as const)
            : finish === 'tool_calls'
              ? ('tools' as const)
              : finish === 'stop'
                ? ('stop' as const)
                : ('failed' as const),
        message: {
          role: 'assistant' as const,
          content,
          ...(toolCalls.length ? { toolCalls } : {}),
          ...(reasoning ? { continuation: { reasoningContent: reasoning } } : {}),
        },
        ...(inputTokens !== undefined || outputTokens !== undefined
          ? { usage: { inputTokens, outputTokens } }
          : {}),
      };
      if (completion.usage) emit({ type: 'usage', usage: completion.usage });
      emit({ type: 'response.completed', model: completion.model, finish: completion.finish });
      return completion;
    });
  }
}
