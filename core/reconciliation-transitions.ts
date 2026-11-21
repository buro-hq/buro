import type { Run } from '../protocol/domain.ts';
import { DomainError } from './ports.ts';

/** Required reconciliation cannot be erased by unrelated application/profile transitions. */
export function validateRunReconciliationTransitions(
  previous: readonly Run[],
  next: readonly Run[],
) {
  const identity = (run: Run) => {
    const marker = run.reconciliation;
    return (
      marker &&
      JSON.stringify([
        marker.version,
        marker.status,
        marker.code,
        marker.detectedAt,
        marker.threadId,
        marker.backendSessionId,
        marker.runtimeId,
        marker.operationId,
      ])
    );
  };
  for (const before of previous) {
    if (!before.reconciliation) continue;
    const after = next.find((run) => run.id === before.id);
    if (!after || identity(before) !== identity(after))
      throw new DomainError(
        'RUN_RECONCILIATION_REQUIRED',
        'The unresolved operation record cannot be removed or changed without verified reconciliation.',
      );
  }
}
