import { isDeepStrictEqual } from 'node:util';
import { DomainError, type ProjectDocument } from '../../core/ports.ts';
import { assertPlanningPolicy } from '../../core/planning-policy.ts';

/** A run's planning mode cannot change when defaults change or a run is resumed. */
export function validateProjectPlanningPolicies(
  document: ProjectDocument,
  previous?: ProjectDocument,
) {
  for (const run of document.runs) {
    if (run.planningPolicy !== undefined) {
      const coordinator = run.roleResources?.coordinator?.resource || run.resources?.coordinator;
      if (!coordinator)
        throw new DomainError(
          'INVALID_PLANNING_POLICY',
          'The saved planning policy needs its configured coordinator.',
        );
      assertPlanningPolicy(run.planningPolicy, coordinator);
    }
    const before = previous?.runs.find((candidate) => candidate.id === run.id);
    if (before && !isDeepStrictEqual(before.planningPolicy, run.planningPolicy))
      throw new DomainError('INVALID_PLANNING_POLICY', 'The run planning policy is immutable.');
    if ((run.attempts?.length || 0) < (before?.attempts?.length || 0))
      throw new DomainError(
        'INVALID_PLANNING_POLICY',
        'The attempt planning history cannot be removed.',
      );
    for (const [index, attempt] of (run.attempts || []).entries()) {
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
