import type { Role } from '../protocol/domain.ts';
import type { BackendRequirements } from '../agent/contracts/capabilities.ts';
import type { AssignmentResource, ResourceSnapshot } from '../protocol/resources.ts';
import {
  resolveRoleResource,
  roleResourcePool,
  type RoleResourceProposal,
} from './role-routing.ts';
export type WorkerResourceProposal = RoleResourceProposal;

/** Workers share the same explicitly authorized frozen profile pool as other roles. */
export const workerResourcePool = roleResourcePool;

export function resolveWorkerResource(
  snapshot: ResourceSnapshot,
  role: Role,
  proposal: WorkerResourceProposal = {},
  requirements: BackendRequirements = {},
): AssignmentResource {
  return resolveRoleResource(snapshot, role, {
    purpose: 'implementation',
    requirements: { structuredTurns: true, ...requirements },
    proposal,
  });
}
