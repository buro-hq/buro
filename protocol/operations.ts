import { z } from 'zod';
import { RelativePathSchema } from './projects-paths.ts';
import { ContextMaterialSchema, type ContextMaterial } from './context.ts';
import { ResourceSnapshotSchema, type ResourceSnapshot } from './resources.ts';
import { AssignmentResourceSchema, type AssignmentResource } from './resources.ts';
import { RoleSchema } from './workflow-roles.ts';
import type { Role } from './domain.ts';

export const ComponentSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  name: z.string().min(1).max(120),
  kind: z.enum(['web', 'api', 'worker', 'cli', 'library', 'other']),
  path: RelativePathSchema,
  command: z.string().max(4000),
  port: z.number().int().min(0).max(65535),
  readyPath: z.string().max(500),
  instructions: z.string().max(4000),
  evidence: z.string().max(2000),
});
export type ProjectComponent = z.infer<typeof ComponentSchema>;
export const DeliveryConfigSchema = z.strictObject({
  remote: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('origin'),
  pullRequests: z.boolean().default(false),
  environments: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        name: z.string().min(1).max(120),
        enabled: z.boolean(),
        command: z.string().max(4000),
        url: z
          .string()
          .max(2000)
          .refine((v) => !v || /^https?:\/\//.test(v), 'An HTTP or HTTPS URL is required.'),
        requireConfirmation: z.boolean(),
        roleId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
      }),
    )
    .max(8)
    .default([]),
});
export type DeliveryConfig = z.infer<typeof DeliveryConfigSchema>;
export const GoalOutcomeSchema = z.strictObject({
  kind: z.enum(['local', 'pull-request', 'deploy']),
  environmentId: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .optional(),
});
export type GoalOutcome = z.infer<typeof GoalOutcomeSchema>;
export type ProjectResearch = {
  roleSnapshot: Role;
  roleResource: AssignmentResource;
  analysis: { id: string; revision: string };
  contextMaterials: ContextMaterial[];
  resources: ResourceSnapshot;
  id: string;
  status: 'running' | 'ready' | 'failed' | 'interrupted';
  startedAt: string;
  completedAt?: string;
  threadId?: string;
  sourceHead: string;
  profileRevision: number;
  appliedProfileRevision?: number;
  reviewedProfileRevision?: number;
  summary: string;
  events: { at: string; text: string }[];
  components?: ProjectComponent[];
  context?: string;
  checks?: { id: string; title: string; command: string; timeoutMs: number }[];
  questions?: string[];
  error?: string;
};
export const ResearchResultSchema = z.object({
  summary: z.string().min(1).max(4000),
  context: z.string().max(16000),
  components: z.array(ComponentSchema).max(12),
  checks: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        title: z.string().min(1).max(120),
        command: z.string().min(1).max(4000),
        timeoutMs: z.number().int().min(1000).max(900000),
      }),
    )
    .max(8),
  questions: z.array(z.string().max(2000)).max(12),
});
export const ResearchSchema = z.object({
  roleSnapshot: RoleSchema,
  roleResource: AssignmentResourceSchema,
  contextMaterials: z.array(ContextMaterialSchema),
  resources: ResourceSnapshotSchema,
  analysis: z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    revision: z.string().min(1),
  }),
  id: z.string(),
  status: z.enum(['running', 'ready', 'failed', 'interrupted']),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  threadId: z.string().optional(),
  sourceHead: z.string(),
  profileRevision: z.number(),
  appliedProfileRevision: z.number().optional(),
  reviewedProfileRevision: z.number().optional(),
  summary: z.string(),
  events: z.array(z.object({ at: z.string(), text: z.string() })),
  components: z.array(ComponentSchema).optional(),
  context: z.string().optional(),
  checks: ResearchResultSchema.shape.checks.optional(),
  questions: z.array(z.string()).optional(),
  error: z.string().optional(),
});
export type RunDelivery = {
  kind: GoalOutcome['kind'];
  environmentId?: string;
  status:
    | 'pending'
    | 'running'
    | 'needs-attention'
    | 'awaiting-confirmation'
    | 'completed'
    | 'failed'
    | 'interrupted';
  commit: string;
  branch?: string;
  url?: string;
  summary: string;
  output?: string;
  updatedAt: string;
  roleId?: string;
  roleVersion?: number;
  config?: DeliveryConfig;
};
export type RunPreview = {
  status: 'starting' | 'running' | 'stopped' | 'failed';
  components: { id: string; name: string; url?: string; output: string; envFiles?: string[] }[];
  updatedAt: string;
  error?: string;
};
export const DeliverySchema = z.object({
  kind: GoalOutcomeSchema.shape.kind,
  environmentId: z.string().optional(),
  status: z.enum([
    'pending',
    'running',
    'needs-attention',
    'awaiting-confirmation',
    'completed',
    'failed',
    'interrupted',
  ]),
  commit: z.string(),
  branch: z.string().optional(),
  url: z.string().optional(),
  summary: z.string(),
  output: z.string().optional(),
  updatedAt: z.string(),
  roleId: z.string().optional(),
  roleVersion: z.number().optional(),
  config: DeliveryConfigSchema.optional(),
});
export const PreviewSchema = z.object({
  status: z.enum(['starting', 'running', 'stopped', 'failed']),
  components: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      url: z.string().optional(),
      output: z.string(),
      envFiles: z.array(z.string()).optional(),
    }),
  ),
  updatedAt: z.string(),
  error: z.string().optional(),
});
