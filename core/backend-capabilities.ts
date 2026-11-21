import type { BackendCapabilities, BackendRequirements } from '../agent/contracts/capabilities.ts';
import {
  BackendCapabilitiesSchema,
  BackendRequirementsSchema,
} from '../protocol/backend-capabilities.ts';
import { DomainError, type RegisteredRuntime } from './ports.ts';

const unavailable: Record<keyof BackendRequirements, string> = {
  structuredTurns: 'This backend cannot complete structured requests.',
  toolsFreeTurns: 'This backend cannot run a turn without tools.',
  readOnlySessions: 'This backend cannot enforce read-only work.',
  immutableReview: 'This backend cannot review the isolated source snapshot.',
  strictPlannedWrites:
    'This backend cannot prevent changes outside planned paths. Choose a backend with strict scope support or turn off strict scope.',
  hostToolLifecycle: 'This backend cannot use service-managed tool execution.',
  usage: 'This backend cannot provide the requested usage accounting.',
  resumeSessions: 'This backend cannot restore the saved session.',
  cancellation: 'This backend does not support cancellation.',
};

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
        unavailable[key as keyof BackendRequirements],
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
