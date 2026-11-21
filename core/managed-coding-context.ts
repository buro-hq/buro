import { DomainError } from './ports.ts';
import type { ManagedSession } from './model-ports.ts';
import type {
  ManagedPreparedRequest,
  ManagedResponseDecision,
  ManagedTurnHost,
  ManagedTurnState,
} from './managed-turn-state.ts';
import { estimateManagedRequest, prepareManagedRequest } from './request-policy.ts';
import { checkManagedWorkerStep } from './managed-worker-checks.ts';
import {
  assertSegmentScope,
  decideWorkSegment,
  parseSegmentClosing,
  segmentActionReceipts,
  segmentClosingInstruction,
  segmentClosingSchema,
  segmentMessages,
  validateSegmentEvidence,
} from './work-segments.ts';

/** Coding context is application policy; it never schedules a model or dispatches model tools. */
export async function initializeManagedCodingContext(
  state: ManagedTurnState,
  host: ManagedTurnHost,
  task: string,
) {
  const session = state.session;
  if (
    state.noTools ||
    !host.options.segmentPolicy ||
    !host.options.segmentEvidence ||
    session.purpose !== 'implementation' ||
    !session.assignment ||
    session.scope.readOnly
  )
    return;
  const anchor = {
    turnId: state.turnId,
    instructions:
      session.scopeRevisions?.at(-1)?.instructions ??
      session.messages.find((message) => message.role === 'system')?.content ??
      '',
    task,
    scopeRevision: session.scopeRevisions?.at(-1)?.revision || 1,
  };
  if (!session.workSegments) {
    const baseline = await host.options.segmentEvidence.inspect(session.scope, host.signal);
    host.check();
    validateSegmentEvidence(baseline);
    session.workSegments = {
      version: 1,
      limits: structuredClone(host.options.segmentPolicy.limits),
      baseline,
      anchor,
      active: { index: 1, startedAtRequest: session.requests, toolRounds: 0 },
      archives: [],
    };
  } else {
    session.workSegments.anchor = anchor;
    session.workSegments.active.toolRounds = 0;
  }
  // The owner commits this anchor with the new turn authority and task, never separately.
}

/** Build the active canonical model view; transport and dispatch remain host effect operations. */
export async function prepareManagedCodingRequest(
  state: ManagedTurnState,
  host: ManagedTurnHost,
): Promise<ManagedPreparedRequest> {
  let session = state.session;
  const limits = session.limits;
  if (
    !state.noTools &&
    !state.finalizing &&
    !state.closing &&
    session.workSegments &&
    session.workSegments.active.toolRounds > 0 &&
    host.options.segmentPolicy
  ) {
    const step = session.workSegments;
    const decision = decideWorkSegment(
      {
        limits: step.limits,
        toolRounds: step.active.toolRounds,
        segmentCount: step.active.index,
        estimatedInput: estimateManagedRequest({
          messages: session.messages,
          tools: host.toolDefinitions(session.scope),
          schema: state.separate ? undefined : state.schema,
        }),
        contextTokens: limits.contextTokens,
        maxOutputTokens: limits.maxOutputTokens,
      },
      host.options.segmentPolicy,
    );
    if (decision === 'close') {
      host.assertReconciled(session);
      const next = structuredClone(session);
      next.messages.push({ role: 'user', content: segmentClosingInstruction });
      await host.commit(next);
      session = state.session;
      state.closing = true;
    }
  }
  const definitions =
    state.noTools || state.finalizing || state.closing ? [] : host.toolDefinitions(session.scope);
  const messages = host.options.provider.contextMessages
    ? host.options.provider.contextMessages(structuredClone(session.messages), {
        phase: state.finalizing || state.closing ? 'final' : 'work',
        ...(session.intermediateNotes
          ? { intermediateMessageIndexes: [...session.intermediateNotes] }
          : {}),
      })
    : session.messages;
  const schema = state.closing
    ? segmentClosingSchema
    : state.separate && !state.finalizing
      ? undefined
      : state.schema;
  const budget = prepareManagedRequest(
    {
      phase: state.finalizing || state.closing ? 'final' : 'work',
      messages,
      tools: definitions,
      schema,
      limits: state.closing
        ? { ...limits, maxOutputTokens: Math.min(512, limits.maxOutputTokens) }
        : limits,
    },
    host.options.requestPolicy,
  );
  return { messages, definitions, schema, budget };
}

/** Run coding checks/context transitions only after the host has settled the complete tool batch. */
export async function afterManagedResponse(
  state: ManagedTurnState,
  host: ManagedTurnHost,
): Promise<ManagedResponseDecision> {
  let session = state.session;
  host.check();
  const batch = state.activeBatch;
  const generation = session.generation;
  if (
    !batch ||
    batch.requestId !== `${state.turnId}:${state.round}` ||
    batch.inFlight ||
    batch.nextAction !== batch.actionIds.length ||
    generation?.requestId !== batch.requestId ||
    generation.outcome !== 'completed' ||
    !generation.response
  )
    throw new DomainError(
      'INCOMPLETE_ACTION_BATCH',
      'The current model response and tool receipts must be committed before context or completion can advance.',
    );
  host.assertReconciled(session);
  const response = structuredClone(generation.response);
  const requested = response.message.toolCalls || [];
  if (requested.length) {
    if (session.workSegments) {
      session.workSegments.active.toolRounds++;
      await host.commit(session);
    }
    return { kind: 'continue' };
  }
  if (state.closing && response.finish !== 'stop')
    throw new DomainError(
      'INVALID_WORK_SEGMENT',
      'A work step requires a complete tools-free closing response.',
    );
  const closingDecision = state.closing ? parseSegmentClosing(response.message.content) : undefined;
  if (
    !state.noTools &&
    !state.finalizing &&
    (!state.closing || closingDecision?.status === 'complete') &&
    host.options.workerStepChecks &&
    host.options.segmentEvidence
  ) {
    const checked = await checkManagedWorkerStep({
      session,
      turnId: state.turnId,
      checks: host.options.workerStepChecks,
      evidence: host.options.segmentEvidence,
      budgets: host.options.budgets,
      budgetOwner: host.budgetOwner,
      remainingToolCalls: session.limits.maxToolCallsPerTurn - state.calls,
      signal: host.signal,
      id: host.options.idGenerator,
      availableTools: host.toolDefinitions(session.scope).map((tool) => tool.name),
      commit: (next) => host.commit(next),
    });
    state.calls += checked.disposition === 'skipped' ? 0 : checked.toolCallsUsed;
    host.check();
    session = state.session;
    if (checked.disposition === 'feedback') {
      host.emit({
        type: 'segment.completed',
        turnId: state.turnId,
        segmentIndex: checked.previousIndex,
        reason: 'continue',
        workspaceFingerprint: checked.entry.before.workspaceFingerprint,
      });
      host.emit({
        type: 'segment.started',
        turnId: state.turnId,
        segmentIndex: checked.nextIndex,
      });
      state.closing = false;
      state.finalizing = false;
      state.segmentCompleteEmitted = false;
      return { kind: 'continue' };
    }
  }
  if (state.closing) {
    const decision = closingDecision!;
    host.assertReconciled(session);
    const step = session.workSegments!;
    const evidence = await host.options.segmentEvidence!.inspect(session.scope, host.signal);
    host.check();
    assertSegmentScope(step.baseline, evidence, session.scope);
    if (decision.status === 'continue') {
      if (step.active.index >= step.limits.maxSegments)
        throw new DomainError('WORK_SEGMENT_LIMIT', 'The saved work segment limit is exhausted.');
      const handoff = {
        version: 1 as const,
        nextTask: decision.nextTask,
        evidence,
        completedActions: session.actions.length,
        receipts: segmentActionReceipts(session.actions),
        availableTools: host.toolDefinitions(session.scope).map((tool) => tool.name),
      };
      const next = structuredClone(session);
      next.workSegments!.archives.push({
        index: step.active.index,
        anchor: structuredClone(step.anchor),
        startedAtRequest: step.active.startedAtRequest,
        endedAtRequest: session.requests,
        messages: structuredClone(session.messages),
        ...(session.intermediateNotes ? { intermediateNotes: [...session.intermediateNotes] } : {}),
        handoff,
      });
      next.workSegments!.active = {
        index: step.active.index + 1,
        startedAtRequest: session.requests,
        toolRounds: 0,
      };
      next.messages = segmentMessages(step.anchor, session.scope, handoff);
      delete next.intermediateNotes;
      await host.commit(next);
      host.check();
      host.emit({
        type: 'segment.completed',
        turnId: state.turnId,
        segmentIndex: step.active.index,
        reason: 'continue',
        workspaceFingerprint: evidence.workspaceFingerprint,
      });
      host.emit({
        type: 'segment.started',
        turnId: state.turnId,
        segmentIndex: state.session.workSegments!.active.index,
      });
      state.closing = false;
      return { kind: 'continue' };
    }
    const next = structuredClone(session);
    next.intermediateNotes = [...(next.intermediateNotes || []), next.messages.length - 1];
    next.messages.push({
      role: 'user',
      content:
        'Return only the final JSON for the original assignment, reconstructed from the original task and recorded tool results. ' +
        'A work-step closure is not acceptance. No tools are available. Match this schema: ' +
        JSON.stringify(state.schema),
    });
    await host.commit(next);
    host.emit({
      type: 'segment.completed',
      turnId: state.turnId,
      segmentIndex: step.active.index,
      reason: 'complete',
      workspaceFingerprint: evidence.workspaceFingerprint,
    });
    state.segmentCompleteEmitted = true;
    state.closing = false;
    state.finalizing = true;
    return { kind: 'continue' };
  }
  if (!state.finalizing && state.separate) {
    state.finalizing = true;
    const next: ManagedSession = {
      ...session,
      intermediateNotes: [...(session.intermediateNotes || []), session.messages.length - 1],
      messages: [
        ...session.messages,
        {
          role: 'user',
          content:
            'Return only the final JSON for the preceding task. Reconstruct it from the original task and recorded tool results; do not serialize or rely on an intermediate completion note. No tools are available in this final response. Match this schema: ' +
            JSON.stringify(state.schema),
        },
      ],
    };
    // The provenance tag and final instruction become usable together only after durable save.
    await host.commit(next);
    return { kind: 'continue' };
  }
  return {
    kind: 'complete',
    result: { turnId: state.turnId, text: response.message.content, model: session.reportedModel },
  };
}
