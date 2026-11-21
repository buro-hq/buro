import type { Role } from '../protocol/domain.ts';
import type { BackendRequirements } from '../agent/contracts/capabilities.ts';
import {
  AssignmentResourceSchema,
  ResourceSnapshotSchema,
  RuntimePreferenceSchema,
  resourceForPurpose,
  type AssignmentResource,
  type ResourceSnapshot,
  type RuntimePurpose,
  type RuntimeResource,
} from '../protocol/resources.ts';
import { requireBackendCapabilities } from './backend-capabilities.ts';
import { DomainError } from './ports.ts';

export type RoleResourceProposal = { runtimeId?: string | null; runtimeReason?: string };
export type RoleResourceContext = {
  /** Actual service operation; a role's descriptive kind never grants execution authority. */
  purpose: RuntimePurpose;
  requirements?: BackendRequirements;
  proposal?: RoleResourceProposal;
};
export type RoleResourceEligibility = {
  resource: RuntimeResource;
  eligible: boolean;
  reason: string;
};

/** One saved profile is the complete authority. Selecting a role never adds a connection. */
export function roleResourcePool(snapshot: ResourceSnapshot): RuntimeResource[] {
  const parsed = ResourceSnapshotSchema.safeParse(snapshot);
  if (!parsed.success)
    throw new DomainError('INVALID_RESOURCE_POOL', 'The saved role resource pool is invalid.');
  const saved = parsed.data;
  const resources = [saved.coordinator, saved.worker, saved.reviewer, ...(saved.workerPool || [])];
  const pool = new Map<string, RuntimeResource>();
  for (const resource of resources) {
    const previous = pool.get(resource.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(resource))
      throw new DomainError(
        'INVALID_RESOURCE_POOL',
        'A saved runtime ID has inconsistent resource identities.',
      );
    pool.set(resource.id, resource);
  }
  if (saved.policy === 'local-only' && [...pool.values()].some((resource) => !resource.local))
    throw new DomainError(
      'DATA_POLICY_BLOCKED',
      'A local-only resource snapshot cannot include remote runtimes.',
    );
  return structuredClone([...pool.values()]);
}

export function roleResourceEligibility(
  snapshot: ResourceSnapshot,
  requirements: BackendRequirements = {},
  purpose?: RuntimePurpose,
): RoleResourceEligibility[] {
  return roleResourcePool(snapshot).map((resource) => {
    try {
      requireBackendCapabilities(resource.capabilities, requirements);
      if (
        purpose === 'coordination' &&
        !resource.capabilities.toolsFreeTurns &&
        !resource.capabilities.readOnlySessions
      )
        throw new DomainError(
          'BACKEND_CAPABILITY_UNAVAILABLE',
          'Planning requires tools-free structured turns or read-only inspection.',
        );
      return { resource, eligible: true, reason: 'Available for this operation.' };
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'BACKEND_CAPABILITY_UNAVAILABLE')
        throw error;
      return { resource, eligible: false, reason: error.message };
    }
  });
}

/** Resolve all roles by explicit preference and actual operation mechanics, never client branding. */
export function resolveRoleResource(
  snapshot: ResourceSnapshot,
  role: Role,
  context: RoleResourceContext,
): AssignmentResource {
  const choices = roleResourceEligibility(snapshot, context.requirements, context.purpose);
  const preference = RuntimePreferenceSchema.safeParse(role.runtimePreference || { mode: 'auto' });
  if (!preference.success)
    throw new DomainError('INVALID_RUNTIME_PREFERENCE', `Invalid model preference for ${role.id}.`);
  const proposal = context.proposal || {};
  if (
    proposal.runtimeReason !== undefined &&
    (typeof proposal.runtimeReason !== 'string' || proposal.runtimeReason.length > 1000)
  )
    throw new DomainError(
      'INVALID_RUNTIME_REASON',
      'A runtime selection reason must contain at most 1000 characters.',
    );
  const reason = proposal.runtimeReason?.trim();
  const proposed =
    proposal.runtimeId == null
      ? undefined
      : choices.find((choice) => choice.resource.id === proposal.runtimeId);
  if (proposal.runtimeId != null && !proposed)
    throw new DomainError(
      'RUNTIME_NOT_ALLOWED',
      `Runtime ${proposal.runtimeId} is outside the saved profile pool.`,
    );
  const selected = (
    resource: RuntimeResource,
    source: AssignmentResource['source'],
    reason: string,
  ): AssignmentResource => ({
    resource: structuredClone(resource),
    roleVersion: role.version,
    preference: structuredClone(preference.data),
    source,
    reason,
  });
  const preferredId = preference.data.mode === 'auto' ? undefined : preference.data.runtimeId;
  const preferred = choices.find((choice) => choice.resource.id === preferredId);
  if (preference.data.mode === 'fixed') {
    if (!preferred?.eligible)
      throw new DomainError(
        'FIXED_RUNTIME_UNAVAILABLE',
        `The fixed runtime ${preference.data.runtimeId} for ${role.id} is unavailable: ${preferred?.reason || 'outside the saved profile pool.'}`,
      );
    if (proposed && proposed.resource.id !== preferred.resource.id)
      throw new DomainError(
        'ROLE_RUNTIME_FIXED',
        `Role ${role.id} is fixed to ${preferred.resource.id}; the coordinator cannot override it.`,
      );
    return selected(
      preferred.resource,
      'fixed',
      `The user fixed this role to ${preferred.resource.id}.`,
    );
  }
  if (proposed && !proposed.eligible)
    throw new DomainError(
      'BACKEND_CAPABILITY_UNAVAILABLE',
      `Role ${role.id} cannot use ${proposed.resource.id}: ${proposed.reason}`,
    );
  if (preference.data.mode === 'prefer') {
    if (proposed && proposed.resource.id !== preference.data.runtimeId) {
      if (!reason)
        throw new DomainError(
          'RUNTIME_REASON_REQUIRED',
          `Explain why ${role.id} should use ${proposed.resource.id} instead of its preferred runtime.`,
        );
      return selected(proposed.resource, 'coordinator', reason);
    }
    if (preferred?.eligible)
      return selected(
        preferred.resource,
        'preferred',
        `The user prefers ${preferred.resource.id} for this role.`,
      );
  } else if (proposed)
    return selected(
      proposed.resource,
      'coordinator',
      reason || `The coordinator selected ${proposed.resource.id} from the saved profile pool.`,
    );
  const defaultId = resourceForPurpose(snapshot, context.purpose).id;
  const fallback =
    choices.find((choice) => choice.resource.id === defaultId && choice.eligible) ||
    choices.find((choice) => choice.eligible);
  if (!fallback)
    throw new DomainError(
      'BACKEND_CAPABILITY_UNAVAILABLE',
      `No runtime in the saved profile supports ${role.id}: ${choices.map((choice) => `${choice.resource.id}: ${choice.reason}`).join(' ')}`,
    );
  const preferenceReason =
    preference.data.mode === 'prefer'
      ? `Preferred runtime ${preference.data.runtimeId} is unavailable (${preferred?.reason || 'outside the saved profile pool'}); `
      : '';
  if (fallback.resource.id === defaultId)
    return selected(
      fallback.resource,
      'profile',
      preferenceReason + `Using the profile ${context.purpose} runtime ${defaultId}.`,
    );
  const unavailableDefault = choices.find((choice) => choice.resource.id === defaultId);
  return selected(
    fallback.resource,
    'automatic',
    preferenceReason +
      `Profile runtime ${defaultId} is ineligible (${unavailableDefault?.reason || 'unavailable'}); automatically selected ${fallback.resource.id} from the saved profile pool.`,
  );
}

/** Revalidate a durable decision without consulting current defaults or inventing a fallback. */
export function validateRoleResource(
  snapshot: ResourceSnapshot,
  role: Role,
  saved: AssignmentResource,
  context: Omit<RoleResourceContext, 'proposal'>,
): AssignmentResource {
  const parsed = AssignmentResourceSchema.safeParse(saved);
  if (!parsed.success)
    throw new DomainError('INVALID_ASSIGNMENT', 'The saved role resource decision is invalid.');
  const decision = parsed.data;
  const preference = RuntimePreferenceSchema.safeParse(role.runtimePreference || { mode: 'auto' });
  if (
    !preference.success ||
    decision.roleVersion !== role.version ||
    JSON.stringify(decision.preference) !== JSON.stringify(preference.data)
  )
    throw new DomainError(
      'INVALID_ASSIGNMENT',
      'The resource decision belongs to another role version or preference.',
    );
  const expected = resolveRoleResource(snapshot, role, {
    ...context,
    ...(decision.source === 'coordinator'
      ? { proposal: { runtimeId: decision.resource.id, runtimeReason: decision.reason } }
      : {}),
  });
  if (
    expected.source !== decision.source ||
    JSON.stringify(expected.resource) !== JSON.stringify(decision.resource)
  )
    throw new DomainError(
      'INVALID_ASSIGNMENT',
      'The resource decision does not match the frozen profile, role and operation requirements.',
    );
  return decision;
}

/** Built-in host entry points, never inferred from a role's descriptive kind. */
export function roleResourceContext(
  roleId: string,
  strict: boolean,
): Omit<RoleResourceContext, 'proposal'> {
  if (roleId === 'reviewer')
    return {
      purpose: 'review',
      requirements: { structuredTurns: true, readOnlySessions: true, immutableReview: true },
    };
  if (['local_preview', 'delivery_pr', 'production_delivery'].includes(roleId))
    return { purpose: 'delivery', requirements: { structuredTurns: true, readOnlySessions: true } };
  if (roleId === 'coordinator')
    return {
      purpose: 'coordination',
      requirements: {
        structuredTurns: true,
        ...(strict ? { strictPlannedWrites: true as const } : {}),
      },
    };
  return {
    purpose: 'implementation',
    requirements: {
      structuredTurns: true,
      ...(strict ? { strictPlannedWrites: true as const } : {}),
    },
  };
}
