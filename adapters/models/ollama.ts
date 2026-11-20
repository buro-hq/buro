import { createHash } from 'node:crypto';
import { DomainError } from '../../core/ports.ts';
import type {
  ModelContext,
  ModelMessage,
  ModelProvider,
  ModelToolCall,
} from '../../core/model-ports.ts';
import {
  RequestGate,
  endpointURL,
  json,
  lines,
  object,
  parseJSON,
  request,
  tokenCount,
  type HttpOptions,
} from './http.ts';

type Options = HttpOptions & { id: string; think?: boolean | string };
export class OllamaProvider implements ModelProvider {
  readonly structuredToolMode = 'separate-turn' as const;
  readonly id: string;
  readonly revision: string;
  readonly local: boolean;
  private options: Options;
  private gate: RequestGate;
  constructor(options: Options) {
    const url = endpointURL(options.endpoint);
    this.options = options;
    this.id = options.id;
    this.local = ['localhost', '[::1]'].includes(url.hostname) || /^127\./.test(url.hostname);
    this.revision = createHash('sha256')
      .update(JSON.stringify(['ollama-native-v2', url.href, options.think ?? 'model-default']))
      .digest('hex');
    this.gate = options.gate || new RequestGate(1);
  }
  /**
   * An intentionally lossy request view for explicit non-thinking mode: once every tool
   * result is present, retain the calls and their evidence without assistant commentary.
   * Only core-tagged completion notes may be omitted across requests, including after reload.
   * Private checkpoints remain complete; this is not a lossless provider conversation.
   */
  contextMessages(messages: readonly ModelMessage[], context?: ModelContext): ModelMessage[] {
    const projected = structuredClone([...messages]);
    if (this.options.think !== false) return projected;
    const callCounts = new Map<string, number>();
    const resultCounts = new Map<string, number>();
    for (const message of messages) {
      if (message.role === 'assistant')
        for (const call of message.toolCalls || [])
          callCounts.set(call.id, (callCounts.get(call.id) || 0) + 1);
      if (message.role === 'tool' && message.toolCallId)
        resultCounts.set(message.toolCallId, (resultCounts.get(message.toolCallId) || 0) + 1);
    }
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
      const ids = new Set(message.toolCalls.map((call) => call.id));
      if (
        ids.size !== message.toolCalls.length ||
        [...ids].some((id) => !id || callCounts.get(id) !== 1 || resultCounts.get(id) !== 1)
      )
        continue;
      const completed = new Set<string>();
      let valid = true;
      for (let next = index + 1; next < messages.length; next++) {
        const following = messages[next];
        if (following.role === 'user' || following.role === 'assistant') break;
        if (following.role !== 'tool') continue;
        if (!following.toolCallId || !ids.has(following.toolCallId)) {
          valid = false;
          break;
        }
        completed.add(following.toolCallId);
      }
      if (valid && completed.size === ids.size) projected[index].content = '';
    }
    const notes = context?.intermediateMessageIndexes;
    if (
      notes?.length &&
      (context?.phase === 'work' ||
        (context?.phase === 'final' && notes.at(-1) === messages.length - 2)) &&
      notes.every(
        (index, position) =>
          Number.isInteger(index) &&
          index >= 0 &&
          (position === 0 || index > notes[position - 1]) &&
          messages[index]?.role === 'assistant' &&
          !messages[index].toolCalls?.length &&
          messages[index + 1]?.role === 'user',
      )
    )
      for (const index of notes) projected[index].content = '';
    return projected;
  }
  async listModels(signal: AbortSignal) {
    return this.gate.run(signal, async () => {
      const result = object(await json(await request(this.options, 'api/tags', { signal })));
      if (!Array.isArray(result.models))
        throw new DomainError('MODEL_INVALID_RESPONSE', 'Ollama did not return a model list.');
      return result.models
        .map((raw) => object(raw))
        .filter((model) => typeof model.name === 'string')
        .map((model) => ({
          id: model.name as string,
          digest: typeof model.digest === 'string' ? model.digest : undefined,
        }));
    });
  }
  async inspect(model: string, signal: AbortSignal) {
    return this.gate.run(signal, async () => {
      const result = object(
        await json(
          await request(this.options, 'api/show', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({ model }),
          }),
        ),
      );
      const info = object(result.model_info);
      const capabilities = Array.isArray(result.capabilities)
        ? result.capabilities.filter((c): c is string => typeof c === 'string')
        : [];
      const context = Object.entries(info).find(([key]) => key.endsWith('.context_length'))?.[1];
      const remote =
        !!result.remote_host || !!result.remote_model || /(?:[:_-]cloud)(?:$|:)/i.test(model);
      return {
        id: model,
        local: this.local && !remote,
        remote,
        capabilities,
        contextTokens: tokenCount(context),
        thinkingValues: Array.isArray(object(result.thinking).values)
          ? (object(result.thinking).values as unknown[])
          : [],
      };
    });
  }
  async complete(input: Parameters<ModelProvider['complete']>[0]) {
    const info = await this.inspect(input.model, input.signal);
    if (info.remote)
      throw new DomainError(
        'MODEL_REMOTE_ROUTE',
        'Cloud-backed Ollama models are not enabled by this local-model adapter.',
      );
    if (
      this.options.think !== undefined &&
      info.thinkingValues.length &&
      !info.thinkingValues.includes(this.options.think)
    )
      throw new DomainError(
        'MODEL_UNSUPPORTED',
        'This model does not support the selected thinking setting.',
      );
    if (input.tools.length && !info.capabilities.includes('tools'))
      throw new DomainError(
        'MODEL_UNSUPPORTED',
        'The installed Ollama model does not advertise tool calling.',
      );
    if (info.contextTokens && input.contextTokens > info.contextTokens)
      throw new DomainError(
        'MODEL_CONTEXT_EXHAUSTED',
        'The configured context exceeds this model capability.',
      );
    return this.gate.run(input.signal, async () => {
      const messages = input.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.role === 'tool' ? { tool_name: message.toolName } : {}),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call, index) => ({
                function: { index, name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
        ...(typeof object(message.continuation).thinking === 'string'
          ? { thinking: object(message.continuation).thinking }
          : {}),
      }));
      const response = await request(this.options, 'api/chat', {
        method: 'POST',
        signal: input.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          messages,
          tools: input.tools.map((tool) => ({ type: 'function', function: tool })),
          ...(!input.tools.length ? { format: input.schema } : {}),
          stream: true,
          ...(this.options.think !== undefined ? { think: this.options.think } : {}),
          options: { num_ctx: input.contextTokens, num_predict: input.maxOutputTokens },
        }),
      });
      let content = '',
        thinking = '',
        done = false,
        reason = '',
        reportedModel = input.model;
      let inputTokens: number | undefined, outputTokens: number | undefined;
      const calls = new Map<number, { name: string; fragments: string; args?: unknown }>();
      for await (const line of lines(response, input.onProgress)) {
        if (!line.trim()) continue;
        const chunk = object(parseJSON(line));
        if (chunk.error)
          throw new DomainError('MODEL_REQUEST_REJECTED', 'Ollama returned a generation error.');
        const message = object(chunk.message);
        if (typeof message.content === 'string') content += message.content;
        if (typeof message.thinking === 'string') thinking += message.thinking;
        if (typeof chunk.model === 'string') reportedModel = chunk.model;
        if (Array.isArray(message.tool_calls))
          for (const raw of message.tool_calls) {
            const call = object(raw),
              fn = object(call.function);
            const index = tokenCount(call.index) ?? tokenCount(fn.index) ?? calls.size;
            const current = calls.get(index) || { name: '', fragments: '' };
            if (typeof fn.name === 'string' && fn.name !== current.name) current.name += fn.name;
            if (typeof fn.arguments === 'string') {
              if (current.args !== undefined)
                throw new DomainError(
                  'MODEL_INVALID_RESPONSE',
                  'Ollama mixed tool argument formats.',
                );
              current.fragments += fn.arguments;
            } else if (fn.arguments !== undefined) {
              if (current.fragments)
                throw new DomainError(
                  'MODEL_INVALID_RESPONSE',
                  'Ollama mixed tool argument formats.',
                );
              if (
                current.args !== undefined &&
                JSON.stringify(current.args) !== JSON.stringify(fn.arguments)
              )
                throw new DomainError(
                  'MODEL_INVALID_RESPONSE',
                  'Ollama returned conflicting tool arguments.',
                );
              current.args = fn.arguments;
            }
            calls.set(index, current);
          }
        if (chunk.done === true) {
          done = true;
          reason = typeof chunk.done_reason === 'string' ? chunk.done_reason : 'stop';
          inputTokens = tokenCount(chunk.prompt_eval_count);
          outputTokens = tokenCount(chunk.eval_count);
          break;
        }
      }
      if (!done)
        throw new DomainError(
          'MODEL_STREAM_INTERRUPTED',
          'Ollama generation ended without a terminal response.',
        );
      const toolCalls: ModelToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => {
          if (!call.name)
            throw new DomainError('MODEL_INVALID_RESPONSE', 'A tool call has no name.');
          return {
            id: `${input.requestId}:call:${index}`,
            name: call.name,
            arguments: call.fragments ? parseJSON(call.fragments) : (call.args ?? {}),
          };
        });
      if (!toolCalls.length && reason === 'stop' && !content.trim())
        throw new DomainError(
          'MODEL_INVALID_RESPONSE',
          'Ollama completed without an assistant answer.',
        );
      return {
        model: reportedModel,
        finish:
          reason === 'length'
            ? ('length' as const)
            : toolCalls.length
              ? ('tools' as const)
              : reason === 'stop'
                ? ('stop' as const)
                : ('failed' as const),
        message: {
          role: 'assistant' as const,
          content,
          ...(toolCalls.length ? { toolCalls } : {}),
          ...(thinking ? { continuation: { thinking } } : {}),
        },
        ...(inputTokens !== undefined || outputTokens !== undefined
          ? { usage: { inputTokens, outputTokens } }
          : {}),
      };
    });
  }
}
