/** Workflow contracts inspired by SSSF's phase/envelope/gate separation.
 * Independent implementation; no runtime, filesystem, UI or Cordis dependency.
 */
export type Envelope = {
  status: 'success' | 'fail';
  summary: string;
  artifacts: string[];
  notesForNextAgent?: string;
};
export type GateCheck = { item: string; passed: boolean; evidence: string };
export type GateReport = { id: string; checks: GateCheck[] };
export type PhaseReceipt = {
  id: string;
  kind: 'agent' | 'code' | 'operator';
  status: 'pending' | 'running' | 'completed' | 'failed';
  envelope?: Envelope;
  gates: GateReport[];
};
export type ReviewVerdict = {
  verdict: 'approved' | 'changes_requested';
  blockingFindings: string[];
};
export function evaluateAcceptance(input: {
  phases: PhaseReceipt[];
  review?: ReviewVerdict;
  scopePreserved: boolean;
  specsUnchanged: boolean;
}) {
  const reasons: string[] = [];
  if (!input.phases.length) reasons.push('No completed phases.');
  for (const phase of input.phases) {
    if (phase.status !== 'completed')
      reasons.push(`Phase ${phase.id} did not complete successfully.`);
    if (phase.kind === 'agent' && phase.envelope?.status !== 'success')
      reasons.push(`Phase ${phase.id} did not return a successful result.`);
    for (const gate of phase.gates)
      for (const check of gate.checks)
        if (!check.passed)
          reasons.push(`${phase.id}/${gate.id}: ${check.item} — ${check.evidence}`);
  }
  if (!input.scopePreserved) reasons.push('Change boundaries violated.');
  if (!input.specsUnchanged) reasons.push('Protected instructions were changed.');
  if (input.review?.verdict !== 'approved' || input.review.blockingFindings.length)
    reasons.push('No consistent reviewer approval.');
  return { accepted: reasons.length === 0, reasons };
}
