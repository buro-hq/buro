import type {
  RunAttemptContext,
  RunAttemptStop,
  CurrentRunAttempt,
} from '../protocol/run-attempt.ts';
import type {
  RunAdmission,
  RunAdmissionPolicy,
  RunAttempt,
  RunCurrent,
} from '../protocol/run-state.ts';
import type { RunIssue } from '../protocol/domain.ts';
import {
  RunAttemptContextSchema,
  RunAttemptStopSchema,
  RunAttemptSchema,
  RunCurrentSchema,
} from '../protocol/schema.ts';
import { DomainError } from './ports.ts';
import type { RunTransactionStorage } from './project-runs.ts';
import { validateProjectGoal, validateProjectRole } from './project-entities.ts';
import { validateProjectMaterial } from './project-materials.ts';
import { validateProjectProfile, executionPolicy } from './project-settings.ts';
import { validateRoleResource } from './role-routing.ts';
import { serviceOperationContext, operationIds } from './operation-catalog.ts';
import { validateRunWorkerAssignment } from './project-run-delegations.ts';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../protocol/domain.ts';
import type { RunWorkerAssignment } from '../protocol/run-delegation.ts';

const invalid = () =>
  new DomainError('INVALID_RUN_ATTEMPT', 'The saved attempt or its context is invalid.');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function inheritAssignments(
  assignments: RunWorkerAssignment[],
  previous: RunAttemptContext,
  goalText: string,
  priorAttemptId: string,
): NonNullable<RunAttemptContext['inheritedAssignments']> {
  const unchanged = goalText === previous.goalText;
  return Object.fromEntries(
    assignments.map((assignment) => {
      const prior = previous.inheritedAssignments?.[assignment.role.id];
      return [
        assignment.role.id,
        {
          id: assignment.id,
          taskMode:
            unchanged &&
            (assignment.attemptId === priorAttemptId ||
              (prior?.id === assignment.id && prior.taskMode === 'original'))
              ? 'original'
              : 'full-goal',
        },
      ];
    }),
  );
}
function continuationTaskMode(
  assignments: RunWorkerAssignment[],
  references: NonNullable<RunAttemptContext['inheritedAssignments']>,
): RunAttemptContext['taskMode'] {
  return assignments.length > 0 &&
    assignments.every((assignment) => references[assignment.role.id].taskMode === 'original')
    ? 'original'
    : 'full-goal';
}
const closed = (value: unknown, required: string[], optional: string[] = []) =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Reflect.ownKeys(value).every(
    (key) =>
      typeof key === 'string' &&
      (required.includes(key) || optional.includes(key)) &&
      'value' in Object.getOwnPropertyDescriptor(value, key)!,
  );
export type FinishRunAttempt = {
  runId: string;
  attemptId: string;
  now: string;
  status: RunAttemptStop['status'];
  text: string;
  issue?: RunIssue;
  errorCode?: string;
};
export type ContinueRunAttempt = {
  runId: string;
  attemptId: string;
  expectedAttemptId: string;
  expectedGoalRevision: number;
  expectedProfileRevision: number | null;
  mode: 'repair' | 'recheck';
  instructions: string;
  checkIds?: string[];
  useCurrentProfile: boolean;
  now: string;
  policy: RunAdmissionPolicy;
  repairCapabilities: { managedEnvironment: boolean; synchronizeDependencies: boolean };
};
export function validateRunAttemptContext(value: unknown): RunAttemptContext {
  const parsed = RunAttemptContextSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  const context = copy(parsed.data);
  validateProjectGoal(context.goal);
  if (
    context.policySource === 'project-profile' &&
    (!context.policy.profile ||
      !same(
        context.policy,
        RunAttemptContextSchema.shape.policy.parse(
          executionPolicy(validateProjectProfile(context.policy.profile)),
        ),
      ))
  )
    throw invalid();
  if (
    (context.policySource === 'admission') !== (context.continuation === undefined) ||
    (context.continuation &&
      context.continuation.useCurrentProfile !==
        ['project-profile', 'configured-host'].includes(context.policySource))
  )
    throw invalid();
  if (
    context.goalText !== context.goal.body + '\n\nAcceptance criteria:\n' + context.goal.criteria ||
    !context.checkIds.length ||
    new Set(context.checkIds).size !== context.checkIds.length ||
    context.checkIds.some((id) => !context.policy.checks.some((check) => check.id === id))
  )
    throw invalid();
  for (const roleId of ['coordinator', 'reviewer']) {
    const role = context.roleSnapshots.find((role) => role.id === roleId),
      decision = context.roleResources[roleId];
    if (!role || !decision) throw invalid();
    validateProjectRole(role);
    validateRoleResource(
      context.resources,
      role,
      decision,
      serviceOperationContext(
        roleId === 'coordinator' ? operationIds.coordination : operationIds.review,
        context.policy.profile,
        context.policy.scope.mode === 'strict',
      ),
    );
  }
  if (
    Object.keys(context.roleResources).length !== 2 ||
    new Set(context.roleSnapshots.map((role) => role.id)).size !== context.roleSnapshots.length
  )
    throw invalid();
  for (const role of context.roleSnapshots) validateProjectRole(role);
  const ids = new Set<string>();
  for (const material of context.contextMaterials) {
    validateProjectMaterial(material);
    if (ids.has(material.id)) throw invalid();
    ids.add(material.id);
  }
  if (context.goal.materialIds?.some((id) => !ids.has(id))) throw invalid();
  return context;
}
export function validateRunAttemptStop(value: unknown): RunAttemptStop {
  const parsed = RunAttemptStopSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return copy(parsed.data);
}
export function initialAttemptContext(admission: RunAdmission): RunAttemptContext {
  return validateRunAttemptContext({
    version: 1,
    attemptId: admission.attemptId,
    runId: admission.runId,
    admissionId: admission.id,
    goal: admission.goal,
    goalText: admission.goalText,
    policy: admission.policy,
    policySource: 'admission',
    resources: admission.resources,
    workflow: admission.workflow,
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
export type AttemptReadStorage = Pick<
  RunTransactionStorage,
  'admission' | 'attempt' | 'attemptContext' | 'attemptStop' | 'workspace' | 'assignments'
>;

/** Compare one immutable decision with its named predecessor and origins, never the history chain. */
export function validateRunAttemptLineage(
  owner: CurrentRunAttempt,
  admission: RunAdmission,
  storage: AttemptReadStorage,
) {
  const { attempt, context } = owner;
  if (
    context.goal.id !== admission.goal.id ||
    context.goal.projectId !== admission.goal.projectId ||
    !same(context.resources, admission.resources) ||
    !same(context.workflow, admission.workflow) ||
    !same(context.roleResources, admission.roleResources)
  )
    throw invalid();
  if (attempt.reason === 'initial') return;
  const prior = storage.attempt(attempt.priorAttemptId!);
  if (
    !prior ||
    prior.runId !== attempt.runId ||
    prior.admissionId !== attempt.admissionId ||
    prior.ordinal + 1 !== attempt.ordinal
  )
    throw invalid();
  const previous =
    prior.reason === 'initial'
      ? initialAttemptContext(admission)
      : validateRunAttemptContext(storage.attemptContext(prior.id));
  const stopped = storage.attemptStop(prior.id);
  if (
    previous.attemptId !== prior.id ||
    previous.runId !== attempt.runId ||
    previous.admissionId !== attempt.admissionId ||
    previous.goal.id !== admission.goal.id ||
    previous.goal.projectId !== admission.goal.projectId ||
    !stopped ||
    validateRunAttemptStop(stopped).attemptId !== prior.id ||
    stopped.runId !== attempt.runId ||
    (!context.continuation!.useCurrentProfile && !same(context.policy, previous.policy)) ||
    context.taskChanged !== (context.goalText !== previous.goalText)
  )
    throw invalid();
  const binding = storage.workspace(attempt.runId);
  const workspaceOwner = context.workspaceOriginAttemptId
    ? storage.attempt(context.workspaceOriginAttemptId)
    : undefined;
  if (
    !binding ||
    binding.runId !== attempt.runId ||
    binding.admissionId !== attempt.admissionId ||
    binding.attemptId !== context.workspaceOriginAttemptId ||
    !workspaceOwner ||
    workspaceOwner.runId !== attempt.runId ||
    workspaceOwner.admissionId !== attempt.admissionId
  )
    throw invalid();
  const assignments = storage.assignments(attempt.runId).filter((assignment) => {
    const owner = storage.attempt(assignment.attemptId);
    if (!owner || owner.runId !== attempt.runId || owner.admissionId !== attempt.admissionId)
      throw invalid();
    return owner.ordinal <= prior.ordinal;
  });
  for (const assignment of assignments) {
    validateRunWorkerAssignment(assignment);
    if (assignment.runId !== attempt.runId || assignment.admissionId !== attempt.admissionId)
      throw invalid();
  }
  const references = inheritAssignments(assignments, previous, context.goalText, prior.id);
  if (
    Object.keys(context.inheritedAssignments ?? {}).length !== assignments.length ||
    assignments.some((assignment) => {
      const actual = context.inheritedAssignments?.[assignment.role.id],
        expected = references[assignment.role.id];
      return actual?.id !== expected.id || actual.taskMode !== expected.taskMode;
    })
  )
    throw invalid();
  const roles = [...admission.roleSnapshots, ...assignments.map((assignment) => assignment.role)];
  const mode = continuationTaskMode(assignments, references);
  if (!same(context.roleSnapshots, roles) || context.taskMode !== mode) throw invalid();
}

export function readRunAttempt(
  storage: AttemptReadStorage,
  attemptId: string,
): CurrentRunAttempt | undefined {
  const saved = storage.attempt(attemptId);
  if (!saved) return undefined;
  const attempt = RunAttemptSchema.safeParse(saved);
  if (!attempt.success || attempt.data.id !== attemptId) throw invalid();
  const admission = storage.admission(attempt.data.admissionId);
  if (!admission || admission.runId !== attempt.data.runId) throw invalid();
  if (attempt.data.reason === 'initial') {
    if (attempt.data.id !== admission.attemptId) throw invalid();
  } else {
    const prior = storage.attempt(attempt.data.priorAttemptId!);
    if (
      !prior ||
      prior.runId !== attempt.data.runId ||
      prior.admissionId !== attempt.data.admissionId ||
      prior.ordinal + 1 !== attempt.data.ordinal
    )
      throw invalid();
  }
  const context =
    attempt.data.reason === 'initial'
      ? initialAttemptContext(admission)
      : validateRunAttemptContext(storage.attemptContext(attemptId));
  if (
    context.attemptId !== attemptId ||
    context.runId !== attempt.data.runId ||
    context.admissionId !== attempt.data.admissionId ||
    (attempt.data.reason !== 'initial' &&
      (context.continuation?.mode !== attempt.data.reason ||
        context.continuation.requestedAt !== attempt.data.createdAt))
  )
    throw invalid();
  const owner = { attempt: copy(attempt.data), context };
  validateRunAttemptLineage(owner, admission, storage);
  return owner;
}
export function stopRunAttempt(
  input: FinishRunAttempt,
  current: RunCurrent,
  storage: RunTransactionStorage,
) {
  if (
    !closed(input, ['runId', 'attemptId', 'now', 'status', 'text'], ['issue', 'errorCode']) ||
    !['failed', 'interrupted', 'needs-attention'].includes(input.status) ||
    typeof input.text !== 'string' ||
    typeof input.now !== 'string' ||
    !input.now
  )
    throw invalid();
  if (input.attemptId !== current.attemptId)
    throw new DomainError('STALE_RUN_ATTEMPT', 'This attempt no longer owns the run.');
  const prior = storage.attemptStop(input.attemptId);
  if (prior) {
    const stop = validateRunAttemptStop(prior);
    if (stop.runId !== current.id || current.phase !== 'done' || current.status !== stop.status)
      throw invalid();
    return { stop, replayed: true };
  }
  if (!['queued', 'running', 'canceling'].includes(current.status))
    throw new DomainError('INVALID_STATE', 'Only active work can stop.');
  const unresolved = storage.unresolvedForRun(current.id);
  const issue = unresolved
    ? storage.runIssue(current.id)?.code === 'RECONCILIATION_REQUIRED'
      ? storage.runIssue(current.id)
      : {
          code: 'RECONCILIATION_REQUIRED' as const,
          message: 'An operation has an unknown outcome. Reconcile it before continuing.',
          checks: [],
        }
    : input.issue;
  const stop = validateRunAttemptStop({
    version: 1,
    id: 'stop-' + input.attemptId,
    runId: current.id,
    attemptId: input.attemptId,
    createdAt: input.now,
    status: unresolved ? 'needs-attention' : input.status,
    text: input.text,
    ...(issue ? { issue } : {}),
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
  });
  RunCurrentSchema.parse({
    ...current,
    revision: current.revision + 1,
    status: stop.status,
    phase: 'done',
    summary: stop.text,
    updatedAt: stop.createdAt,
    completedAt: stop.createdAt,
  });
  return { stop, replayed: false };
}
export function prepareRunContinuation(
  input: ContinueRunAttempt,
  current: RunCurrent,
  storage: RunTransactionStorage,
  projectId: string,
) {
  if (
    !closed(
      input,
      [
        'runId',
        'attemptId',
        'expectedAttemptId',
        'expectedGoalRevision',
        'expectedProfileRevision',
        'mode',
        'instructions',
        'useCurrentProfile',
        'now',
        'policy',
        'repairCapabilities',
      ],
      ['checkIds'],
    ) ||
    !closed(input.repairCapabilities, ['managedEnvironment', 'synchronizeDependencies']) ||
    typeof input.repairCapabilities.managedEnvironment !== 'boolean' ||
    typeof input.repairCapabilities.synchronizeDependencies !== 'boolean' ||
    !Number.isSafeInteger(input.expectedGoalRevision) ||
    input.expectedGoalRevision < 1 ||
    (input.expectedProfileRevision !== null &&
      (!Number.isSafeInteger(input.expectedProfileRevision) ||
        input.expectedProfileRevision < 0)) ||
    typeof input.expectedAttemptId !== 'string' ||
    !input.expectedAttemptId ||
    (input.checkIds !== undefined &&
      (!Array.isArray(input.checkIds) ||
        input.checkIds.some((id) => typeof id !== 'string' || !id))) ||
    typeof input.instructions !== 'string' ||
    !['repair', 'recheck'].includes(input.mode) ||
    typeof input.useCurrentProfile !== 'boolean' ||
    typeof input.now !== 'string' ||
    !input.now ||
    typeof input.attemptId !== 'string' ||
    !input.attemptId
  )
    throw invalid();
  if (current.attemptId !== input.expectedAttemptId)
    throw new DomainError('STALE_RUN_ATTEMPT', 'This attempt no longer owns the run.');
  if (!['failed', 'interrupted', 'needs-attention'].includes(current.status))
    throw new DomainError('INVALID_STATE', 'Only stopped or unsuccessful runs can be continued.');
  const stopped = storage.attemptStop(current.attemptId);
  if (!stopped || stopped.runId !== current.id)
    throw new DomainError('ATTEMPT_STOP_REQUIRED', 'The stopped attempt needs its saved result.');
  if (storage.unresolvedForGoal(current.goalId))
    throw new DomainError(
      'RUN_RECONCILIATION_REQUIRED',
      'Reconcile unknown operations before continuing.',
    );
  if (storage.budgetBlocked(current.id))
    throw new DomainError(
      'RUN_BUDGET_USAGE_EXCEEDED',
      'The managed run budget is blocked by invalid or excessive usage. Start a new run.',
    );
  if (storage.hasActiveRun())
    throw new DomainError('PROJECT_BUSY', 'A goal is already running in this project.');
  if (storage.attempt(input.attemptId))
    throw new DomainError('ATTEMPT_ID_EXISTS', 'This attempt identity already exists.');
  const predecessor = readRunAttempt(storage, current.attemptId);
  if (!predecessor) throw invalid();
  const savedGoal = storage.goal(current.goalId);
  if (!savedGoal) throw new DomainError('NOT_FOUND', 'Run or goal not found.');
  const goal = validateProjectGoal(savedGoal, projectId);
  if (goal.revision !== input.expectedGoalRevision)
    throw new DomainError('CONFLICT', 'The goal changed. Refresh before continuing.');
  let policy: RunAdmissionPolicy;
  let policySource: RunAttemptContext['policySource'];
  if (input.useCurrentProfile) {
    const raw = storage.profile(),
      profile = raw === undefined ? undefined : validateProjectProfile(raw);
    if ((profile?.revision ?? null) !== input.expectedProfileRevision)
      throw new DomainError('CONFLICT', 'Settings changed. Reload before continuing.');
    policy = profile ? executionPolicy(profile) : input.policy;
    policySource = profile ? 'project-profile' : 'configured-host';
    if (!same(copy(policy), copy(input.policy)))
      throw new DomainError('CONFLICT', 'The captured policy differs from saved settings.');
  } else {
    policy = predecessor.context.policy;
    policySource = 'retained-attempt';
    if (!same(copy(policy), copy(input.policy)))
      throw new DomainError('CONFLICT', 'The original attempt policy changed.');
  }
  const binding = storage.workspace(current.id);
  if (!binding)
    throw new DomainError('NO_WORKSPACE', 'This run has no saved workspace. Start the goal again.');
  const origin = storage.attempt(binding.attemptId);
  if (!origin || origin.runId !== current.id || origin.admissionId !== current.admissionId)
    throw invalid();
  if (
    goal.repairEnvironment &&
    (!policy.profile ||
      (!input.repairCapabilities.managedEnvironment &&
        !input.repairCapabilities.synchronizeDependencies))
  )
    throw new DomainError(
      'ENVIRONMENT_REPAIR_UNAVAILABLE',
      'Environment repair requires a managed project and an execution environment.',
    );
  const checkIds = [
    ...new Set(input.checkIds ?? predecessor.context.checkIds ?? policy.defaultCheckIds),
  ];
  let materials = predecessor.context.contextMaterials;
  if (input.mode === 'repair') {
    const shared = input.useCurrentProfile
      ? storage.activeProjectMaterials()
      : materials.filter((m) => m.scope === 'project');
    const selected = (goal.materialIds ?? []).map((id) => {
      const value = storage.material(id);
      if (!value)
        throw new DomainError('CONTEXT_NOT_FOUND', 'An attached material could not be found.');
      return validateProjectMaterial(value);
    });
    materials = [
      ...new Map([...shared, ...selected].map((material) => [material.id, material])).values(),
    ];
  }
  const goalText = goal.body + '\n\nAcceptance criteria:\n' + goal.criteria;
  const workers = storage.assignments(current.id);
  if (
    workers.some(
      (assignment) =>
        assignment.runId !== current.id ||
        assignment.admissionId !== current.admissionId ||
        (assignment.attemptId !== current.attemptId &&
          predecessor.context.inheritedAssignments?.[assignment.role.id]?.id !== assignment.id),
    )
  )
    throw invalid();
  const roleSnapshots = [
    ...predecessor.context.roleSnapshots.filter((role) =>
      ['coordinator', 'reviewer'].includes(role.id),
    ),
    ...workers.map((assignment) => assignment.role),
  ];
  const references = inheritAssignments(
    workers,
    predecessor.context,
    goalText,
    predecessor.attempt.id,
  );
  const context = validateRunAttemptContext({
    ...predecessor.context,
    attemptId: input.attemptId,
    roleSnapshots,
    goal,
    goalText,
    policy,
    policySource,
    contextMaterials: materials,
    checkIds,
    repairEnvironment: !!goal.repairEnvironment,
    timePolicy: { kind: 'inactivity', idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS },
    continuation: {
      mode: input.mode,
      instructions: input.instructions,
      requestedAt: input.now,
      useCurrentProfile: input.useCurrentProfile,
    },
    workspaceOriginAttemptId: binding.attemptId,
    inheritedAssignments: references,
    taskChanged: goalText !== predecessor.context.goalText,
    taskMode: continuationTaskMode(workers, references),
  });
  const attempt = RunAttemptSchema.parse({
    version: 1,
    id: input.attemptId,
    runId: current.id,
    admissionId: current.admissionId,
    ordinal: predecessor.attempt.ordinal + 1,
    reason: input.mode,
    createdAt: input.now,
    priorAttemptId: current.attemptId,
  });
  const next = RunCurrentSchema.parse({
    ...current,
    revision: current.revision + 1,
    attemptId: attempt.id,
    title: goal.title,
    status: 'queued',
    phase: 'queued',
    cancelRequested: false,
    updatedAt: input.now,
    completedAt: undefined,
  });
  const linked = validateProjectGoal({ ...goal, status: 'running', runId: current.id }, projectId);
  return { attempt: copy(attempt), context, next: copy(next), goal: linked };
}
