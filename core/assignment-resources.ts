import type { Role } from '../protocol/domain.ts';
import {
  ResourceSnapshotSchema,
  RuntimePreferenceSchema,
  type AssignmentResource,
  type ResourceSnapshot,
  type RuntimeResource,
} from '../protocol/resources.ts';
import { DomainError } from './ports.ts';

export type WorkerResourceProposal = { runtimeId?: string | null; runtimeReason?: string };

/** A historical snapshot without a pool authorizes only its original worker. */
export function workerResourcePool(snapshot: ResourceSnapshot): RuntimeResource[] {
  const parsed = ResourceSnapshotSchema.safeParse(snapshot);
  if (!parsed.success)
    throw new DomainError('INVALID_RESOURCE_POOL', 'The saved worker resource pool is invalid.');
  const saved = parsed.data;
  const pool = saved.workerPool || [saved.worker];
  if (
    saved.policy === 'local-only' &&
    [...pool, saved.coordinator, saved.reviewer].some((resource) => !resource.local)
  )
    throw new DomainError(
      'DATA_POLICY_BLOCKED',
      'A local-only resource snapshot cannot include remote runtimes.',
    );
  return structuredClone(pool);
}

/** Resolve a plan proposal before dispatch. This never consults current defaults or retries a client. */
export function resolveWorkerResource(
  snapshot: ResourceSnapshot,
  role: Role,
  proposal: WorkerResourceProposal = {},
): AssignmentResource {
  const pool = workerResourcePool(snapshot);
  const parsed = RuntimePreferenceSchema.safeParse(role.runtimePreference || { mode: 'auto' });
  if (!parsed.success)
    throw new DomainError('INVALID_RUNTIME_PREFERENCE', `Invalid model preference for ${role.id}.`);
  const preference = parsed.data;
  const fallback = pool.find((resource) => resource.id === snapshot.worker.id)!;
  const proposed =
    proposal.runtimeId == null
      ? undefined
      : pool.find((resource) => resource.id === proposal.runtimeId);
  if (proposal.runtimeId != null && !proposed)
    throw new DomainError(
      'RUNTIME_NOT_ALLOWED',
      `Runtime ${proposal.runtimeId} is outside the saved worker pool.`,
    );
  if (
    proposal.runtimeReason !== undefined &&
    (typeof proposal.runtimeReason !== 'string' || proposal.runtimeReason.length > 1000)
  )
    throw new DomainError(
      'INVALID_RUNTIME_REASON',
      'A runtime selection reason must contain at most 1000 characters.',
    );
  const reason = proposal.runtimeReason?.trim();
  const selected = (
    resource: RuntimeResource,
    source: AssignmentResource['source'],
    explanation: string,
  ): AssignmentResource => ({
    resource: structuredClone(resource),
    roleVersion: role.version,
    preference: structuredClone(preference),
    source,
    reason: explanation,
  });
  if (preference.mode === 'fixed') {
    const fixed = pool.find((resource) => resource.id === preference.runtimeId);
    if (!fixed)
      throw new DomainError(
        'FIXED_RUNTIME_UNAVAILABLE',
        `The fixed runtime for ${role.id} is outside the saved worker pool. Choose another profile or update the role preference for a new assignment.`,
      );
    if (proposed && proposed.id !== fixed.id)
      throw new DomainError(
        'ROLE_RUNTIME_FIXED',
        `Role ${role.id} is fixed to ${fixed.id}; the coordinator cannot override it.`,
      );
    return selected(fixed, 'fixed', `The user fixed this specialist to ${fixed.id}.`);
  }
  if (preference.mode === 'prefer') {
    const preferred = pool.find((resource) => resource.id === preference.runtimeId);
    if (proposed && proposed.id !== preference.runtimeId) {
      if (!reason)
        throw new DomainError(
          'RUNTIME_REASON_REQUIRED',
          `Explain why ${role.id} should use ${proposed.id} instead of its preferred runtime.`,
        );
      return selected(proposed, 'coordinator', reason);
    }
    if (preferred)
      return selected(
        preferred,
        'preferred',
        `The user prefers ${preferred.id} for this specialist.`,
      );
    return selected(
      fallback,
      'profile',
      `Preferred runtime ${preference.runtimeId} is outside the saved worker pool; using the profile worker ${fallback.id}.`,
    );
  }
  if (proposed)
    return selected(
      proposed,
      'coordinator',
      reason || `The coordinator selected ${proposed.id} from the saved worker pool.`,
    );
  return selected(fallback, 'profile', `Using the profile worker ${fallback.id}.`);
}
