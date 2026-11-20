import { z } from 'zod';
export const ResourceIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const RuntimeResourceSchema = z.object({
  id: ResourceIdSchema,
  client: z.enum(['codex', 'managed']),
  providerId: z.string().optional(),
  model: z.string().optional(),
  configurationRevision: z.string(),
  local: z.boolean(),
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
      (['client', 'providerId', 'model', 'configurationRevision', 'local'] as const).some(
        (key) => worker[key] !== snapshot.worker[key],
      )
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
  source: z.enum(['profile', 'coordinator', 'preferred', 'fixed']),
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
export type ResourceCatalog = {
  defaultProfile: string;
  profiles: ResourceProfile[];
  runtimes: RuntimeResource[];
  connections: {
    id: string;
    kind: 'ollama' | 'deepseek';
    endpoint: string;
    credentialConfigured?: boolean;
    apiKeyEnv?: string;
  }[];
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
) {
  const resource = snapshot ? resourceForPurpose(snapshot, purpose) : undefined;
  return {
    runtimeId: resource?.id || fallbackId,
    providerId: resource?.providerId,
    model: resource?.model,
    configurationRevision: resource?.configurationRevision,
  };
}
