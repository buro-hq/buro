import { createHash } from 'node:crypto';
import { DomainError } from '../../core/ports.ts';
import type { ModelProvider, ModelToolCall } from '../../core/model-ports.ts';
import {
  RequestGate,
  endpointURL,
  json,
  object,
  parseJSON,
  request,
  sse,
  tokenCount,
  type HttpOptions,
} from './http.ts';

type Options = HttpOptions & {
  id: string;
  apiKey: () => string | undefined;
  thinking?: 'enabled' | 'disabled';
};
export class DeepSeekProvider implements ModelProvider {
  readonly id: string;
  readonly revision: string;
  readonly local = false;
  private options: Options;
  private gate: RequestGate;
  constructor(options: Options) {
    const endpoint = endpointURL(options.endpoint);
    if (
      endpoint.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    )
      throw new DomainError('INVALID_ENDPOINT', 'Remote DeepSeek endpoints require HTTPS.');
    this.options = options;
    this.id = options.id;
    this.revision = createHash('sha256')
      .update(JSON.stringify(['deepseek-chat-v1', endpoint.href, options.thinking ?? 'disabled']))
      .digest('hex');
    this.gate = options.gate || new RequestGate(2);
  }
  private headers() {
    const key = this.options.apiKey();
    if (!key)
      throw new DomainError(
        'MODEL_AUTH_REQUIRED',
        'Set the private DeepSeek API key before using this connection.',
      );
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
  }
  async listModels(signal: AbortSignal) {
    return this.gate.run(signal, async () => {
      const body = object(
        await json(await request(this.options, 'models', { signal, headers: this.headers() })),
      );
      if (!Array.isArray(body.data))
        throw new DomainError('MODEL_INVALID_RESPONSE', 'DeepSeek did not return a model list.');
      return body.data
        .map((raw) => object(raw))
        .filter((model) => typeof model.id === 'string')
        .map((model) => ({ id: model.id as string }));
    });
  }
  async complete(input: Parameters<ModelProvider['complete']>[0]) {
    return this.gate.run(input.signal, async () => {
      const messages = input.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
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
        body: JSON.stringify({
          model: input.model,
          messages,
          ...(input.tools.length
            ? { tools: input.tools.map((tool) => ({ type: 'function', function: tool })) }
            : {}),
          response_format: { type: 'json_object' },
          max_tokens: input.maxOutputTokens,
          thinking: { type: this.options.thinking ?? 'disabled' },
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
          throw new DomainError('MODEL_REQUEST_REJECTED', 'DeepSeek returned a generation error.');
        if (typeof chunk.model === 'string') reportedModel = chunk.model;
        const usage = object(chunk.usage);
        inputTokens = tokenCount(usage.prompt_tokens) ?? inputTokens;
        outputTokens = tokenCount(usage.completion_tokens) ?? outputTokens;
        const choices = Array.isArray(chunk.choices) ? chunk.choices.map(object) : [];
        const choice = choices.find((item) => item.index === 0);
        if (!choice) continue;
        const delta = object(choice.delta);
        if (typeof delta.content === 'string') content += delta.content;
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
        if (Array.isArray(delta.tool_calls))
          for (const raw of delta.tool_calls) {
            const part = object(raw),
              fn = object(part.function),
              index = tokenCount(part.index);
            if (index === undefined)
              throw new DomainError(
                'MODEL_INVALID_RESPONSE',
                'A streamed tool call is missing its index.',
              );
            const current = calls.get(index) || { id: '', name: '', arguments: '' };
            if (typeof part.id === 'string') {
              if (current.id && current.id !== part.id)
                throw new DomainError(
                  'MODEL_INVALID_RESPONSE',
                  'A streamed tool call changed its ID.',
                );
              current.id = part.id;
            }
            if (typeof fn.name === 'string') current.name += fn.name;
            if (typeof fn.arguments === 'string') current.arguments += fn.arguments;
            calls.set(index, current);
          }
      }
      if (!done || !finish)
        throw new DomainError(
          'MODEL_STREAM_INTERRUPTED',
          'DeepSeek generation ended without a terminal response.',
        );
      const toolCalls: ModelToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => {
          if (!call.id || !call.name)
            throw new DomainError(
              'MODEL_INVALID_RESPONSE',
              'An incomplete streamed tool call was returned.',
            );
          return { id: call.id, name: call.name, arguments: parseJSON(call.arguments || '{}') };
        });
      if (!toolCalls.length && finish === 'stop' && !content.trim())
        throw new DomainError(
          'MODEL_INVALID_RESPONSE',
          'DeepSeek completed without an assistant answer.',
        );
      return {
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
    });
  }
}
