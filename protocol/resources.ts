import { z } from 'zod';
import { BackendCapabilitiesSchema, BackendRequirementsSchema } from './backend-capabilities.ts';
import type { BackendRequirements } from '../agent/contracts/capabilities.ts';
export const ResourceIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
function canonicalJSON<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonicalJSON) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJSON((value as Record<string, unknown>)[key])]),
    ) as T;
  return value;
}
export const ResourceConfigSchema = z.record(z.string(), z.json()).transform(canonicalJSON);
export type ResourceConfig = z.infer<typeof ResourceConfigSchema>;
/** Open contribution envelopes: configuration semantics belong to trusted registrations. */
export const ResourceConnectionSchema = z.strictObject({
  id: ResourceIdSchema,
  provider: ResourceIdSchema,
  config: ResourceConfigSchema,
});
export type ResourceConnection = z.infer<typeof ResourceConnectionSchema>;
export type ResourceConnectionCatalogEntry = ResourceConnection & {
  revision: string;
  local: boolean;
  endpoint?: string;
  credentialConfigured: boolean;
  modelListing: boolean;
  activeEndpoint?: string;
  restartRequired?: boolean;
};
export const RuntimeDefinitionSchema = z.strictObject({
  id: ResourceIdSchema,
  backend: ResourceIdSchema,
  config: ResourceConfigSchema,
});
export type RuntimeDefinition = z.infer<typeof RuntimeDefinitionSchema>;
export type ResourceContributionDescriptor = {
  id: string;
  label: string;
  revision: string;
  editor?: string;
  defaultConfig: ResourceConfig;
  configSchema?: ResourceConfig;
};
export type ModelRuntimeTemplate = {
  backend: string;
  config: ResourceConfig;
  local: boolean;
  label: string;
};
export type ResourceModel = { id: string; digest?: string; templates?: ModelRuntimeTemplate[] };
export const RuntimeResourceSchema = z.object({
  id: ResourceIdSchema,
  backendId: ResourceIdSchema,
  providerId: z.string().optional(),
  model: z.string().optional(),
  configurationRevision: z.string(),
  local: z.boolean(),
  capabilities: BackendCapabilitiesSchema,
});
export const ResourceProfileSchema = z
  .strictObject({
    id: ResourceIdSchema,
    name: z.string().min(1).max(120),
    policy: z.enum(['local-only', 'hybrid']),
    coordinator: ResourceIdSchema,
    worker: ResourceIdSchema,
    reviewer: ResourceIdSchema,
    workerPool: z.array(ResourceIdSchema).min(1).max(16).optional(),
  })
  .superRefine((profile, ctx) => {
    if (
      profile.workerPool &&
      (new Set(profile.workerPool).size !== profile.workerPool.length ||
        !profile.workerPool.includes(profile.worker))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['workerPool'],
        message: 'The worker pool must contain unique runtime IDs and include the default worker.',
      });
  });
export const ResourceSetupInputSchema = z.strictObject({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  runtimes: z.array(RuntimeDefinitionSchema).max(8),
  profile: ResourceProfileSchema,
});
export type ResourceSetupInput = z.infer<typeof ResourceSetupInputSchema>;
export const ResourceSnapshotSchema = z
  .object({
    profileId: ResourceIdSchema,
    policy: z.enum(['local-only', 'hybrid']),
    coordinator: RuntimeResourceSchema,
    worker: RuntimeResourceSchema,
    reviewer: RuntimeResourceSchema,
    workerPool: z.array(RuntimeResourceSchema).min(1).max(16).optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (!snapshot.workerPool) return;
    const worker = snapshot.workerPool.find((resource) => resource.id === snapshot.worker.id);
    if (
      new Set(snapshot.workerPool.map((resource) => resource.id)).size !==
        snapshot.workerPool.length ||
      !worker ||
      (['backendId', 'providerId', 'model', 'configurationRevision', 'local'] as const).some(
        (key) => worker[key] !== snapshot.worker[key],
      ) ||
      JSON.stringify(worker?.capabilities) !== JSON.stringify(snapshot.worker.capabilities)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['workerPool'],
        message: 'The frozen pool must contain unique runtimes and the exact default worker.',
      });
  });
export const RuntimePreferenceSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('auto') }),
  z.strictObject({ mode: z.literal('prefer'), runtimeId: ResourceIdSchema }),
  z.strictObject({ mode: z.literal('fixed'), runtimeId: ResourceIdSchema }),
]);
export const AssignmentSelectionSchema = z.strictObject({
  source: z.enum(['profile', 'coordinator', 'preferred', 'fixed', 'automatic']),
  reason: z.string().trim().min(1).max(1000),
});
export const AssignmentResourceSchema = AssignmentSelectionSchema.extend({
  resource: RuntimeResourceSchema,
  roleVersion: z.number().int().positive(),
  preference: RuntimePreferenceSchema,
});
export type RuntimeResource = z.infer<typeof RuntimeResourceSchema>;
export type ResourceProfile = z.infer<typeof ResourceProfileSchema>;
export type ResourceSnapshot = z.infer<typeof ResourceSnapshotSchema>;
export type RuntimePreference = z.infer<typeof RuntimePreferenceSchema>;
export type AssignmentSelection = z.infer<typeof AssignmentSelectionSchema>;
export type AssignmentResource = z.infer<typeof AssignmentResourceSchema>;
export type RuntimePurpose =
  | 'coordination'
  | 'implementation'
  | 'review'
  | 'research'
  | 'environment'
  | 'delivery';
/** Captured by the result service before its first role/model dispatch. */
export const SavedOperationContextSchema = z.strictObject({
  id: z.string().regex(/^result\.(?:preview|pull-request|deploy\.[a-z][a-z0-9_-]{0,63})$/),
  label: z.string().min(1),
  purpose: z.literal('delivery'),
  requirements: BackendRequirementsSchema.refine(
    (requirements) =>
      requirements.structuredTurns === true && requirements.readOnlySessions === true,
    'Result preparation requires structured read-only inspection.',
  ),
  roles: z.strictObject({ kind: z.literal('fixed'), roleId: ResourceIdSchema }),
  readOnly: z.literal(true),
});
export type SavedOperationContext = z.infer<typeof SavedOperationContextSchema>;
export type RoleResourceChoices = {
  operationId: string;
  operationLabel: string;
  /** '*' is the server-authored template for newly created worker roles. */
  roleId: string;
  roleVersion?: number;
  purpose: RuntimePurpose;
  requirements: BackendRequirements;
  choices: { resource: RuntimeResource; eligible: boolean; reason: string }[];
};
export type ResourceCatalog = {
  providers: ResourceContributionDescriptor[];
  backends: ResourceContributionDescriptor[];
  roleChoices?: RoleResourceChoices[];
  /** Active provider-bound runtimes supporting the separate raw model diagnostic. */
  probeRuntimeIds?: string[];
  configurationRevision?: string;
  configured?: {
    runtimes: { definition: RuntimeDefinition; restartRequired: boolean }[];
    profiles: { profile: ResourceProfile; restartRequired: boolean }[];
  };
  defaultProfile: string;
  profiles: ResourceProfile[];
  runtimes: RuntimeResource[];
  connections: ResourceConnectionCatalogEntry[];
  selected?: ResourceSnapshot;
  probes: {
    runtimeId: string;
    configurationRevision: string;
    checkedAt: string;
    status: 'passed' | 'failed';
    reportedModel?: string;
    code?: string;
  }[];
};
export const resourceForPurpose = (snapshot: ResourceSnapshot, purpose?: RuntimePurpose) =>
  purpose === 'implementation'
    ? snapshot.worker
    : purpose === 'review'
      ? snapshot.reviewer
      : snapshot.coordinator;
export function sessionResource(
  snapshot: ResourceSnapshot | undefined,
  purpose: RuntimePurpose,
  fallbackId: string,
  decision?: AssignmentResource,
) {
  const resource =
    decision?.resource || (snapshot ? resourceForPurpose(snapshot, purpose) : undefined);
  return {
    runtimeId: resource?.id || fallbackId,
    providerId: resource?.providerId,
    model: resource?.model,
    configurationRevision: resource?.configurationRevision,
    ...(decision ? { selection: { source: decision.source, reason: decision.reason } } : {}),
  };
}
