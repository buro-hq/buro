import { z } from 'zod';
import { roleIdPattern } from './domain.ts';
export const TeamPlanSchema = z.strictObject({
  summary: z.string(),
  steps: z
    .array(z.strictObject({ step: z.string().min(1), owner: z.string().min(1) }))
    .min(2)
    .max(12),
  team: z
    .array(
      z.strictObject({
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
      }),
    )
    .max(2),
});
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
export const teamOutputSchema = z.toJSONSchema(TeamPlanSchema);
export const envelopeOutputSchema = z.toJSONSchema(EnvelopeSchema);
export const reviewOutputSchema = z.toJSONSchema(ReviewSchema);
