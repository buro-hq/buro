import type { Role } from '../protocol/domain.ts';
import type { BackendRequirements } from '../agent/contracts/capabilities.ts';
import type { AssignmentResource, ResourceSnapshot } from '../protocol/resources.ts';
import { validateRoleResource } from './role-routing.ts';

/** Validate a recorded worker decision against the same shared role-selection contract. */
export function validateAssignmentResource(
  snapshot: ResourceSnapshot,
  role: Role,
  saved: AssignmentResource,
  requirements: BackendRequirements = {},
): AssignmentResource {
  return validateRoleResource(snapshot, role, saved, {
    purpose: 'implementation',
    requirements: { structuredTurns: true, ...requirements },
  });
}
