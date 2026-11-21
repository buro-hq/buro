import { DomainError } from './ports.ts';
import type { ProjectDocument } from './ports.ts';

/** Private dispatch intent. A source-branch effect is not inferred from an assistant reply. */
export type ResultApplyIntent = {
  version: 1;
  requestId: string;
  fingerprint: string;
  projectId: string;
  runId: string;
  root: string;
  branch: string;
  baseHead: string;
  targetCommit: string;
  startedAt: string;
  status: 'prepared' | 'dispatched' | 'completed';
  dispatchOwner?: string;
  completedAt?: string;
};

export const resultApplyReceiptId = (phase: 'prepare' | 'dispatch', requestId: string) =>
  `result.apply/${phase}/${requestId}`;

const text = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\0\r\n]/.test(value);
const commit = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function invalid(): never {
  throw new DomainError('INVALID_APPLY_INTENT', 'The saved result application intent is invalid.');
}

/** Validate private state at open and before a transaction commits. */
export function validateResultApplyIntents(doc: ProjectDocument, previous?: ProjectDocument) {
  const intents = doc.resultApplyIntents;
  if (intents !== undefined && (!intents || typeof intents !== 'object' || Array.isArray(intents)))
    invalid();
  for (const [id, intent] of Object.entries(intents || {})) {
    if (
      !intent ||
      intent.version !== 1 ||
      intent.requestId !== id ||
      ![id, intent.fingerprint, intent.projectId, intent.runId, intent.root, intent.branch].every(
        text,
      ) ||
      intent.projectId !== doc.project.id ||
      intent.root !== doc.project.root ||
      !commit(intent.baseHead) ||
      !commit(intent.targetCommit) ||
      !date(intent.startedAt) ||
      (intent.dispatchOwner !== undefined && !text(intent.dispatchOwner)) ||
      !['prepared', 'dispatched', 'completed'].includes(intent.status) ||
      (intent.status === 'prepared' &&
        (intent.dispatchOwner !== undefined || intent.completedAt !== undefined)) ||
      (intent.status === 'dispatched' &&
        (!text(intent.dispatchOwner) || intent.completedAt !== undefined)) ||
      (intent.status === 'completed' && !date(intent.completedAt))
    )
      invalid();
    const before =
      previous?.resultApplyIntents && Object.hasOwn(previous.resultApplyIntents, id)
        ? previous.resultApplyIntents[id]
        : undefined;
    if (before) {
      const identity = (value: ResultApplyIntent) =>
        JSON.stringify([
          value.version,
          value.requestId,
          value.fingerprint,
          value.projectId,
          value.runId,
          value.root,
          value.branch,
          value.baseHead,
          value.targetCommit,
          value.startedAt,
        ]);
      if (
        identity(intent) !== identity(before) ||
        (before.status === 'completed' && JSON.stringify(intent) !== JSON.stringify(before)) ||
        (before.status === 'dispatched' && intent.status === 'prepared') ||
        (before.dispatchOwner !== undefined && before.dispatchOwner !== intent.dispatchOwner)
      )
        invalid();
    } else if (previous && intent.status !== 'prepared') invalid();
  }
  for (const id of Object.keys(previous?.resultApplyIntents || {}))
    if (!intents || !Object.hasOwn(intents, id)) invalid();
}
