import type { BackendCapabilities } from '../../agent/contracts/capabilities.ts';
import type { ResourceSnapshot } from '../../protocol/resources.ts';
import type { RuntimeSelection } from '../../core/ports.ts';
import { fixtureCapabilities } from './backend-capabilities.ts';

/** For in-process fakes with no tool effects during planning and a separate read-only critic. */
export const fixtureExecutionCapabilities = (
  declared: Partial<Omit<BackendCapabilities, 'version'>> = {},
): BackendCapabilities =>
  fixtureCapabilities({
    structuredTurns: true,
    toolsFreeTurns: true,
    readOnlySessions: true,
    immutableReview: true,
    ...declared,
  });

/** Every Core fixture explicitly selects its fake's declared mechanics; labels grant nothing. */
export function fixtureExecutionSelection(
  runtimeId: string,
  capabilities: BackendCapabilities,
): RuntimeSelection {
  const resource = {
    id: runtimeId,
    client: 'managed' as const,
    configurationRevision: 'fixture-runtime-v1',
    local: true,
    capabilities: structuredClone(capabilities),
  };
  const snapshot: ResourceSnapshot = {
    profileId: 'fixture',
    policy: 'local-only',
    coordinator: resource,
    worker: resource,
    reviewer: resource,
  };
  return { forProject: () => structuredClone(snapshot) };
}
