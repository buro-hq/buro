import type { ManagedTurnHost, ManagedTurnState } from './managed-turn-state.ts';
import { assertSegmentScope, validateSegmentEvidence } from './work-segments.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Repeated receipts request a service decision, never completion or acceptance. */
export async function coordinatorToolsStalled(state: ManagedTurnState, host: ManagedTurnHost) {
  if (state.session.purpose !== 'coordination' || !state.separate || !host.options.segmentEvidence)
    return false;
  const actions = state.activeBatch!.actionIds.map(
    (id) => state.session.actions.find((action) => action.id === id)!,
  );
  const signature = JSON.stringify(
    actions.map(({ call, result }) => [call.name, canonical(call.arguments), canonical(result)]),
  );
  const previous = state.toolProgress;
  if (previous?.signature !== signature) {
    state.toolProgress = { signature, repeats: 1 };
    return false;
  }
  const evidence = await host.options.segmentEvidence.inspect(state.session.scope, host.signal);
  host.check();
  validateSegmentEvidence(evidence);
  if (state.session.workSegments)
    assertSegmentScope(state.session.workSegments.baseline, evidence, state.session.scope);
  const workspace = JSON.stringify([
    evidence.baseCommit,
    evidence.headCommit,
    evidence.workspaceFingerprint,
  ]);
  const repeats =
    previous.workspace !== undefined && previous.workspace !== workspace ? 1 : previous.repeats + 1;
  state.toolProgress = { signature, repeats, workspace };
  return repeats >= 3;
}
