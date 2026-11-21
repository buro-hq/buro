import { z } from 'zod';
import type { BackendCapabilities } from '../agent/contracts/capabilities.ts';

/** The service freezes the selected mechanics and configured backend before planning dispatch. */
export const PlanningPolicySchema = z.strictObject({
  version: z.literal(1),
  revision: z.literal('capability-planning-v1'),
  strategy: z.enum(['tools-free-structured', 'read-only-inspection']),
  runtimeId: z.string().min(1),
  configurationRevision: z.string().min(1),
  capabilitiesRevision: z.string().min(1),
});
export type PlanningPolicy = Readonly<z.infer<typeof PlanningPolicySchema>>;

/** Metadata binding is separate from the adapter's real enforcement at session/turn dispatch. */
export function planningPolicyMatchesResource(
  policy: PlanningPolicy,
  resource: { id: string; configurationRevision: string; capabilities: BackendCapabilities },
) {
  const capabilities = resource.capabilities;
  return (
    policy.runtimeId === resource.id &&
    policy.configurationRevision === resource.configurationRevision &&
    policy.capabilitiesRevision === capabilities.revision &&
    capabilities.structuredTurns &&
    (policy.strategy === 'tools-free-structured'
      ? capabilities.toolsFreeTurns
      : !capabilities.toolsFreeTurns && capabilities.readOnlySessions)
  );
}
