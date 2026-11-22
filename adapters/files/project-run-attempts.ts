import { isDeepStrictEqual } from 'node:util';
import type { ProjectDocument } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import type { RunTransactionStorage } from '../../core/project-runs.ts';
import { validateRunAdmission, validateRunAttempt } from '../../core/project-runs.ts';
import {
  validateRunAttemptContext,
  validateRunAttemptStop,
  validateRunAttemptLineage,
} from '../../core/project-run-attempts.ts';
import type {
  RunAdmission,
  RunAttempt,
  RunCurrent,
  RunWorkspaceBinding,
} from '../../protocol/run-state.ts';
import type { RunAttemptContext, RunAttemptStop } from '../../protocol/run-attempt.ts';
import type { Run } from '../../protocol/domain.ts';
import type { RunPlan, RunWorkerAssignment } from '../../protocol/run-plan.ts';
import { managedBudgetSummary } from '../../core/run-budget.ts';
import { mergeRunContinued, mergeRunStopped, mergeRunCurrent } from '../../protocol/run-view.ts';

type AttemptDocument = ProjectDocument & {
  runAdmissions?: Record<string, RunAdmission>;
  runInitialAttempts?: Record<string, RunAttempt>;
  runAttemptContexts?: Record<string, RunAttemptContext>;
  runAttemptStops?: Record<string, RunAttemptStop>;
  runHeads?: Record<string, RunCurrent>;
  runWorkspaces?: Record<string, RunWorkspaceBinding>;
  runPlans?: Record<string, RunPlan>;
  runPlanHeads?: Record<string, string>;
  runAssignments?: Record<string, Record<string, RunWorkerAssignment>>;
};
type Access = { write<T>(action: () => T): T };
const invalid = () =>
  new DomainError('IMMUTABLE_RUN_ATTEMPT', 'Saved attempt authority cannot change.');
const define = <T>(map: Record<string, T>, id: string, value: T) => {
  if (Object.hasOwn(map, id)) throw invalid();
  Object.defineProperty(map, id, { value, enumerable: true, writable: false, configurable: false });
};
const lineageRows = (doc: AttemptDocument) => ({
  ...createDocumentRunAttemptRows(doc, {
    write() {
      throw invalid();
    },
  }),
  workspace: (runId: string) => doc.runWorkspaces?.[runId],
  plan: (runId: string) => {
    const id = doc.runPlanHeads?.[runId];
    return id === undefined ? undefined : doc.runPlans?.[id];
  },
  planAssignments: (runId: string) => {
    const id = doc.runPlanHeads?.[runId];
    return id === undefined ? [] : Object.values(doc.runAssignments?.[id] ?? {});
  },
});
export function documentAttemptContext(source: ProjectDocument, id: string): RunAttemptContext {
  const doc = source as AttemptDocument;
  const attempt = doc.runInitialAttempts?.[id];
  if (!attempt) throw invalid();
  if (attempt.reason !== 'initial') {
    const stored = doc.runAttemptContexts?.[id];
    if (!stored) throw invalid();
    const context = validateRunAttemptContext(stored);
    const admission = doc.runAdmissions?.[attempt.admissionId];
    if (!admission) throw invalid();
    validateRunAttemptLineage({ attempt, context }, admission, lineageRows(doc));
    return context;
  }
  const admission = doc.runAdmissions?.[attempt.admissionId];
  if (!admission || admission.attemptId !== id) throw invalid();
  return validateRunAttemptContext({
    version: 1,
    attemptId: id,
    runId: attempt.runId,
    admissionId: admission.id,
    goal: admission.goal,
    goalText: admission.goalText,
    policy: admission.policy,
    policySource: 'admission',
    resources: admission.resources,
    workflow: admission.workflow,
    planningPolicy: admission.planningPolicy,
    roleSnapshots: admission.roleSnapshots,
    roleResources: admission.roleResources,
    contextMaterials: admission.contextMaterials,
    checkIds: admission.checkIds,
    repairEnvironment: admission.repairEnvironment,
    timePolicy: admission.timePolicy,
    taskMode: 'original',
    taskChanged: false,
  });
}
export function createDocumentRunAttemptRows(
  source: ProjectDocument,
  access: Access,
): Pick<
  RunTransactionStorage,
  | 'admission'
  | 'attempt'
  | 'attemptContext'
  | 'attemptStop'
  | 'insertAttemptContext'
  | 'insertStop'
  | 'budgetBlocked'
  | 'runIssue'
  | 'unresolvedForRun'
> {
  const doc = source as AttemptDocument;
  return {
    admission: (id) => {
      const value = doc.runAdmissions?.[id];
      return value === undefined ? undefined : validateRunAdmission(value, doc.project.id);
    },
    attempt: (id) => {
      const value = doc.runInitialAttempts?.[id];
      return value === undefined ? undefined : validateRunAttempt(value);
    },
    attemptContext: (id) => {
      const value = doc.runAttemptContexts?.[id];
      return value === undefined ? undefined : validateRunAttemptContext(value);
    },
    attemptStop: (id) => {
      const value = doc.runAttemptStops?.[id];
      return value === undefined ? undefined : validateRunAttemptStop(value);
    },
    insertAttemptContext: (candidate) =>
      access.write(() => {
        const value = validateRunAttemptContext(candidate),
          header = doc.runInitialAttempts?.[value.attemptId];
        if (
          !header ||
          header.reason === 'initial' ||
          header.runId !== value.runId ||
          header.admissionId !== value.admissionId
        )
          throw invalid();
        doc.runAttemptContexts ??= {};
        define(doc.runAttemptContexts, value.attemptId, value);
      }),
    insertStop: (candidate) =>
      access.write(() => {
        const value = validateRunAttemptStop(candidate),
          header = doc.runInitialAttempts?.[value.attemptId];
        if (!header || header.runId !== value.runId) throw invalid();
        doc.runAttemptStops ??= {};
        define(doc.runAttemptStops, value.attemptId, value);
      }),
    budgetBlocked: (runId) => {
      const ledger = doc.managedRunBudgets?.[runId];
      return ledger !== undefined && managedBudgetSummary(ledger).status === 'exceeded';
    },
    runIssue: (runId) => structuredClone(doc.runs.find((run) => run.id === runId)?.issue),
    unresolvedForRun: (runId) => {
      const run = doc.runs.find((run) => run.id === runId);
      return !!(run?.pendingTurn || run?.reconciliation);
    },
  };
}
/** Only a fully persisted new attempt/stop can change the temporary public Run projection. */
export function projectDocumentAttemptState(
  source: ProjectDocument,
  previous: RunCurrent,
  next: RunCurrent,
  run: Run,
): Run {
  const doc = source as AttemptDocument;
  if (previous.attemptId !== next.attemptId) {
    const attempt = doc.runInitialAttempts?.[next.attemptId],
      context = doc.runAttemptContexts?.[next.attemptId];
    if (
      !attempt ||
      !context ||
      attempt.priorAttemptId !== previous.attemptId ||
      attempt.runId !== next.id ||
      context.attemptId !== next.attemptId
    )
      throw invalid();
    return mergeRunContinued(run, next, attempt, context, []);
  }
  const stop = doc.runAttemptStops?.[next.attemptId];
  if (
    stop &&
    next.phase === 'done' &&
    next.completedAt === stop.createdAt &&
    next.status === stop.status
  )
    return mergeRunStopped(run, next, stop, []);
  return mergeRunCurrent(run, next);
}
/** File is still the sole aggregate authority; these guards prevent its legacy callback from bypassing the new owner. */
export function validateDocumentRunAttempts(previous: ProjectDocument, next: ProjectDocument) {
  const before = previous as AttemptDocument,
    after = next as AttemptDocument;
  for (const key of ['runInitialAttempts', 'runAttemptContexts', 'runAttemptStops'] as const) {
    for (const [id, value] of Object.entries(before[key] ?? {}))
      if (!Object.hasOwn(after[key] ?? {}, id) || !isDeepStrictEqual(value, after[key]![id]))
        throw invalid();
  }
  const ordinals = new Map<string, Map<number, RunAttempt>>();
  for (const [id, raw] of Object.entries(after.runInitialAttempts ?? {})) {
    const attempt = validateRunAttempt(raw),
      admission = after.runAdmissions?.[attempt.admissionId];
    if (id !== attempt.id || !admission || admission.runId !== attempt.runId) throw invalid();
    const byOrdinal = ordinals.get(attempt.runId) ?? new Map<number, RunAttempt>();
    if (byOrdinal.has(attempt.ordinal)) throw invalid();
    byOrdinal.set(attempt.ordinal, attempt);
    ordinals.set(attempt.runId, byOrdinal);
    if (attempt.reason === 'initial') {
      if (attempt.id !== admission.attemptId || after.runAttemptContexts?.[id]) throw invalid();
    } else {
      const prior = attempt.priorAttemptId
        ? after.runInitialAttempts?.[attempt.priorAttemptId]
        : undefined;
      const context = after.runAttemptContexts?.[id];
      if (
        !prior ||
        prior.runId !== attempt.runId ||
        prior.admissionId !== attempt.admissionId ||
        prior.ordinal + 1 !== attempt.ordinal ||
        !context
      )
        throw invalid();
    }
  }
  for (const [id, raw] of Object.entries(after.runAttemptContexts ?? {})) {
    const context = validateRunAttemptContext(raw),
      attempt = after.runInitialAttempts?.[id];
    if (
      !attempt ||
      attempt.reason === 'initial' ||
      context.attemptId !== id ||
      context.runId !== attempt.runId ||
      context.admissionId !== attempt.admissionId ||
      context.continuation?.mode !== attempt.reason ||
      context.continuation.requestedAt !== attempt.createdAt
    )
      throw invalid();
    const admission = after.runAdmissions?.[attempt.admissionId];
    if (!admission) throw invalid();
    validateRunAttemptLineage({ attempt, context }, admission, lineageRows(after));
    const workspace = context.workspaceOriginAttemptId
      ? after.runWorkspaces?.[context.runId]
      : undefined;
    if (
      !workspace ||
      workspace.attemptId !== context.workspaceOriginAttemptId ||
      workspace.admissionId !== context.admissionId
    )
      throw invalid();
    if (context.inheritedPlanId) {
      const plan = after.runPlans?.[context.inheritedPlanId];
      if (
        !plan ||
        plan.attemptId !== context.planOriginAttemptId ||
        plan.runId !== context.runId ||
        plan.admissionId !== context.admissionId
      )
        throw invalid();
    }
  }
  for (const [id, raw] of Object.entries(after.runAttemptStops ?? {})) {
    const stop = validateRunAttemptStop(raw),
      attempt = after.runInitialAttempts?.[id];
    if (stop.attemptId !== id || !attempt || stop.runId !== attempt.runId) throw invalid();
  }
  for (const [id, head] of Object.entries(after.runHeads ?? {})) {
    const attempt = after.runInitialAttempts?.[head.attemptId],
      run = after.runs.find((run) => run.id === id);
    if (
      !attempt ||
      !run ||
      run.attemptId !== head.attemptId ||
      attempt.runId !== id ||
      attempt.admissionId !== head.admissionId
    )
      throw invalid();
    const old = before.runHeads?.[id];
    if (
      old &&
      old.attemptId !== head.attemptId &&
      (attempt.priorAttemptId !== old.attemptId ||
        !['failed', 'interrupted', 'needs-attention'].includes(old.status) ||
        head.status !== 'queued' ||
        head.phase !== 'queued')
    )
      throw invalid();
    const context = documentAttemptContext(after, head.attemptId);
    if (attempt.reason !== 'initial') {
      if (
        !isDeepStrictEqual(run.continuation, {
          mode: context.continuation!.mode,
          instructions: context.continuation!.instructions,
          requestedAt: context.continuation!.requestedAt,
        }) ||
        run.goalText !== context.goalText ||
        run.title !== context.goal.title ||
        !isDeepStrictEqual(run.contextMaterials, context.contextMaterials) ||
        !isDeepStrictEqual(run.executionPolicySnapshot, context.policy) ||
        !isDeepStrictEqual(run.checkIds, context.checkIds) ||
        run.repairEnvironment !== context.repairEnvironment ||
        !isDeepStrictEqual(run.timePolicy, context.timePolicy) ||
        !isDeepStrictEqual(run.planningPolicy, context.planningPolicy) ||
        !isDeepStrictEqual(run.resources, context.resources) ||
        !isDeepStrictEqual(run.workflow, context.workflow) ||
        !isDeepStrictEqual(run.roleResources, context.roleResources)
      )
        throw invalid();
    }
    if ((run.attempts?.length ?? 0) !== attempt.ordinal - 1) throw invalid();
    const stops = after.runAttemptStops?.[head.attemptId];
    if (['failed', 'interrupted', 'needs-attention'].includes(run.status ?? '')) {
      if (!stops) throw invalid();
      if (
        run.status !== stops.status ||
        run.phase !== 'done' ||
        run.completedAt !== stops.createdAt ||
        run.result !== stops.text ||
        run.summary !== stops.text
      )
        throw invalid();
    }
    for (const [index, entry] of (run.attempts ?? []).entries()) {
      const prior = ordinals.get(id)?.get(index + 1),
        following = ordinals.get(id)?.get(index + 2);
      if (!prior || !following) throw invalid();
      const priorContext = documentAttemptContext(after, prior.id),
        nextContext = documentAttemptContext(after, following.id),
        stop = after.runAttemptStops?.[prior.id];
      if (
        !stop ||
        !isDeepStrictEqual(entry, {
          at: nextContext.continuation!.requestedAt,
          status: stop.status,
          result: stop.text,
          goalText: priorContext.goalText,
          contextMaterials: priorContext.contextMaterials,
          repairEnvironment: priorContext.repairEnvironment,
          timePolicy: priorContext.timePolicy,
          planningPolicy: priorContext.planningPolicy,
          policy: priorContext.policy,
        })
      )
        throw invalid();
    }
  }
  for (const run of after.runs) {
    if (run.attemptId !== undefined && after.runHeads?.[run.id]?.attemptId !== run.attemptId)
      throw invalid();
  }
}
