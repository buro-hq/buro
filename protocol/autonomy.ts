import { z } from 'zod';
import { WorkScopeSchema } from './work-scope.ts';
import { ManagedRunBudgetPolicySchema } from './run-budget.ts';

/** Service-derived policy values, never permission grants supplied by a model or UI. */
export const EffectivePolicySchema = z
  .strictObject({
    version: z.literal(1),
    source: z.enum(['project', 'saved-run']),
    origin: z.strictObject({
      kind: z.enum(['project-profile', 'service-settings']),
      revision: z.number().int().nonnegative().optional(),
    }),
    files: WorkScopeSchema,
    routing: z.strictObject({
      dataPolicy: z.enum(['local-only', 'hybrid', 'unknown']),
      profileId: z.string().min(1).optional(),
      assignments: z.array(
        z.strictObject({
          roleId: z.string().min(1),
          operationId: z.string().min(1).optional(),
          operationLabel: z.string().min(1).optional(),
          runtimeId: z.string().min(1),
          providerId: z.string().optional(),
          model: z.string().optional(),
          configurationRevision: z.string().min(1),
          capabilityRevision: z.string().min(1),
          tools: z.enum(['host-managed', 'backend-managed']),
          usage: z.enum(['reported', 'unknown']),
        }),
      ),
      unavailable: z
        .array(
          z.strictObject({
            roleId: z.string().min(1),
            operationId: z.string().min(1).optional(),
            operationLabel: z.string().min(1).optional(),
            code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
            message: z.string().min(1),
          }),
        )
        .optional(),
    }),
    checks: z.strictObject({
      source: z.literal('immutable-snapshot'),
      intermediate: z.enum(['available', 'deferred', 'unavailable']),
      checkIds: z.array(z.string()),
    }),
    usage: z.strictObject({
      mode: z.enum(['bounded-managed', 'unknown']),
      origin: z.enum(['project-profile', 'service-default', 'saved-run']),
      policy: ManagedRunBudgetPolicySchema.optional(),
      coverage: z.enum(['managed-api', 'partial', 'unknown']),
      unknownUsageRequests: z.number().int().nonnegative().optional(),
    }),
  })
  .superRefine((policy, context) => {
    if ((policy.usage.mode === 'bounded-managed') !== (policy.usage.policy !== undefined))
      context.addIssue({
        code: 'custom',
        message: 'A managed limit summary requires its actual policy.',
      });
    if (policy.usage.mode === 'unknown' && policy.usage.coverage !== 'unknown')
      context.addIssue({
        code: 'custom',
        message: 'Unknown accounting cannot claim complete coverage.',
      });
  });
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;

export const RunStopActionSchema = z.enum([
  'repair',
  'recheck',
  'edit-goal',
  'new-run',
  'project-settings',
]);
export type RunStopAction = z.infer<typeof RunStopActionSchema>;
/** A stopped run's observed condition and currently available application actions. */
export const RunStopSchema = z
  .strictObject({
    version: z.literal(1),
    category: z.enum([
      'user-policy',
      'capability',
      'capacity',
      'checks',
      'unknown',
      'configuration',
    ]),
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string().min(1),
    detail: z.string().min(1).optional(),
    savedProgress: z.strictObject({ workspace: z.boolean(), history: z.literal(true) }),
    automaticRecovery: z.enum(['not-scheduled', 'requires-reconciliation']),
    actions: z
      .array(RunStopActionSchema)
      .refine((actions) => new Set(actions).size === actions.length),
  })
  .superRefine((stop, context) => {
    if (
      stop.category === 'unknown' &&
      stop.actions.some((action) => ['repair', 'recheck', 'new-run'].includes(action))
    )
      context.addIssue({
        code: 'custom',
        message: 'An unknown operation cannot offer conflicting execution.',
      });
    if (stop.category === 'unknown' && stop.automaticRecovery !== 'requires-reconciliation')
      context.addIssue({
        code: 'custom',
        message: 'An unknown operation requires reconciliation.',
      });
  });
export type RunStop = z.infer<typeof RunStopSchema>;
