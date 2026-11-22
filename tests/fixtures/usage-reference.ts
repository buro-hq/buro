/** Independent whole-history oracle used only by tests, never by a storage/admission hot path. */
export type ReferenceUsageOperation =
  | {
      kind: 'generation';
      phase: 'work' | 'review';
      allowance: number;
      outcome: 'pending' | 'observed' | 'unknown';
      usage?: { inputTokens?: number; outputTokens?: number };
    }
  | { kind: 'tools'; phase: 'work' | 'review'; count: number };

export function referenceUsageTotals(history: Iterable<ReferenceUsageOperation>) {
  const admitted = () => ({ requests: 0, outputTokens: 0, toolCalls: 0 });
  const totals = {
    work: admitted(),
    review: admitted(),
    knownInputTokens: 0,
    knownOutputTokens: 0,
    completeUsageRequests: 0,
    unknownUsageRequests: 0,
    outstandingOutputTokens: 0,
  };
  for (const operation of history) {
    const phase = totals[operation.phase];
    if (operation.kind === 'tools') {
      phase.toolCalls += operation.count;
      continue;
    }
    phase.requests++;
    phase.outputTokens += operation.allowance;
    if (operation.outcome === 'observed') {
      totals.knownInputTokens += operation.usage?.inputTokens ?? 0;
      totals.knownOutputTokens += operation.usage?.outputTokens ?? 0;
    }
    const complete =
      operation.outcome === 'observed' &&
      operation.usage?.inputTokens !== undefined &&
      operation.usage.outputTokens !== undefined;
    if (complete) totals.completeUsageRequests++;
    else totals.unknownUsageRequests++;
    if (operation.outcome !== 'observed' || operation.usage?.outputTokens === undefined)
      totals.outstandingOutputTokens += operation.allowance;
  }
  return totals;
}
