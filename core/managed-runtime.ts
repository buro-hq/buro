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
  ToolScope,
} from './model-ports.ts';
import { inScope } from './execution-ports.ts';
import { withEnvironmentRepair } from './environment-repair.ts';
import { prepareManagedRequest, type ManagedRequestPolicy } from './request-policy.ts';
import type { ManagedRunBudgetPort } from './run-budget.ts';
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
  requestPolicy?: ManagedRequestPolicy;
  budgets?: ManagedRunBudgetPort;
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
  private resuming = new Map<string, Promise<{ threadId: string }>>();
  private disposal?: Promise<void>;

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
    const ownerRunId = input.ownerRunId || input.runId;
    const run = snapshot.runs.find((r) => r.id === ownerRunId);
    if (input.ownerRunId && !run)
      throw new DomainError('SESSION_MISMATCH', 'The owning run was not found.');
    if (input.purpose === 'review' && (!input.readOnly || input.assignment))
      throw new DomainError('SESSION_MISMATCH', 'Review requires a read-only service session.');
    if (
      this.options.budgets &&
      ownerRunId &&
      !run &&
      !['research', 'environment'].includes(input.purpose || '')
    )
      throw new DomainError('SESSION_MISMATCH', 'The owning run was not found.');
    const workspace = input.workspace || snapshot.project.root;
    if (run?.workspace && run.workspace !== workspace)
      throw new DomainError('SESSION_MISMATCH', 'The owning run uses another workspace.');
    const materials = run
      ? run.contextMaterials || []
      : (snapshot.contextMaterials || []).filter((m) => m.active && m.scope === 'project');
    const policy = run?.executionPolicySnapshot
      ? withEnvironmentRepair(run.executionPolicySnapshot, !!run.repairEnvironment)
      : undefined;
    const session: ManagedSession = {
      version: 1,
      id,
      runtimeId: this.id,
      limits: structuredClone(this.options.limits),
      providerId: this.options.provider.id,
      providerRevision: this.options.provider.revision,
      requestedModel: this.options.model,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      scope: {
        projectId: input.projectId,
        runId: input.runId,
        ownerRunId: run?.id || input.ownerRunId,
        sessionId: input.assignment?.sessionId || id,
        workspace,
        readOnly: !!input.readOnly,
        allowedPaths: [...(input.assignment?.allowedPaths || policy?.allowedPaths || [])],
        protectedPaths: [...(input.assignment?.protectedPaths || policy?.protectedPaths || [])],
        materials: materials
          .flatMap((m) => [m.relativePath, ...(m.textPath ? [m.textPath] : [])])
          .map(
            (file) =>
              '.buro/' +
              (workspace === snapshot.project.root ? file : file.replace(/^local\//, '')),
          ),
        commands: structuredClone(
          (run?.executionPolicySnapshot?.profile || snapshot.profile)?.checks || [],
        ),
        baseCommit: run?.baseCommit,
      },
      messages: [{ role: 'system', content: input.instructions }],
      status: 'ready',
      requests: 0,
      usage: { requestsWithUsage: 0, inputTokens: 0, outputTokens: 0 },
      actions: [],
      ...(input.assignment
        ? {
            assignment: {
              roleId: input.assignment.roleId,
              allowedPaths: [...input.assignment.allowedPaths],
              protectedPaths: [...input.assignment.protectedPaths],
            },
          }
        : {}),
    };
    session.scopeRevisions = [
      { revision: 1, scope: structuredClone(session.scope), instructions: input.instructions },
    ];
    await this.options.sessions.save(session);
    this.assertOpen();
    this.loaded.set(id, session);
    return { threadId: id };
  }

  async resume(input: Parameters<NonNullable<AgentRuntime['resume']>>[0]) {
    this.assertOpen();
    if (this.active.has(input.threadId) || this.resuming.has(input.threadId))
      throw new DomainError('SESSION_BUSY', 'The session is already running.');
    const done = Promise.resolve().then(() => this.resumeSession(input));
    this.resuming.set(input.threadId, done);
    try {
      return await done;
    } finally {
      this.resuming.delete(input.threadId);
    }
  }

  private async resumeSession(input: Parameters<NonNullable<AgentRuntime['resume']>>[0]) {
    const session = await this.session(input.threadId);
    this.assertOpen();
    if (
      session.scope.projectId !== input.projectId ||
      session.scope.workspace !== input.workspace ||
      session.scope.runId !== input.runId ||
      (session.scope.ownerRunId || session.scope.runId) !== (input.ownerRunId || input.runId)
    )
      throw new DomainError(
        'SESSION_MISMATCH',
        'The checkpoint belongs to another project, run or workspace.',
      );
    this.assertReconciled(session);
    const next = structuredClone(session);
    const snapshot = this.options.projects.get(input.projectId).snapshot();
    const ownerRunId = input.ownerRunId || session.scope.ownerRunId || input.runId;
    const run = snapshot.runs.find((r) => r.id === ownerRunId);
    if ((session.scope.ownerRunId || input.ownerRunId) && !run)
      throw new DomainError('SESSION_MISMATCH', 'The owning run was not found.');
    if (run?.workspace && run.workspace !== session.scope.workspace)
      throw new DomainError('SESSION_MISMATCH', 'The owning run uses another workspace.');
    if (run?.baseCommit && session.scope.baseCommit && run.baseCommit !== session.scope.baseCommit)
      throw new DomainError('SESSION_MISMATCH', 'The owning run uses another Git base.');
    const scope: ToolScope = structuredClone(session.scope);
    const policy = run?.executionPolicySnapshot
      ? withEnvironmentRepair(run.executionPolicySnapshot, !!run.repairEnvironment)
      : undefined;
    const assignmentBound = !!session.assignment || session.scope.sessionId !== session.id;
    if (policy) {
      // A role assignment never inherits the entire project's write scope on continuation.
      scope.allowedPaths = assignmentBound
        ? session.scope.allowedPaths.filter((path) =>
            inScope(path, policy.allowedPaths, policy.protectedPaths),
          )
        : [...policy.allowedPaths];
      scope.protectedPaths = [
        ...new Set([
          ...(policy.protectedPaths || []),
          ...(assignmentBound
            ? session.assignment?.protectedPaths || session.scope.protectedPaths
            : []),
        ]),
      ];
      scope.commands = structuredClone(policy.profile?.checks || []);
    }
    const materials = run
      ? run.contextMaterials || []
      : (snapshot.contextMaterials || []).filter((m) => m.active && m.scope === 'project');
    scope.materials = materials
      .flatMap((material) => [
        material.relativePath,
        ...(material.textPath ? [material.textPath] : []),
      ])
      .map(
        (file) =>
          '.buro/' +
          (scope.workspace === snapshot.project.root ? file : file.replace(/^local\//, '')),
      );
    scope.ownerRunId = run?.id || session.scope.ownerRunId;
    scope.baseCommit = run?.baseCommit || session.scope.baseCommit;
    next.scopeRevisions ||= [
      {
        revision: 1,
        scope: structuredClone(session.scope),
        instructions: session.messages.find((message) => message.role === 'system')?.content || '',
      },
    ];
    next.scopeRevisions.push({
      revision: next.scopeRevisions.length + 1,
      scope: structuredClone(scope),
      instructions: input.instructions,
    });
    next.scope = scope;
    next.messages.push({
      role: 'system',
      content: 'Updated instructions for continuing saved work:\n' + input.instructions,
    });
    next.cancelRequested = false;
    next.status = 'ready';
    await this.options.sessions.save(next);
    this.assertOpen();
    this.loaded.set(next.id, next);
    return { threadId: next.id };
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
    if (this.active.has(threadId) || this.resuming.has(threadId))
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
    const { provider, sessions, tools, budgets } = this.options;
    const budgetOwner = budgets ? this.budgetOwner(session) : undefined;
    const budgetPhase = session.purpose === 'review' ? ('review' as const) : ('work' as const);
    if (session.purpose === 'review' && (!session.scope.readOnly || session.assignment))
      throw new DomainError('SESSION_MISMATCH', 'Review requires a read-only service session.');
    const limits = session.limits;
    const signal = controller.signal;
    const separate = provider.structuredToolMode === 'separate-turn';
    let finalizing = false;
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
          (separate
            ? '\nUse the available tools when needed to complete the task. When the work is complete, give a brief completion note; the final response is requested separately.'
            : '\nReturn your final answer as JSON matching this schema: ' +
              JSON.stringify(options.schema)),
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
        const definitions = finalizing ? [] : tools.definitions(session.scope);
        const requestMessages = provider.contextMessages
          ? provider.contextMessages(structuredClone(session.messages), {
              phase: finalizing ? 'final' : 'work',
              ...(session.intermediateNotes
                ? { intermediateMessageIndexes: [...session.intermediateNotes] }
                : {}),
            })
          : session.messages;
        const requestSchema = separate && !finalizing ? undefined : options.schema;
        const budget = prepareManagedRequest(
          {
            phase: finalizing ? 'final' : 'work',
            messages: requestMessages,
            tools: definitions,
            schema: requestSchema,
            limits,
          },
          this.options.requestPolicy,
        );
        const operationId = 'G-' + turnId + '-' + round;
        const reservation =
          budgetOwner && budgets
            ? await budgets.reserveGeneration({
                ...budgetOwner,
                operationId,
                phase: budgetPhase,
                requestedOutputTokens: budget.maxOutputTokens,
                minimumOutputTokens: Math.min(128, budget.maxOutputTokens),
              })
            : undefined;
        check();
        if (budgetOwner && budgets && (!reservation || reservation.operationId !== operationId))
          throw new DomainError(
            'INVALID_RUN_BUDGET',
            'The run budget returned an invalid reservation.',
          );
        const maxOutputTokens = reservation ? reservation.maxOutputTokens : budget.maxOutputTokens;
        if (
          !Number.isSafeInteger(maxOutputTokens) ||
          maxOutputTokens < Math.min(128, budget.maxOutputTokens) ||
          maxOutputTokens > budget.maxOutputTokens
        )
          throw new DomainError(
            'INVALID_RUN_BUDGET',
            'The run budget returned an invalid output reservation.',
          );
        session.requests++;
        await sessions.save(session);
        check();
        let response: Awaited<ReturnType<ModelProvider['complete']>>;
        try {
          response = await provider.complete({
            requestId: `${turnId}:${round}`,
            model: session.requestedModel,
            messages: requestMessages,
            tools: definitions,
            schema: requestSchema,
            maxOutputTokens,
            contextTokens: limits.contextTokens,
            signal,
            onProgress: touch,
          });
        } catch (error) {
          if (reservation && budgets && budgetOwner)
            await budgets.recordUsage({
              ...budgetOwner,
              operationId: reservation.operationId,
              outcome: 'unknown',
            });
          throw error;
        }
        if (reservation && budgets && budgetOwner)
          await budgets.recordUsage({
            ...budgetOwner,
            operationId: reservation.operationId,
            usage: response.usage,
            outcome: 'observed',
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
        if (finalizing && requested.length)
          throw new DomainError(
            'MODEL_INVALID_RESPONSE',
            'Tools cannot be dispatched during final serialization.',
          );
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
        if (requested.length && budgetOwner && budgets) {
          await budgets.reserveTools({
            ...budgetOwner,
            operationId: 'U-' + turnId + '-' + round,
            phase: budgetPhase,
            count: requested.length,
          });
          check();
        }
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
          if (!finalizing && separate) {
            finalizing = true;
            const next: ManagedSession = {
              ...session,
              intermediateNotes: [
                ...(session.intermediateNotes || []),
                session.messages.length - 1,
              ],
              messages: [
                ...session.messages,
                {
                  role: 'user',
                  content:
                    'Return only the final JSON for the preceding task. Reconstruct it from the original task and recorded tool results; do not serialize or rely on an intermediate completion note. No tools are available in this final response. Match this schema: ' +
                    JSON.stringify(options.schema),
                },
              ],
            };
            // The provenance tag and final instruction become usable together, only after durable save.
            await sessions.save(next);
            session.messages = next.messages;
            session.intermediateNotes = next.intermediateNotes;
            continue;
          }
          session.status = 'ready';
          await sessions.save(session);
          emit({ type: 'message.completed', text: response.message.content.slice(0, 12000) });
          emit({ type: 'turn.completed', turnId, status: 'completed' });
          return { turnId, text: response.message.content, model: session.reportedModel };
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
  private budgetOwner(session: ManagedSession) {
    const scope = session.scope;
    const ownerRunId = scope.ownerRunId || scope.runId;
    if (!ownerRunId) return undefined;
    const run = this.options.projects
      .get(scope.projectId)
      .snapshot()
      .runs.find((run) => run.id === ownerRunId);
    if (!run) {
      if (!scope.ownerRunId && ['research', 'environment'].includes(session.purpose || ''))
        return undefined;
      throw new DomainError('SESSION_MISMATCH', 'The owning run was not found.');
    }
    if (run.workspace && run.workspace !== scope.workspace)
      throw new DomainError('SESSION_MISMATCH', 'The owning run uses another workspace.');
    return { projectId: scope.projectId, ownerRunId };
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
      const cached = this.loaded.get(id);
      if (cached) return cached;
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
    try {
      await this.options.sessions.save(session);
    } finally {
      active.controller.abort();
    }
  }
  async release(threadId: string) {
    await this.resuming.get(threadId)?.catch(() => {});
    const active = this.active.get(threadId);
    let failure: unknown;
    if (active) {
      try {
        await this.interrupt(threadId, active.turnId);
      } catch (error) {
        failure = error;
      }
      await active.done.catch(() => {});
    }
    this.loaded.delete(threadId);
    if (failure) throw failure;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = (async () => {
      await Promise.allSettled([...this.resuming.values()]);
      const results = await Promise.allSettled(
        [...this.active.keys()].map((id) => this.release(id)),
      );
      this.loaded.clear();
      this.listeners.clear();
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, 'Managed runtime cleanup failed.');
    })();
    return this.disposal;
  }
}
