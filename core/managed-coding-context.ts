import { DomainError } from './ports.ts';
import type { ModelMessage } from '../agent/contracts/model.ts';
import type { ManagedSession } from './model-ports.ts';
import type {
  ManagedPreparedRequest,
  ManagedResponseDecision,
  ManagedTurnHost,
  ManagedTurnState,
} from './managed-turn-state.ts';
import { prepareManagedRequest } from './request-policy.ts';
import { checkManagedWorkerStep } from './managed-worker-checks.ts';
import { coordinatorToolsStalled } from './managed-tool-progress.ts';
import {
  assertSegmentScope,
  decideWorkSegment,
  parseSegmentClosing,
  resolveWorkSegmentPolicy,
  segmentActionReceipts,
  segmentClosingInstruction,
  coordinatorSegmentClosingInstruction,
  segmentClosingSchema,
  segmentFinalFormatTask,
  segmentMessages,
  validateSegmentEvidence,
} from './work-segments.ts';

const finalResponseInstruction =
  'Return only the final JSON for the preceding task. Reconstruct it from the original task and recorded tool results; do not serialize or rely on an intermediate completion note. No tools are available in this final response.';
const closingFinalResponseInstruction =
  'Return only the final JSON for the original assignment, reconstructed from the original task and recorded tool results. ' +
  'A work-step closure is not acceptance. No tools are available.';
const coordinatorFinalResponseInstruction =
  'Return one registered service action as the formal decision for the next useful work. The overall goal need not be complete. ' +
  'Use the current goal packet and actual recorded observations. No repository tools are available in this response. ' +
  'A service action does not itself certify acceptance.';
const finalInstruction = (session: Pick<ManagedSession, 'purpose'>, closing = false) =>
  session.purpose === 'coordination'
    ? coordinatorFinalResponseInstruction
    : closing
      ? closingFinalResponseInstruction
      : finalResponseInstruction;

/** Last server-observed context use, not a guess based on payload size. */
function observedContextTokens(session: ManagedSession): number | undefined {
  const usage = session.generation?.response?.usage;
  return usage?.inputTokens !== undefined && usage.outputTokens !== undefined
    ? usage.inputTokens + usage.outputTokens
    : undefined;
}

/** Coding context is application policy; it never schedules a model or dispatches model tools. */
export async function initializeManagedCodingContext(
  state: ManagedTurnState,
  host: ManagedTurnHost,
  task: string,
) {
  let session = state.session;
  const coordinator = session.purpose === 'coordination';
  if (
    state.noTools ||
    !host.options.segmentPolicy ||
    !host.options.segmentEvidence ||
    (!coordinator && (session.purpose !== 'implementation' || !session.assignment)) ||
    session.scope.readOnly
  )
    return;
  // Preparing a new coordinator window must not mutate the cached settled checkpoint
  // before its archive, current packet and turn authority are durably committed together.
  if (coordinator) state.session = session = structuredClone(session);
  const anchor = {
    turnId: state.turnId,
    instructions: session.scopeRevisions.at(-1)!.instructions,
    task,
    scopeRevision: session.scopeRevisions.at(-1)!.revision,
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
    const step = session.workSegments;
    if (coordinator && session.requests > step.active.startedAtRequest) {
      const decision = decideWorkSegment(
        {
          limits: step.limits,
          toolRounds: step.active.toolRounds,
          segmentCount: step.active.index,
          observedTokens: observedContextTokens(session),
          contextTokens: session.limits.contextTokens,
          maxOutputTokens: session.limits.maxOutputTokens,
        },
        resolveWorkSegmentPolicy(step.limits, host.options.segmentPolicy),
      );
      if (decision === 'close') {
        host.assertReconciled(session);
        // Explicit resume may append host-owned system instruction revisions after
        // the completed assistant reply. They remain in the archived conversation.
        const last = [...session.messages].reverse().find((message) => message.role !== 'system');
        if (
          session.status !== 'ready' ||
          session.cancelRequested ||
          session.actions.some((action) => action.status !== 'completed') ||
          session.generation?.outcome !== 'completed' ||
          session.generation.response?.finish !== 'stop' ||
          last?.role !== 'assistant' ||
          last.toolCalls?.length
        )
          throw new DomainError(
            'INCOMPLETE_WORK_SEGMENT',
            'A service-turn boundary requires a fully settled coordinator turn.',
          );
        if (step.limits.maxSegments !== undefined && step.active.index >= step.limits.maxSegments)
          throw new DomainError('WORK_SEGMENT_LIMIT', 'The saved work segment limit is exhausted.');
        const evidence = await host.options.segmentEvidence.inspect(session.scope, host.signal);
        host.check();
        assertSegmentScope(step.baseline, evidence, session.scope);
        const handoff = {
          version: 1 as const,
          kind: 'service-turn' as const,
          nextTask: 'Continue the goal using the current service observations.',
          evidence,
          completedActions: session.actions.length,
          receipts: segmentActionReceipts(session.actions),
          availableTools: host.toolDefinitions(session.scope).map((tool) => tool.name),
        };
        step.archives.push({
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
        step.active = {
          index: step.active.index + 1,
          startedAtRequest: session.requests,
          toolRounds: 0,
        };
        step.anchor = anchor;
        // The caller appends this exact current packet with the new turn authority in one save.
        session.messages = segmentMessages(anchor, session.scope, handoff).slice(0, -1);
        delete session.intermediateNotes;
        return;
      }
    }
    session.workSegments.anchor = anchor;
    session.workSegments.active.toolRounds = 0;
  }
  // The owner commits this anchor with the new turn authority and task, never separately.
}

/** A detached request view; current response formatting never becomes historical task content. */
export function projectManagedRequestContext(
  state: Pick<
    ManagedTurnState,
    'session' | 'schema' | 'noTools' | 'separate' | 'finalizing' | 'closing'
  >,
  host: Pick<ManagedTurnHost, 'options' | 'toolDefinitions'>,
) {
  const { session } = state;
  const phase = state.finalizing || state.closing ? ('final' as const) : ('work' as const);
  const definitions = structuredClone(
    state.noTools || state.finalizing || state.closing ? [] : host.toolDefinitions(session.scope),
  );
  const schema = structuredClone(
    state.closing
      ? segmentClosingSchema
      : state.separate && !state.finalizing
        ? undefined
        : state.schema,
  );
  const messages = structuredClone(session.messages);
  const instruction =
    schema === undefined
      ? session.purpose === 'coordination'
        ? 'Use repository tools for the next useful piece of work. When a registered service action is needed, stop repository tool work and give a brief note for the structured decision requested separately. You need not complete the whole goal before requesting an action. Repository commands do not replace service checks or independent review.'
        : 'Use the available tools when needed to complete the task. When the work is complete, give a brief completion note; the final response is requested separately.'
      : host.options.provider.structuredOutputMode === 'schema'
        ? 'Return your final answer as JSON matching the response format supplied by the service.'
        : (state.finalizing || state.closing
            ? 'Match this schema: '
            : 'Return your final answer as JSON matching this schema: ') + JSON.stringify(schema);
  // Extend only this detached view. Never infer or remove instructions from historical text.
  const task = [...messages].reverse().find((message) => message.role === 'user');
  if (task) task.content += '\n' + instruction;
  else messages.push({ role: 'user', content: instruction });
  const projected: ModelMessage[] = host.options.provider.contextMessages
    ? host.options.provider.contextMessages(messages, {
        phase,
        ...(session.intermediateNotes
          ? { intermediateMessageIndexes: [...session.intermediateNotes] }
          : {}),
      })
    : messages;
  return { phase, messages: projected, definitions, schema };
}

/** Build the active canonical model view; transport and dispatch remain host effect operations. */
export async function prepareManagedCodingRequest(
  state: ManagedTurnState,
  host: ManagedTurnHost,
): Promise<ManagedPreparedRequest> {
  let session = state.session;
  const limits = session.limits;
  let projected = projectManagedRequestContext(state, host);
  if (
    !state.noTools &&
    !state.closing &&
    !state.segmentCompleteEmitted &&
    session.workSegments &&
    session.requests > session.workSegments.active.startedAtRequest &&
    host.options.segmentPolicy
  ) {
    const step = session.workSegments;
    const decision = decideWorkSegment(
      {
        limits: step.limits,
        toolRounds: step.active.toolRounds,
        segmentCount: step.active.index,
        observedTokens: observedContextTokens(session),
        contextTokens: limits.contextTokens,
        maxOutputTokens: limits.maxOutputTokens,
      },
      resolveWorkSegmentPolicy(step.limits, host.options.segmentPolicy),
    );
    if (decision === 'close') {
      host.assertReconciled(session);
      const next = structuredClone(session);
      next.messages.push({
        role: 'user',
        content:
          session.purpose === 'coordination'
            ? coordinatorSegmentClosingInstruction
            : segmentClosingInstruction,
      });
      await host.commit(next);
      session = state.session;
      state.closing = true;
      projected = projectManagedRequestContext(state, host);
    }
  }
  const { phase, messages, definitions, schema } = projected;
  const budget = prepareManagedRequest(
    {
      phase,
      messages,
      tools: definitions,
      schema,
      // Closing responses may include reasoning. The configured allowance and
      // request policy also bound this phase.
      limits,
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
  if (batch.disposition === 'tools-rejected') return { kind: 'continue' };
  const requested = response.message.toolCalls || [];
  if (requested.length) {
    if (session.workSegments) {
      session.workSegments.active.toolRounds++;
      await host.commit(session);
    }
    if (await coordinatorToolsStalled(state, host)) {
      const next = structuredClone(state.session);
      next.messages.push({
        role: 'user',
        content:
          'The same repository calls returned the same results repeatedly while the observed workspace stayed unchanged. ' +
          'Choose the next registered service action using the goal packet and these actual receipts. ' +
          'If more work is needed, request an appropriate service action or report the blocker. ' +
          'Repeated results do not certify completion, current acceptance or review. No repository tools are available in this response.',
      });
      await host.commit(next);
      state.finalizing = true;
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
      remainingToolCalls:
        session.limits.maxToolCallsPerTurn === undefined
          ? undefined
          : session.limits.maxToolCallsPerTurn - state.calls,
      maxFeedbackSteps: session.limits.maxFeedbackSteps,
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
    const observed = observedContextTokens(session);
    const needsFinalRotation =
      decision.status === 'complete' &&
      observed !== undefined &&
      observed + session.limits.maxOutputTokens > session.limits.contextTokens;
    if (decision.status === 'continue' || needsFinalRotation) {
      if (step.limits.maxSegments !== undefined && step.active.index >= step.limits.maxSegments)
        throw new DomainError('WORK_SEGMENT_LIMIT', 'The saved work segment limit is exhausted.');
      const handoff = {
        version: 1 as const,
        nextTask: needsFinalRotation ? segmentFinalFormatTask : decision.nextTask,
        ...(needsFinalRotation ? { kind: 'final-format' as const } : {}),
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
      state.finalizing = needsFinalRotation;
      state.segmentCompleteEmitted = false;
      return { kind: 'continue' };
    }
    const next = structuredClone(session);
    next.intermediateNotes = [...(next.intermediateNotes || []), next.messages.length - 1];
    next.messages.push({
      role: 'user',
      content: finalInstruction(session, true),
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
          content: finalInstruction(session),
        },
      ],
    };
    // The provenance tag and bare final instruction become usable together after durable save.
    await host.commit(next);
    return { kind: 'continue' };
  }
  return {
    kind: 'complete',
    result: { turnId: state.turnId, text: response.message.content, model: session.reportedModel },
  };
}
