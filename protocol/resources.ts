import { z } from 'zod';
import { endpointIsPrivate, modelEndpointURL } from './endpoint-trust.ts';
import { BackendCapabilitiesSchema } from './backend-capabilities.ts';
import type { BackendRequirements } from '../agent/contracts/capabilities.ts';
export const ResourceIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const modelEndpoint = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => {
    try {
      modelEndpointURL(value);
      return true;
    } catch {
      return false;
    }
  }, 'Use an HTTP(S) endpoint without credentials, query or fragment.');
export const ResourceConnectionSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      id: ResourceIdSchema,
      kind: z.literal('ollama'),
      endpoint: modelEndpoint.default('http://127.0.0.1:11434'),
      capacity: z.number().int().min(1).max(8).default(1),
      trust: z.enum(['auto', 'private-network', 'external']).default('auto'),
      think: z.union([z.boolean(), z.string().max(40)]).optional(),
    }),
    z.strictObject({
      id: ResourceIdSchema,
      kind: z.literal('deepseek'),
      endpoint: modelEndpoint.default('https://api.deepseek.com'),
      capacity: z.number().int().min(1).max(8).default(2),
      apiKeyEnv: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
        .default('DEEPSEEK_API_KEY'),
      thinking: z.enum(['enabled', 'disabled']).default('disabled'),
    }),
  ])
  .superRefine((connection, ctx) => {
    if (connection.kind === 'deepseek') {
      try {
        const endpoint = modelEndpointURL(connection.endpoint);
        if (
          endpoint.protocol !== 'https:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
        )
          ctx.addIssue({
            code: 'custom',
            path: ['endpoint'],
            message: 'Remote DeepSeek endpoints require HTTPS.',
          });
      } catch {
        // The endpoint field reports malformed URLs.
      }
      return;
    }
    if (connection.kind !== 'ollama' || connection.trust !== 'private-network') return;
    try {
      if (endpointIsPrivate(modelEndpointURL(connection.endpoint))) return;
    } catch {
      return; // The endpoint field already reports malformed URLs.
    }
    ctx.addIssue({
      code: 'custom',
      path: ['trust'],
      message: 'Private network trust requires a literal private or loopback IP address.',
    });
  });
export type ResourceConnection = z.infer<typeof ResourceConnectionSchema>;
export type ResourceConnectionCatalogEntry = ResourceConnection & {
  revision: string;
  credentialConfigured: boolean;
  activeEndpoint?: string;
  restartRequired?: boolean;
};
export const ManagedLimitsSchema = z
  .strictObject({
    contextTokens: z.number().int().min(1024).max(262144).default(32768),
    maxOutputTokens: z.number().int().min(128).max(32768).default(4096),
    maxRequestsPerTurn: z.number().int().min(1).max(64).default(24),
    maxToolCallsPerTurn: z.number().int().min(1).max(128).default(64),
    maxSessionRequests: z.number().int().min(1).max(1024).default(256),
  })
  .refine((limits) => limits.maxOutputTokens < limits.contextTokens, 'Reserve input context.');
export const ManagedRuntimeDefinitionSchema = z.strictObject({
  id: ResourceIdSchema,
  client: z.literal('managed'),
  connectionId: ResourceIdSchema,
  model: z.string().min(1).max(200),
  limits: ManagedLimitsSchema.default(() => ManagedLimitsSchema.parse({})),
});
export const NativeRuntimeDefinitionSchema = z.strictObject({
  id: ResourceIdSchema,
  client: z.literal('codex'),
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !/[\0\r\n]/.test(value), 'Use a single model identifier.')
    .optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
});
export const RuntimeDefinitionSchema = z.discriminatedUnion('client', [
  NativeRuntimeDefinitionSchema,
  ManagedRuntimeDefinitionSchema,
]);
export type ManagedRuntimeDefinition = z.infer<typeof ManagedRuntimeDefinitionSchema>;
export type NativeRuntimeDefinition = z.infer<typeof NativeRuntimeDefinitionSchema>;
export type RuntimeDefinition = z.infer<typeof RuntimeDefinitionSchema>;
export const RuntimeResourceSchema = z.object({
  id: ResourceIdSchema,
  client: z.enum(['codex', 'managed']),
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
      (['client', 'providerId', 'model', 'configurationRevision', 'local'] as const).some(
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
export type RoleResourceChoices = {
  /** '*' is the server-authored template for newly created worker roles. */
  roleId: string;
  roleVersion?: number;
  purpose: RuntimePurpose;
  requirements: BackendRequirements;
  choices: { resource: RuntimeResource; eligible: boolean; reason: string }[];
};
export type ResourceCatalog = {
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
