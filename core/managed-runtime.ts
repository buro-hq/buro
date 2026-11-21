import {
  DomainError,
  type AgentRuntime,
  type RegisteredRuntime,
  type ProjectRegistry,
  type RuntimeEvent,
} from './ports.ts';
import type { BackendCapabilities } from '../agent/contracts/capabilities.ts';
import type { ManagedSession, ManagedSessionStore, ToolBroker, ToolScope } from './model-ports.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import { inScope } from './execution-ports.ts';
import type { Run } from '../protocol/domain.ts';
import { VerificationViewSchema } from '../protocol/verification.ts';
import { withEnvironmentRepair } from './environment-repair.ts';
import {
  estimateManagedRequest,
  prepareManagedRequest,
  type ManagedRequestPolicy,
} from './request-policy.ts';
import type { ManagedRunBudgetPort } from './run-budget.ts';
import { checkManagedWorkerStep } from './managed-worker-checks.ts';
import type { WorkerStepCheckPort } from './worker-step-checks.ts';
import {
  isKnownTurnRejection,
  observedTurnFailure,
  UnresolvedEffectError,
} from './run-reconciliation.ts';
import {
  assertSegmentScope,
  decideWorkSegment,
  parseSegmentClosing,
  segmentActionReceipts,
  segmentClosingInstruction,
  segmentClosingSchema,
  segmentMessages,
  validateSegmentEvidence,
  validateSegmentLimits,
  type SegmentEvidencePort,
  type WorkSegmentPolicy,
} from './work-segments.ts';
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
  segmentPolicy?: WorkSegmentPolicy;
  segmentEvidence?: SegmentEvidencePort;
  workerStepChecks?: WorkerStepCheckPort;
  limits: {
    contextTokens: number;
    maxOutputTokens: number;
    maxRequestsPerTurn: number;
    maxToolCallsPerTurn: number;
    maxSessionRequests: number;
  };
};

/** Buro owns this loop. Providers never execute tools or accept a coding result. */
export class ManagedAgentRuntime implements RegisteredRuntime {
  readonly id: string;
  readonly capabilities: BackendCapabilities = Object.freeze({
    version: 1,
    revision: 'managed-host-tools-v1',
    structuredTurns: true,
    toolsFreeTurns: true,
    readOnlySessions: true,
    immutableReview: true,
    // Registered commands still have worktree-wide write access; edit_file alone
    // does not establish prevention for every indirect tool effect.
    strictPlannedWrites: false,
    hostToolLifecycle: true,
    usage: 'reported',
    resumeSessions: true,
    cancellation: 'settled-or-unknown',
  });
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
    if (options.segmentPolicy) {
      validateSegmentLimits(options.segmentPolicy.limits);
      if (
        options.segmentPolicy.revision !== options.segmentPolicy.limits.revision ||
        typeof options.segmentPolicy.decide !== 'function' ||
        !options.segmentEvidence
      )
        throw new DomainError('INVALID_SEGMENT_POLICY', 'The work segment policy is incomplete.');
    }
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
    const verificationView =
      run?.verificationView?.readRoot === workspace ? run.verificationView : undefined;
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
        ...(verificationView
          ? {
              verificationViewId: verificationView.id,
              verificationTree: verificationView.tree,
            }
          : {}),
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
    if (run) this.assertRunWorkspace(run, session);
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
    if (run) this.assertRunWorkspace(run, session);
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
    options: { schema: unknown; signal: AbortSignal; timeoutMs: number; toolPolicy?: 'none' },
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
    options: { schema: unknown; timeoutMs: number; toolPolicy?: 'none' },
    controller: AbortController,
  ) {
    let session = await this.session(threadId);
    this.assertReconciled(session);
    const { provider, sessions, tools, budgets } = this.options;
    if (
      session.purpose === 'review' ||
      session.scope.verificationViewId ||
      session.scope.verificationTree
    )
      this.assertCurrentWorkspace(session);
    const budgetOwner = budgets ? this.budgetOwner(session) : undefined;
    const budgetPhase = session.purpose === 'review' ? ('review' as const) : ('work' as const);
    if (session.purpose === 'review' && (!session.scope.readOnly || session.assignment))
      throw new DomainError('SESSION_MISMATCH', 'Review requires a read-only service session.');
    const limits = session.limits;
    const signal = controller.signal;
    const noTools = options.toolPolicy === 'none';
    const separate = !noTools && provider.structuredToolMode === 'separate-turn';
    let finalizing = false;
    let closing = false;
    let segmentCompleteEmitted = false;
    let responseSettled = false;
    let effectDispatched = false;
    let generationDispatched = false;
    const dispatchedActions = new Set<string>();
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
      if (
        session.purpose === 'review' ||
        session.scope.verificationViewId ||
        session.scope.verificationTree
      )
        this.assertCurrentWorkspace(session);
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
      const task =
        text +
        (separate
          ? '\nUse the available tools when needed to complete the task. When the work is complete, give a brief completion note; the final response is requested separately.'
          : '\nReturn your final answer as JSON matching this schema: ' +
            JSON.stringify(options.schema));
      if (
        !noTools &&
        this.options.segmentPolicy &&
        this.options.segmentEvidence &&
        session.purpose === 'implementation' &&
        session.assignment &&
        !session.scope.readOnly
      ) {
        const anchor = {
          turnId,
          instructions:
            session.scopeRevisions?.at(-1)?.instructions ??
            session.messages.find((message) => message.role === 'system')?.content ??
            '',
          task,
          scopeRevision: session.scopeRevisions?.at(-1)?.revision || 1,
        };
        if (!session.workSegments) {
          const baseline = await this.options.segmentEvidence.inspect(session.scope, signal);
          check();
          validateSegmentEvidence(baseline);
          session.workSegments = {
            version: 1,
            limits: structuredClone(this.options.segmentPolicy.limits),
            baseline,
            anchor,
            active: { index: 1, startedAtRequest: session.requests, toolRounds: 0 },
            archives: [],
          };
        } else {
          session.workSegments.anchor = anchor;
          session.workSegments.active.toolRounds = 0;
        }
      }
      session.status = 'running';
      session.turnAuthorities ||= [];
      session.turnAuthorities.push({
        turnId,
        toolPolicy: noTools ? 'none' : 'normal',
        startedAtRequest: session.requests,
        scopeRevision: session.scopeRevisions?.at(-1)?.revision || 1,
      });
      session.messages.push({
        role: 'user',
        content: task,
      });
      await sessions.save(session);
      emit({ type: 'turn.started', turnId });
      if (session.workSegments)
        emit({
          type: 'segment.started',
          turnId,
          segmentIndex: session.workSegments.active.index,
        });
      touch();
      for (let round = 0; round < limits.maxRequestsPerTurn; round++) {
        check();
        if (session.requests >= limits.maxSessionRequests)
          throw new DomainError(
            'MODEL_BUDGET_EXHAUSTED',
            'The session request budget is exhausted.',
          );
        if (
          !noTools &&
          !finalizing &&
          !closing &&
          session.workSegments &&
          session.workSegments.active.toolRounds > 0 &&
          this.options.segmentPolicy
        ) {
          const step = session.workSegments;
          const decision = decideWorkSegment(
            {
              limits: step.limits,
              toolRounds: step.active.toolRounds,
              segmentCount: step.active.index,
              estimatedInput: estimateManagedRequest({
                messages: session.messages,
                tools: tools.definitions(session.scope),
                schema: separate ? undefined : options.schema,
              }),
              contextTokens: limits.contextTokens,
              maxOutputTokens: limits.maxOutputTokens,
            },
            this.options.segmentPolicy,
          );
          if (decision === 'close') {
            this.assertReconciled(session);
            const next = structuredClone(session);
            next.messages.push({ role: 'user', content: segmentClosingInstruction });
            await sessions.save(next);
            session = next;
            this.loaded.set(threadId, session);
            closing = true;
          }
        }
        const definitions =
          noTools || finalizing || closing ? [] : tools.definitions(session.scope);
        const requestMessages = provider.contextMessages
          ? provider.contextMessages(structuredClone(session.messages), {
              phase: finalizing || closing ? 'final' : 'work',
              ...(session.intermediateNotes
                ? { intermediateMessageIndexes: [...session.intermediateNotes] }
                : {}),
            })
          : session.messages;
        const requestSchema = closing
          ? segmentClosingSchema
          : separate && !finalizing
            ? undefined
            : options.schema;
        const budget = prepareManagedRequest(
          {
            phase: finalizing || closing ? 'final' : 'work',
            messages: requestMessages,
            tools: definitions,
            schema: requestSchema,
            limits: closing
              ? { ...limits, maxOutputTokens: Math.min(512, limits.maxOutputTokens) }
              : limits,
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
        responseSettled = false;
        generationDispatched = false;
        session.generation = { requestId: `${turnId}:${round}`, outcome: 'pending' };
        await sessions.save(session);
        check();
        let response: Awaited<ReturnType<ModelProvider['complete']>>;
        try {
          effectDispatched = true;
          generationDispatched = true;
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
          responseSettled = isKnownTurnRejection(error);
          session.generation!.outcome = responseSettled ? 'completed' : 'unknown';
          if (responseSettled && error instanceof DomainError)
            session.generation!.rejectionCode = error.code;
          if (reservation && budgets && budgetOwner)
            await budgets.recordUsage({
              ...budgetOwner,
              operationId: reservation.operationId,
              outcome: 'unknown',
            });
          throw error;
        }
        session.generation = {
          ...session.generation!,
          outcome: 'completed',
          response: structuredClone(response),
        };
        // Preserve observed response/continuation before a usage-ledger failure can interrupt us.
        await sessions.save(session);
        responseSettled = true;
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
        // Authority is enforced before reservations, intent journaling and broker dispatch.
        if (noTools && requested.length)
          throw new DomainError(
            'TOOL_POLICY_VIOLATION',
            'The model requested a tool that this turn did not authorize.',
          );
        if ((finalizing || closing) && requested.length)
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
        // Checking the exact request definitions also rejects hidden tools on ordinary turns.
        const advertised = new Set(definitions.map((definition) => definition.name));
        if (requested.some((call) => !advertised.has(call.name)))
          throw new DomainError(
            'TOOL_POLICY_VIOLATION',
            'The model requested a tool that this turn did not authorize.',
          );
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
        // A complete response and its tool intents become durable with the generation receipt.
        // Never publish a completed generation whose response/continuation could still be lost.
        if (session.generation) session.generation.outcome = 'completed';
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
          effectDispatched = true;
          dispatchedActions.add(action.id);
          const result = await tools.execute(action.call, session.scope, {
            actionId: action.id,
            signal,
            onCommandStart: (observed) =>
              emit({ type: 'command.started', commandId: action.id, command: observed }),
          });
          action.status = 'completed';
          action.result = result;
          session.messages.push({
            role: 'tool',
            content: result.content,
            toolCallId: action.call.id,
            toolName: action.call.name,
          });
          await sessions.save(session);
          check();
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
        if (requested.length && session.workSegments) {
          session.workSegments.active.toolRounds++;
          await sessions.save(session);
        }
        if (!requested.length) {
          if (closing && response.finish !== 'stop')
            throw new DomainError(
              'INVALID_WORK_SEGMENT',
              'A work step requires a complete tools-free closing response.',
            );
          const closingDecision = closing
            ? parseSegmentClosing(response.message.content)
            : undefined;
          if (
            !noTools &&
            !finalizing &&
            (!closing || closingDecision?.status === 'complete') &&
            this.options.workerStepChecks &&
            this.options.segmentEvidence
          ) {
            const checked = await checkManagedWorkerStep({
              session,
              turnId,
              checks: this.options.workerStepChecks,
              evidence: this.options.segmentEvidence,
              budgets,
              budgetOwner,
              remainingToolCalls: limits.maxToolCallsPerTurn - calls,
              signal,
              id: this.options.idGenerator,
              availableTools: tools.definitions(session.scope).map((tool) => tool.name),
              commit: async (next) => {
                await sessions.save(next);
                session = next;
                this.loaded.set(threadId, session);
              },
            });
            calls += checked.disposition === 'skipped' ? 0 : checked.toolCallsUsed;
            check();
            if (checked.disposition === 'feedback') {
              emit({
                type: 'segment.completed',
                turnId,
                segmentIndex: checked.previousIndex,
                reason: 'continue',
                workspaceFingerprint: checked.entry.before.workspaceFingerprint,
              });
              emit({
                type: 'segment.started',
                turnId,
                segmentIndex: checked.nextIndex,
              });
              closing = false;
              finalizing = false;
              segmentCompleteEmitted = false;
              continue;
            }
          }
          if (closing) {
            const decision = closingDecision!;
            this.assertReconciled(session);
            const step = session.workSegments!;
            const evidence = await this.options.segmentEvidence!.inspect(session.scope, signal);
            check();
            assertSegmentScope(step.baseline, evidence, session.scope);
            if (decision.status === 'continue') {
              if (step.active.index >= step.limits.maxSegments)
                throw new DomainError(
                  'WORK_SEGMENT_LIMIT',
                  'The saved work segment limit is exhausted.',
                );
              const handoff = {
                version: 1 as const,
                nextTask: decision.nextTask,
                evidence,
                completedActions: session.actions.length,
                receipts: segmentActionReceipts(session.actions),
                availableTools: tools.definitions(session.scope).map((tool) => tool.name),
              };
              const next = structuredClone(session);
              next.workSegments!.archives.push({
                index: step.active.index,
                anchor: structuredClone(step.anchor),
                startedAtRequest: step.active.startedAtRequest,
                endedAtRequest: session.requests,
                messages: structuredClone(session.messages),
                ...(session.intermediateNotes
                  ? { intermediateNotes: [...session.intermediateNotes] }
                  : {}),
                handoff,
              });
              next.workSegments!.active = {
                index: step.active.index + 1,
                startedAtRequest: session.requests,
                toolRounds: 0,
              };
              next.messages = segmentMessages(step.anchor, session.scope, handoff);
              delete next.intermediateNotes;
              await sessions.save(next);
              session = next;
              this.loaded.set(threadId, session);
              check();
              emit({
                type: 'segment.completed',
                turnId,
                segmentIndex: step.active.index,
                reason: 'continue',
                workspaceFingerprint: evidence.workspaceFingerprint,
              });
              emit({
                type: 'segment.started',
                turnId,
                segmentIndex: session.workSegments!.active.index,
              });
              closing = false;
              continue;
            }
            const next = structuredClone(session);
            next.intermediateNotes = [...(next.intermediateNotes || []), next.messages.length - 1];
            next.messages.push({
              role: 'user',
              content:
                'Return only the final JSON for the original assignment, reconstructed from the original task and recorded tool results. ' +
                'A work-step closure is not acceptance. No tools are available. Match this schema: ' +
                JSON.stringify(options.schema),
            });
            await sessions.save(next);
            session = next;
            this.loaded.set(threadId, session);
            emit({
              type: 'segment.completed',
              turnId,
              segmentIndex: step.active.index,
              reason: 'complete',
              workspaceFingerprint: evidence.workspaceFingerprint,
            });
            segmentCompleteEmitted = true;
            closing = false;
            finalizing = true;
            continue;
          }
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
          if (session.workSegments && !segmentCompleteEmitted)
            emit({
              type: 'segment.completed',
              turnId,
              segmentIndex: session.workSegments.active.index,
              reason: 'complete',
            });
          emit({ type: 'message.completed', text: response.message.content.slice(0, 12000) });
          emit({ type: 'turn.completed', turnId, status: 'completed' });
          return { turnId, text: response.message.content, model: session.reportedModel };
        }
      }
      throw new DomainError('MODEL_BUDGET_EXHAUSTED', 'The turn request budget is exhausted.');
    } catch (error) {
      session.status = signal.aborted || session.cancelRequested ? 'interrupted' : 'failed';
      if (session.generation?.outcome === 'pending')
        if (!generationDispatched) {
          session.generation.outcome = 'completed';
          session.generation.rejectionCode = 'TURN_NOT_DISPATCHED';
        } else session.generation.outcome = responseSettled ? 'completed' : 'unknown';
      for (const action of session.actions)
        if (action.status === 'pending') {
          if (dispatchedActions.has(action.id)) action.status = 'unknown';
          else {
            action.status = 'completed';
            action.result = {
              content: 'Tool was not dispatched because the turn stopped before execution.',
              isError: true,
            };
            session.messages.push({
              role: 'tool',
              content: action.result.content,
              toolCallId: action.call.id,
              toolName: action.call.name,
            });
          }
        }
      let durable = session;
      try {
        await sessions.save(session);
      } catch {
        if (effectDispatched) {
          try {
            durable = (await sessions.load(session.id)) || session;
          } catch {
            emit({ type: 'turn.completed', turnId, status: session.status });
            throw new UnresolvedEffectError(
              'SESSION_RECONCILIATION_REQUIRED',
              { backendSessionId: session.id, runtimeId: this.id, operationId: turnId },
              error,
            );
          }
        }
      }
      emit({ type: 'turn.completed', turnId, status: session.status });
      if (effectDispatched) {
        const reference = { backendSessionId: session.id, runtimeId: this.id };
        const unresolvedCheck = durable.workerStepChecks?.entries.find(
          (entry) => entry.status !== 'completed',
        );
        if (unresolvedCheck)
          throw new UnresolvedEffectError(
            'WORKER_CHECK_RECONCILIATION_REQUIRED',
            { ...reference, operationId: unresolvedCheck.id },
            error,
          );
        if (durable.generation && durable.generation.outcome !== 'completed')
          throw new UnresolvedEffectError(
            'GENERATION_RECONCILIATION_REQUIRED',
            { ...reference, operationId: durable.generation.requestId },
            error,
          );
        const unresolvedAction = durable.actions.find((action) => action.status !== 'completed');
        if (unresolvedAction)
          throw new UnresolvedEffectError(
            'ACTION_RECONCILIATION_REQUIRED',
            { ...reference, operationId: unresolvedAction.id },
            error,
          );
      }
      throw observedTurnFailure(error);
    } finally {
      clearTimeout(timer);
    }
  }

  private assertOpen() {
    if (this.closed) throw new DomainError('RUNTIME_CLOSED', 'The runtime stopped.');
  }
  private assertRunWorkspace(
    run: Run,
    session: Pick<ManagedSession, 'purpose' | 'scope' | 'assignment'>,
  ) {
    const scope = session.scope;
    if (scope.verificationViewId || scope.verificationTree) {
      const parsed = VerificationViewSchema.safeParse(run.verificationView);
      if (!parsed.success || session.purpose !== 'review' || !scope.readOnly || session.assignment)
        throw new DomainError(
          'SESSION_MISMATCH',
          'Only a read-only service reviewer can use an issued verification view.',
        );
      const view = parsed.data;
      if (
        view.id !== scope.verificationViewId ||
        view.tree !== scope.verificationTree ||
        view.projectId !== scope.projectId ||
        view.runId !== run.id ||
        view.readRoot !== scope.workspace ||
        view.sourceWorkspace !== run.workspace ||
        view.base !== run.baseCommit ||
        view.base !== scope.baseCommit
      )
        throw new DomainError(
          'SESSION_MISMATCH',
          'The saved verification view is unavailable or changed.',
        );
      return;
    }
    if (
      (run.workspace && run.workspace !== scope.workspace) ||
      (session.purpose === 'review' && run.verificationView)
    )
      throw new DomainError(
        'SESSION_MISMATCH',
        'The owning run uses another workspace or active verification view.',
      );
  }
  private assertCurrentWorkspace(session: ManagedSession) {
    const owner = session.scope.ownerRunId || session.scope.runId;
    const run = this.options.projects
      .get(session.scope.projectId)
      .snapshot()
      .runs.find((run) => run.id === owner);
    if (run) this.assertRunWorkspace(run, session);
    else if (session.scope.verificationViewId || session.scope.verificationTree)
      throw new DomainError('SESSION_MISMATCH', 'The owning verification run was not found.');
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
    this.assertRunWorkspace(run, session);
    return { projectId: scope.projectId, ownerRunId };
  }
  private assertReconciled(session: ManagedSession) {
    if (session.workerStepChecks?.entries.some((entry) => entry.status !== 'completed'))
      throw new DomainError(
        'WORKER_CHECK_RECONCILIATION_REQUIRED',
        'A saved service check has an unknown outcome. It cannot be automatically repeated.',
      );
    if (session.generation && session.generation.outcome !== 'completed')
      throw new DomainError(
        'GENERATION_RECONCILIATION_REQUIRED',
        'A saved model generation has an unknown outcome. It cannot be automatically repeated.',
      );
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
      if (
        session.workSegments &&
        (!this.options.segmentPolicy ||
          !this.options.segmentEvidence ||
          JSON.stringify(session.workSegments.limits) !==
            JSON.stringify(this.options.segmentPolicy.limits))
      )
        throw new DomainError(
          'SEGMENT_POLICY_CHANGED',
          'The saved work segment policy is unavailable or changed.',
        );
      if (session.workerStepChecks && !this.options.workerStepChecks)
        throw new DomainError(
          'WORKER_CHECK_CHANGED',
          'The saved worker check service is unavailable.',
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
