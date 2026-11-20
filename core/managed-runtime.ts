import {
  DomainError,
  type AgentRuntime,
  type ProjectRegistry,
  type RuntimeEvent,
} from './ports.ts';
import type {
  ManagedSession,
  ManagedSessionStore,
  ModelProvider,
  ToolBroker,
} from './model-ports.ts';
type EventBody<T = RuntimeEvent> = T extends RuntimeEvent
  ? Omit<T, 'id' | 'threadId' | 'runId'>
  : never;

export type ManagedRuntimeOptions = {
  id: string;
  model: string;
  provider: ModelProvider;
  sessions: ManagedSessionStore;
  tools: ToolBroker;
  projects: ProjectRegistry;
  idGenerator: () => string;
  limits: {
    contextTokens: number;
    maxOutputTokens: number;
    maxRequestsPerTurn: number;
    maxToolCallsPerTurn: number;
    maxSessionRequests: number;
  };
};

/** Buro owns this loop. Providers never execute tools or accept a coding result. */
export class ManagedAgentRuntime implements AgentRuntime {
  readonly id: string;
  private options: ManagedRuntimeOptions;
  private loaded = new Map<string, ManagedSession>();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private active = new Map<
    string,
    { turnId: string; controller: AbortController; done: Promise<unknown> }
  >();
  private closed = false;

  constructor(options: ManagedRuntimeOptions) {
    const limits = options.limits;
    if (
      Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1) ||
      limits.maxOutputTokens >= limits.contextTokens
    )
      throw new DomainError(
        'INVALID_RUNTIME_LIMITS',
        'Managed runtime limits must be positive and reserve input context.',
      );
    this.id = options.id;
    this.options = options;
  }

  async start(input: Parameters<AgentRuntime['start']>[0]) {
    this.assertOpen();
    const id = 'M-' + this.options.idGenerator();
    const snapshot = this.options.projects.get(input.projectId).snapshot();
    const run = snapshot.runs.find((r) => r.id === input.runId);
    const workspace = input.workspace || snapshot.project.root;
    const materials =
      run?.contextMaterials ||
      (snapshot.contextMaterials || []).filter((m) => m.active && m.scope === 'project');
    const session: ManagedSession = {
      version: 1,
      id,
      runtimeId: this.id,
      limits: structuredClone(this.options.limits),
      providerId: this.options.provider.id,
      providerRevision: this.options.provider.revision,
      requestedModel: this.options.model,
      scope: {
        projectId: input.projectId,
        runId: input.runId,
        sessionId: input.assignment?.sessionId || id,
        workspace,
        readOnly: !!input.readOnly,
        allowedPaths:
          input.assignment?.allowedPaths || run?.executionPolicySnapshot?.allowedPaths || [],
        protectedPaths:
          input.assignment?.protectedPaths || run?.executionPolicySnapshot?.protectedPaths || [],
        materials: materials
          .flatMap((m) => [m.relativePath, ...(m.textPath ? [m.textPath] : [])])
          .map(
            (file) =>
              '.buro/' +
              (workspace === snapshot.project.root ? file : file.replace(/^local\//, '')),
          ),
        commands: (run?.executionPolicySnapshot?.profile || snapshot.profile)?.checks || [],
        baseCommit: run?.baseCommit,
      },
      messages: [{ role: 'system', content: input.instructions }],
      status: 'ready',
      requests: 0,
      usage: { requestsWithUsage: 0, inputTokens: 0, outputTokens: 0 },
      actions: [],
    };
    await this.options.sessions.save(session);
    this.loaded.set(id, session);
    return { threadId: id };
  }

  async resume(input: Parameters<NonNullable<AgentRuntime['resume']>>[0]) {
    this.assertOpen();
    if (this.active.has(input.threadId))
      throw new DomainError('SESSION_BUSY', 'The session is already running.');
    const session = await this.session(input.threadId);
    if (
      session.scope.projectId !== input.projectId ||
      session.scope.workspace !== input.workspace ||
      session.scope.runId !== input.runId
    )
      throw new DomainError(
        'SESSION_MISMATCH',
        'The checkpoint belongs to another project, run or workspace.',
      );
    this.assertReconciled(session);
    session.messages.push({
      role: 'system',
      content: 'Updated instructions for continuing saved work:\n' + input.instructions,
    });
    session.cancelRequested = false;
    session.status = 'ready';
    await this.options.sessions.save(session);
    return { threadId: session.id };
  }

  async submit(threadId: string, text: string) {
    const result = await this.turn(threadId, text, {
      schema: {},
      signal: new AbortController().signal,
      timeoutMs: 600000,
    });
    return { turnId: result.turnId };
  }

  async turn(
    threadId: string,
    text: string,
    options: { schema: unknown; signal: AbortSignal; timeoutMs: number },
  ) {
    this.assertOpen();
    if (this.active.has(threadId))
      throw new DomainError('SESSION_BUSY', 'The session is already running.');
    const turnId = 'T-' + this.options.idGenerator();
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) controller.abort();
    // Reserve before loading so concurrent calls cannot enter the same checkpoint.
    const done = Promise.resolve().then(() =>
      this.execute(threadId, turnId, text, options, controller),
    );
    this.active.set(threadId, { turnId, controller, done });
    try {
      return await done;
    } finally {
      this.active.delete(threadId);
      options.signal.removeEventListener('abort', abort);
    }
  }

  private async execute(
    threadId: string,
    turnId: string,
    text: string,
    options: { schema: unknown; timeoutMs: number },
    controller: AbortController,
  ) {
    const session = await this.session(threadId);
    this.assertReconciled(session);
    const { provider, sessions, tools } = this.options;
    const limits = session.limits;
    const signal = controller.signal;
    let sequence = 0,
      calls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), options.timeoutMs);
    };
    const check = () => {
      if (signal.aborted || session.cancelRequested)
        throw new DOMException('Interrupted', 'AbortError');
    };
    const emit = (body: EventBody) => {
      const event = {
        id: `${turnId}:${++sequence}`,
        runId: session.scope.runId || '',
        threadId,
        ...body,
      } as RuntimeEvent;
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {}
      }
    };
    try {
      check();
      session.status = 'running';
      session.messages.push({
        role: 'user',
        content:
          text +
          '\nReturn your final answer as JSON matching this schema: ' +
          JSON.stringify(options.schema),
      });
      await sessions.save(session);
      emit({ type: 'turn.started', turnId });
      touch();
      for (let round = 0; round < limits.maxRequestsPerTurn; round++) {
        check();
        if (session.requests >= limits.maxSessionRequests)
          throw new DomainError(
            'MODEL_BUDGET_EXHAUSTED',
            'The session request budget is exhausted.',
          );
        // UTF-8 bytes plus message overhead are a conservative token upper estimate, not metered usage.
        const estimatedInput =
          new TextEncoder().encode(
            JSON.stringify([session.messages, tools.definitions(session.scope), options.schema]),
          ).length +
          session.messages.length * 16;
        if (estimatedInput + limits.maxOutputTokens > limits.contextTokens)
          throw new DomainError(
            'MODEL_CONTEXT_EXHAUSTED',
            'The conservative context estimate exceeds the configured token budget. Start a focused assignment.',
          );
        session.requests++;
        await sessions.save(session);
        const response = await provider.complete({
          requestId: `${turnId}:${round}`,
          model: session.requestedModel,
          messages: session.messages,
          tools: tools.definitions(session.scope),
          schema: options.schema,
          maxOutputTokens: limits.maxOutputTokens,
          contextTokens: limits.contextTokens,
          signal,
          onProgress: touch,
        });
        check();
        session.reportedModel = response.model;
        if (response.usage) {
          session.usage.requestsWithUsage++;
          session.usage.inputTokens += response.usage.inputTokens || 0;
          session.usage.outputTokens += response.usage.outputTokens || 0;
        }
        if (response.finish === 'length' || response.finish === 'failed')
          throw new DomainError('MODEL_INCOMPLETE', 'The model response did not complete.');
        if (response.message.role !== 'assistant')
          throw new DomainError('MODEL_INVALID_RESPONSE', 'Expected an assistant message.');
        const requested = response.message.toolCalls || [];
        if (requested.length && response.finish !== 'tools')
          throw new DomainError(
            'MODEL_INVALID_RESPONSE',
            'Tool calls require a completed tool response.',
          );
        if (response.finish === 'tools' && !requested.length)
          throw new DomainError(
            'MODEL_INVALID_RESPONSE',
            'The model requested tools without calls.',
          );
        const known = new Set(session.actions.map((action) => action.call.id));
        for (const call of requested) {
          if (!call.id || known.has(call.id))
            throw new DomainError(
              'DUPLICATE_TOOL_CALL',
              'A tool call ID was reused. No repeated action was dispatched.',
            );
          known.add(call.id);
        }
        if (calls + requested.length > limits.maxToolCallsPerTurn)
          throw new DomainError('TOOL_BUDGET_EXHAUSTED', 'The tool action budget is exhausted.');
        session.messages.push(response.message);
        const actions = requested.map((call, index) => ({
          id: `A-${turnId}-${round}-${index}`,
          turnId,
          call,
          status: 'pending' as const,
        }));
        session.actions.push(...actions);
        await sessions.save(session);
        for (const pending of actions) {
          check();
          calls++;
          const action = session.actions.find((item) => item.id === pending.id)!;
          const command =
            action.call.name === 'run_command' &&
            action.call.arguments !== null &&
            typeof action.call.arguments === 'object'
              ? String((action.call.arguments as Record<string, unknown>).command || '')
              : undefined;
          emit({ type: 'tool.started', actionId: action.id, toolName: action.call.name });
          const result = await tools.execute(action.call, session.scope, {
            actionId: action.id,
            signal,
            onCommandStart: (observed) =>
              emit({ type: 'command.started', commandId: action.id, command: observed }),
          });
          check();
          action.status = 'completed';
          action.result = result;
          session.messages.push({
            role: 'tool',
            content: result.content,
            toolCallId: action.call.id,
            toolName: action.call.name,
          });
          await sessions.save(session);
          emit({
            type: 'tool.completed',
            actionId: action.id,
            toolName: action.call.name,
            isError: !!result.isError,
          });
          if (command !== undefined && result.exitCode !== undefined)
            emit({
              type: 'command.completed',
              commandId: action.id,
              command,
              output: result.content,
              exitCode: result.exitCode === undefined ? (result.isError ? 1 : 0) : result.exitCode,
            });
          touch();
        }
        if (!requested.length) {
          session.status = 'ready';
          await sessions.save(session);
          emit({ type: 'message.completed', text: response.message.content.slice(0, 12000) });
          emit({ type: 'turn.completed', turnId, status: 'completed' });
          return { turnId, text: response.message.content };
        }
      }
      throw new DomainError('MODEL_BUDGET_EXHAUSTED', 'The turn request budget is exhausted.');
    } catch (error) {
      session.status = signal.aborted || session.cancelRequested ? 'interrupted' : 'failed';
      for (const action of session.actions)
        if (action.status === 'pending') action.status = 'unknown';
      await sessions.save(session).catch(() => {});
      emit({ type: 'turn.completed', turnId, status: session.status });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private assertOpen() {
    if (this.closed) throw new DomainError('RUNTIME_CLOSED', 'The runtime stopped.');
  }
  private assertReconciled(session: ManagedSession) {
    if (session.actions.some((action) => action.status !== 'completed'))
      throw new DomainError(
        'ACTION_RECONCILIATION_REQUIRED',
        'A saved tool action has an unknown outcome. It cannot be automatically repeated.',
      );
  }
  private async session(id: string) {
    let session = this.loaded.get(id);
    if (!session) {
      session = await this.options.sessions.load(id);
      if (!session) throw new DomainError('THREAD_NOT_FOUND', 'Managed session not found.');
      if (
        session.runtimeId !== this.id ||
        session.providerId !== this.options.provider.id ||
        session.providerRevision !== this.options.provider.revision ||
        session.requestedModel !== this.options.model
      )
        throw new DomainError(
          'SESSION_MISMATCH',
          'The checkpoint uses another provider configuration or model.',
        );
      this.loaded.set(id, session);
    }
    return session;
  }
  subscribe(listener: (event: RuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async interrupt(threadId: string, turnId: string) {
    const active = this.active.get(threadId);
    if (!active || active.turnId !== turnId) return;
    const session = await this.session(threadId);
    session.cancelRequested = true;
    await this.options.sessions.save(session);
    active.controller.abort();
  }
  async release(threadId: string) {
    const active = this.active.get(threadId);
    if (active) {
      await this.interrupt(threadId, active.turnId);
      await active.done.catch(() => {});
    }
    this.loaded.delete(threadId);
  }
  async dispose() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.active.keys()].map((id) => this.release(id)));
    this.loaded.clear();
    this.listeners.clear();
  }
}
