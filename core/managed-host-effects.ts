import { DomainError } from './ports.ts';
import {
  isKnownTurnRejection,
  observedTurnFailure,
  UnresolvedEffectError,
} from './run-reconciliation.ts';
import { toolEffectAllowed } from './tool-contributions.ts';
import type {
  ManagedModelCompletion,
  ManagedPreparedRequest,
  ManagedTurnHost,
  ManagedTurnState,
} from './managed-turn-state.ts';

/** A scheduler sees a response only after the entire proposed action batch is durable. */
export async function generateManagedBatch(
  state: ManagedTurnState,
  host: ManagedTurnHost,
  request: ManagedPreparedRequest,
): Promise<{ response: ManagedModelCompletion; actionIds: string[] }> {
  const session = state.session;
  const { provider, budgets } = host.options;
  const { budgetOwner, budgetPhase, signal } = host;
  const limits = session.limits;
  host.check();
  const previousBatch = state.activeBatch;
  if (
    previousBatch &&
    (previousBatch.inFlight ||
      previousBatch.nextAction !== previousBatch.actionIds.length ||
      previousBatch.actionIds.some(
        (id) => session.actions.find((action) => action.id === id)?.status !== 'completed',
      ))
  )
    throw new DomainError(
      'INCOMPLETE_ACTION_BATCH',
      'The previous action batch must have committed receipts before another request.',
    );
  host.assertReconciled(session);
  const requestId = `${state.turnId}:${state.round}`;
  if (session.generation?.requestId === requestId)
    throw new DomainError(
      'INVALID_GENERATION_REQUEST',
      'A generation request identity cannot be dispatched again.',
    );
  // Packet construction is preflight; a failed clone must never look like a provider dispatch.
  const packet = structuredClone({
    messages: request.messages,
    tools: request.definitions,
    schema: request.schema,
  });
  const advertised = new Set(packet.tools.map((definition) => definition.name));
  const plannedMaxOutputTokens = request.budget.maxOutputTokens;
  if (limits.maxSessionRequests !== undefined && session.requests >= limits.maxSessionRequests)
    throw new DomainError('MODEL_BUDGET_EXHAUSTED', 'The session request budget is exhausted.');
  const operationId = 'G-' + state.turnId + '-' + state.round;
  const reservation =
    budgetOwner && budgets
      ? await budgets.reserveGeneration({
          ...budgetOwner,
          operationId,
          phase: budgetPhase,
          requestedOutputTokens: plannedMaxOutputTokens,
          minimumOutputTokens: Math.min(128, plannedMaxOutputTokens),
        })
      : undefined;
  host.check();
  if (budgetOwner && budgets && (!reservation || reservation.operationId !== operationId))
    throw new DomainError('INVALID_RUN_BUDGET', 'The run budget returned an invalid reservation.');
  const maxOutputTokens = reservation ? reservation.maxOutputTokens : plannedMaxOutputTokens;
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < Math.min(128, plannedMaxOutputTokens) ||
    maxOutputTokens > plannedMaxOutputTokens
  )
    throw new DomainError(
      'INVALID_RUN_BUDGET',
      'The run budget returned an invalid output reservation.',
    );
  session.requests++;
  state.responseSettled = false;
  state.generationDispatched = false;
  session.generation = { requestId, outcome: 'pending' };
  await host.commit(session);
  host.check();
  let response: ManagedModelCompletion;
  try {
    state.effectDispatched = true;
    state.generationDispatched = true;
    response = structuredClone(
      await provider.complete({
        requestId,
        model: session.requestedModel,
        ...packet,
        maxOutputTokens,
        contextTokens: limits.contextTokens,
        signal,
        onProgress: host.touch,
        onEvent: (event) => {
          if (event.type === 'text.delta')
            host.emit({ type: 'message.delta', turnId: state.turnId, requestId, text: event.text });
        },
      }),
    );
  } catch (error) {
    state.responseSettled = isKnownTurnRejection(error);
    session.generation!.outcome = state.responseSettled ? 'completed' : 'unknown';
    if (state.responseSettled && error instanceof DomainError)
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
  // This receipt must survive a later usage-ledger failure, before any tool can run.
  await host.commit(session);
  state.responseSettled = true;
  if (reservation && budgets && budgetOwner)
    await budgets.recordUsage({
      ...budgetOwner,
      operationId: reservation.operationId,
      usage: structuredClone(response.usage),
      outcome: 'observed',
    });
  host.check();
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
  if (state.noTools && requested.length)
    throw new DomainError(
      'TOOL_POLICY_VIOLATION',
      'The model requested a tool that this turn did not authorize.',
    );
  if ((state.finalizing || state.closing) && requested.length)
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
    throw new DomainError('MODEL_INVALID_RESPONSE', 'The model requested tools without calls.');
  const known = new Set(session.actions.map((action) => action.call.id));
  for (const call of requested) {
    if (!call.id || known.has(call.id))
      throw new DomainError(
        'DUPLICATE_TOOL_CALL',
        'A tool call ID was reused. No repeated action was dispatched.',
      );
    known.add(call.id);
  }
  // Validate the whole batch before reserving or publishing any action intent.
  if (
    requested.some(
      (call) =>
        !advertised.has(call.name) ||
        !toolEffectAllowed(host.options.tools.effect(call.name), session.scope),
    )
  )
    throw new DomainError(
      'TOOL_POLICY_VIOLATION',
      'The model requested a tool that this turn did not authorize.',
    );
  if (
    limits.maxToolCallsPerTurn !== undefined &&
    state.calls + requested.length > limits.maxToolCallsPerTurn
  )
    throw new DomainError('TOOL_BUDGET_EXHAUSTED', 'The tool action budget is exhausted.');
  if (requested.length && budgetOwner && budgets) {
    await budgets.reserveTools({
      ...budgetOwner,
      operationId: 'U-' + state.turnId + '-' + state.round,
      phase: budgetPhase,
      count: requested.length,
    });
    host.check();
  }
  // These are independent canonical copies, never aliases of a scheduler/provider view.
  session.messages.push(structuredClone(response.message));
  const actions = requested.map((call, index) => ({
    id: `A-${state.turnId}-${state.round}-${index}`,
    turnId: state.turnId,
    call: structuredClone(call),
    status: 'pending' as const,
  }));
  session.actions.push(...actions);
  if (session.generation) session.generation.outcome = 'completed';
  await host.commit(session);
  const actionIds = actions.map((action) => action.id);
  state.activeBatch = { requestId, actionIds: [...actionIds], nextAction: 0 };
  return { response: structuredClone(response), actionIds };
}

/** Dispatch only an existing pending host intent, using its saved call rather than caller arguments. */
export async function dispatchManagedAction(
  state: ManagedTurnState,
  host: ManagedTurnHost,
  actionId: string,
): Promise<void> {
  host.check();
  const session = state.session;
  const batch = state.activeBatch;
  const action = session.actions.find((item) => item.id === actionId);
  if (
    !batch ||
    batch.inFlight ||
    batch.requestId !== `${state.turnId}:${state.round}` ||
    batch.requestId !== session.generation?.requestId ||
    session.generation.outcome !== 'completed' ||
    batch.actionIds[batch.nextAction] !== actionId ||
    !action ||
    action.turnId !== state.turnId ||
    action.status !== 'pending' ||
    state.dispatchedActions.has(actionId)
  )
    throw new DomainError(
      'INVALID_TOOL_ACTION',
      'Only a pending action from this turn may be dispatched once.',
    );
  const call = structuredClone(action.call);
  const scope = structuredClone(session.scope);
  state.calls++;
  let command: string | undefined;
  batch.inFlight = action.id;
  try {
    host.emit({ type: 'tool.started', actionId: action.id, toolName: action.call.name });
    state.effectDispatched = true;
    state.dispatchedActions.add(action.id);
    const result = structuredClone(
      await host.options.tools.execute(call, scope, {
        actionId: action.id,
        signal: host.signal,
        onCommandStart: (observed) => {
          command = observed;
          host.emit({ type: 'command.started', commandId: action.id, command: observed });
        },
      }),
    );
    action.status = 'completed';
    action.result = structuredClone(result);
    session.messages.push({
      role: 'tool',
      content: result.content,
      toolCallId: action.call.id,
      toolName: action.call.name,
    });
    await host.commit(session);
    batch.nextAction++;
    host.check();
    host.emit({
      type: 'tool.completed',
      actionId: action.id,
      toolName: action.call.name,
      isError: !!result.isError,
    });
    if (command !== undefined && result.exitCode !== undefined)
      host.emit({
        type: 'command.completed',
        commandId: action.id,
        command,
        output: result.content,
        exitCode: result.exitCode === undefined ? (result.isError ? 1 : 0) : result.exitCode,
      });
    host.touch();
  } finally {
    delete batch.inFlight;
  }
}

/** Settle undispatched work and retain unknown effects using the existing durable host journal. */
export async function failManagedTurn(
  state: ManagedTurnState,
  host: ManagedTurnHost,
  error: unknown,
): Promise<never> {
  const session = state.session;
  session.status = host.signal.aborted || session.cancelRequested ? 'interrupted' : 'failed';
  if (
    session.generation?.outcome === 'pending' &&
    session.generation.requestId === `${state.turnId}:${state.round}`
  ) {
    if (!state.generationDispatched) {
      session.generation.outcome = 'completed';
      session.generation.rejectionCode = 'TURN_NOT_DISPATCHED';
    } else session.generation.outcome = state.responseSettled ? 'completed' : 'unknown';
  }
  for (const action of session.actions)
    if (action.status === 'pending' && action.turnId === state.turnId) {
      if (state.dispatchedActions.has(action.id)) action.status = 'unknown';
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
  const stillUnsettled =
    !!session.workerStepChecks?.entries.some((entry) => entry.status !== 'completed') ||
    !!(session.generation && session.generation.outcome !== 'completed') ||
    session.actions.some((action) => action.status !== 'completed');
  try {
    await host.commit(session);
  } catch {
    if (state.effectDispatched || stillUnsettled) {
      try {
        durable = (await host.options.sessions.load(session.id)) || session;
      } catch {
        host.emit({ type: 'turn.completed', turnId: state.turnId, status: session.status });
        throw new UnresolvedEffectError(
          'SESSION_RECONCILIATION_REQUIRED',
          {
            backendSessionId: session.id,
            runtimeId: host.runtimeId,
            operationId: state.turnId,
          },
          error,
        );
      }
    }
  }
  host.emit({ type: 'turn.completed', turnId: state.turnId, status: session.status });
  {
    const reference = { backendSessionId: session.id, runtimeId: host.runtimeId };
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
}
