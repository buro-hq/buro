import { isDeepStrictEqual } from 'node:util';
import type { ProjectDocument } from '../../core/ports.ts';
import type { Goal } from '../../protocol/domain.ts';
import { DomainError } from '../../core/ports.ts';
import {
  createRunTransaction,
  validateRunCurrent,
  validateRunAdmission,
  validateRunAttempt,
  validateRunTimelineEntry,
  validateRunWorkspaceBinding,
  type ProjectRuns,
  type ProjectRunChange,
  type RunCommand,
  type RunTransactionStorage,
} from '../../core/project-runs.ts';
import type {
  RunAdmission,
  RunAttempt,
  RunCurrent,
  RunTimelineQuery,
  RunWorkspaceBinding,
} from '../../protocol/run-state.ts';
import { initialRunView, mergeRunCurrent } from '../../protocol/run-view.ts';
import { validateProjectGoal } from '../../core/project-entities.ts';
import { createManagedRunBudget, managedBudgetSummary } from '../../core/run-budget.ts';
import { projectRunAutonomy } from '../../core/autonomy-policy.ts';
import { commandCopy } from '../state/transaction-values.ts';
import { createDocumentFacet, type DocumentFacetHost } from './document-facet.ts';

type RunDocument = ProjectDocument & {
  runAdmissions?: Record<string, RunAdmission>;
  runInitialAttempts?: Record<string, RunAttempt>;
  runHeads?: Record<string, RunCurrent>;
  runWorkspaces?: Record<string, RunWorkspaceBinding>;
};
const conflict = () =>
  new DomainError('CONFLICT', 'Run state changed. Refresh before trying again.');
/** Temporary bridge: queued commands share the existing file authority, never a SQL sidecar. */
export function createDocumentProjectRuns(host: DocumentFacetHost<ProjectRunChange>): ProjectRuns {
  const { projectId, read } = host;
  const facet = createDocumentFacet(host, (source, access) => {
    const doc = source as RunDocument;
    const legacy = (id: string) => doc.runs.find((run) => run.id === id);
    const current = (id: string): RunCurrent | undefined => {
      const head = doc.runHeads?.[id],
        run = legacy(id);
      if (!head) {
        if (run)
          throw new DomainError(
            'RUN_ADMISSION_REQUIRED',
            'This run has no current admission record.',
          );
        return undefined;
      }
      if (!run || !run.status || !run.phase || !run.updatedAt) throw conflict();
      const next = validateRunCurrent({
        ...head,
        title: run.title,
        summary: run.summary,
        status: run.status,
        phase: run.phase,
        updatedAt: run.updatedAt,
        cancelRequested: !!run.cancelRequested,
        ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
      });
      // Unmigrated executor writes still belong to this sole document. Their lifecycle is a read projection.
      if (!isDeepStrictEqual(next, head)) {
        const revision = Math.max(head.revision + 1, doc.revision + 1);
        if (!Number.isSafeInteger(revision)) throw conflict();
        next.revision = revision;
      }
      return next;
    };
    const rows: RunTransactionStorage = {
      current,
      workspace: (id) => {
        const value = doc.runWorkspaces?.[id];
        return value === undefined ? undefined : validateRunWorkspaceBinding(value);
      },
      goal: (id) => doc.goals.find((goal) => goal.id === id),
      profile: () => doc.profile,
      role: (id) => doc.roleVersions.filter((role) => role.id === id).at(-1),
      material: (id) => doc.contextMaterials?.find((material) => material.id === id),
      activeProjectMaterials: () =>
        (doc.contextMaterials ?? []).filter(
          (material) => material.active && material.scope === 'project',
        ),
      hasActiveRun: () =>
        doc.runs.some(
          (run) => !!run.status && ['queued', 'running', 'canceling'].includes(run.status),
        ),
      unresolvedForGoal: (goalId) =>
        doc.runs.some((run) => run.goalId === goalId && !!(run.pendingTurn || run.reconciliation)),
      parentRun: (id) => {
        const run = legacy(id);
        return run ? { id, status: run.status, commit: run.commit } : undefined;
      },
      timeline: (query) => {
        const run = legacy(query.runId);
        if (!run) throw new DomainError('NOT_FOUND', 'Run not found.');
        const watermark = query.cursor?.watermark ?? run.events.length;
        if (watermark > run.events.length)
          throw new DomainError(
            'INVALID_RUN_CURSOR',
            'The timeline cursor is ahead of saved history.',
          );
        const after = query.cursor?.after ?? 0;
        const end = Math.min(after + query.limit, watermark);
        const entries = run.events
          .slice(after, end)
          .map((event, index) => ({ ...event, runId: run.id, sequence: after + index + 1 }));
        return {
          entries,
          watermark,
          ...(end < watermark
            ? { next: { version: 1 as const, projectId, runId: run.id, after: end, watermark } }
            : {}),
        };
      },
      insertAdmission: (value) =>
        access.write(() => {
          const admission = validateRunAdmission(value, projectId);
          if (Object.hasOwn(doc.runAdmissions ?? {}, admission.id) || legacy(admission.runId))
            throw conflict();
          doc.runAdmissions ??= {};
          Object.defineProperty(doc.runAdmissions, admission.id, {
            value: admission,
            enumerable: true,
            writable: false,
            configurable: false,
          });
        }),
      insertAttempt: (value) =>
        access.write(() => {
          const attempt = validateRunAttempt(value);
          if (Object.hasOwn(doc.runInitialAttempts ?? {}, attempt.id)) throw conflict();
          doc.runInitialAttempts ??= {};
          Object.defineProperty(doc.runInitialAttempts, attempt.id, {
            value: attempt,
            enumerable: true,
            writable: false,
            configurable: false,
          });
        }),
      insertCurrent: (value) =>
        access.write(() => {
          const head = validateRunCurrent(value),
            admission = doc.runAdmissions?.[head.admissionId];
          if (
            legacy(head.id) ||
            Object.hasOwn(doc.runHeads ?? {}, head.id) ||
            !admission ||
            admission.runId !== head.id ||
            !doc.runInitialAttempts?.[head.attemptId]
          )
            throw conflict();
          const run = initialRunView(head, admission);
          if (
            [
              admission.resources.coordinator,
              admission.resources.worker,
              admission.resources.reviewer,
              ...(admission.resources.workerPool ?? []),
            ].some((resource) => resource.capabilities.hostToolLifecycle)
          ) {
            const ledger = createManagedRunBudget({
              projectId,
              ownerRunId: run.id,
              policy: admission.policy.profile?.managedBudget,
              coverage: 'managed-api',
            });
            doc.managedRunBudgets ??= {};
            Object.defineProperty(doc.managedRunBudgets, run.id, {
              value: ledger,
              enumerable: true,
              writable: true,
              configurable: true,
            });
            run.managedBudget = managedBudgetSummary(ledger);
          }
          Object.assign(
            run,
            projectRunAutonomy(run, {
              goalExists: true,
              goalUnsettled: false,
              projectBusy: false,
              resumeSupported: true,
              startSupported: true,
              settingsSupported: !!admission.policy.profile,
            }),
          );
          doc.runHeads ??= {};
          Object.defineProperty(doc.runHeads, head.id, {
            value: head,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          doc.runs.unshift(run);
        }),
      insertWorkspace: (value) =>
        access.write(() => {
          const binding = validateRunWorkspaceBinding(value),
            head = current(binding.runId),
            run = legacy(binding.runId);
          if (
            !head ||
            !run ||
            head.admissionId !== binding.admissionId ||
            head.attemptId !== binding.attemptId ||
            Object.hasOwn(doc.runWorkspaces ?? {}, binding.runId) ||
            run.workspace !== undefined ||
            run.baseCommit !== undefined
          )
            throw conflict();
          doc.runWorkspaces ??= {};
          Object.defineProperty(doc.runWorkspaces, binding.runId, {
            value: binding,
            enumerable: true,
            writable: false,
            configurable: false,
          });
          run.workspace = binding.path;
          run.baseCommit = binding.baseCommit;
        }),
      linkGoal: (previous: Goal, next: Goal) =>
        access.write(() => {
          const index = doc.goals.findIndex((goal) => goal.id === previous.id);
          if (
            index < 0 ||
            !isDeepStrictEqual(validateProjectGoal(doc.goals[index], projectId), previous)
          )
            throw conflict();
          doc.goals[index] = validateProjectGoal(next, projectId);
        }),
      appendRole: (role, expected) =>
        access.write(() => {
          if (
            expected !== 0 ||
            doc.roleVersions.some((saved) => saved.id === role.id) ||
            role.version !== 1
          )
            throw conflict();
          doc.roleVersions.push(structuredClone(role));
        }),
      replaceCurrent: (previous, next) =>
        access.write(() => {
          if (!isDeepStrictEqual(current(previous.id), previous)) throw conflict();
          const run = legacy(previous.id)!;
          doc.runHeads![previous.id] = validateRunCurrent(next);
          const updated = mergeRunCurrent(run, next);
          if (!next.cancelRequested)
            Object.assign(
              updated,
              projectRunAutonomy(updated, {
                goalExists: doc.goals.some((goal) => goal.id === updated.goalId),
                goalUnsettled: doc.runs.some(
                  (other) =>
                    other.id !== updated.id &&
                    other.goalId === updated.goalId &&
                    !!(other.pendingTurn || other.reconciliation),
                ),
                projectBusy: doc.runs.some(
                  (other) =>
                    other.id !== updated.id &&
                    !!other.status &&
                    ['queued', 'running', 'canceling'].includes(other.status),
                ),
                resumeSupported: true,
                startSupported: true,
                settingsSupported: !!updated.executionPolicySnapshot?.profile,
              }),
            );
          doc.runs[doc.runs.indexOf(run)] = updated;
        }),
      appendTimeline: (entry) =>
        access.write(() => {
          const run = legacy(entry.runId);
          if (!run) throw conflict();
          if (entry.type === 'run.queued' || entry.type === 'run.cancel-requested') {
            const last = run.events.at(-1);
            // The legacy read projector installs the queue/stop item alongside its lifecycle view.
            if (last?.at !== entry.at || last.type !== entry.type || last.text !== entry.text)
              throw conflict();
          } else {
            const {
              runId: _runId,
              sequence: _sequence,
              ...event
            } = validateRunTimelineEntry({
              ...entry,
              sequence: run.events.length + 1,
            });
            run.events.push(event);
          }
        }),
      appendChange: (change) => {
        if (
          change.type !== 'run.admitted' &&
          change.type !== 'run.lifecycle-changed' &&
          change.type !== 'run.workspace-bound'
        ) {
          access.appendChange(change);
          return;
        }
        const run = legacy(change.current.id)!;
        const view = {
          ...(run.managedBudget ? { managedBudget: run.managedBudget } : {}),
          ...(run.effectivePolicy ? { effectivePolicy: run.effectivePolicy } : {}),
          ...(run.stop ? { stop: run.stop } : {}),
          ...(run.issue ? { issue: run.issue } : {}),
        };
        access.appendChange({ ...change, view });
      },
    };
    return createRunTransaction({ projectId, storage: rows, assertActive: access.assertActive });
  });
  return Object.freeze({
    projectId,
    transaction: facet.transaction,
    current: (id: string) => facet.query((tx) => tx.current(id)),
    workspace: (id: string) => facet.query((tx) => tx.workspace(id)),
    timeline: (query: RunTimelineQuery) => {
      const captured = structuredClone(query);
      return facet.query((tx) => tx.timeline(captured));
    },
    receipt(command: RunCommand) {
      const captured = commandCopy(command);
      return read((doc) => {
        const found = Object.hasOwn(doc.receipts, captured.id)
          ? doc.receipts[captured.id]
          : undefined;
        if (found && found.fingerprint !== captured.fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'This ID was used for another command.');
        return found ? { result: structuredClone(found.result) } : undefined;
      });
    },
  });
}

/** The temporary legacy transaction API cannot rewrite captured admission identity or first-attempt records. */
export function validateDocumentRunAdmissions(
  previous: ProjectDocument,
  next: ProjectDocument,
): void {
  const before = previous as RunDocument,
    after = next as RunDocument;
  const invalid = () =>
    new DomainError(
      'IMMUTABLE_RUN_ADMISSION',
      'Captured run admission and attempt records cannot change.',
    );
  for (const [id, value] of Object.entries(before.runAdmissions ?? {})) {
    const saved = after.runAdmissions?.[id];
    if (
      !saved ||
      !isDeepStrictEqual(
        validateRunAdmission(value, previous.project.id),
        validateRunAdmission(saved, next.project.id),
      )
    )
      throw invalid();
  }
  for (const [id, value] of Object.entries(before.runInitialAttempts ?? {})) {
    const saved = after.runInitialAttempts?.[id];
    if (!saved || !isDeepStrictEqual(validateRunAttempt(value), validateRunAttempt(saved)))
      throw invalid();
  }
  for (const [id, value] of Object.entries(before.runWorkspaces ?? {})) {
    const saved = after.runWorkspaces?.[id];
    if (
      !saved ||
      !isDeepStrictEqual(validateRunWorkspaceBinding(value), validateRunWorkspaceBinding(saved))
    )
      throw invalid();
  }
  for (const [id, value] of Object.entries(after.runWorkspaces ?? {})) {
    const binding = validateRunWorkspaceBinding(value),
      head = after.runHeads?.[id],
      run = after.runs.find((value) => value.id === id);
    if (
      binding.runId !== id ||
      !head ||
      head.admissionId !== binding.admissionId ||
      head.attemptId !== binding.attemptId ||
      !run ||
      run.workspace !== binding.path ||
      run.baseCommit !== binding.baseCommit
    )
      throw invalid();
  }
  for (const [id, value] of Object.entries(before.runHeads ?? {})) {
    const saved = after.runHeads?.[id];
    if (
      !saved ||
      ['id', 'goalId', 'admissionId', 'attemptId', 'createdAt'].some(
        (field) => value[field as keyof RunCurrent] !== saved[field as keyof RunCurrent],
      )
    )
      throw invalid();
  }
  for (const [id, value] of Object.entries(after.runAdmissions ?? {})) {
    const admission = validateRunAdmission(value, next.project.id),
      head = after.runHeads?.[admission.runId];
    if (admission.id !== id || !head || head.admissionId !== id) throw invalid();
  }
  for (const [id, value] of Object.entries(after.runInitialAttempts ?? {})) {
    const attempt = validateRunAttempt(value),
      head = after.runHeads?.[attempt.runId];
    if (
      attempt.id !== id ||
      !head ||
      head.attemptId !== id ||
      head.admissionId !== attempt.admissionId
    )
      throw invalid();
  }
  for (const [id, raw] of Object.entries(after.runHeads ?? {})) {
    const head = validateRunCurrent(raw),
      admission = after.runAdmissions?.[head.admissionId],
      attempt = after.runInitialAttempts?.[head.attemptId];
    const run = after.runs.find((value) => value.id === id);
    if (
      head.id !== id ||
      !admission ||
      !attempt ||
      !run ||
      admission.id !== head.admissionId ||
      admission.runId !== id ||
      admission.attemptId !== head.attemptId ||
      admission.goal.id !== head.goalId ||
      attempt.id !== head.attemptId ||
      attempt.runId !== id ||
      attempt.admissionId !== head.admissionId ||
      run.goalId !== head.goalId ||
      ((run.workspace !== undefined || run.baseCommit !== undefined) && !after.runWorkspaces?.[id])
    )
      throw invalid();
  }
}
