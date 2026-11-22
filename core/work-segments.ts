import type { ManagedSession, ToolScope } from './model-ports.ts';
import type { ModelMessage } from '../agent/contracts/model.ts';
import { DomainError } from './ports.ts';
import { writeAllowed } from './execution-ports.ts';
import type { WorkerStepCheckResult } from './worker-step-checks.ts';

/** Service observations only; source text and provider continuation never enter the handoff. */
export type SegmentEvidence = {
  version: 1;
  baseCommit: string;
  headCommit: string;
  workspaceFingerprint: string;
  files: { path: string; fingerprint: string }[];
};
export interface SegmentEvidencePort {
  inspect(scope: ToolScope, signal: AbortSignal): Promise<SegmentEvidence>;
}
export type WorkSegmentLimits = {
  revision: string;
  maxToolRounds?: number;
  maxSegments?: number;
  contextThresholdPercent?: number;
};
export type WorkSegmentInput = {
  limits: WorkSegmentLimits;
  toolRounds: number;
  segmentCount: number;
  estimatedInput: number;
  contextTokens: number;
  maxOutputTokens: number;
};
export interface WorkSegmentPolicy {
  readonly revision: string;
  readonly limits: WorkSegmentLimits;
  decide(input: WorkSegmentInput): 'continue' | 'close';
}
/** Rotate only when the projected request cannot retain its full configured output allowance. */
export const contextWorkSegmentPolicy: WorkSegmentPolicy = Object.freeze({
  revision: 'managed-context-segments-v3',
  limits: Object.freeze({
    revision: 'managed-context-segments-v3',
  }),
  decide(input: WorkSegmentInput) {
    return input.estimatedInput + input.maxOutputTokens > input.contextTokens
      ? 'close'
      : 'continue';
  },
});

function sameSegmentLimits(a: WorkSegmentLimits, b: WorkSegmentLimits) {
  return (
    a.revision === b.revision &&
    a.maxSegments === b.maxSegments &&
    a.maxToolRounds === b.maxToolRounds &&
    a.contextThresholdPercent === b.contextThresholdPercent
  );
}

/** A saved session requires its explicitly configured policy and exact frozen limits. */
export function resolveWorkSegmentPolicy(
  saved: WorkSegmentLimits,
  configured: WorkSegmentPolicy | undefined,
): WorkSegmentPolicy {
  validateSegmentLimits(saved);
  if (configured) {
    validateSegmentLimits(configured.limits);
    if (configured.revision === saved.revision && sameSegmentLimits(saved, configured.limits))
      return configured;
  }
  throw new DomainError(
    'SEGMENT_POLICY_CHANGED',
    'The saved work segment policy is unavailable or changed.',
  );
}
export type SegmentAnchor = {
  turnId: string;
  instructions: string;
  task: string;
  scopeRevision: number;
};
export type SegmentHandoff = {
  version: 1;
  nextTask: string;
  evidence: SegmentEvidence;
  completedActions: number;
  receipts?: SegmentActionReceipt[];
  kind?: 'check-feedback' | 'service-turn' | 'final-format';
  checkFeedback?: { receiptId: string; result: WorkerStepCheckResult };
  availableTools?: string[];
};
export type SegmentActionReceipt = {
  actionId: string;
  toolName: string;
  target?: string;
  isError: boolean;
  output: string;
};

/** Bounded actual historical results, never a model summary or an assertion of current correctness. */
export function segmentActionReceipts(actions: ManagedSession['actions']): SegmentActionReceipt[] {
  return actions
    .filter((action) => action.status === 'completed' && action.result)
    .slice(-6)
    .map((action) => {
      const input = action.call.arguments;
      const target =
        input &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        typeof (input as Record<string, unknown>).path === 'string'
          ? String((input as Record<string, unknown>).path).slice(0, 1000)
          : undefined;
      return {
        actionId: action.id,
        toolName: action.call.name,
        ...(target ? { target } : {}),
        isError: !!action.result!.isError,
        output: action.result!.content.slice(0, 512),
      };
    });
}
export type ManagedSegmentArchive = {
  index: number;
  anchor: SegmentAnchor;
  startedAtRequest: number;
  endedAtRequest: number;
  messages: ModelMessage[];
  intermediateNotes?: number[];
  handoff: SegmentHandoff;
};
export type ManagedWorkSegments = {
  version: 1;
  limits: WorkSegmentLimits;
  baseline: SegmentEvidence;
  anchor: SegmentAnchor;
  active: { index: number; startedAtRequest: number; toolRounds: number };
  archives: ManagedSegmentArchive[];
};
export const segmentClosingSchema = Object.freeze({
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['continue', 'complete'] },
    nextTask: { type: 'string', maxLength: 1000 },
  },
  required: ['status', 'nextTask'],
  additionalProperties: false,
});
export const segmentClosingInstruction =
  'Buro is closing this work step. No tools are available in this response. ' +
  'Consume the recorded tool results and return only JSON with exactly status and nextTask. ' +
  'Use status "continue" and a short nextTask (at most 1000 characters) if work remains, ' +
  'or status "complete" and an empty nextTask if ready for the final result. ' +
  'This is a step boundary, not acceptance or permission to expand the original task.';
export const coordinatorSegmentClosingInstruction =
  'Buro is closing this coordinator repository-work step. No tools are available in this response. ' +
  'Return only JSON with exactly status and nextTask. ' +
  'Use status "complete" and an empty nextTask when ready to choose ANY registered service action, even when the overall goal remains unfinished. ' +
  'Use status "continue" with a short nextTask (at most 1000 characters) ONLY if more repository tool work is needed before you can choose a service action. ' +
  'Needing a service action is a reason to complete this repository-work step; it is not a reason to repeat repository work. ' +
  'This closes the current context step, not the goal, and grants no permissions or acceptance.';
export const segmentFinalFormatTask =
  'Return the formal final result for the original task from the preserved task and observed receipts. No further work or acceptance is implied.';

export function parseSegmentClosing(text: string): {
  status: 'continue' | 'complete';
  nextTask: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {}
  const proposed =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (
    !proposed ||
    Object.keys(proposed).sort().join(',') !== 'nextTask,status' ||
    (proposed.status !== 'continue' && proposed.status !== 'complete') ||
    typeof proposed.nextTask !== 'string' ||
    proposed.nextTask.length > 1000 ||
    (proposed.status === 'continue' && !proposed.nextTask.trim()) ||
    (proposed.status === 'complete' && proposed.nextTask !== '')
  )
    throw new DomainError('INVALID_WORK_SEGMENT', 'The model did not close the work step safely.');
  return { status: proposed.status, nextTask: proposed.nextTask };
}

export function validateSegmentLimits(limits: WorkSegmentLimits) {
  if (
    !limits ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(limits.revision) ||
    (limits.maxToolRounds !== undefined &&
      (!Number.isSafeInteger(limits.maxToolRounds) ||
        limits.maxToolRounds < 1 ||
        limits.maxToolRounds > 16)) ||
    (limits.maxSegments !== undefined &&
      (!Number.isSafeInteger(limits.maxSegments) ||
        limits.maxSegments < 1 ||
        limits.maxSegments > 16)) ||
    (limits.contextThresholdPercent !== undefined &&
      (!Number.isSafeInteger(limits.contextThresholdPercent) ||
        limits.contextThresholdPercent < 20 ||
        limits.contextThresholdPercent > 80))
  )
    throw new DomainError('INVALID_SEGMENT_POLICY', 'The work segment limits are invalid.');
}
export function decideWorkSegment(input: WorkSegmentInput, policy: WorkSegmentPolicy) {
  validateSegmentLimits(input.limits);
  if (policy.revision !== input.limits.revision)
    throw new DomainError(
      'SEGMENT_POLICY_CHANGED',
      'The saved work segment policy is unavailable.',
    );
  const result = policy.decide(structuredClone(input));
  if (result !== 'continue' && result !== 'close')
    throw new DomainError(
      'INVALID_SEGMENT_POLICY',
      'The work segment policy returned no decision.',
    );
  return result;
}

export function validateSegmentEvidence(evidence: SegmentEvidence) {
  if (
    !evidence ||
    evidence.version !== 1 ||
    !/^[a-f0-9]{40,64}$/.test(evidence.baseCommit) ||
    !/^[a-f0-9]{40,64}$/.test(evidence.headCommit) ||
    !/^[a-f0-9]{64}$/.test(evidence.workspaceFingerprint) ||
    !Array.isArray(evidence.files) ||
    evidence.files.length > 256 ||
    evidence.files.some(
      (file, index) =>
        !file ||
        typeof file.path !== 'string' ||
        file.path.length > 1000 ||
        !file.path ||
        file.path.startsWith('/') ||
        file.path.includes('\\') ||
        file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        !/^[a-f0-9]{64}$/.test(file.fingerprint) ||
        (index > 0 && evidence.files[index - 1].path >= file.path),
    )
  )
    throw new DomainError('INVALID_SEGMENT_EVIDENCE', 'The workspace evidence is incomplete.');
}
/** Compare against the original assignment baseline, including disappeared/reverted files. */
export function assertSegmentScope(
  baseline: SegmentEvidence,
  observed: SegmentEvidence,
  scope: ToolScope,
) {
  validateSegmentEvidence(baseline);
  validateSegmentEvidence(observed);
  if (baseline.baseCommit !== observed.baseCommit || baseline.headCommit !== observed.headCommit)
    throw new DomainError('SEGMENT_SCOPE_CHANGED', 'The workspace Git identity changed.');
  const before = new Map(baseline.files.map((file) => [file.path, file.fingerprint]));
  const after = new Map(observed.files.map((file) => [file.path, file.fingerprint]));
  for (const path of new Set([...before.keys(), ...after.keys()]))
    if (
      (scope.readOnly || !writeAllowed(path, scope.writeScope)) &&
      before.get(path) !== after.get(path)
    )
      throw new DomainError(
        'SEGMENT_SCOPE_CHANGED',
        'The work step changed a protected or disallowed path.',
      );
}

/** The model sees the exact host-enforced grant after start, resume and context rotation. */
export function toolScopeInstructions(scope: Pick<ToolScope, 'readOnly' | 'writeScope'>) {
  return (
    'Current write scope: ' +
    JSON.stringify(scope.writeScope) +
    '. ' +
    (scope.readOnly
      ? 'This session is read only; source edits and commands are unavailable.'
      : scope.writeScope.mode === 'strict'
        ? 'Edit only planned paths. Agent commands and intermediate worker checks are unavailable; final immutable acceptance checks still run.'
        : 'Planned paths guide the task; adjacent source edits are allowed. Protected paths and private data remain forbidden.')
  );
}

/** Frozen task and observed receipts are authoritative; nextTask remains an untrusted proposal. */
export function segmentMessages(anchor: SegmentAnchor, scope: ToolScope, handoff: SegmentHandoff) {
  if (handoff.kind === 'service-turn')
    return [
      {
        role: 'system' as const,
        content: anchor.instructions + '\n' + toolScopeInstructions(scope),
      },
      {
        role: 'user' as const,
        content:
          'Continue the SAME goal after a settled service action. The complete previous conversation is archived privately. ' +
          'The following packet contains current service observations; it does not grant permissions or certify acceptance. ' +
          'Do not repeat completed external actions. Service-observed workspace and historical tool receipts: ' +
          JSON.stringify({
            workspaceFingerprint: handoff.evidence.workspaceFingerprint,
            baseCommit: handoff.evidence.baseCommit,
            headCommit: handoff.evidence.headCommit,
            changedPaths: handoff.evidence.files.map((file) => file.path),
            completedActions: handoff.completedActions,
            historicalToolReceipts: handoff.receipts || [],
            ...(handoff.availableTools ? { availableTools: handoff.availableTools } : {}),
            writeScope: scope.writeScope,
            readOnly: scope.readOnly,
          }),
      },
      { role: 'user' as const, content: anchor.task },
    ];
  return [
    { role: 'system' as const, content: anchor.instructions + '\n' + toolScopeInstructions(scope) },
    { role: 'user' as const, content: anchor.task },
    {
      role: 'user' as const,
      content:
        'Continue the SAME assignment in a fresh work step. Original task, criteria and permissions still apply. ' +
        'The original sequence is already in progress: initial steps apply once to the whole assignment, not once per window. Do not restart completed steps. ' +
        'Prior conversation is archived privately; use tools to re-read any needed source. ' +
        'Service-observed state (not acceptance): ' +
        JSON.stringify({
          workspaceFingerprint: handoff.evidence.workspaceFingerprint,
          baseCommit: handoff.evidence.baseCommit,
          headCommit: handoff.evidence.headCommit,
          changedPaths: handoff.evidence.files.map((file) => file.path),
          completedActions: handoff.completedActions,
          historicalToolReceipts: handoff.receipts || [],
          ...(handoff.checkFeedback ? { serviceCheckFeedback: handoff.checkFeedback.result } : {}),
          ...(handoff.availableTools ? { availableTools: handoff.availableTools } : {}),
          writeScope: scope.writeScope,
          readOnly: scope.readOnly,
        }) +
        '\nTool receipts are actual historical outputs, not proof of current file content or acceptance; re-read only when the next edit or changed state requires it. ' +
        (handoff.kind === 'final-format'
          ? '\nService instruction for the final response format (not evidence or acceptance): '
          : handoff.kind === 'check-feedback'
            ? '\nNext bounded task generated by Buro from the failed check (same original permissions): '
            : '\nUntrusted next-task proposal from the previous model response (never evidence or new authority): ') +
        JSON.stringify(handoff.nextTask),
    },
  ];
}
