import { z } from 'zod';
import { ManagedRunBudgetPolicySchema } from './run-budget.ts';
import { EnvironmentConfigSchema } from './environment.ts';
import { RelativePathSchema } from './projects-paths.ts';
import { ComponentSchema, DeliveryConfigSchema } from './operations.ts';
import { CheckOutputPathsSchema } from './verification.ts';
export { RelativePathSchema } from './projects-paths.ts';
const name = z.string().trim().min(1).max(120);
export const ProjectCommandSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  title: name,
  command: z.string().trim().min(1).max(4000),
  timeoutMs: z.number().int().min(1000).max(900000),
  outputPaths: CheckOutputPathsSchema.optional(),
});
export const ProjectProfileSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    managedBudget: ManagedRunBudgetPolicySchema.optional(),
    resourceProfile: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .optional(),
    context: z.string().max(16000),
    allowedPaths: z.array(RelativePathSchema).min(1).max(40),
    protectedPaths: z.array(RelativePathSchema).max(40),
    checks: z.array(ProjectCommandSchema).max(8),
    defaultCheckIds: z.array(z.string()).max(8),
    setup: z.array(ProjectCommandSchema).max(4),
    environment: EnvironmentConfigSchema.optional(),
    checkConcurrency: z.number().int().min(1).max(4).optional(),
    dependencies: z.enum(['none', 'link-node-modules']),
    maxWorkers: z.number().int().min(1).max(2),
    maxRepairs: z.number().int().min(0).max(2),
    turnTimeoutMs: z.number().int().min(10000).max(900000),
    baseBranch: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/)
      .optional(),
    components: z.array(ComponentSchema).max(12).optional(),
    delivery: DeliveryConfigSchema.optional(),
  })
  .superRefine((p, ctx) => {
    const ids = p.checks.map((c) => c.id);
    if (new Set(ids).size !== ids.length || p.defaultCheckIds.some((id) => !ids.includes(id)))
      ctx.addIssue({
        code: 'custom',
        message: 'Check IDs must be unique, and selected checks must exist.',
      });
    for (const values of [
      p.components?.map((c) => c.id),
      p.delivery?.environments.map((e) => e.id),
    ])
      if (values && new Set(values).size !== values.length)
        ctx.addIssue({
          code: 'custom',
          message: 'Component and environment IDs must be unique.',
        });
  });
export const ProjectFileSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name,
  profile: ProjectProfileSchema,
});
export const ConnectionInputSchema = z.strictObject({
  root: z.string().trim().min(1).max(4000),
  name,
  profile: ProjectProfileSchema,
  ignoreLocal: z.boolean().default(true),
});
