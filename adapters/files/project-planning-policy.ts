import { isDeepStrictEqual } from 'node:util';
import { DomainError, type ProjectDocument } from '../../core/ports.ts';
import { PlanningPolicySchema } from '../../protocol/schema.ts';

/** A run's planning mode cannot change when defaults change or a run is resumed. */
export function validateProjectPlanningPolicies(
  document: ProjectDocument,
  previous?: ProjectDocument,
) {
  for (const run of document.runs) {
    if (
      run.planningPolicy !== undefined &&
      (!PlanningPolicySchema.safeParse(run.planningPolicy).success ||
        (run.planningPolicy.mode === 'bounded' && run.resources?.coordinator.client !== 'managed'))
    )
      throw new DomainError('INVALID_PLANNING_POLICY', 'The saved planning policy is invalid.');
    const before = previous?.runs.find((candidate) => candidate.id === run.id);
    if (before && !isDeepStrictEqual(before.planningPolicy, run.planningPolicy))
      throw new DomainError('INVALID_PLANNING_POLICY', 'The run planning policy is immutable.');
    if ((run.attempts?.length || 0) < (before?.attempts?.length || 0))
      throw new DomainError(
        'INVALID_PLANNING_POLICY',
        'The attempt planning history cannot be removed.',
      );
    for (const [index, attempt] of (run.attempts || []).entries()) {
      if (
        attempt.planningPolicy !== undefined &&
        !PlanningPolicySchema.safeParse(attempt.planningPolicy).success
      )
        throw new DomainError('INVALID_PLANNING_POLICY', 'The attempt planning policy is invalid.');
      if (!isDeepStrictEqual(attempt.planningPolicy, run.planningPolicy))
        throw new DomainError(
          'INVALID_PLANNING_POLICY',
          'The attempt must retain its run planning policy.',
        );
      const saved = before?.attempts?.[index];
      if (saved && !isDeepStrictEqual(saved.planningPolicy, attempt.planningPolicy))
        throw new DomainError(
          'INVALID_PLANNING_POLICY',
          'The attempt planning policy is immutable.',
        );
    }
  }
}
