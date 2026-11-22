import type { CreateGoal, DomainEvent, Goal, Role, Run } from '../protocol/domain.ts';
import { GoalSchema } from '../protocol/schema.ts';
import { RoleSchema } from '../protocol/workflow-roles.ts';
import { DomainError } from './ports.ts';

export type EntityCommand = { id: string; fingerprint: string };
export type ParentRunReference = { id: string; status?: Run['status']; commit?: string };
export type GoalEdit = Omit<CreateGoal, 'projectId'>;
export type ProjectEntityChange = Extract<
  DomainEvent['change'],
  { type: 'goal.created' | 'goal.updated' | 'goal.deleted' | 'role.saved' }
>;
export interface EntityTransaction {
  goal(id: string): Goal | undefined;
  role(id: string, version?: number): Role | undefined;
  /** Known immutable material references remain valid after library removal. */
  materialExists(id: string): boolean;
  parentRun(id: string): ParentRunReference | undefined;
  hasBusyResult(goalId: string): boolean;
  createGoal(goal: Goal): Goal;
  updateGoal(id: string, expectedRevision: number, patch: GoalEdit): Goal;
  deleteGoal(id: string, expectedRevision: number): { id: string };
  appendRole(role: Role, expectedPreviousVersion: number): Role;
}
export interface ProjectEntities {
  readonly projectId: string;
  /** Same authority/receipt/event transaction as the other facets, never an independent sidecar. */
  transaction<T>(command: EntityCommand, apply: (tx: EntityTransaction) => T): Promise<T>;
  goal(id: string): Promise<Goal | undefined>;
  role(id: string, version?: number): Promise<Role | undefined>;
}
/** Trusted adapter-only narrow rows inside the owning open transaction. */
export interface EntityTransactionStorage {
  goal(id: string): Goal | undefined;
  role(id: string, version?: number): Role | undefined;
  materialExists(id: string): boolean;
  parentRun(id: string): ParentRunReference | undefined;
  hasBusyResult(goalId: string): boolean;
  insertGoal(goal: Goal): void;
  replaceGoal(previous: Goal, next: Goal): void;
  /** Adapters may retain an indexed tombstone; public queries treat this goal as absent. */
  deleteGoal(previous: Goal): void;
  insertRole(role: Role, expectedPreviousVersion: number): void;
  appendChange(change: ProjectEntityChange): void;
}
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const invalid = () => new DomainError('INVALID_PROJECT_ENTITY', 'The project entity is invalid.');
const validRevision = (value: number) => Number.isSafeInteger(value) && value > 0;
const conflict = () =>
  new DomainError('CONFLICT', 'The goal changed. Refresh the data before saving.');

/** Only schema-validated entity optionals are normalized; arbitrary callback results are not coerced. */
export function validateProjectGoal(value: unknown, projectId?: string): Goal {
  const parsed = GoalSchema.strict().safeParse(value);
  if (
    !parsed.success ||
    !identity(parsed.data.id) ||
    !identity(parsed.data.projectId) ||
    (projectId !== undefined && parsed.data.projectId !== projectId)
  )
    throw invalid();
  return JSON.parse(JSON.stringify(parsed.data)) as Goal;
}
export function validateProjectRole(value: unknown): Role {
  const parsed = RoleSchema.strict().safeParse(value);
  if (!parsed.success || !identity(parsed.data.id)) throw invalid();
  return JSON.parse(JSON.stringify(parsed.data)) as Role;
}
export function validateProjectEntityChange(
  value: unknown,
  projectId?: string,
): ProjectEntityChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const change = value as Record<string, unknown>;
  const fields =
    change.type === 'goal.deleted'
      ? ['type', 'id']
      : change.type === 'role.saved'
        ? ['type', 'role']
        : change.type === 'goal.created' || change.type === 'goal.updated'
          ? ['type', 'goal']
          : [];
  if (
    !fields.length ||
    Reflect.ownKeys(change).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(change, key))
  )
    throw invalid();
  if (change.type === 'goal.deleted') {
    if (!identity(change.id)) throw invalid();
    return { type: 'goal.deleted', id: change.id };
  }
  if (change.type === 'role.saved')
    return { type: 'role.saved', role: validateProjectRole(change.role) };
  return {
    type: change.type as 'goal.created' | 'goal.updated',
    goal: validateProjectGoal(change.goal, projectId),
  };
}

export function createEntityTransaction(options: {
  projectId: string;
  storage: EntityTransactionStorage;
  assertActive(): void;
}): EntityTransaction {
  const { projectId, storage, assertActive } = options;
  if (!identity(projectId))
    throw new DomainError('INVALID_PROJECT_ID', 'The project identity is invalid.');
  const checkId = (id: string) => {
    assertActive();
    if (!identity(id)) throw invalid();
  };
  const goal = (id: string) => {
    checkId(id);
    const value = storage.goal(id);
    const parsed = value === undefined ? undefined : validateProjectGoal(value, projectId);
    if (parsed && parsed.id !== id) throw invalid();
    return parsed;
  };
  const role = (id: string, version?: number) => {
    checkId(id);
    if (version !== undefined && !validRevision(version)) throw invalid();
    const value = storage.role(id, version);
    const parsed = value === undefined ? undefined : validateProjectRole(value);
    if (parsed && (parsed.id !== id || (version !== undefined && parsed.version !== version)))
      throw invalid();
    return parsed;
  };
  const materialExists = (id: string) => {
    checkId(id);
    return storage.materialExists(id);
  };
  const parentRun = (id: string) => {
    checkId(id);
    const value = storage.parentRun(id);
    if (value && value.id !== id) throw invalid();
    return value === undefined
      ? undefined
      : {
          id: value.id,
          ...(value.status !== undefined ? { status: value.status } : {}),
          ...(value.commit !== undefined ? { commit: value.commit } : {}),
        };
  };
  const hasBusyResult = (id: string) => {
    checkId(id);
    return storage.hasBusyResult(id);
  };
  const validateReferences = (candidate: { parentRunId?: string; materialIds?: string[] }) => {
    if (candidate.parentRunId) {
      const parent = parentRun(candidate.parentRunId);
      if (!parent || parent.status !== 'completed' || !parent.commit)
        throw new DomainError(
          'INVALID_PARENT',
          'A parent must be a completed run in this project with a saved commit.',
        );
    }
    if (candidate.materialIds?.some((id) => !materialExists(id)))
      throw new DomainError(
        'CONTEXT_NOT_FOUND',
        'An attached material could not be found in this project.',
      );
  };
  const emit = (change: ProjectEntityChange) =>
    storage.appendChange(validateProjectEntityChange(change, projectId));
  return Object.freeze({
    goal,
    role,
    materialExists,
    parentRun,
    hasBusyResult,
    createGoal(input: Goal) {
      assertActive();
      const candidate = validateProjectGoal(input, projectId);
      if (candidate.status !== 'draft' || candidate.revision !== 1 || candidate.runId !== undefined)
        throw invalid();
      if (goal(candidate.id))
        throw new DomainError('CONFLICT', 'A goal with this identity already exists.');
      // Match GoalService.create's original error precedence: materials before parent.
      if (candidate.materialIds?.some((id) => !materialExists(id)))
        throw new DomainError(
          'CONTEXT_NOT_FOUND',
          'An attached material could not be found in this project.',
        );
      validateReferences({ parentRunId: candidate.parentRunId });
      storage.insertGoal(structuredClone(candidate));
      emit({ type: 'goal.created', goal: candidate });
      return structuredClone(candidate);
    },
    updateGoal(id: string, expectedRevision: number, patch: GoalEdit) {
      const current = goal(id);
      if (!current) throw new DomainError('NOT_FOUND', 'Goal not found.');
      if (current.status === 'running')
        throw new DomainError('GOAL_RUNNING', 'Stop the run before editing the goal.');
      if (
        !validRevision(expectedRevision) ||
        (current.revision || 1) !== expectedRevision ||
        !validRevision(expectedRevision + 1)
      )
        throw conflict();
      if (
        !patch ||
        Reflect.ownKeys(patch).some(
          (key) =>
            ![
              'title',
              'body',
              'criteria',
              'repairEnvironment',
              'parentRunId',
              'outcome',
              'materialIds',
            ].includes(String(key)),
        )
      )
        throw invalid();
      const candidate = validateProjectGoal(
        {
          ...current,
          title: patch.title,
          body: patch.body,
          criteria: patch.criteria,
          repairEnvironment: !!patch.repairEnvironment,
          parentRunId: patch.parentRunId,
          outcome: patch.outcome,
          ...(patch.materialIds !== undefined
            ? { materialIds: [...new Set(patch.materialIds)] }
            : {}),
          revision: expectedRevision + 1,
        },
        projectId,
      );
      validateReferences({ parentRunId: patch.parentRunId, materialIds: patch.materialIds });
      storage.replaceGoal(structuredClone(current), structuredClone(candidate));
      emit({ type: 'goal.updated', goal: candidate });
      return structuredClone(candidate);
    },
    deleteGoal(id: string, expectedRevision: number) {
      const current = goal(id);
      if (!current) throw new DomainError('NOT_FOUND', 'Goal not found.');
      if (current.status === 'running')
        throw new DomainError('GOAL_RUNNING', 'Stop the current run first.');
      if (!validRevision(expectedRevision) || (current.revision || 1) !== expectedRevision)
        throw conflict();
      if (hasBusyResult(id))
        throw new DomainError(
          'RESULT_BUSY',
          'Wait for delivery or stop local preview before deleting the goal.',
        );
      storage.deleteGoal(structuredClone(current));
      emit({ type: 'goal.deleted', id });
      return { id };
    },
    appendRole(input: Role, expectedPreviousVersion: number) {
      assertActive();
      const candidate = validateProjectRole(input);
      const current = role(candidate.id);
      if (
        !Number.isSafeInteger(expectedPreviousVersion) ||
        expectedPreviousVersion < 0 ||
        (current?.version || 0) !== expectedPreviousVersion ||
        candidate.version !== expectedPreviousVersion + 1
      )
        throw new DomainError('CONFLICT', 'The role changed. Refresh it before saving.');
      storage.insertRole(structuredClone(candidate), expectedPreviousVersion);
      emit({ type: 'role.saved', role: candidate });
      return structuredClone(candidate);
    },
  });
}
