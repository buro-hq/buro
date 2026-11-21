import type { Run, RunIssue } from '../protocol/domain.ts';
import type {
  PendingRunTurn,
  ReconciliationCode,
  RunReconciliation,
} from '../protocol/reconciliation.ts';
import { DomainError } from './ports.ts';

const messages: Record<ReconciliationCode, string> = {
  SESSION_RECONCILIATION_REQUIRED:
    'A previous agent session has an unknown outcome. Reconcile it before continuing.',
  GENERATION_RECONCILIATION_REQUIRED:
    'A previous model request has an unknown outcome. Reconcile it before continuing.',
  ACTION_RECONCILIATION_REQUIRED:
    'A previous tool action has an unknown outcome. Reconcile it before continuing.',
  WORKER_CHECK_RECONCILIATION_REQUIRED:
    'A previous service check has an unknown outcome. Reconcile it before continuing.',
  WORKSPACE_CHECKPOINT_RECONCILIATION_REQUIRED:
    'The workspace checkpoint has an unknown outcome. Reconcile it before continuing.',
};

type EffectReference = Pick<
  RunReconciliation,
  'threadId' | 'backendSessionId' | 'runtimeId' | 'operationId'
>;

/** Backend-owned observation, not a model claim or a generic transport error. */
export class UnresolvedEffectError extends DomainError {
  readonly reference: EffectReference;
  constructor(code: ReconciliationCode, reference: EffectReference, cause?: unknown) {
    super(code, messages[code]);
    this.reference = { ...reference };
    this.cause = cause;
  }
}

const observedFailures = new WeakSet<object>();

/** Preserve the original error while recording a backend-confirmed settled/no-dispatch outcome. */
export function observedTurnFailure<T>(error: T): T {
  if (error !== null && (typeof error === 'object' || typeof error === 'function'))
    observedFailures.add(error);
  return error;
}

// These errors explicitly report admission/preflight failure or a negative HTTP response.
// Network errors, partial/invalid streams and timeouts are deliberately absent.
const knownRejections = new Set([
  'MODEL_REQUEST_REJECTED',
  'MODEL_AUTH_FAILED',
  'MODEL_AUTH_REQUIRED',
  'MODEL_BILLING_BLOCKED',
  'MODEL_NOT_FOUND',
  'MODEL_RATE_LIMITED',
  'MODEL_CONTEXT_EXHAUSTED',
  'MODEL_BUDGET_EXHAUSTED',
  'TOOL_BUDGET_EXHAUSTED',
  'RUN_BUDGET_EXHAUSTED',
  'RUN_BUDGET_RESERVE_UNAVAILABLE',
  'TOOL_POLICY_UNSUPPORTED',
  'SESSION_BUSY',
  'THREAD_NOT_FOUND',
  'TURN_UNSUPPORTED',
  'RUNTIME_CLOSED',
]);

/** A receipt-based observation is stronger than classification by exception text. */
export function isKnownTurnRejection(error: unknown): boolean {
  return (
    (error !== null && typeof error === 'object' && observedFailures.has(error)) ||
    (error instanceof DomainError && knownRejections.has(error.code))
  );
}

export function reconciliationForError(
  error: unknown,
  context: EffectReference & { detectedAt: string },
): RunReconciliation | undefined {
  if (!(error instanceof DomainError) || !Object.hasOwn(messages, error.code)) return undefined;
  return {
    version: 1,
    status: 'required',
    code: error.code as ReconciliationCode,
    ...(error instanceof UnresolvedEffectError ? error.reference : {}),
    ...context,
  };
}

export function reconciliationForPendingTurn(
  pending: PendingRunTurn,
  detectedAt: string,
): RunReconciliation {
  return {
    version: 1,
    status: 'required',
    code: 'SESSION_RECONCILIATION_REQUIRED',
    detectedAt,
    threadId: pending.threadId,
    runtimeId: pending.runtimeId,
    operationId: pending.id,
  };
}

/** Recording another failure cannot clear or replace an unresolved owner-run boundary. */
export function retainRunReconciliation(
  current: RunReconciliation | undefined,
  incoming: RunReconciliation | undefined,
): RunReconciliation | undefined {
  return current || incoming;
}

export function reconciliationIssue(reconciliation: RunReconciliation): RunIssue {
  return {
    code: 'RECONCILIATION_REQUIRED',
    message: messages[reconciliation.code],
    checks: [],
  };
}

export function assertRunReconciled(run: Pick<Run, 'reconciliation' | 'pendingTurn'>) {
  if (run.reconciliation || run.pendingTurn)
    throw new DomainError(
      'RUN_RECONCILIATION_REQUIRED',
      run.reconciliation
        ? messages[run.reconciliation.code]
        : 'A previous agent turn has no observed outcome. Reconcile it before continuing.',
    );
}
