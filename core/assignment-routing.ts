import type { Role } from '../protocol/domain.ts';
import {
  AssignmentResourceSchema,
  type AssignmentResource,
  type ResourceSnapshot,
} from '../protocol/resources.ts';
import { resolveWorkerResource } from './assignment-resources.ts';
import { DomainError } from './ports.ts';

/** Validate a recorded decision without consulting today's catalog or choosing another model. */
export function validateAssignmentResource(
  snapshot: ResourceSnapshot,
  role: Role,
  saved: AssignmentResource,
): AssignmentResource {
  const parsed = AssignmentResourceSchema.safeParse(saved);
  if (!parsed.success)
    throw new DomainError('INVALID_ASSIGNMENT', 'The saved resource decision is invalid.');
  const decision = parsed.data;
  const preference = role.runtimePreference || { mode: 'auto' as const };
  if (
    decision.roleVersion !== role.version ||
    decision.preference.mode !== preference.mode ||
    (preference.mode !== 'auto' &&
      (decision.preference.mode === 'auto' ||
        decision.preference.runtimeId !== preference.runtimeId))
  )
    throw new DomainError(
      'INVALID_ASSIGNMENT',
      'The resource decision belongs to another role version.',
    );
  const expected = resolveWorkerResource(
    snapshot,
    role,
    decision.source === 'coordinator'
      ? { runtimeId: decision.resource.id, runtimeReason: decision.reason }
      : {},
  );
  if (
    expected.source !== decision.source ||
    (['id', 'client', 'providerId', 'model', 'configurationRevision', 'local'] as const).some(
      (key) => expected.resource[key] !== decision.resource[key],
    )
  )
    throw new DomainError(
      'INVALID_ASSIGNMENT',
      'The resource decision does not match the frozen worker pool and preference.',
    );
  return decision;
}
