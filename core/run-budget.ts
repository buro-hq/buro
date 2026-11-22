import { z } from 'zod';
import {
  ManagedRunBudgetPolicySchema,
  ManagedRunBudgetSummarySchema,
  DEFAULT_MANAGED_RUN_BUDGET_POLICY,
  type ManagedRunBudgetPolicy,
  type ManagedRunBudgetSummary,
} from '../protocol/run-budget.ts';
import { DomainError } from './ports.ts';

export type ManagedBudgetPhase = 'work' | 'review';
export type ManagedBudgetUsage = { inputTokens?: number; outputTokens?: number };
export type ManagedGenerationInput = {
  operationId: string;
  phase: ManagedBudgetPhase;
  requestedOutputTokens: number;
  minimumOutputTokens: number;
};
export type ManagedToolBudgetInput = {
  operationId: string;
  phase: ManagedBudgetPhase;
  count: number;
};
export type ManagedUsageInput = {
  operationId: string;
  usage?: ManagedBudgetUsage;
  outcome: 'observed' | 'unknown';
};
export type ManagedGenerationGrant = { operationId: string; maxOutputTokens: number };
type Owner = { projectId: string; ownerRunId: string };
export interface ManagedRunBudgetPort {
  reserveGeneration(input: Owner & ManagedGenerationInput): Promise<ManagedGenerationGrant>;
  recordUsage(input: Owner & ManagedUsageInput): Promise<void>;
  reserveTools(input: Owner & ManagedToolBudgetInput): Promise<void>;
}

const phase = z.enum(['work', 'review']);
const operationId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,179}$/)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value));
const output = z.number().int().min(1).max(16777216);
// Keep every bounded ledger aggregate a safe integer even for malformed provider accounting.
const usageValue = z.number().int().nonnegative().max(1099511627776);
const usage = z.strictObject({
  inputTokens: usageValue.optional(),
  outputTokens: usageValue.optional(),
});
const generation = z
  .strictObject({
    kind: z.literal('generation'),
    phase,
    requestedOutputTokens: output,
    minimumOutputTokens: output,
    reservedOutputTokens: output,
    outcome: z.enum(['reserved', 'observed', 'unknown']),
    usage: usage.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.minimumOutputTokens > value.reservedOutputTokens ||
      value.reservedOutputTokens > value.requestedOutputTokens ||
      (value.outcome !== 'observed' && value.usage !== undefined)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid generation reservation.' });
  });
const tools = z.strictObject({
  kind: z.literal('tools'),
  phase,
  count: z.number().int().min(1).max(16384),
});
const baseLedger = z.strictObject({
  version: z.literal(1),
  projectId: z.string().min(1).max(200),
  ownerRunId: z.string().min(1).max(200),
  coverage: z.literal('managed-api'),
  policy: ManagedRunBudgetPolicySchema,
  operations: z.record(operationId, z.union([generation, tools])),
  violation: z.enum(['OUTPUT_RESERVATION_EXCEEDED', 'INVALID_USAGE']).optional(),
});
type LedgerData = z.infer<typeof baseLedger>;

function counters(ledger: LedgerData) {
  const empty = () => ({ requests: 0, reservedOutputTokens: 0, toolCalls: 0 });
  const work = empty(),
    review = empty();
  let inputTokens = 0,
    outputTokens = 0,
    completeUsageRequests = 0;
  for (const entry of Object.values(ledger.operations)) {
    const target = entry.phase === 'review' ? review : work;
    if (entry.kind === 'tools') target.toolCalls += entry.count;
    else {
      target.requests++;
      target.reservedOutputTokens += entry.reservedOutputTokens;
      if (entry.outcome === 'observed') {
        inputTokens += entry.usage?.inputTokens ?? 0;
        outputTokens += entry.usage?.outputTokens ?? 0;
        if (entry.usage?.inputTokens !== undefined && entry.usage.outputTokens !== undefined)
          completeUsageRequests++;
      }
    }
  }
  const used = {
    requests: work.requests + review.requests,
    reservedOutputTokens: work.reservedOutputTokens + review.reservedOutputTokens,
    toolCalls: work.toolCalls + review.toolCalls,
  };
  return {
    used,
    workUsed: work,
    reviewUsed: review,
    observed: {
      inputTokens,
      outputTokens,
      completeUsageRequests,
      unknownUsageRequests: used.requests - completeUsageRequests,
    },
  };
}

export const ManagedRunBudgetLedgerSchema = baseLedger.superRefine((ledger, ctx) => {
  const { used, workUsed } = counters(ledger);
  const policy = ledger.policy;
  const overObserved = Object.values(ledger.operations).some(
    (entry) =>
      entry.kind === 'generation' && (entry.usage?.outputTokens ?? 0) > entry.reservedOutputTokens,
  );
  if (
    Object.keys(ledger.operations).length > 17408 ||
    used.requests > policy.maxRequests ||
    used.reservedOutputTokens > policy.maxReservedOutputTokens ||
    used.toolCalls > policy.maxToolCalls ||
    workUsed.requests > policy.maxRequests - policy.reviewReserve.requests ||
    workUsed.reservedOutputTokens >
      policy.maxReservedOutputTokens - policy.reviewReserve.outputTokens ||
    workUsed.toolCalls > policy.maxToolCalls - policy.reviewReserve.toolCalls ||
    (overObserved && !ledger.violation)
  )
    ctx.addIssue({
      code: 'custom',
      message: 'The private budget ledger violates its frozen policy.',
    });
});
export type ManagedRunBudgetLedger = z.infer<typeof ManagedRunBudgetLedgerSchema>;

export function validateManagedRunBudget(value: unknown): ManagedRunBudgetLedger {
  const parsed = ManagedRunBudgetLedgerSchema.safeParse(value);
  if (!parsed.success)
    throw new DomainError('INVALID_RUN_BUDGET', 'The saved run budget is invalid.');
  return parsed.data;
}

/** An unrelated project transaction cannot reset a frozen allowance or rewrite charged work. */
export function validateManagedRunBudgetTransition(
  previous: ManagedRunBudgetLedger,
  value: ManagedRunBudgetLedger,
) {
  const before = validateManagedRunBudget(previous);
  const after = validateManagedRunBudget(value);
  const unchanged = (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right);
  const invalid = () =>
    new DomainError(
      'INVALID_RUN_BUDGET',
      'A managed budget transition changed frozen policy or previously charged work.',
    );
  if (
    before.projectId !== after.projectId ||
    before.ownerRunId !== after.ownerRunId ||
    before.coverage !== after.coverage ||
    !unchanged(before.policy, after.policy) ||
    (before.violation !== undefined && after.violation === undefined)
  )
    throw invalid();
  for (const [id, entry] of Object.entries(before.operations)) {
    const next = Object.hasOwn(after.operations, id) ? after.operations[id] : undefined;
    if (!next || entry.kind !== next.kind || entry.phase !== next.phase) throw invalid();
    if (entry.kind === 'tools' || entry.outcome !== 'reserved') {
      if (!unchanged(entry, next)) throw invalid();
    } else if (
      next.kind !== 'generation' ||
      entry.requestedOutputTokens !== next.requestedOutputTokens ||
      entry.minimumOutputTokens !== next.minimumOutputTokens ||
      entry.reservedOutputTokens !== next.reservedOutputTokens
    )
      throw invalid();
  }
}
export function createManagedRunBudget(
  input: Owner & {
    policy?: ManagedRunBudgetPolicy;
    coverage: ManagedRunBudgetLedger['coverage'];
  },
): ManagedRunBudgetLedger {
  const parsedPolicy = ManagedRunBudgetPolicySchema.safeParse(
    input.policy || DEFAULT_MANAGED_RUN_BUDGET_POLICY,
  );
  if (!parsedPolicy.success)
    throw new DomainError('INVALID_RUN_BUDGET', 'The run budget policy is invalid.');
  return validateManagedRunBudget({
    version: 1,
    ...input,
    policy: parsedPolicy.data,
    operations: {},
  });
}
export function managedBudgetSummary(value: ManagedRunBudgetLedger): ManagedRunBudgetSummary {
  const ledger = validateManagedRunBudget(value);
  return ManagedRunBudgetSummarySchema.parse({
    version: 1,
    coverage: ledger.coverage,
    policy: ledger.policy,
    status: ledger.violation ? 'exceeded' : 'open',
    ...counters(ledger),
  });
}

function openLedger(value: ManagedRunBudgetLedger) {
  const ledger = validateManagedRunBudget(value);
  if (ledger.violation)
    throw new DomainError(
      'RUN_BUDGET_USAGE_EXCEEDED',
      'Observed model usage exceeded its reservation. Start a new run.',
    );
  return ledger;
}
function conflict() {
  return new DomainError(
    'BUDGET_RECEIPT_CONFLICT',
    'This budget operation ID belongs to another reservation or observation.',
  );
}
function exhausted() {
  return new DomainError(
    'RUN_BUDGET_EXHAUSTED',
    'The managed run budget is exhausted; protected review capacity cannot be spent on work.',
  );
}
function usageError(ledger: ManagedRunBudgetLedger) {
  return ledger.violation
    ? {
        code: 'RUN_BUDGET_USAGE_EXCEEDED',
        message:
          ledger.violation === 'INVALID_USAGE'
            ? 'The provider returned invalid usage accounting. Further managed work is blocked.'
            : 'Observed model output exceeded its reservation. Further managed work is blocked.',
      }
    : undefined;
}
function ownOperation(ledger: ManagedRunBudgetLedger, id: string) {
  if (!operationId.safeParse(id).success)
    throw new DomainError('INVALID_RUN_BUDGET', 'Invalid budget operation ID.');
  return Object.hasOwn(ledger.operations, id) ? ledger.operations[id] : undefined;
}

export function reserveManagedGeneration(
  value: ManagedRunBudgetLedger,
  input: ManagedGenerationInput,
) {
  const ledger = openLedger(value);
  const parsed = z
    .strictObject({
      operationId,
      phase,
      requestedOutputTokens: output,
      minimumOutputTokens: output,
    })
    .safeParse(input);
  if (!parsed.success || input.minimumOutputTokens > input.requestedOutputTokens)
    throw new DomainError('INVALID_RUN_BUDGET', 'The model reservation is invalid.');
  const previous = ownOperation(ledger, input.operationId);
  if (previous) {
    if (
      previous.kind !== 'generation' ||
      previous.phase !== input.phase ||
      previous.requestedOutputTokens !== input.requestedOutputTokens ||
      previous.minimumOutputTokens !== input.minimumOutputTokens
    )
      throw conflict();
    return {
      ledger,
      grant: { operationId: input.operationId, maxOutputTokens: previous.reservedOutputTokens },
    };
  }
  const { used, workUsed } = counters(ledger),
    policy = ledger.policy;
  if (
    used.requests >= policy.maxRequests ||
    (input.phase === 'work' &&
      workUsed.requests >= policy.maxRequests - policy.reviewReserve.requests)
  )
    throw exhausted();
  const remaining = Math.min(
    policy.maxReservedOutputTokens - used.reservedOutputTokens,
    input.phase === 'work'
      ? policy.maxReservedOutputTokens -
          policy.reviewReserve.outputTokens -
          workUsed.reservedOutputTokens
      : Infinity,
  );
  const amount = Math.min(input.requestedOutputTokens, remaining);
  if (amount < input.minimumOutputTokens) throw exhausted();
  ledger.operations[input.operationId] = {
    kind: 'generation',
    phase: input.phase,
    requestedOutputTokens: input.requestedOutputTokens,
    minimumOutputTokens: input.minimumOutputTokens,
    reservedOutputTokens: amount,
    outcome: 'reserved',
  };
  return {
    ledger: validateManagedRunBudget(ledger),
    grant: { operationId: input.operationId, maxOutputTokens: amount },
  };
}

export function reserveManagedTools(value: ManagedRunBudgetLedger, input: ManagedToolBudgetInput) {
  const ledger = openLedger(value);
  const parsed = z
    .strictObject({ operationId, phase, count: z.number().int().min(1).max(16384) })
    .safeParse(input);
  if (!parsed.success)
    throw new DomainError('INVALID_RUN_BUDGET', 'The tool reservation is invalid.');
  const previous = ownOperation(ledger, input.operationId);
  if (previous) {
    if (
      previous.kind !== 'tools' ||
      previous.phase !== input.phase ||
      previous.count !== input.count
    )
      throw conflict();
    return { ledger };
  }
  const { used, workUsed } = counters(ledger),
    policy = ledger.policy;
  if (
    used.toolCalls + input.count > policy.maxToolCalls ||
    (input.phase === 'work' &&
      workUsed.toolCalls + input.count > policy.maxToolCalls - policy.reviewReserve.toolCalls)
  )
    throw exhausted();
  ledger.operations[input.operationId] = { kind: 'tools', phase: input.phase, count: input.count };
  return { ledger: validateManagedRunBudget(ledger) };
}

/** Observation failures return poisoned state: the adapter must commit it before throwing error. */
export function observeManagedUsage(
  value: ManagedRunBudgetLedger,
  input: ManagedUsageInput,
): {
  ledger: ManagedRunBudgetLedger;
  error?: { code: string; message: string };
} {
  const ledger = validateManagedRunBudget(value);
  const previous = ownOperation(ledger, input.operationId);
  if (!previous || previous.kind !== 'generation') throw conflict();
  const parsed = z
    .strictObject({
      operationId,
      usage: usage.optional(),
      outcome: z.enum(['observed', 'unknown']),
    })
    .safeParse(input);
  if (!parsed.success || (input.outcome === 'unknown' && input.usage !== undefined)) {
    ledger.violation = 'INVALID_USAGE';
    return {
      ledger: validateManagedRunBudget(ledger),
      error: {
        code: 'RUN_BUDGET_USAGE_EXCEEDED',
        message: 'The provider returned invalid usage accounting. Further managed work is blocked.',
      },
    };
  }
  if (previous.outcome !== 'reserved') {
    if (
      previous.outcome !== input.outcome ||
      JSON.stringify(previous.usage) !== JSON.stringify(parsed.data.usage)
    )
      throw conflict();
    return { ledger, ...(usageError(ledger) ? { error: usageError(ledger) } : {}) };
  }
  previous.outcome = input.outcome;
  if (input.outcome === 'observed' && input.usage !== undefined) previous.usage = parsed.data.usage;
  if ((previous.usage?.outputTokens ?? 0) > previous.reservedOutputTokens)
    ledger.violation = 'OUTPUT_RESERVATION_EXCEEDED';
  return {
    ledger: validateManagedRunBudget(ledger),
    ...(usageError(ledger) ? { error: usageError(ledger) } : {}),
  };
}
