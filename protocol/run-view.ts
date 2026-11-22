import type { RunAttemptContext, RunAttemptStop } from './run-attempt.ts';
import type { RunAttempt } from './run-state.ts';
import type { RunPlan, RunWorkerAssignment } from './run-plan.ts';
import type { Run } from './domain.ts';
import type {
  RunAdmission,
  RunCurrent,
  RunTimelineEntry,
  RunWorkspaceBinding,
} from './run-state.ts';

/** Read projections never grant dispatch authority. */
export function mergeRunWorkerAssignment(
  run: Run,
  current: RunCurrent,
  assignment: RunWorkerAssignment,
  entries: Omit<RunTimelineEntry, 'sequence'>[],
  view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>,
): Run {
  if (
    assignment.runId !== run.id ||
    current.id !== run.id ||
    assignment.admissionId !== current.admissionId ||
    assignment.attemptId !== current.attemptId
  )
    throw Error('Worker delegation identities differ.');
  return {
    ...mergeRunCurrent(run, current),
    ...view,
    roleSnapshots: [
      ...(run.roleSnapshots ?? []).filter((role) => role.id !== assignment.role.id),
      structuredClone(assignment.role),
    ],
    roleOrigins: { ...run.roleOrigins, [assignment.role.id]: assignment.origin },
    roleAssignments: { ...run.roleAssignments, [assignment.role.id]: [...assignment.paths] },
    assignmentResources: {
      ...run.assignmentResources,
      [assignment.role.id]: structuredClone(assignment.resource),
    },
    workerTasks: {
      ...run.workerTasks,
      ...(assignment.task ? { [assignment.role.id]: structuredClone(assignment.task) } : {}),
    },
    events: [...run.events, ...entries.map(({ runId: _runId, ...entry }) => entry)],
  };
}

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
    attemptId: current.attemptId,
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
    attemptId: current.attemptId,
    title: current.title,
    summary: current.summary,
    status: current.status,
    phase: current.phase,
    updatedAt: current.updatedAt,
    cancelRequested: current.cancelRequested,
    completedAt: current.completedAt,
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

/** A prepared workspace is an observed identity, not an accepted revision or execution permission. */
export function mergeRunWorkspace(
  run: Run,
  current: RunCurrent,
  binding: RunWorkspaceBinding,
  entry: Omit<RunTimelineEntry, 'sequence'>,
  view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>,
): Run {
  if (binding.runId !== run.id) throw Error('Run workspace identity mismatch.');
  return {
    ...mergeRunLifecycle(run, current, entry, view),
    workspace: binding.path,
    baseCommit: binding.baseCommit,
  };
}

/** Temporary complete UI projection; current tasks may subsequently be refined by their existing owner. */
export function mergeRunPlan(
  run: Run,
  current: RunCurrent,
  plan: RunPlan,
  assignments: RunWorkerAssignment[],
  entries: Omit<RunTimelineEntry, 'sequence'>[],
  view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>,
): Run {
  if (
    plan.runId !== run.id ||
    assignments.some((assignment) => assignment.runId !== run.id || assignment.planId !== plan.id)
  )
    throw Error('Run plan identity mismatch.');
  const next = mergeRunCurrent(run, current);
  if (plan.readOnlyPlanner) {
    const session = run.coordinatorSession;
    const grant = session
      ? JSON.parse(
          JSON.stringify({
            id: session.id,
            roleId: session.roleId,
            roleVersion: session.roleVersion,
            runtimeId: session.runtimeId,
            providerId: session.providerId,
            model: session.model,
            configurationRevision: session.configurationRevision,
            selection: session.selection,
            parentId: session.parentId,
          }),
        )
      : undefined;
    if (
      run.threadId !== plan.readOnlyPlanner.threadId ||
      run.coordinatorSession?.id !== plan.readOnlyPlanner.sessionId ||
      JSON.stringify(grant) !== JSON.stringify(plan.readOnlyPlanner.sessionGrant)
    )
      throw Error('Read-only planner handoff mismatch.');
    next.planningSession = run.coordinatorSession;
    next.coordinatorSession = undefined;
    next.threadId = '';
  }
  return {
    ...next,
    ...view,
    plan: structuredClone(plan.steps),
    planSavedAt: plan.createdAt,
    roleSnapshots: [
      ...(run.roleSnapshots || []).filter((role) => ['coordinator', 'reviewer'].includes(role.id)),
      ...assignments.map((assignment) => structuredClone(assignment.role)),
    ],
    roleOrigins: Object.fromEntries(
      assignments.map((assignment) => [assignment.role.id, assignment.origin]),
    ),
    roleAssignments: Object.fromEntries(
      assignments.map((assignment) => [assignment.role.id, [...assignment.paths]]),
    ),
    workerTasks: Object.fromEntries(
      assignments
        .filter((assignment) => assignment.task !== undefined)
        .map((assignment) => [assignment.role.id, structuredClone(assignment.task!)]),
    ),
    assignmentResources: Object.fromEntries(
      assignments.map((assignment) => [assignment.role.id, structuredClone(assignment.resource)]),
    ),
    events: [
      ...next.events,
      ...entries.map(({ runId: _runId, ...entry }) => structuredClone(entry)),
    ],
  };
}

/** The actual nonaccepted result; it grants no accepted commit or result application. */
export function mergeRunStopped(
  run: Run,
  current: RunCurrent,
  stop: RunAttemptStop,
  entries: Omit<RunTimelineEntry, 'sequence'>[],
  view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>,
): Run {
  if (
    stop.runId !== run.id ||
    stop.attemptId !== current.attemptId ||
    run.attemptId !== stop.attemptId
  )
    throw Error('Run stop identity mismatch.');
  return {
    ...mergeRunCurrent(run, current),
    result: stop.text,
    summary: stop.text,
    ...(stop.issue ? { issue: structuredClone(stop.issue) } : {}),
    agents: run.agents.map((agent) =>
      agent.completedAt
        ? agent
        : { ...agent, completedAt: stop.createdAt, status: 'interrupted' as const },
    ),
    events: [...run.events, ...entries.map(({ runId: _runId, ...entry }) => entry)],
    ...view,
  };
}
/** UI-only previous-attempt projection; authority is the immutable named context/header. */
export function mergeRunContinued(
  run: Run,
  current: RunCurrent,
  attempt: RunAttempt,
  context: RunAttemptContext,
  entries: Omit<RunTimelineEntry, 'sequence'>[],
  view?: Pick<Run, 'managedBudget' | 'effectivePolicy' | 'stop' | 'issue'>,
): Run {
  if (
    attempt.runId !== run.id ||
    attempt.id !== current.attemptId ||
    run.attemptId !== attempt.priorAttemptId ||
    context.attemptId !== attempt.id ||
    !context.continuation
  )
    throw Error('Run continuation identity mismatch.');
  const previous: NonNullable<Run['attempts']>[number] = {
    at: attempt.createdAt,
    status: run.status || 'failed',
    result: run.result,
    goalText: run.goalText,
    contextMaterials: run.contextMaterials,
    repairEnvironment: run.repairEnvironment,
    timePolicy: run.timePolicy,
    planningPolicy: run.planningPolicy,
    policy: run.executionPolicySnapshot,
  };
  const workerTasks = Object.fromEntries(
    Object.entries(run.workerTasks ?? {}).filter(
      ([roleId]) => context.inheritedAssignments?.[roleId]?.taskMode === 'original',
    ),
  );
  return {
    ...mergeRunCurrent(run, current),
    attempts: [...(run.attempts ?? []), previous],
    title: context.goal.title,
    goalText: context.goalText,
    contextMaterials: structuredClone(context.contextMaterials),
    repairEnvironment: context.repairEnvironment,
    timePolicy: structuredClone(context.timePolicy),
    planningPolicy: structuredClone(context.planningPolicy),
    executionPolicySnapshot: structuredClone(context.policy),
    resources: structuredClone(context.resources),
    roleResources: structuredClone(context.roleResources),
    roleSnapshots: structuredClone(context.roleSnapshots),
    checkIds: [...context.checkIds],
    continuation: {
      mode: context.continuation.mode,
      instructions: context.continuation.instructions,
      requestedAt: context.continuation.requestedAt,
    },
    cancelRequested: false,
    completedAt: undefined,
    review: undefined,
    independentReviewer: false,
    issue: undefined,
    stop: undefined,
    workerTasks: Object.keys(workerTasks).length ? workerTasks : undefined,
    agents: run.agents.filter((agent) => agent.threadId !== run.threadId),
    events: [...run.events, ...entries.map(({ runId: _runId, ...entry }) => entry)],
    ...view,
  };
}
