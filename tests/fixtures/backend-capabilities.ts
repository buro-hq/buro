import type { BackendCapabilities } from '../../agent/contracts/capabilities.ts';

/** Tests declare only the mechanics their fake actually implements. No client-name inference. */
export function fixtureCapabilities(
  declared: Partial<Omit<BackendCapabilities, 'version'>> = {},
): BackendCapabilities {
  return {
    version: 1,
    revision: 'fixture-v1',
    structuredTurns: false,
    toolsFreeTurns: false,
    readOnlySessions: false,
    immutableReview: false,
    strictPlannedWrites: false,
    hostToolLifecycle: false,
    usage: 'unknown',
    resumeSessions: false,
    cancellation: 'unsupported',
    ...declared,
  };
}
