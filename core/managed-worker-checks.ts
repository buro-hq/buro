import type { ManagedSession } from './model-ports.ts';
import type { ManagedRunBudgetPort } from './run-budget.ts';
import { DomainError } from './ports.ts';
import {
  assertSegmentScope,
  segmentActionReceipts,
  segmentMessages,
  type SegmentEvidencePort,
} from './work-segments.ts';
import {
  WORKER_STEP_CHECK_REVISION,
  validateWorkerStepCheckPlan,
  validateWorkerStepCheckResult,
  workerStepFeedback,
  type WorkerStepCheckEntry,
  type WorkerStepCheckPort,
} from './worker-step-checks.ts';

/** One application step; caller retains turn ownership, event projection and cache adoption. */
export async function checkManagedWorkerStep(options: {
  session: ManagedSession;
  turnId: string;
  checks: WorkerStepCheckPort;
  evidence: SegmentEvidencePort;
  budgets?: ManagedRunBudgetPort;
  budgetOwner?: { projectId: string; ownerRunId: string };
  signal: AbortSignal;
  id: () => string;
  availableTools: string[];
  remainingToolCalls: number;
  /** Save atomically and adopt the successfully saved checkpoint before resolving. */
  commit: (next: ManagedSession) => Promise<void>;
}) {
  let session = options.session;
  const stop = () => {
    options.signal.throwIfAborted();
    if (session.cancelRequested) throw new DOMException('Interrupted', 'AbortError');
  };
  stop();
  if (
    !session.workSegments ||
    session.purpose !== 'implementation' ||
    !session.assignment ||
    session.scope.readOnly
  )
    return { disposition: 'skipped' as const };
  if (session.workerStepChecks?.entries.some((entry) => entry.status !== 'completed'))
    throw new DomainError(
      'WORKER_CHECK_RECONCILIATION_REQUIRED',
      'A saved service check has an unknown outcome. It cannot be automatically repeated.',
    );
  // Never run candidate-controlled code in a strict live worktree. Unknown
  // receipts above still require reconciliation; final immutable checks remain.
  if (session.scope.writeScope.mode === 'strict') return { disposition: 'skipped' as const };
  const plan = options.checks.plan(structuredClone(session.scope));
  if (!plan) return { disposition: 'skipped' as const };
  validateWorkerStepCheckPlan(plan);
  if (
    !Number.isSafeInteger(options.remainingToolCalls) ||
    options.remainingToolCalls < plan.checkIds.length
  )
    throw new DomainError('TOOL_BUDGET_EXHAUSTED', 'The tool action budget is exhausted.');
  const scopeRevision = session.workSegments.anchor.scopeRevision;
  const previous = session.workerStepChecks?.entries
    .filter((entry) => entry.scopeRevision === scopeRevision)
    .at(-1);
  if (previous && JSON.stringify(previous.plan) !== JSON.stringify(plan))
    throw new DomainError('WORKER_CHECK_CHANGED', 'The frozen worker check selection changed.');
  const last = session.messages.at(-1);
  if (
    last?.role !== 'assistant' ||
    last.toolCalls?.length ||
    session.generation?.outcome !== 'completed' ||
    session.actions.some((action) => action.status !== 'completed')
  )
    throw new DomainError(
      'INVALID_STEP_CHECK',
      'A worker check requires a settled model and tool chain.',
    );
  const before = await options.evidence.inspect(session.scope, options.signal);
  stop();
  assertSegmentScope(session.workSegments.baseline, before, session.scope);
  const entry: WorkerStepCheckEntry = {
    id: 'C-' + options.id(),
    turnId: options.turnId,
    scopeRevision,
    requestedAtRequest: session.requests,
    plan: structuredClone(plan),
    before,
    status: 'pending',
  };
  if (options.budgets && options.budgetOwner)
    await options.budgets.reserveTools({
      ...options.budgetOwner,
      operationId: entry.id,
      phase: 'work',
      count: plan.checkIds.length,
    });
  stop();
  const pending = structuredClone(session);
  pending.workerStepChecks ||= {
    version: 1,
    revision: WORKER_STEP_CHECK_REVISION,
    maxFeedbackSteps: 2,
    feedbackSteps: 0,
    entries: [],
  };
  pending.workerStepChecks.entries.push(entry);
  await options.commit(pending);
  session = pending;
  let completed: WorkerStepCheckEntry;
  try {
    stop();
    const result = await options.checks.run(
      structuredClone(session.scope),
      structuredClone(plan),
      before.workspaceFingerprint,
      options.signal,
    );
    stop();
    validateWorkerStepCheckResult(plan, before.workspaceFingerprint, result);
    const after = await options.evidence.inspect(session.scope, options.signal);
    stop();
    assertSegmentScope(session.workSegments!.baseline, after, session.scope);
    if (after.workspaceFingerprint !== before.workspaceFingerprint)
      throw new DomainError(
        'WORKER_CHECK_STALE',
        'The workspace changed while its worker checks were running.',
      );
    const next = structuredClone(session);
    completed = next.workerStepChecks!.entries.at(-1)!;
    completed.status = 'completed';
    completed.result = structuredClone(result);
    await options.commit(next);
    session = next;
  } catch (error) {
    const unknown = structuredClone(session);
    unknown.workerStepChecks!.entries.at(-1)!.status = 'unknown';
    await options.commit(unknown).catch(() => {});
    throw error;
  }
  stop();
  const result = completed.result!;
  if (result.outcome !== 'completed')
    throw new DomainError(
      'WORKER_CHECK_UNAVAILABLE',
      'A registered worker check is unavailable. No automatic repair was started.',
    );
  if (result.passed === result.total)
    return {
      disposition: 'passed' as const,
      entry: completed,
      toolCallsUsed: plan.checkIds.length,
    };
  const step = session.workSegments!;
  if (session.workerStepChecks!.feedbackSteps >= session.workerStepChecks!.maxFeedbackSteps)
    throw new DomainError(
      'WORKER_CHECK_FEEDBACK_LIMIT',
      'The saved worker check feedback limit is exhausted.',
    );
  if (step.limits.maxSegments !== undefined && step.active.index >= step.limits.maxSegments)
    throw new DomainError('WORK_SEGMENT_LIMIT', 'The saved work segment limit is exhausted.');
  const handoff = {
    version: 1 as const,
    kind: 'check-feedback' as const,
    nextTask: workerStepFeedback(completed),
    evidence: before,
    completedActions: session.actions.length,
    receipts: segmentActionReceipts(session.actions),
    checkFeedback: { receiptId: completed.id, result: structuredClone(result) },
    availableTools: [...options.availableTools],
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
  next.workerStepChecks!.feedbackSteps++;
  next.messages = segmentMessages(step.anchor, session.scope, handoff);
  delete next.intermediateNotes;
  stop();
  await options.commit(next);
  return {
    disposition: 'feedback' as const,
    toolCallsUsed: plan.checkIds.length,
    entry: completed,
    previousIndex: step.active.index,
    nextIndex: next.workSegments!.active.index,
  };
}
