import { randomUUID } from 'node:crypto';
import type { ModelCompletion, ModelToolCall } from '../../agent/contracts/model.ts';
import type { Notifications } from '../events/notifications.ts';
import type { Models } from '../models/model.ts';
import type { ToolContext, Tools, ToolResult } from '../tools/tool.ts';
import type { ActivityHistory } from './activity.ts';
import { conversationContext } from './context.ts';
import { settledHistory } from './history.ts';
import type {
  Session,
  SessionInput,
  SessionResult,
  SessionStore,
  SessionTurn,
  Sessions,
  SessionWaitResult,
} from './session.ts';

interface ActiveSession {
  controller: AbortController;
  modelId?: string;
  settled: Promise<void>;
  waitingFor?: string;
}

function reportedTokens(input: { previous?: number; current?: number }): number | undefined {
  return input.previous === undefined && input.current === undefined
    ? undefined
    : (input.previous ?? 0) + (input.current ?? 0);
}

/** Runs one common model/tool loop for any task and any agent description. */
export class SessionService implements Sessions {
  private store: SessionStore;
  private models: Models;
  private tools: Tools;
  private activity: ActivityHistory;
  private events: Notifications;
  private active = new Map<string, ActiveSession>();

  /** Connects the module's own store to public model, tool and notification interfaces. */
  constructor(input: {
    store: SessionStore;
    models: Models;
    tools: Tools;
    activity: ActivityHistory;
    events: Notifications;
  }) {
    this.store = input.store;
    this.models = input.models;
    this.tools = input.tools;
    this.activity = input.activity;
    this.events = input.events;
  }

  /** Creates a portable session without dispatching inference. */
  async create(input: SessionInput = {}): Promise<SessionResult> {
    const model = this.models.get({ id: input.modelId });
    if (!model) return { ok: false, sessionId: '', error: 'Select an available model.' };
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      runId: input.runId,
      parentId: input.parentId,
      agentId: input.agentId,
      modelId: model.id,
      instructions: input.instructions ?? '',
      context: input.context,
      access: structuredClone(input.access),
      messages: [
        {
          role: 'system' as const,
          content: [
            input.instructions,
            input.context ? 'Shared work context:\n' + input.context : undefined,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
        ...(input.messages ?? [])
          .filter((message) => message.role !== 'system')
          .map(({ continuation: _private, ...message }) => structuredClone(message)),
      ].map((message) => ({ ...message, id: randomUUID() })),
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    };
    await this.save(session);
    return { ok: true, sessionId: session.id };
  }

  /** Returns the session's stored conversation, including completed tool results. */
  async get(input: { id: string }): Promise<Session | undefined> {
    return this.store.get(input.id);
  }

  /** Joins an active turn without taking ownership of its execution. */
  async wait(input: {
    id: string;
    callerId?: string;
    signal?: AbortSignal;
  }): Promise<SessionWaitResult> {
    for (let id: string | undefined = input.id; id; id = this.active.get(id)?.waitingFor)
      if (id === input.callerId)
        return {
          ok: false,
          error:
            'These conversations would wait for each other. Read their status or continue other work instead.',
        };
    const caller = input.callerId ? this.active.get(input.callerId) : undefined;
    if (caller) caller.waitingFor = input.id;
    let onAbort!: () => void;
    try {
      const interrupted = new Promise<void>((resolve) => {
        onAbort = resolve;
      });
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      await Promise.race([this.active.get(input.id)?.settled, interrupted]);
      if (input.signal?.aborted)
        return { ok: false, interrupted: true, error: 'Waiting was interrupted.' };
      const session = await this.store.get(input.id);
      return session ? { ok: true, session } : { ok: false, error: 'Session not found.' };
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      if (caller) caller.waitingFor = undefined;
    }
  }

  /** Lists conversations, optionally restricted to one run. */
  async list(input: { runId?: string } = {}): Promise<Session[]> {
    return (await this.store.list()).filter(
      (session) => !input.runId || session.runId === input.runId,
    );
  }

  /** Marks abandoned turns interrupted; their files and recorded messages remain authoritative observations. */
  async recover(): Promise<void> {
    for (const session of await this.store.list())
      if (session.status === 'running' && !this.active.has(session.id))
        await this.save({
          ...session,
          status: 'interrupted',
          error: 'The previous process stopped. Saved history and files remain available.',
        });
  }

  /** Removes an inactive conversation; an active conversation must be stopped first. */
  async delete(input: { id: string }): Promise<boolean> {
    if (this.active.has(input.id)) return false;
    await this.store.delete(input.id);
    this.events.publish({ type: 'session.deleted', data: input });
    return true;
  }

  /** Selects the next model without changing identity or dropping shared history. */
  async switchModel(input: { sessionId: string; modelId: string }): Promise<boolean> {
    const session = await this.store.get(input.sessionId);
    if (!session || !this.models.get({ id: input.modelId })) return false;
    const active = this.active.get(input.sessionId);
    if (active) active.modelId = input.modelId;
    const next = await this.store.patch({
      id: input.sessionId,
      changes: { modelId: input.modelId, updatedAt: new Date().toISOString() },
    });
    if (next) this.events.publish({ type: 'session.updated', data: next });
    return true;
  }

  /** Stops an active turn while preserving its already committed history and files. */
  interrupt(input: { sessionId: string }): void {
    this.active.get(input.sessionId)?.controller.abort();
  }

  /** Stops and joins conversations, optionally only those belonging to a particular run. */
  async close(input: { runId?: string } = {}): Promise<void> {
    const sessions = input.runId ? await this.list({ runId: input.runId }) : undefined;
    const ids = sessions ? new Set(sessions.map((session) => session.id)) : undefined;
    const active = [...this.active].filter(([id]) => !ids || ids.has(id)).map(([, entry]) => entry);
    for (const entry of active) entry.controller.abort();
    await Promise.all(active.map((entry) => entry.settled));
  }

  /** Executes model requests and tool calls until the agent returns a result or the caller stops it. */
  async run(input: SessionTurn): Promise<SessionResult> {
    input = {
      ...input,
      tools: input.tools ? [...input.tools] : undefined,
      schema: structuredClone(input.schema),
    };
    if (this.active.has(input.sessionId))
      return { ok: false, sessionId: input.sessionId, error: 'This session is already running.' };
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    this.active.set(input.sessionId, { controller, modelId: input.modelId, settled });
    const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) controller.abort();
    let session: Session | undefined;
    try {
      session = await this.store.get(input.sessionId);
      if (!session) return { ok: false, sessionId: input.sessionId, error: 'Session not found.' };
      input = {
        ...input,
        readOnly: input.readOnly || session.access?.readOnly,
        tools: session.access?.tools
          ? session.access.tools.filter((name) => !input.tools || input.tools.includes(name))
          : input.tools,
      };
      session = {
        ...session,
        modelId: input.modelId ?? session.modelId,
        status: 'running',
        error: undefined,
        messages: [...settledHistory(session.messages), { role: 'user', content: input.input }],
      };
      await this.save(session);
      let requests = 0;
      while (true) {
        controller.signal.throwIfAborted();
        // A tool can explicitly select the next model; historical adapter state stays with its message.
        const selected = await this.store.get(session.id);
        if (selected) session = { ...session, modelId: selected.modelId };
        const model = this.models.get({ id: session.modelId });
        if (!model)
          return await this.finish(session, {
            ok: false,
            sessionId: session.id,
            error: 'The selected model is unavailable.',
          });
        if (input.maxRequests !== undefined && requests >= input.maxRequests)
          return await this.finish(session, {
            ok: false,
            sessionId: session.id,
            error: 'The request allowance supplied for this turn was reached.',
          });
        requests++;
        const requestId = randomUUID();
        const definitions = this.tools.definitions({
          names: input.tools,
          readOnly: input.readOnly,
        });
        const privateMessages = await this.models.context({
          sessionId: session.id,
          modelId: model.id,
          providerRevision: model.backend.revision,
          messages: session.messages,
        });
        const context = conversationContext({
          messages: privateMessages,
          contextTokens: model.contextTokens,
          outputTokens: model.outputTokens,
          toolTokens: Math.ceil(JSON.stringify(definitions).length / 4),
        });
        const messages = model.backend.contextMessages?.(context) ?? context;
        const toolContext: ToolContext = {
          sessionId: session.id,
          runId: session.runId,
          workspace: input.workspace,
          projectId: input.projectId,
          readOnly: input.readOnly,
          tools: input.tools,
          signal: controller.signal,
        };
        let callbacks: Promise<void> = Promise.resolve();
        let response: ModelCompletion;
        try {
          response = await model.backend.complete({
            sessionId: session.id,
            workspace: input.workspace,
            readOnly: input.readOnly,
            executeTool: (call) => {
              const operation = callbacks.then(async () => {
                session = {
                  ...session!,
                  messages: [
                    ...session!.messages,
                    {
                      id: randomUUID(),
                      role: 'assistant',
                      content: '',
                      toolCalls: [call],
                      modelId: model.id,
                    },
                  ],
                };
                await this.save(session);
                const executed = await this.performTool({ session, call, context: toolContext });
                session = executed.session;
                return executed.result;
              });
              callbacks = operation.then(() => {});
              void callbacks.catch(() => {});
              return operation;
            },
            requestId,
            model: model.model,
            messages,
            tools: definitions,
            schema: input.schema,
            maxOutputTokens: model.outputTokens,
            contextTokens: model.contextTokens,
            signal: controller.signal,
            onProgress() {},
            onRetry: (retry) =>
              this.events.publish({
                type: 'session.retry',
                data: { sessionId: session!.id, runId: session!.runId, requestId, ...retry },
              }),
            onEvent: (event) => {
              if (event.type === 'text.delta')
                this.events.publish({
                  type: 'session.text',
                  data: {
                    sessionId: session!.id,
                    runId: session!.runId,
                    requestId,
                    text: event.text,
                  },
                });
            },
          });
        } finally {
          await callbacks;
        }
        // Correlation IDs are a transport boundary, not an agent policy. Invalid batches
        // cannot be executed or appended as an ambiguous tool exchange.
        const calls = response.message.toolCalls ?? [];
        if (
          calls.some((call) => !call.id || !call.name) ||
          new Set(calls.map((call) => call.id)).size !== calls.length
        )
          return await this.finish(session, {
            ok: false,
            sessionId: session.id,
            error:
              'The model returned tool calls without unique, nonempty IDs and names. No action was executed.',
          });
        await this.activity.append({
          sessionId: session.id,
          runId: session.runId,
          type: 'model.completed',
          data: {
            requestId,
            modelId: model.id,
            model: response.model,
            finish: response.finish,
            usage: response.usage,
          },
        });
        const messageId = randomUUID();
        await this.models.remember({
          sessionId: session.id,
          messageId,
          modelId: model.id,
          providerRevision: model.backend.revision,
          continuation: response.message.continuation,
        });
        session = this.withResponse({ session, response, messageId, modelId: model.id });
        await this.save(session);
        const switched = this.active.get(session.id)?.modelId;
        if (switched && switched !== model.id) {
          session = {
            ...session,
            modelId: switched,
            messages: [
              ...session.messages,
              ...calls.map((call) => ({
                id: randomUUID(),
                role: 'tool' as const,
                toolCallId: call.id,
                toolName: call.name,
                content:
                  'The model changed before this proposal was dispatched. No action was performed.',
              })),
              {
                id: randomUUID(),
                role: 'user',
                content:
                  'Continue this task with the selected model using the saved files and observed work. Inspect current state rather than repeating completed actions.',
              },
            ],
          };
          await this.save(session);
          continue;
        }
        if (response.finish === 'length' || (calls.length > 0 && response.finish === 'stop')) {
          session = {
            ...session,
            messages: [
              ...session.messages,
              ...(response.message.toolCalls ?? []).map((call) => ({
                role: 'tool' as const,
                toolCallId: call.id,
                toolName: call.name,
                content:
                  'This proposal did not have a complete tool-call terminal. The tool was not executed.',
              })),
              {
                role: 'user',
                content:
                  'The previous response was incomplete or did not end as a tool request. Its proposed tools were not executed. Continue from the saved task and observed tool results. Return the next useful tool call or a concise final answer; do not repeat completed actions.',
              },
            ],
          };
          await this.save(session);
          continue;
        }
        if (response.finish === 'failed')
          return await this.finish(session, {
            ok: false,
            sessionId: session.id,
            error: 'The model could not complete its response.',
          });
        if (!calls.length)
          return await this.finish(session, {
            ok: true,
            sessionId: session.id,
            text: response.message.content,
          });
        for (const call of calls) {
          session = (await this.performTool({ session, call, context: toolContext })).session;
        }
      }
    } catch (error) {
      if (!session) throw error;
      if (controller.signal.aborted)
        return await this.finish(session, {
          ok: false,
          sessionId: session.id,
          interrupted: true,
          error: 'Work was interrupted. Saved files and history are available for a new run.',
        });
      return await this.finish(session, {
        ok: false,
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      input.signal?.removeEventListener('abort', abort);
      this.active.delete(input.sessionId);
      resolveSettled();
    }
  }

  private async performTool(input: {
    session: Session;
    call: ModelToolCall;
    context: ToolContext;
  }): Promise<{ session: Session; result: ToolResult }> {
    const { session, call, context } = input;
    context.signal.throwIfAborted();
    const action = await this.activity.append({
      sessionId: session.id,
      runId: session.runId,
      type: 'tool.started',
      data: { call },
    });
    const result = await this.tools.execute({
      name: call.name,
      arguments: call.arguments,
      context,
      names: context.tools,
    });
    await this.activity.append({
      sessionId: session.id,
      runId: session.runId,
      type: 'tool.completed',
      data: { actionId: action.id, call, result },
    });
    const next: Session = {
      ...session,
      messages: [
        ...session.messages,
        {
          id: randomUUID(),
          role: 'tool',
          content: result.content,
          toolCallId: call.id,
          toolName: call.name,
        },
      ],
    };
    await this.save(next);
    return { session: next, result };
  }

  private withResponse(input: {
    session: Session;
    response: ModelCompletion;
    messageId: string;
    modelId: string;
  }): Session {
    const { session, response } = input;
    const usage =
      session.usage || response.usage
        ? {
            inputTokens: reportedTokens({
              previous: session.usage?.inputTokens,
              current: response.usage?.inputTokens,
            }),
            outputTokens: reportedTokens({
              previous: session.usage?.outputTokens,
              current: response.usage?.outputTokens,
            }),
          }
        : undefined;
    const { continuation: _continuation, ...message } = response.message;
    return {
      ...session,
      usage,
      messages: [
        ...session.messages,
        { ...structuredClone(message), id: input.messageId, modelId: input.modelId },
      ],
    };
  }

  private async save(session: Session): Promise<void> {
    const next = {
      ...session,
      modelId: this.active.get(session.id)?.modelId ?? session.modelId,
      messages: session.messages.map((message) =>
        message.id ? message : { ...message, id: randomUUID() },
      ),
      updatedAt: new Date().toISOString(),
    };
    await this.store.save(next);
    this.events.publish({ type: 'session.updated', data: next });
  }

  private async finish(session: Session, result: SessionResult): Promise<SessionResult> {
    await this.save({
      ...session,
      status: result.ok ? 'completed' : result.interrupted ? 'interrupted' : 'failed',
      result: result.text,
      error: result.error,
    });
    return result;
  }
}
