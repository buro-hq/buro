import type { SQLInputValue } from 'node:sqlite';
import type { Goal, Role } from '../../protocol/domain.ts';
import { DomainError } from '../../core/ports.ts';
import {
  validateProjectGoal,
  validateProjectRole,
  type EntityTransactionStorage,
  type ProjectEntityChange,
  type ParentRunReference,
} from '../../core/project-entities.ts';

export const projectEntitySchema = `
  CREATE TABLE IF NOT EXISTS project_goals (
    goal_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
    goal_json TEXT NOT NULL CHECK(json_valid(goal_json))
  );
  CREATE TABLE IF NOT EXISTS role_versions (
    role_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version>0),
    role_json TEXT NOT NULL CHECK(json_valid(role_json)),
    PRIMARY KEY(role_id,version)
  );
  CREATE TABLE IF NOT EXISTS role_heads (
    role_id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL,
    FOREIGN KEY(role_id,version) REFERENCES role_versions(role_id,version)
  );
  CREATE TRIGGER IF NOT EXISTS immutable_role_version_update
    BEFORE UPDATE ON role_versions BEGIN SELECT RAISE(ABORT,'Role versions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_role_version_delete
    BEFORE DELETE ON role_versions BEGIN SELECT RAISE(ABORT,'Role versions are immutable'); END;
  CREATE TABLE IF NOT EXISTS material_refs (material_id TEXT PRIMARY KEY NOT NULL);
  CREATE TABLE IF NOT EXISTS project_run_index (
    run_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT REFERENCES project_goals(goal_id),
    status TEXT CHECK(status IS NULL OR status IN ('queued','running','canceling','completed','failed','interrupted','needs-attention')),
    commit_oid TEXT,
    delivery_busy INTEGER NOT NULL DEFAULT 0 CHECK(delivery_busy IN (0,1)),
    preview_busy INTEGER NOT NULL DEFAULT 0 CHECK(preview_busy IN (0,1)),
    unresolved INTEGER NOT NULL DEFAULT 0 CHECK(unresolved IN (0,1))
  );
  CREATE INDEX IF NOT EXISTS project_runs_delivery_busy ON project_run_index(goal_id) WHERE delivery_busy=1;
  CREATE INDEX IF NOT EXISTS project_runs_preview_busy ON project_run_index(goal_id) WHERE preview_busy=1;
`;

type Row = Record<string, unknown>;
/** Adapter-private statement capabilities, always bound to the owning authority and its current transaction. */
type EntityDatabase = {
  projectId: string;
  get(label: string, sql: string, ...values: SQLInputValue[]): Row | undefined;
  run(label: string, sql: string, ...values: SQLInputValue[]): { changes: number | bigint };
  json(value: unknown): string;
  mutate<T>(action: () => T): T;
  appendChange(change: ProjectEntityChange): void;
};
const conflict = () => new DomainError('CONFLICT', 'The entity changed. Refresh before saving.');

export function createSqliteEntityRows(database: EntityDatabase): EntityTransactionStorage {
  const goal = (id: string): Goal | undefined => {
    const row = database.get(
      'goal.read',
      'SELECT goal_id,revision,goal_json FROM project_goals WHERE goal_id=? AND deleted=0',
      id,
    );
    if (!row) return undefined;
    const value = validateProjectGoal(JSON.parse(String(row.goal_json)), database.projectId);
    if (value.id !== row.goal_id || value.revision !== row.revision)
      throw new DomainError('INVALID_PROJECT_GOAL', 'The goal differs from its indexed identity.');
    return value;
  };
  const role = (id: string, version?: number): Role | undefined => {
    const row =
      version === undefined
        ? database.get(
            'role.read',
            'SELECT v.role_id,v.version,v.role_json FROM role_heads h JOIN role_versions v ON v.role_id=h.role_id AND v.version=h.version WHERE h.role_id=?',
            id,
          )
        : database.get(
            'role-version.read',
            'SELECT role_id,version,role_json FROM role_versions WHERE role_id=? AND version=?',
            id,
            version,
          );
    if (!row) return undefined;
    const value = validateProjectRole(JSON.parse(String(row.role_json)));
    if (value.id !== row.role_id || value.version !== row.version)
      throw new DomainError(
        'INVALID_PROJECT_ROLE',
        'The role differs from its immutable version identity.',
      );
    return value;
  };
  return {
    goal,
    role,
    materialExists: (id) =>
      !!database.get(
        'material.exists',
        'SELECT material_id FROM material_refs WHERE material_id=?',
        id,
      ),
    parentRun: (id) => {
      const row = database.get(
        'parent-run.read',
        'SELECT run_id,status,commit_oid FROM project_run_index WHERE run_id=?',
        id,
      );
      if (!row) return undefined;
      return {
        id: String(row.run_id),
        ...(row.status === null
          ? {}
          : {
              status: row.status as NonNullable<
                ReturnType<EntityTransactionStorage['parentRun']>
              >['status'],
            }),
        ...(row.commit_oid === null ? {} : { commit: String(row.commit_oid) }),
      };
    },
    hasBusyResult: (goalId) =>
      Number(
        database.get(
          'goal.busy-result',
          `SELECT EXISTS(SELECT 1 FROM project_run_index WHERE goal_id=? AND delivery_busy=1)
      OR EXISTS(SELECT 1 FROM project_run_index WHERE goal_id=? AND preview_busy=1) AS busy`,
          goalId,
          goalId,
        )!.busy,
      ) === 1,
    insertGoal: (candidate) =>
      database.mutate(() => {
        const value = validateProjectGoal(candidate, database.projectId);
        try {
          database.run(
            'goal.insert',
            'INSERT INTO project_goals(goal_id,revision,goal_json) VALUES (?,?,?)',
            value.id,
            value.revision,
            database.json(value),
          );
        } catch (error) {
          if ([1555, 2067].includes((error as { errcode?: number }).errcode || 0)) throw conflict();
          throw error;
        }
      }),
    replaceGoal: (previous, next) =>
      database.mutate(() => {
        const before = validateProjectGoal(previous, database.projectId);
        const after = validateProjectGoal(next, database.projectId);
        if (before.id !== after.id) throw conflict();
        const changed = database.run(
          'goal.update',
          'UPDATE project_goals SET revision=?,goal_json=? WHERE goal_id=? AND revision=? AND deleted=0 AND goal_json=?',
          after.revision,
          database.json(after),
          before.id,
          before.revision,
          database.json(before),
        );
        if (Number(changed.changes) !== 1) throw conflict();
      }),
    deleteGoal: (previous) =>
      database.mutate(() => {
        const before = validateProjectGoal(previous, database.projectId);
        const changed = database.run(
          'goal.delete',
          'UPDATE project_goals SET deleted=1 WHERE goal_id=? AND revision=? AND deleted=0 AND goal_json=?',
          before.id,
          before.revision,
          database.json(before),
        );
        if (Number(changed.changes) !== 1) throw conflict();
      }),
    insertRole: (candidate, expectedPreviousVersion) =>
      database.mutate(() => {
        const value = validateProjectRole(candidate);
        if (value.version !== expectedPreviousVersion + 1) throw conflict();
        database.run(
          'role-version.insert',
          'INSERT INTO role_versions(role_id,version,role_json) VALUES (?,?,?)',
          value.id,
          value.version,
          database.json(value),
        );
        const changed =
          expectedPreviousVersion === 0
            ? database.run(
                'role-head.insert',
                'INSERT INTO role_heads(role_id,version) VALUES (?,?)',
                value.id,
                value.version,
              )
            : database.run(
                'role-head.update',
                'UPDATE role_heads SET version=? WHERE role_id=? AND version=?',
                value.version,
                value.id,
                expectedPreviousVersion,
              );
        if (Number(changed.changes) !== 1) throw conflict();
      }),
    appendChange: (change) => database.mutate(() => database.appendChange(change)),
  };
}
