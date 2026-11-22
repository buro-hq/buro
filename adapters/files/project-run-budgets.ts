import type { DomainEvent, Run } from '../../protocol/domain.ts';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type { ProjectDocument, ProjectRegistry } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import {
  managedBudgetSummary,
  observeManagedUsage,
  reserveManagedGeneration,
  reserveManagedTools,
  ManagedRunBudgetLedgerSchema,
  validateManagedRunBudgetTransition,
  type ManagedRunBudgetPort,
  type ManagedRunBudgetLedger,
} from '../../core/run-budget.ts';

/** Budget state and its public projection commit under the owning project's writer lease. */
export class ProjectRunBudgets implements ManagedRunBudgetPort {
  private projects: ProjectRegistry;
  constructor(projects: ProjectRegistry, _options: { now?: () => string } = {}) {
    this.projects = projects;
  }

  private mutate<T>(
    owner: { projectId: string; ownerRunId: string; operationId: string },
    kind: string,
    fingerprint: string,
    apply: (ledger: ManagedRunBudgetLedger) => { ledger: ManagedRunBudgetLedger; result: T },
  ): Promise<T> {
    return this.projects
      .get(owner.projectId)
      .transact(`managed-budget-${kind}-${randomUUID()}`, fingerprint, (draft) => {
        if (draft.project.id !== owner.projectId)
          throw new DomainError('RUN_BUDGET_OWNER_UNKNOWN', 'The budget project does not match.');
        const runs = draft.runs.filter((candidate) => candidate.id === owner.ownerRunId);
        const run = runs[0];
        const goals = run?.goalId
          ? draft.goals.filter((candidate) => candidate.id === run.goalId)
          : [];
        const goal = goals[0];
        if (
          runs.length !== 1 ||
          goals.length !== 1 ||
          !run ||
          !goal ||
          goal.projectId !== owner.projectId
        )
          throw new DomainError(
            'RUN_BUDGET_OWNER_UNKNOWN',
            'The owning run and goal are required for a managed budget.',
          );
        const saved =
          draft.managedRunBudgets && Object.hasOwn(draft.managedRunBudgets, owner.ownerRunId)
            ? draft.managedRunBudgets[owner.ownerRunId]
            : undefined;
        if (!saved)
          throw new DomainError(
            'INVALID_RUN_BUDGET',
            'The private managed budget record is missing.',
          );
        const ledger = ManagedRunBudgetLedgerSchema.parse(saved);
        if (ledger.projectId !== owner.projectId || ledger.ownerRunId !== owner.ownerRunId)
          throw new DomainError('INVALID_RUN_BUDGET', 'The saved managed budget owner differs.');
        const next = apply(ledger);
        draft.managedRunBudgets = {
          ...draft.managedRunBudgets,
          [owner.ownerRunId]: next.ledger,
        };
        run.managedBudget = managedBudgetSummary(next.ledger);
        return {
          result: next.result,
          change: { type: 'run.changed', run, goal } satisfies DomainEvent['change'],
        };
      });
  }

  reserveGeneration(input: Parameters<ManagedRunBudgetPort['reserveGeneration']>[0]) {
    const operation = {
      operationId: input.operationId,
      phase: input.phase,
      requestedOutputTokens: input.requestedOutputTokens,
      minimumOutputTokens: input.minimumOutputTokens,
    };
    return this.mutate(input, 'generation', fingerprint(operation), (ledger) => {
      const next = reserveManagedGeneration(ledger, operation);
      return { ledger: next.ledger, result: next.grant };
    });
  }

  async reserveTools(input: Parameters<ManagedRunBudgetPort['reserveTools']>[0]) {
    const operation = { operationId: input.operationId, phase: input.phase, count: input.count };
    await this.mutate(input, 'tools', fingerprint(operation), (ledger) => {
      const next = reserveManagedTools(ledger, operation);
      return { ledger: next.ledger, result: null };
    });
  }

  async recordUsage(input: Parameters<ManagedRunBudgetPort['recordUsage']>[0]) {
    const operation = {
      operationId: input.operationId,
      outcome: input.outcome,
      ...(input.usage !== undefined
        ? {
            usage:
              input.usage && typeof input.usage === 'object' && !Array.isArray(input.usage)
                ? Object.fromEntries(
                    Object.entries(input.usage).sort(([a], [b]) => a.localeCompare(b)),
                  )
                : input.usage,
          }
        : {}),
    };
    const result = await this.mutate(input, 'usage', fingerprint(operation), (ledger) => {
      const next = observeManagedUsage(ledger, operation);
      return {
        ledger: next.ledger,
        result:
          next.error ||
          (next.ledger.violation
            ? {
                code: 'RUN_BUDGET_USAGE_EXCEEDED',
                message:
                  'Observed model usage exceeded its reservation. Further managed work is blocked.',
              }
            : null),
      };
    });
    // The poisoned ledger and observed overage are durable before the caller is stopped.
    if (result) throw new DomainError(result.code, result.message);
  }
}

function fingerprint(operation: unknown) {
  // Invalid accounting can contain unexpected values; even conflict receipts store no raw payload.
  return createHash('sha256').update(JSON.stringify(operation)).digest('hex');
}

/** Private budget records are validated without including them in snapshots or events. */
export function validateProjectRunBudgets(document: ProjectDocument, previous?: ProjectDocument) {
  if (
    document.managedRunBudgets !== undefined &&
    (!document.managedRunBudgets ||
      typeof document.managedRunBudgets !== 'object' ||
      Array.isArray(document.managedRunBudgets))
  )
    throw new DomainError(
      'INVALID_RUN_BUDGET',
      'The private managed budget collection is invalid.',
    );
  const ledgers = document.managedRunBudgets || {};
  for (const runId of Object.keys(previous?.managedRunBudgets || {}))
    if (document.runs.some((run) => run.id === runId) && !Object.hasOwn(ledgers, runId))
      throw new DomainError('INVALID_RUN_BUDGET', 'An existing managed budget cannot be removed.');
  for (const [runId, raw] of Object.entries(ledgers)) {
    const parsed = ManagedRunBudgetLedgerSchema.safeParse(raw);
    if (!parsed.success)
      throw new DomainError('INVALID_RUN_BUDGET', 'The private managed budget is invalid.');
    const ledger = parsed.data;
    if (previous?.managedRunBudgets && Object.hasOwn(previous.managedRunBudgets, runId))
      validateManagedRunBudgetTransition(previous.managedRunBudgets[runId], ledger);
    const runs = document.runs.filter((candidate) => candidate.id === runId);
    const run = runs[0];
    if (
      runs.length !== 1 ||
      !run ||
      ledger.projectId !== document.project.id ||
      ledger.ownerRunId !== runId ||
      !sameSummary(run, ledger)
    )
      throw new DomainError(
        'INVALID_RUN_BUDGET',
        'The private managed budget and owning run do not match.',
      );
  }
  for (const run of document.runs)
    if (run.managedBudget && !Object.hasOwn(ledgers, run.id))
      throw new DomainError('INVALID_RUN_BUDGET', 'The private managed budget record is missing.');
}

function sameSummary(run: Run, ledger: ManagedRunBudgetLedger) {
  return isDeepStrictEqual(run.managedBudget, managedBudgetSummary(ledger));
}
