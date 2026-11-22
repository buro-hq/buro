import type { Run } from './domain.ts';
import type { RunAdmission, RunCurrent, RunTimelineEntry } from './run-state.ts';

/** Temporary legacy read projection for File/UI consumers; never a SQL execution authority. */
export function initialRunView(
  current: RunCurrent,
  admission: RunAdmission,
  view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>,
): Run {
  return {
    ...(view?.managedBudget === undefined
      ? {}
      : { managedBudget: structuredClone(view.managedBudget) }),
    ...(view?.effectivePolicy === undefined
      ? {}
      : { effectivePolicy: structuredClone(view.effectivePolicy) }),
    ...(view?.stop === undefined ? {} : { stop: structuredClone(view.stop) }),
    ...(view?.issue === undefined ? {} : { issue: structuredClone(view.issue) }),
    id: current.id,
    key: current.goalId,
    goalId: current.goalId,
    title: current.title,
    summary: current.summary,
    status: current.status,
    phase: current.phase,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
    ...(current.completedAt === undefined ? {} : { completedAt: current.completedAt }),
    cancelRequested: current.cancelRequested,
    delegation: 'buro',
    threadId: '',
    workflow: structuredClone(admission.workflow),
    resources: structuredClone(admission.resources),
    roleSnapshots: structuredClone(admission.roleSnapshots),
    roleResources: structuredClone(admission.roleResources),
    planningPolicy: structuredClone(admission.planningPolicy),
    executionPolicySnapshot: structuredClone(admission.policy),
    checkIds: [...admission.checkIds],
    contextMaterials: structuredClone(admission.contextMaterials),
    goalText: admission.goalText,
    repairEnvironment: admission.repairEnvironment,
    timePolicy: structuredClone(admission.timePolicy),
    outcome: structuredClone(admission.outcome),
    ...(admission.parentRunId === undefined ? {} : { parentRunId: admission.parentRunId }),
    ...(admission.policy.profile?.baseBranch === undefined
      ? {}
      : { baseBranch: admission.policy.profile.baseBranch }),
    agents: [],
    events: [{ at: current.createdAt, type: 'run.queued', text: 'Goal queued' }],
    commands: [],
    plan: [],
    changedFiles: [],
    baseline: { passed: 0, total: 0, results: [] },
    acceptance: { passed: 0, total: 0, results: [] },
    specsUnchanged: true,
    scopePreserved: true,
    independentReviewer: false,
    result: '',
    sourceHash: '',
  };
}

/** Update lifecycle facts while retaining worker messages, commands, checks and other legacy history. */
export function mergeRunCurrent(run: Run, current: RunCurrent): Run {
  if (run.id !== current.id || run.goalId !== current.goalId)
    throw Error('Run current identity mismatch.');
  return {
    ...run,
    title: current.title,
    summary: current.summary,
    status: current.status,
    phase: current.phase,
    updatedAt: current.updatedAt,
    cancelRequested: current.cancelRequested,
    ...(current.completedAt === undefined ? {} : { completedAt: current.completedAt }),
    events:
      current.cancelRequested && !run.cancelRequested
        ? [
            ...run.events,
            { at: current.updatedAt, type: 'run.cancel-requested', text: 'Stop requested' },
          ]
        : run.events,
  };
}

/** Public lifecycle projection retains all existing evidence and adds only its committed phase item. */
export function mergeRunLifecycle(
  run: Run,
  current: RunCurrent,
  entry?: Omit<RunTimelineEntry, 'sequence'>,
  view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>,
): Run {
  const next = mergeRunCurrent(run, current);
  if (entry) {
    const { runId: _runId, ...item } = entry;
    next.events = [...next.events, item];
  }
  return { ...next, ...view };
}
