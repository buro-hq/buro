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
    maxRequests: counter.min(1).optional(),
    maxReservedOutputTokens: counter.min(1).optional(),
    maxToolCalls: counter.min(1).optional(),
    reviewReserve: z
      .strictObject({ requests: counter, outputTokens: counter, toolCalls: counter })
      .optional(),
  })
  .superRefine((policy, ctx) => {
    for (const [maximum, reserve] of [
      [policy.maxRequests, policy.reviewReserve?.requests ?? 0],
      [policy.maxReservedOutputTokens, policy.reviewReserve?.outputTokens ?? 0],
      [policy.maxToolCalls, policy.reviewReserve?.toolCalls ?? 0],
    ] as const)
      if (maximum === undefined ? reserve !== 0 : reserve >= maximum)
        ctx.addIssue({
          code: 'custom',
          message: 'Review reserves require a finite limit and must leave a work allowance.',
        });
  });

export type ManagedRunBudgetPolicy = z.infer<typeof ManagedRunBudgetPolicySchema>;
export const DEFAULT_MANAGED_RUN_BUDGET_POLICY: Readonly<ManagedRunBudgetPolicy> = Object.freeze({
  version: 1,
});

type BudgetCounters = z.infer<typeof counters>;

/** Omitted cumulative user quotas have no remaining-allowance value. */
export function managedBudgetRemaining(
  policy: ManagedRunBudgetPolicy,
  used: BudgetCounters,
  workUsed: BudgetCounters,
  phase: 'work' | 'review',
): { [K in keyof BudgetCounters]: number | undefined } {
  const remaining = (maximum: number | undefined, total: number, work: number, reserve = 0) =>
    maximum === undefined
      ? undefined
      : phase === 'work'
        ? Math.min(maximum - total, maximum - reserve - work)
        : maximum - total;
  return {
    requests: remaining(
      policy.maxRequests,
      used.requests,
      workUsed.requests,
      policy.reviewReserve?.requests,
    ),
    reservedOutputTokens: remaining(
      policy.maxReservedOutputTokens,
      used.reservedOutputTokens,
      workUsed.reservedOutputTokens,
      policy.reviewReserve?.outputTokens,
    ),
    toolCalls: remaining(
      policy.maxToolCalls,
      used.toolCalls,
      workUsed.toolCalls,
      policy.reviewReserve?.toolCalls,
    ),
  };
}

export function managedBudgetCountersWithinPolicy(
  policy: ManagedRunBudgetPolicy,
  used: BudgetCounters,
  workUsed: BudgetCounters,
) {
  return Object.values(managedBudgetRemaining(policy, used, workUsed, 'work')).every(
    (remaining) => remaining === undefined || remaining >= 0,
  );
}

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
      !managedBudgetCountersWithinPolicy(summary.policy, summary.used, summary.workUsed) ||
      (summary.status === 'open' &&
        summary.observed.outputTokens > summary.used.reservedOutputTokens)
    )
      ctx.addIssue({ code: 'custom', message: 'Budget summary counters are inconsistent.' });
  });
export type ManagedRunBudgetSummary = z.infer<typeof ManagedRunBudgetSummarySchema>;
