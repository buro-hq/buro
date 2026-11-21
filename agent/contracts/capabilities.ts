/** Execution mechanics declared by one trusted backend implementation, never a model proposal. */
export type BackendCapabilities = Readonly<{
  version: 1;
  revision: string;
  structuredTurns: boolean;
  toolsFreeTurns: boolean;
  readOnlySessions: boolean;
  immutableReview: boolean;
  strictPlannedWrites: boolean;
  hostToolLifecycle: boolean;
  usage: 'reported' | 'unknown';
  resumeSessions: boolean;
  cancellation: 'settled-or-unknown' | 'unsupported';
}>;

/** Required mechanics for a particular assignment/operation; absence grants no authority. */
export type BackendRequirements = {
  structuredTurns?: true;
  toolsFreeTurns?: true;
  readOnlySessions?: true;
  immutableReview?: true;
  strictPlannedWrites?: true;
  hostToolLifecycle?: true;
  usage?: 'reported';
  resumeSessions?: true;
  cancellation?: 'settled-or-unknown';
};
