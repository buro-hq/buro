import { z } from 'zod';
import { roleIdPattern } from './domain.ts';
import { ResourceIdSchema } from './resources.ts';
import { WorkerTaskSchema } from './worker-tasks.ts';
export const WorkerProposalSchema = z.strictObject({
  roleId: z
    .string()
    .regex(
      roleIdPattern,
      'roleId must start with a lowercase letter and contain only lowercase letters, digits, underscores or hyphens (max 64 characters).',
    ),
  action: z.enum(['reuse', 'create']),
  title: z.string(),
  description: z.string(),
  instructions: z.string(),
  kind: z.enum(['implementation', 'testing', 'general']),
  paths: z.array(z.string()),
  runtimeId: ResourceIdSchema.nullable().optional(),
  runtimeReason: z.string().trim().max(1000).optional(),
  assignment: WorkerTaskSchema.nullable().optional(),
});
export type WorkerProposal = z.infer<typeof WorkerProposalSchema>;
export const EnvelopeSchema = z.strictObject({
  status: z.enum(['success', 'fail']),
  summary: z.string(),
  artifacts: z.array(z.string()),
  notesForNextAgent: z.string(),
});
export const ReviewSchema = z.strictObject({
  verdict: z.enum(['approved', 'changes_requested']),
  blockingFindings: z.array(z.string()),
  summary: z.string(),
});
export const envelopeOutputSchema = z.toJSONSchema(EnvelopeSchema);
export const reviewOutputSchema = z.toJSONSchema(ReviewSchema);
