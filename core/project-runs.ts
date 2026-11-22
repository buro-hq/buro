import { withEnvironmentRepair } from './environment-repair.ts';
import { runPlanTimeline } from '../protocol/run-plan.ts';
import { planPathAllowed } from './execution-ports.ts';
import { validateAssignmentResource } from './assignment-routing.ts';
import {
  acceptRunPlan,
  validateRunPlan,
  validateRunWorkerAssignment,
  validateRunPlanningInput,
  type AcceptRunPlan,
} from './project-run-plans.ts';
import type {
  RunPlan,
  RunWorkerAssignment,
  RunPlanningInput,
  RunPlannerHandoff,
} from '../protocol/run-plan.ts';
import type {
  ContextMaterial,
  DomainEvent,
  Goal,
  ProjectProfile,
  Role,
} from '../protocol/domain.ts';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../protocol/domain.ts';
import type {
  RunAdmission,
  RunAdmissionPolicy,
  RunAttempt,
  RunCurrent,
  RunTimelineEntry,
  RunTimelinePage,
  RunTimelineQuery,
  RunWorkspaceBinding,
} from '../protocol/run-state.ts';
import {
  DomainEventSchema,
  RunAdmissionSchema,
  RunAdmissionViewSchema,
  RunAttemptSchema,
  RunCurrentSchema,
  RunTimelineEntrySchema,
  RunWorkspaceBindingSchema,
} from '../protocol/schema.ts';
import { ResourceSnapshotSchema, type ResourceSnapshot } from '../protocol/resources.ts';
import { WorkflowIdentitySchema, type WorkflowIdentity } from '../protocol/workflow-roles.ts';
import { DomainError } from './ports.ts';
import {
  validateProjectGoal,
  validateProjectRole,
  type ParentRunReference,
} from './project-entities.ts';
import { validateProjectMaterial } from './project-materials.ts';
import { executionPolicy, validateProjectProfile } from './project-settings.ts';
import { operationIds, serviceOperationContext } from './operation-catalog.ts';
import { resolveRoleResource, validateRoleResource } from './role-routing.ts';
import { assertPlanningPolicy, selectPlanningPolicy } from './planning-policy.ts';
import type { WorkflowRoleResolver } from './workflow-roles.ts';

export type RunCommand = { id: string; fingerprint: string };
export type ProjectRunChange = Extract<
  DomainEvent['change'],
  {
    type:
      | 'run.admitted'
      | 'run.cancel-requested'
      | 'run.lifecycle-changed'
      | 'run.workspace-bound'
      | 'run.plan-accepted';
  }
>;
export type ExecutionPhase = Exclude<RunCurrent['phase'], 'queued' | 'done'>;
export type RunAdmissionProposal = {
  runId: string;
  admissionId: string;
  attemptId: string;
  goalId: string;
  now: string;
  expectedGoalRevision: number;
  expectedProfileRevision: number | null;
  policy: RunAdmissionPolicy;
  resources: ResourceSnapshot;
  workflow: WorkflowIdentity;
  checkIds?: string[];
  repairCapabilities: { managedEnvironment: boolean; synchronizeDependencies: boolean };
};
export interface RunTransaction {
  admit(proposal: RunAdmissionProposal, workflowRoles: WorkflowRoleResolver): { runId: string };
  requestCancel(input: { runId: string; now: string }): { runId: string };
  beginExecution(input: { runId: string; now: string }): { runId: string };
  advancePhase(input: { runId: string; now: string; phase: ExecutionPhase; text: string }): {
    runId: string;
  };
  bindPreparedWorkspace(input: {
    runId: string;
    path: string;
    baseCommit: string;
    now: string;
  }): RunWorkspaceBinding;
  acceptPlan(input: AcceptRunPlan): { plan: RunPlan; assignments: RunWorkerAssignment[] };
  planningInput(runId: string): RunPlanningInput;
  plan(runId: string): RunPlan | undefined;
  assignment(runId: string, roleId: string): RunWorkerAssignment | undefined;
  workspace(runId: string): RunWorkspaceBinding | undefined;
  current(id: string): RunCurrent | undefined;
  timeline(query: RunTimelineQuery): RunTimelinePage;
}
export interface ProjectRuns {
  readonly projectId: string;
  transaction<T>(command: RunCommand, apply: (tx: RunTransaction) => T): Promise<T>;
  current(id: string): Promise<RunCurrent | undefined>;
  planningInput(runId: string): Promise<RunPlanningInput>;
  plan(runId: string): Promise<RunPlan | undefined>;
  assignment(runId: string, roleId: string): Promise<RunWorkerAssignment | undefined>;
  workspace(runId: string): Promise<RunWorkspaceBinding | undefined>;
  timeline(query: RunTimelineQuery): Promise<RunTimelinePage>;
  receipt(command: RunCommand): Promise<{ result: unknown } | undefined>;
}
/** Indexed adapter rows inside the existing authority transaction; never exposed to application callbacks. */
export interface RunTransactionStorage {
  current(id: string): RunCurrent | undefined;
  workspace(runId: string): RunWorkspaceBinding | undefined;
  insertWorkspace(binding: RunWorkspaceBinding): void;
  planningInput(runId: string): RunPlanningInput | undefined;
  plan(runId: string): RunPlan | undefined;
  assignment(runId: string, roleId: string): RunWorkerAssignment | undefined;
  insertPlan(plan: RunPlan, assignments: RunWorkerAssignment[]): void;
  sealPlanningSession(runId: string, planner: RunPlannerHandoff): void;
  goal(id: string): Goal | undefined;
  profile(): ProjectProfile | undefined;
  role(id: string): Role | undefined;
  material(id: string): ContextMaterial | undefined;
  activeProjectMaterials(): ContextMaterial[];
  hasActiveRun(): boolean;
  unresolvedForGoal(goalId: string): boolean;
  parentRun(id: string): ParentRunReference | undefined;
  timeline(query: RunTimelineQuery): RunTimelinePage;
  insertCurrent(current: RunCurrent): void;
  insertAdmission(admission: RunAdmission): void;
  insertAttempt(attempt: RunAttempt): void;
  appendTimeline(entry: Omit<RunTimelineEntry, 'sequence'>): void;
  linkGoal(previous: Goal, next: Goal): void;
  appendRole(role: Role, expectedPreviousVersion: 0): void;
  replaceCurrent(previous: RunCurrent, next: RunCurrent): void;
  appendChange(change: ProjectRunChange): void;
}
const invalid = () =>
  new DomainError('INVALID_RUN_STATE', 'The saved run state or admission is invalid.');
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const closed = (value: unknown, required: string[], optional: string[] = []) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === 'string' &&
        (required.includes(key) || optional.includes(key)) &&
        'value' in Object.getOwnPropertyDescriptor(value, key)!,
    )
  );
};
const canonical = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const goalText = (goal: Goal) => goal.body + '\n\nAcceptance criteria:\n' + goal.criteria;
const defaultOutcome = (goal: Goal, policy: RunAdmissionPolicy) =>
  goal.outcome ?? { kind: policy.profile ? ('pull-request' as const) : ('local' as const) };
export function validateRunCurrent(value: unknown): RunCurrent {
  const parsed = RunCurrentSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return canonical(parsed.data);
}
export function validateRunWorkspaceBinding(value: unknown): RunWorkspaceBinding {
  const parsed = RunWorkspaceBindingSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return canonical(parsed.data);
}
export function validateRunAttempt(value: unknown): RunAttempt {
  const parsed = RunAttemptSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return canonical(parsed.data);
}
export function validateRunTimelineEntry(value: unknown): RunTimelineEntry {
  const parsed = RunTimelineEntrySchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return canonical(parsed.data);
}
export function validateRunAdmission(value: unknown, projectId?: string): RunAdmission {
  const parsed = RunAdmissionSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  const admission: RunAdmission = canonical(parsed.data);
  validateProjectGoal(admission.goal, projectId);
  if (
    admission.goalText !== goalText(admission.goal) ||
    admission.parentRunId !== admission.goal.parentRunId ||
    JSON.stringify(admission.outcome) !==
      JSON.stringify(defaultOutcome(admission.goal, admission.policy)) ||
    !admission.checkIds.length ||
    new Set(admission.checkIds).size !== admission.checkIds.length ||
    admission.checkIds.some((id) => !admission.policy.checks.some((check) => check.id === id))
  )
    throw invalid();
  const operations = [operationIds.coordination, operationIds.review].map((id) =>
    serviceOperationContext(id, admission.policy.profile, admission.policy.scope.mode === 'strict'),
  );
  if (
    admission.roleSnapshots.length !== operations.length ||
    Object.keys(admission.roleResources).length !== operations.length
  )
    throw invalid();
  for (const operation of operations) {
    if (operation.roles.kind !== 'fixed') throw invalid();
    const roleId = operation.roles.roleId;
    const role = admission.roleSnapshots.find((item) => item.id === roleId);
    const decision = admission.roleResources[roleId];
    if (!role || !decision) throw invalid();
    validateRoleResource(admission.resources, role, decision, operation);
  }
  assertPlanningPolicy(admission.planningPolicy, admission.roleResources.coordinator.resource);
  const materialIds = new Set<string>();
  for (const material of admission.contextMaterials) {
    validateProjectMaterial(material);
    if (
      materialIds.has(material.id) ||
      (!(material.active && material.scope === 'project') &&
        !admission.goal.materialIds?.includes(material.id))
    )
      throw invalid();
    materialIds.add(material.id);
  }
  if (admission.goal.materialIds?.some((id) => !materialIds.has(id))) throw invalid();
  return admission;
}
export function validateProjectRunChange(value: unknown, projectId?: string): ProjectRunChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>,
    keys = Reflect.ownKeys(input);
  if (input.type === 'run.plan-accepted') {
    const parsed = DomainEventSchema.safeParse({
      version: 1,
      id: 'validation',
      projectId: projectId || 'validation',
      seq: 1,
      at: 'validation',
      change: input,
    });
    if (!parsed.success || parsed.data.change.type !== 'run.plan-accepted') throw invalid();
    const value = parsed.data.change;
    validateRunPlan(value.plan);
    for (const assignment of value.assignments) {
      validateRunWorkerAssignment(assignment);
      const scope = withEnvironmentRepair(
        value.plan.context.policy,
        value.plan.context.repairEnvironment,
      ).scope;
      if (
        assignment.paths.some((path) => !planPathAllowed(path, scope)) ||
        (scope.mode === 'strict' && !assignment.paths.length)
      )
        throw invalid();
      validateAssignmentResource(
        value.plan.context.resources,
        assignment.role,
        assignment.resource,
        scope.mode === 'strict' ? { strictPlannedWrites: true } : {},
      );
    }
    return canonical(value);
  }
  if (input.type === 'run.workspace-bound') {
    if (!closed(input, ['type', 'current', 'binding', 'entry'], ['view'])) throw invalid();
    const current = validateRunCurrent(input.current),
      binding = validateRunWorkspaceBinding(input.binding);
    if (!closed(input.entry, ['runId', 'at', 'type', 'text'])) throw invalid();
    const entry = input.entry as {
      runId: string;
      at: string;
      type: 'workspace.prepared';
      text: 'Workspace prepared';
    };
    if (
      current.phase !== 'preparing' ||
      !['running', 'canceling'].includes(current.status) ||
      (current.status === 'running' && current.cancelRequested) ||
      (current.status === 'canceling' && !current.cancelRequested) ||
      current.completedAt !== undefined ||
      binding.runId !== current.id ||
      binding.admissionId !== current.admissionId ||
      binding.attemptId !== current.attemptId ||
      entry.runId !== current.id ||
      entry.at !== current.updatedAt ||
      entry.at !== binding.createdAt ||
      entry.type !== 'workspace.prepared' ||
      entry.text !== 'Workspace prepared'
    )
      throw invalid();
    const view =
      input.view === undefined ? undefined : RunAdmissionViewSchema.safeParse(input.view);
    if (view && !view.success) throw invalid();
    return {
      type: 'run.workspace-bound',
      current,
      binding,
      entry: canonical(entry),
      ...(view?.success ? { view: canonical(view.data) } : {}),
    };
  }
  if (input.type === 'run.lifecycle-changed') {
    if (!closed(input, ['type', 'current'], ['entry', 'view'])) throw invalid();
    const current = validateRunCurrent(input.current);
    if (
      current.status !== 'running' ||
      current.cancelRequested ||
      current.phase === 'done' ||
      current.completedAt !== undefined
    )
      throw invalid();
    if (input.entry !== undefined && !closed(input.entry, ['runId', 'at', 'type', 'text']))
      throw invalid();
    const entry =
      input.entry === undefined
        ? undefined
        : validateRunTimelineEntry({ ...(input.entry as object), sequence: 1 });
    if (
      entry &&
      (entry.runId !== current.id ||
        entry.at !== current.updatedAt ||
        entry.type !== 'phase.' + current.phase ||
        current.phase === 'queued')
    )
      throw invalid();
    if (!entry && current.phase !== 'queued') throw invalid();
    const view =
      input.view === undefined ? undefined : RunAdmissionViewSchema.safeParse(input.view);
    if (view && !view.success) throw invalid();
    if (entry) {
      const { sequence: _sequence, ...item } = entry;
      return {
        type: 'run.lifecycle-changed',
        current,
        entry: item,
        ...(view?.success ? { view: canonical(view.data) } : {}),
      };
    }
    return {
      type: 'run.lifecycle-changed',
      current,
      ...(view?.success ? { view: canonical(view.data) } : {}),
    };
  }
  if (
    input.type === 'run.cancel-requested' &&
    keys.length === 2 &&
    Object.hasOwn(input, 'current')
  ) {
    const current = validateRunCurrent(input.current);
    if (!current.cancelRequested || current.status !== 'canceling') throw invalid();
    return { type: 'run.cancel-requested', current };
  }
  if (
    input.type !== 'run.admitted' ||
    keys.some(
      (key) => !['type', 'current', 'admission', 'goal', 'roles', 'view'].includes(String(key)),
    ) ||
    !Object.hasOwn(input, 'current') ||
    !Object.hasOwn(input, 'admission') ||
    !Object.hasOwn(input, 'goal')
  )
    throw invalid();
  const current = validateRunCurrent(input.current),
    admission = validateRunAdmission(input.admission, projectId),
    linked = validateProjectGoal(input.goal, projectId);
  if (
    current.status !== 'queued' ||
    current.phase !== 'queued' ||
    current.revision !== 1 ||
    current.cancelRequested ||
    current.id !== admission.runId ||
    current.admissionId !== admission.id ||
    current.attemptId !== admission.attemptId ||
    current.goalId !== admission.goal.id ||
    current.goalId !== linked.id ||
    linked.runId !== current.id ||
    linked.status !== 'running'
  )
    throw invalid();
  if (input.roles !== undefined && !Array.isArray(input.roles)) throw invalid();
  const roles =
    input.roles === undefined ? undefined : (input.roles as unknown[]).map(validateProjectRole);
  const view = input.view === undefined ? undefined : RunAdmissionViewSchema.safeParse(input.view);
  if (view && !view.success) throw invalid();
  return {
    type: 'run.admitted',
    current,
    admission,
    goal: linked,
    ...(roles?.length ? { roles } : {}),
    ...(view?.success ? { view: canonical(view.data) } : {}),
  };
}
/** Request/page size only, never a lifetime history limit. */
export const RUN_TIMELINE_PAGE_MAX = 200;
export function validateRunTimelineQuery(
  value: RunTimelineQuery,
  projectId: string,
): RunTimelineQuery {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some((key) => !['runId', 'limit', 'cursor'].includes(String(key))) ||
    !identity(value.runId) ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > RUN_TIMELINE_PAGE_MAX
  )
    throw new DomainError('INVALID_RUN_CURSOR', 'The run timeline query is invalid.');
  const cursor = value.cursor;
  if (
    cursor !== undefined &&
    (!cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(cursor)) ||
      Reflect.ownKeys(cursor).length !== 5 ||
      !['version', 'projectId', 'runId', 'after', 'watermark'].every((key) =>
        Object.hasOwn(cursor, key),
      ) ||
      cursor.version !== 1 ||
      cursor.projectId !== projectId ||
      cursor.runId !== value.runId ||
      !Number.isSafeInteger(cursor.after) ||
      cursor.after < 0 ||
      !Number.isSafeInteger(cursor.watermark) ||
      cursor.watermark < 0 ||
      cursor.after > cursor.watermark)
  )
    throw new DomainError('INVALID_RUN_CURSOR', 'The cursor belongs to another run or timeline.');
  return structuredClone(value);
}
export function createRunTransaction(options: {
  projectId: string;
  storage: RunTransactionStorage;
  assertActive(): void;
}): RunTransaction {
  const { projectId, storage, assertActive } = options;
  if (!identity(projectId))
    throw new DomainError('INVALID_PROJECT_ID', 'The project identity is invalid.');
  const current = (id: string) => {
    assertActive();
    if (!identity(id)) throw invalid();
    const value = storage.current(id),
      parsed = value === undefined ? undefined : validateRunCurrent(value);
    if (parsed && parsed.id !== id) throw invalid();
    return parsed;
  };
  const workspace = (runId: string) => {
    const run = current(runId);
    if (!run) throw new DomainError('NOT_FOUND', 'Run not found.');
    const stored = storage.workspace(runId);
    if (stored === undefined) return undefined;
    const binding = validateRunWorkspaceBinding(stored);
    if (
      binding.runId !== run.id ||
      binding.admissionId !== run.admissionId ||
      binding.attemptId !== run.attemptId
    )
      throw invalid();
    return binding;
  };
  const plan = (runId: string) => {
    const run = current(runId);
    if (!run) throw new DomainError('NOT_FOUND', 'Run not found.');
    const saved = storage.plan(runId);
    if (saved === undefined) return undefined;
    const value = validateRunPlan(saved);
    if (
      value.runId !== runId ||
      value.admissionId !== run.admissionId ||
      value.attemptId !== run.attemptId
    )
      throw invalid();
    return value;
  };
  return Object.freeze({
    current,
    workspace,
    planningInput(runId: string) {
      if (!current(runId)) throw new DomainError('NOT_FOUND', 'Run not found.');
      return validateRunPlanningInput(storage.planningInput(runId));
    },
    plan,
    assignment(runId: string, roleId: string) {
      const selected = plan(runId);
      if (!selected) return undefined;
      if (!identity(roleId)) throw invalid();
      const saved = storage.assignment(runId, roleId);
      if (saved === undefined) return undefined;
      const value = validateRunWorkerAssignment(saved);
      if (
        value.planId !== selected.id ||
        value.runId !== runId ||
        value.admissionId !== selected.admissionId ||
        value.attemptId !== selected.attemptId ||
        value.role.id !== roleId
      )
        throw invalid();
      return value;
    },
    acceptPlan(input: AcceptRunPlan) {
      assertActive();
      if (
        !closed(input, ['runId', 'planId', 'now', 'plan', 'expectedRoleVersions', 'expectedInput'])
      )
        throw invalid();
      const previous = current(input.runId);
      if (!previous) throw new DomainError('NOT_FOUND', 'Run not found.');
      validateRunCurrent({ ...previous, revision: previous.revision + 1, updatedAt: input.now });
      const accepted = acceptRunPlan(input, previous, storage);
      const next = validateRunCurrent({
        ...previous,
        revision: previous.revision + 1,
        summary: accepted.plan.summary,
        updatedAt: input.now,
      });
      storage.replaceCurrent(previous, next);
      const entries = runPlanTimeline(accepted.plan, accepted.assignments);
      for (const entry of entries) storage.appendTimeline(entry);
      storage.appendChange({ type: 'run.plan-accepted', current: next, ...accepted, entries });
      return accepted;
    },
    bindPreparedWorkspace(input: { runId: string; path: string; baseCommit: string; now: string }) {
      assertActive();
      if (
        !closed(input, ['runId', 'path', 'baseCommit', 'now']) ||
        ![input.path, input.baseCommit, input.now].every(identity)
      )
        throw invalid();
      const previous = current(input.runId);
      if (!previous) throw new DomainError('NOT_FOUND', 'Run not found.');
      const retained = workspace(input.runId);
      if (retained) {
        if (retained.path !== input.path || retained.baseCommit !== input.baseCommit)
          throw new DomainError(
            'WORKSPACE_BINDING_CONFLICT',
            'This run already has another prepared workspace.',
          );
        return retained;
      }
      if (
        previous.phase !== 'preparing' ||
        !['running', 'canceling'].includes(previous.status) ||
        previous.completedAt !== undefined ||
        (previous.status === 'running' && previous.cancelRequested) ||
        (previous.status === 'canceling' && !previous.cancelRequested)
      )
        throw new DomainError(
          'INVALID_STATE',
          'Only a preparing run can retain its observed workspace.',
        );
      const binding = validateRunWorkspaceBinding({
        version: 1,
        runId: previous.id,
        admissionId: previous.admissionId,
        attemptId: previous.attemptId,
        path: input.path,
        baseCommit: input.baseCommit,
        createdAt: input.now,
      });
      const next = validateRunCurrent({
        ...previous,
        revision: previous.revision + 1,
        updatedAt: input.now,
      });
      const entry = {
        runId: previous.id,
        at: input.now,
        type: 'workspace.prepared' as const,
        text: 'Workspace prepared' as const,
      };
      storage.insertWorkspace(binding);
      storage.replaceCurrent(structuredClone(previous), structuredClone(next));
      storage.appendTimeline(entry);
      storage.appendChange({ type: 'run.workspace-bound', current: next, binding, entry });
      return structuredClone(binding);
    },
    timeline(query: RunTimelineQuery) {
      assertActive();
      const selected = validateRunTimelineQuery(query, projectId);
      if (!current(selected.runId)) throw new DomainError('NOT_FOUND', 'Run not found.');
      const page = storage.timeline(selected);
      if (
        !Number.isSafeInteger(page.watermark) ||
        page.watermark < 0 ||
        (selected.cursor && page.watermark !== selected.cursor.watermark)
      )
        throw invalid();
      let after = selected.cursor?.after ?? 0;
      if (page.entries.length > selected.limit) throw invalid();
      for (const value of page.entries) {
        const entry = validateRunTimelineEntry(value);
        if (
          entry.runId !== selected.runId ||
          entry.sequence <= after ||
          entry.sequence > page.watermark
        )
          throw invalid();
        after = entry.sequence;
      }
      if (page.next) {
        validateRunTimelineQuery(
          { runId: selected.runId, limit: selected.limit, cursor: page.next },
          projectId,
        );
        if (
          page.next.watermark !== page.watermark ||
          page.next.after !== after ||
          !page.entries.length
        )
          throw invalid();
      }
      return structuredClone(page);
    },
    admit(input: RunAdmissionProposal, workflowRoles: WorkflowRoleResolver) {
      assertActive();
      if (
        !closed(
          input,
          [
            'runId',
            'admissionId',
            'attemptId',
            'goalId',
            'now',
            'expectedGoalRevision',
            'expectedProfileRevision',
            'policy',
            'resources',
            'workflow',
            'repairCapabilities',
          ],
          ['checkIds'],
        ) ||
        !closed(input.repairCapabilities, ['managedEnvironment', 'synchronizeDependencies'])
      )
        throw invalid();
      const proposal = structuredClone(input);
      if (
        ![
          proposal.runId,
          proposal.admissionId,
          proposal.attemptId,
          proposal.goalId,
          proposal.now,
        ].every(identity) ||
        !Number.isSafeInteger(proposal.expectedGoalRevision) ||
        proposal.expectedGoalRevision < 1 ||
        (proposal.expectedProfileRevision !== null &&
          (!Number.isSafeInteger(proposal.expectedProfileRevision) ||
            proposal.expectedProfileRevision < 0)) ||
        typeof proposal.repairCapabilities?.managedEnvironment !== 'boolean' ||
        typeof proposal.repairCapabilities?.synchronizeDependencies !== 'boolean'
      )
        throw invalid();
      const workflow = WorkflowIdentitySchema.safeParse(proposal.workflow);
      if (
        !workflow.success ||
        !workflowRoles ||
        typeof workflowRoles.resolveRole !== 'function' ||
        workflow.data.id !== workflowRoles.workflow.id ||
        workflow.data.revision !== workflowRoles.workflow.revision
      )
        throw new DomainError(
          'WORKFLOW_REQUIRED',
          'The admission needs its trusted configured workflow.',
        );
      if (current(proposal.runId))
        throw new DomainError('RUN_ID_EXISTS', 'This run identity already exists.');
      const savedGoal = storage.goal(proposal.goalId);
      if (!savedGoal) throw new DomainError('NOT_FOUND', 'Goal not found.');
      const goal = validateProjectGoal(savedGoal, projectId);
      if (goal.id !== proposal.goalId || (goal.revision || 1) !== proposal.expectedGoalRevision)
        throw new DomainError('CONFLICT', 'The goal changed. Refresh before starting.');
      if (storage.unresolvedForGoal(goal.id))
        throw new DomainError(
          'RUN_RECONCILIATION_REQUIRED',
          'An earlier run of this goal has an unknown operation. Reconcile it before starting another run.',
        );
      if (storage.hasActiveRun())
        throw new DomainError('PROJECT_BUSY', 'A goal is already running in this project.');
      const rawProfile = storage.profile(),
        profile = rawProfile === undefined ? undefined : validateProjectProfile(rawProfile);
      if ((profile?.revision ?? null) !== proposal.expectedProfileRevision)
        throw new DomainError('CONFLICT', 'Settings changed. Reload the profile before starting.');
      const policyParsed = RunAdmissionSchema.shape.policy.safeParse(proposal.policy);
      if (!policyParsed.success) throw invalid();
      const policy = canonical(policyParsed.data);
      if (profile) {
        const authoritative = canonical(
          RunAdmissionSchema.shape.policy.parse(executionPolicy(profile)),
        );
        if (JSON.stringify(policy) !== JSON.stringify(authoritative))
          throw new DomainError(
            'CONFLICT',
            'The captured execution policy differs from saved project settings.',
          );
      }
      const checkIds = [...new Set(proposal.checkIds ?? policy.defaultCheckIds)];
      if (
        !checkIds.length ||
        checkIds.some((id) => !policy.checks.some((check) => check.id === id))
      )
        throw new DomainError('INVALID_CHECK', 'Select registered checks.');
      if (
        goal.repairEnvironment &&
        (!policy.profile ||
          (!proposal.repairCapabilities.managedEnvironment &&
            !proposal.repairCapabilities.synchronizeDependencies))
      )
        throw new DomainError(
          'ENVIRONMENT_REPAIR_UNAVAILABLE',
          'Environment repair requires a managed project and an execution environment.',
        );
      if (goal.parentRunId) {
        const parent = storage.parentRun(goal.parentRunId);
        if (
          !parent ||
          parent.id !== goal.parentRunId ||
          parent.status !== 'completed' ||
          !parent.commit
        )
          throw new DomainError(
            'INVALID_PARENT',
            'A parent must be a completed run in this project with a saved commit.',
          );
      }
      const materialMap = new Map<string, ContextMaterial>();
      for (const value of storage.activeProjectMaterials()) {
        const material = validateProjectMaterial(value);
        if (!material.active || material.scope !== 'project') throw invalid();
        materialMap.set(material.id, material);
      }
      for (const id of goal.materialIds || []) {
        const value = storage.material(id);
        if (!value)
          throw new DomainError(
            'CONTEXT_NOT_FOUND',
            'An attached material could not be found in this project.',
          );
        const material = validateProjectMaterial(value);
        if (material.id !== id) throw invalid();
        materialMap.set(id, material);
      }
      const resources = ResourceSnapshotSchema.safeParse(proposal.resources);
      if (!resources.success)
        throw new DomainError(
          'RESOURCE_PROFILE_REQUIRED',
          'Execution requires a saved resource profile.',
        );
      const operations = [operationIds.coordination, operationIds.review].map((id) =>
        serviceOperationContext(id, policy.profile, policy.scope.mode === 'strict'),
      );
      const resolved = operations.map((operation) => {
        if (operation.roles.kind !== 'fixed') throw invalid();
        const saved = storage.role(operation.roles.roleId);
        const actualRole = saved === undefined ? undefined : validateProjectRole(saved);
        if (actualRole && actualRole.id !== operation.roles.roleId) throw invalid();
        return { operation, ...workflowRoles.resolveRole(actualRole, operation, proposal.now) };
      });
      const roleResources = Object.fromEntries(
        resolved.map(({ role, operation }) => [
          role.id,
          resolveRoleResource(resources.data, role, operation),
        ]),
      );
      const admission = validateRunAdmission(
        {
          version: 1,
          id: proposal.admissionId,
          runId: proposal.runId,
          attemptId: proposal.attemptId,
          createdAt: proposal.now,
          goal,
          goalText: goalText(goal),
          policy,
          resources: resources.data,
          workflow: workflow.data,
          roleSnapshots: resolved.map(({ role }) => role),
          roleResources,
          planningPolicy: selectPlanningPolicy(roleResources.coordinator.resource),
          contextMaterials: [...materialMap.values()],
          checkIds,
          repairEnvironment: !!goal.repairEnvironment,
          timePolicy: { kind: 'inactivity', idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS },
          outcome: defaultOutcome(goal, policy),
          ...(goal.parentRunId !== undefined ? { parentRunId: goal.parentRunId } : {}),
        },
        projectId,
      );
      const created = validateRunCurrent({
        version: 1,
        id: proposal.runId,
        goalId: goal.id,
        revision: 1,
        admissionId: proposal.admissionId,
        attemptId: proposal.attemptId,
        title: goal.title,
        summary: 'Goal queued',
        status: 'queued',
        phase: 'queued',
        createdAt: proposal.now,
        updatedAt: proposal.now,
        cancelRequested: false,
      });
      const attempt = validateRunAttempt({
        version: 1,
        id: proposal.attemptId,
        runId: proposal.runId,
        admissionId: proposal.admissionId,
        ordinal: 1,
        reason: 'initial',
        createdAt: proposal.now,
      });
      const linked = validateProjectGoal(
        { ...goal, status: 'running', runId: created.id },
        projectId,
      );
      const newRoles = resolved
        .filter(({ created }) => created)
        .map(({ role }) => validateProjectRole(role));
      // Every role/resource/policy/material preflight is complete before the first mutation.
      for (const role of newRoles) storage.appendRole(structuredClone(role), 0);
      storage.insertAdmission(structuredClone(admission));
      storage.insertAttempt(structuredClone(attempt));
      storage.insertCurrent(structuredClone(created));
      storage.linkGoal(structuredClone(goal), structuredClone(linked));
      storage.appendTimeline({
        runId: created.id,
        at: proposal.now,
        type: 'run.queued',
        text: 'Goal queued',
      });
      storage.appendChange(
        validateProjectRunChange(
          {
            type: 'run.admitted',
            current: created,
            admission,
            goal: linked,
            ...(newRoles.length ? { roles: newRoles } : {}),
          },
          projectId,
        ),
      );
      return { runId: created.id };
    },
    requestCancel(input: { runId: string; now: string }) {
      assertActive();
      if (!identity(input?.now)) throw invalid();
      const previous = current(input.runId);
      if (!previous) throw new DomainError('NOT_FOUND', 'Run not found.');
      if (!['queued', 'running', 'canceling'].includes(previous.status) || previous.cancelRequested)
        return { runId: previous.id };
      if (!Number.isSafeInteger(previous.revision + 1)) throw invalid();
      const next = validateRunCurrent({
        ...previous,
        revision: previous.revision + 1,
        cancelRequested: true,
        status: 'canceling',
        updatedAt: input.now,
      });
      storage.replaceCurrent(structuredClone(previous), structuredClone(next));
      storage.appendTimeline({
        runId: next.id,
        at: input.now,
        type: 'run.cancel-requested',
        text: 'Stop requested',
      });
      storage.appendChange({ type: 'run.cancel-requested', current: next });
      return { runId: next.id };
    },
    beginExecution(input: { runId: string; now: string }) {
      assertActive();
      if (!closed(input, ['runId', 'now']) || !identity(input.now)) throw invalid();
      const previous = current(input.runId);
      if (!previous) throw new DomainError('NOT_FOUND', 'Run not found.');
      if (previous.cancelRequested || previous.status === 'canceling')
        throw new DOMException('Interrupted', 'AbortError');
      if (
        previous.status !== 'queued' ||
        previous.phase !== 'queued' ||
        previous.completedAt !== undefined
      )
        throw new DomainError('INVALID_STATE', 'Only queued work can begin execution.');
      if (storage.unresolvedForGoal(previous.goalId))
        throw new DomainError(
          'RUN_RECONCILIATION_REQUIRED',
          'Reconcile unknown operations before execution.',
        );
      const next = validateRunCurrent({
        ...previous,
        revision: previous.revision + 1,
        status: 'running',
        updatedAt: input.now,
      });
      storage.replaceCurrent(structuredClone(previous), structuredClone(next));
      storage.appendChange({ type: 'run.lifecycle-changed', current: next });
      return { runId: next.id };
    },
    advancePhase(input: { runId: string; now: string; phase: ExecutionPhase; text: string }) {
      assertActive();
      if (
        !closed(input, ['runId', 'now', 'phase', 'text']) ||
        !identity(input.now) ||
        typeof input.text !== 'string' ||
        !['preparing', 'planning', 'implementation', 'checking', 'review', 'repair'].includes(
          input.phase,
        )
      )
        throw invalid();
      const previous = current(input.runId);
      if (!previous) throw new DomainError('NOT_FOUND', 'Run not found.');
      if (previous.cancelRequested || previous.status === 'canceling')
        throw new DOMException('Interrupted', 'AbortError');
      if (
        previous.status !== 'running' ||
        previous.phase === 'done' ||
        previous.completedAt !== undefined
      )
        throw new DomainError(
          'INVALID_STATE',
          'Only running work can advance its execution phase.',
        );
      if (storage.unresolvedForGoal(previous.goalId))
        throw new DomainError(
          'RUN_RECONCILIATION_REQUIRED',
          'Reconcile unknown operations before execution.',
        );
      const next = validateRunCurrent({
        ...previous,
        revision: previous.revision + 1,
        phase: input.phase,
        updatedAt: input.now,
      });
      const entry = {
        runId: next.id,
        at: input.now,
        type: 'phase.' + input.phase,
        text: input.text,
      };
      storage.replaceCurrent(structuredClone(previous), structuredClone(next));
      storage.appendTimeline(entry);
      storage.appendChange({ type: 'run.lifecycle-changed', current: next, entry });
      return { runId: next.id };
    },
  });
}
