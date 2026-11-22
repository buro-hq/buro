import { z } from 'zod';

export const ManagedBudgetErrorCodeSchema = z.enum([
  'RUN_BUDGET_EXHAUSTED',
  'RUN_BUDGET_USAGE_EXCEEDED',
  'INVALID_RUN_BUDGET',
  'RUN_BUDGET_OWNER_UNKNOWN',
  'BUDGET_RECEIPT_CONFLICT',
]);
export type ManagedBudgetErrorCode = z.infer<typeof ManagedBudgetErrorCodeSchema>;

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counters = z.strictObject({
  requests: counter,
  reservedOutputTokens: counter,
  toolCalls: counter,
});

/** Buro-managed API calls only; native clients do not expose equivalent accounting. */
export const ManagedRunBudgetPolicySchema = z
  .strictObject({
    version: z.literal(1),
    maxRequests: z.number().int().min(1).max(1024),
    maxReservedOutputTokens: z.number().int().min(1).max(16777216),
    maxToolCalls: z.number().int().min(1).max(16384),
    reviewReserve: z.strictObject({
      requests: z.number().int().nonnegative().max(1024),
      outputTokens: z.number().int().nonnegative().max(16777216),
      toolCalls: z.number().int().nonnegative().max(16384),
    }),
  })
  .superRefine((policy, ctx) => {
    if (
      policy.reviewReserve.requests >= policy.maxRequests ||
      policy.reviewReserve.outputTokens >= policy.maxReservedOutputTokens ||
      policy.reviewReserve.toolCalls >= policy.maxToolCalls
    )
      ctx.addIssue({ code: 'custom', message: 'Review reserves must leave a work allowance.' });
  });

export type ManagedRunBudgetPolicy = z.infer<typeof ManagedRunBudgetPolicySchema>;
export const DEFAULT_MANAGED_RUN_BUDGET_POLICY: Readonly<ManagedRunBudgetPolicy> = Object.freeze({
  version: 1,
  maxRequests: 64,
  maxReservedOutputTokens: 131072,
  maxToolCalls: 256,
  reviewReserve: Object.freeze({ requests: 8, outputTokens: 16384, toolCalls: 32 }),
});

/** Bounded public projection: no request IDs, prompts, tool arguments or provider continuation. */
export const ManagedRunBudgetSummarySchema = z
  .strictObject({
    version: z.literal(1),
    coverage: z.literal('managed-api'),
    policy: ManagedRunBudgetPolicySchema,
    status: z.enum(['open', 'exceeded']),
    used: counters,
    workUsed: counters,
    reviewUsed: counters,
    observed: z.strictObject({
      inputTokens: counter,
      outputTokens: counter,
      completeUsageRequests: counter,
      unknownUsageRequests: counter,
    }),
  })
  .superRefine((summary, ctx) => {
    if (
      (['requests', 'reservedOutputTokens', 'toolCalls'] as const).some(
        (key) => summary.used[key] !== summary.workUsed[key] + summary.reviewUsed[key],
      ) ||
      summary.observed.completeUsageRequests + summary.observed.unknownUsageRequests !==
        summary.used.requests ||
      summary.used.requests > summary.policy.maxRequests ||
      summary.used.reservedOutputTokens > summary.policy.maxReservedOutputTokens ||
      summary.used.toolCalls > summary.policy.maxToolCalls ||
      summary.workUsed.requests >
        summary.policy.maxRequests - summary.policy.reviewReserve.requests ||
      summary.workUsed.reservedOutputTokens >
        summary.policy.maxReservedOutputTokens - summary.policy.reviewReserve.outputTokens ||
      summary.workUsed.toolCalls >
        summary.policy.maxToolCalls - summary.policy.reviewReserve.toolCalls ||
      (summary.status === 'open' &&
        summary.observed.outputTokens > summary.used.reservedOutputTokens)
    )
      ctx.addIssue({ code: 'custom', message: 'Budget summary counters are inconsistent.' });
  });
export type ManagedRunBudgetSummary = z.infer<typeof ManagedRunBudgetSummarySchema>;
