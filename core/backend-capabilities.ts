import type { BackendCapabilities, BackendRequirements } from '../agent/contracts/capabilities.ts';
import {
  BackendCapabilitiesSchema,
  BackendRequirementsSchema,
} from '../protocol/backend-capabilities.ts';
import { DomainError, type RegisteredRuntime } from './ports.ts';

/** Registry-owned flat copy; the adapter's original object cannot revise an active identity. */
export function freezeBackendCapabilities(value: unknown): BackendCapabilities {
  const parsed = BackendCapabilitiesSchema.safeParse(value);
  if (!parsed.success)
    throw new DomainError(
      'INVALID_BACKEND_CAPABILITIES',
      'The backend must declare a complete, internally consistent capabilities revision.',
    );
  return Object.freeze(parsed.data);
}

export function requireBackendCapabilities(
  capabilities: BackendCapabilities,
  requirements: BackendRequirements,
) {
  const trusted = freezeBackendCapabilities(capabilities);
  const requested = BackendRequirementsSchema.safeParse(requirements);
  if (!requested.success)
    throw new DomainError(
      'INVALID_BACKEND_REQUIREMENTS',
      'The assignment requirements must explicitly name supported backend mechanics.',
    );
  for (const [key, value] of Object.entries(requested.data))
    if (value !== undefined && trusted[key as keyof BackendRequirements] !== value)
      throw new DomainError(
        'BACKEND_CAPABILITY_UNAVAILABLE',
        `The configured backend does not support the required ${key} capability.`,
      );
}

/** Compare saved metadata to the trusted registered implementation before any dispatch. */
export function assertBackendAdmission(
  resource: { id: string; capabilities?: BackendCapabilities },
  runtime: RegisteredRuntime,
  requirements: BackendRequirements = {},
) {
  if (resource.id !== runtime.id)
    throw new DomainError('RUNTIME_CONFIG_CHANGED', 'The saved backend identity is unavailable.');
  const saved = BackendCapabilitiesSchema.safeParse(resource.capabilities);
  const actual = freezeBackendCapabilities(runtime.capabilities);
  if (!saved.success || JSON.stringify(saved.data) !== JSON.stringify(actual))
    throw new DomainError(
      'BACKEND_CAPABILITIES_CHANGED',
      'The saved backend capabilities no longer match the trusted registered implementation.',
    );
  requireBackendCapabilities(actual, requirements);
}
