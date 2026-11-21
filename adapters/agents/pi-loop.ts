import {
  runAgentLoop,
  type AgentContext,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
  type JsonObject,
} from '@earendil-works/pi-ai';
import type {
  AgentLoopBatch,
  AgentLoopHost,
  AgentLoopRequest,
  AgentLoopResult,
  AgentLoopRunner,
} from '../../agent/contracts/loop.ts';
import { AgentLoopFailure } from '../../agent/contracts/loop-errors.ts';
import type { ModelMessage } from '../../agent/contracts/model.ts';

// Pi requires concrete usage/cost values. These disposable scheduling fields are
// never returned to the host or used as observed usage, pricing, or checkpoints.
const internalUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const internalModel = (request?: AgentLoopRequest): Model<'openai-completions'> => ({
  id: request?.model.id || 'host-controlled',
  name: request?.model.id || 'Host-controlled scheduling',
  provider: request?.model.providerId || 'host-controlled',
  api: 'openai-completions',
  baseUrl: 'http://host-controlled.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: request?.model.contextTokens || 1,
  maxTokens: request?.model.maxOutputTokens || 1,
});
function assistant(
  model: Model<'openai-completions'>,
  content: AssistantMessage['content'],
  failed = false,
): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    usage: internalUsage(),
    stopReason: failed
      ? 'error'
      : content.some((part) => part.type === 'toolCall')
        ? 'toolUse'
        : 'stop',
    timestamp: 0,
    ...(failed ? { errorMessage: 'Host-controlled scheduling stopped.' } : {}),
  };
}
function messages(input: ModelMessage[], model: Model<'openai-completions'>): AgentMessage[] {
  return input.map((message) => {
    if (message.role === 'assistant')
      return assistant(model, [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.toolCalls || []).map((call) => ({
          type: 'toolCall' as const,
          id: call.id,
          name: call.name,
          arguments: structuredClone(call.arguments) as JsonObject,
        })),
      ]);
    if (message.role === 'tool')
      return {
        role: 'toolResult' as const,
        toolCallId: message.toolCallId || '',
        toolName: message.toolName || '',
        content: [{ type: 'text' as const, text: message.content }],
        isError: false,
        timestamp: 0,
      };
    return { role: message.role, content: message.content, timestamp: 0 };
  });
}

type ActiveBatch = {
  value: AgentLoopBatch;
  actions: Map<string, { id: string; started: boolean; settled: boolean }>;
  advanced: boolean;
};

/** Pi schedules disposable projections. Only host callbacks can generate, act, or accept progress. */
export class PiAgentLoopRunner implements AgentLoopRunner {
  async run(host: AgentLoopHost, signal: AbortSignal): Promise<AgentLoopResult> {
    const child = new AbortController();
    let fatal: unknown;
    let hasFatal = false;
    let request: AgentLoopRequest | undefined;
    let batch: ActiveBatch | undefined;
    let result: AgentLoopResult | undefined;
    const pending = new Set<Promise<unknown>>();
    const cancellation = () =>
      signal.reason instanceof DOMException && signal.reason.name === 'AbortError'
        ? signal.reason
        : new DOMException('Interrupted', 'AbortError');
    const stop = () => child.abort();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) child.abort();
    const fail = (error: unknown) => {
      if (!hasFatal) {
        fatal = error;
        hasFatal = true;
      }
      child.abort();
    };
    const failAdapter = (error: unknown) => {
      if (hasFatal) return;
      fail(
        signal.aborted
          ? cancellation()
          : error instanceof AgentLoopFailure
            ? error
            : new AgentLoopFailure(error),
      );
    };
    const check = () => {
      if (hasFatal) throw fatal;
      if (signal.aborted) throw cancellation();
      if (child.signal.aborted) throw new AgentLoopFailure();
    };
    const invoke = async <T>(action: () => Promise<T>): Promise<T> => {
      check();
      const work = Promise.resolve().then(() => {
        check();
        return action();
      });
      pending.add(work);
      try {
        return await work;
      } catch (error) {
        fail(error);
        throw error;
      } finally {
        pending.delete(work);
      }
    };
    const tool = (name: string, description: string): AgentTool => ({
      name,
      label: name,
      description,
      // The real provider receives the host's real definitions. Pi validation is
      // scheduling-only and must never coerce or replace canonical arguments.
      parameters: {},
      executionMode: 'sequential',
      execute: async (providerCallId) => {
        try {
          check();
          const owned = batch?.actions.get(providerCallId);
          if (!batch || !owned || owned.started) throw new AgentLoopFailure();
          const owner = batch;
          owned.started = true;
          const observed = await invoke(() => host.execute(owner.value.id, owned.id));
          owned.settled = true;
          return {
            content: [{ type: 'text', text: observed.content }],
            details: {},
            ...(observed.isError ? { isError: true } : {}),
          };
        } catch (error) {
          failAdapter(error);
          throw fatal;
        }
      },
    });
    const config: AgentLoopConfig = {
      model: internalModel(),
      toolExecution: 'sequential',
      convertToLlm: (input) => input as Message[],
      prepareRequest: async () => {
        try {
          check();
          request = structuredClone(await invoke(() => host.prepare()));
          check();
          batch = undefined;
          const model = internalModel(request);
          const declarations = [
            ...new Map(request.tools.map((definition) => [definition.name, definition])).values(),
          ];
          const context: AgentContext = {
            messages: messages(request.messages, model),
            tools: declarations.map((definition) => tool(definition.name, definition.description)),
          };
          return { model, context };
        } catch (error) {
          failAdapter(error);
          throw fatal;
        }
      },
      finishTurn: async (turn) => {
        if (hasFatal || signal.aborted) return { action: 'end' };
        try {
          check();
          if (
            !batch ||
            batch.advanced ||
            [...batch.actions.values()].some((action) => !action.settled)
          )
            throw new AgentLoopFailure();
          const owned = batch;
          owned.advanced = true;
          const decision = await invoke(() => host.advance(owned.value.id));
          check();
          if (decision.kind === 'continue') return { action: 'continue' };
          if (decision.kind !== 'complete' && decision.kind !== 'yield')
            throw new AgentLoopFailure();
          result = { kind: decision.kind };
          // The durable host checkpoint is the only transcript across windows.
          turn.newMessages.length = 0;
          return { action: 'end' };
        } catch (error) {
          failAdapter(error);
          return { action: 'end' };
        }
      },
    };
    const stream: StreamFn = async () => {
      const events = createAssistantMessageEventStream();
      try {
        check();
        if (!request) throw new AgentLoopFailure();
        const value = structuredClone(await invoke(() => host.generate(request!.id)));
        check();
        if (
          typeof value.id !== 'string' ||
          !value.id ||
          (value.actions.length > 0 && value.response.finish !== 'tools') ||
          (value.actions.length === 0 && value.response.finish === 'tools')
        )
          throw new AgentLoopFailure();
        const admittedNames = new Set(request.tools.map((definition) => definition.name));
        const actions = new Map<string, { id: string; started: boolean; settled: boolean }>();
        const ids = new Set<string>();
        for (const action of value.actions) {
          if (
            !action.id ||
            !action.call.id ||
            !admittedNames.has(action.call.name) ||
            actions.has(action.call.id) ||
            ids.has(action.id)
          )
            throw new AgentLoopFailure();
          ids.add(action.id);
          actions.set(action.call.id, { id: action.id, started: false, settled: false });
        }
        batch = { value, actions, advanced: false };
        const projection = assistant(internalModel(request), [
          ...(value.response.message.content
            ? [{ type: 'text' as const, text: value.response.message.content }]
            : []),
          ...value.actions.map((action) => ({
            type: 'toolCall' as const,
            id: action.call.id,
            name: action.call.name,
            arguments: structuredClone(action.call.arguments) as JsonObject,
          })),
        ]);
        events.push({
          type: 'done',
          reason: projection.stopReason as 'stop' | 'toolUse',
          message: projection,
        });
      } catch (error) {
        failAdapter(error);
        events.push({
          type: 'error',
          reason: 'error',
          error: assistant(internalModel(request), [], true),
        });
      }
      return events;
    };
    let sdkError: unknown;
    let sdkFailed = false;
    try {
      check();
      await runAgentLoop([], { messages: [], tools: [] }, config, () => {}, child.signal, stream);
    } catch (error) {
      sdkError = error;
      sdkFailed = true;
      child.abort();
    } finally {
      // No SDK completion or error may outlive an admitted host callback.
      while (pending.size) await Promise.allSettled([...pending]);
      signal.removeEventListener('abort', stop);
    }
    if (hasFatal) throw fatal;
    if (signal.aborted) throw cancellation();
    if (sdkFailed)
      throw sdkError instanceof AgentLoopFailure ? sdkError : new AgentLoopFailure(sdkError);
    if (!result) throw new AgentLoopFailure();
    return result;
  }
}
