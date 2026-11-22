import { z } from 'zod';
import { ResourceIdSchema, RuntimePreferenceSchema } from './resources.ts';

export const WorkflowIdentitySchema = z.strictObject({
  id: ResourceIdSchema,
  revision: z.string().min(1),
});
export type WorkflowIdentity = z.infer<typeof WorkflowIdentitySchema>;
export const RoleProvenanceSchema = z.discriminatedUnion('origin', [
  z.strictObject({
    origin: z.literal('user'),
    workflow: WorkflowIdentitySchema.optional(),
    template: WorkflowIdentitySchema.optional(),
  }),
  z.strictObject({
    origin: z.literal('workflow'),
    workflow: WorkflowIdentitySchema,
    template: WorkflowIdentitySchema,
  }),
  z.strictObject({ origin: z.literal('coordinator'), workflow: WorkflowIdentitySchema }),
]);
export type RoleProvenance = z.infer<typeof RoleProvenanceSchema>;
export const RoleSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  instructions: z.string(),
  kind: z.enum(['implementation', 'testing', 'review', 'coordination', 'general']),
  model: z.string().optional(),
  runtimePreference: RuntimePreferenceSchema.optional(),
  provenance: RoleProvenanceSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
