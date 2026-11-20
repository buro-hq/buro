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
export const ResourceProfileSchema = z.strictObject({
  id: ResourceIdSchema,
  name: z.string().min(1).max(120),
  policy: z.enum(['local-only', 'hybrid']),
  coordinator: ResourceIdSchema,
  worker: ResourceIdSchema,
  reviewer: ResourceIdSchema,
});
export const ResourceSnapshotSchema = z.object({
  profileId: ResourceIdSchema,
  policy: z.enum(['local-only', 'hybrid']),
  coordinator: RuntimeResourceSchema,
  worker: RuntimeResourceSchema,
  reviewer: RuntimeResourceSchema,
});
export type RuntimeResource = z.infer<typeof RuntimeResourceSchema>;
export type ResourceProfile = z.infer<typeof ResourceProfileSchema>;
export type ResourceSnapshot = z.infer<typeof ResourceSnapshotSchema>;
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
