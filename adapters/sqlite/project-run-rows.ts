import type { SQLInputValue } from 'node:sqlite';
import { DomainError } from '../../core/ports.ts';
import {
  validateRunCurrent,
  validateRunAdmission,
  validateRunAttempt,
  validateRunTimelineEntry,
  validateRunWorkspaceBinding,
  RUN_TIMELINE_PAGE_MAX,
  type RunTransactionStorage,
  type ProjectRunChange,
} from '../../core/project-runs.ts';
import type { EntityTransactionStorage } from '../../core/project-entities.ts';
import type { MaterialTransactionStorage } from '../../core/project-materials.ts';
import { validateProjectMaterial } from '../../core/project-materials.ts';
import type { SettingsTransactionStorage } from '../../core/project-settings.ts';
import type { RunCurrent } from '../../protocol/run-state.ts';

export const projectRunSchema = `
  CREATE TABLE IF NOT EXISTS run_current (
    run_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL REFERENCES project_goals(goal_id),
    revision INTEGER NOT NULL CHECK(revision>0),
    admission_id TEXT NOT NULL UNIQUE REFERENCES run_admissions(admission_id) DEFERRABLE INITIALLY DEFERRED,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES run_attempts(attempt_id) DEFERRABLE INITIALLY DEFERRED,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','canceling','completed','failed','interrupted','needs-attention')),
    phase TEXT NOT NULL CHECK(phase IN ('queued','preparing','planning','implementation','checking','review','repair','done')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS run_admissions (
    admission_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL UNIQUE REFERENCES run_current(run_id) DEFERRABLE INITIALLY DEFERRED,
    attempt_id TEXT NOT NULL UNIQUE,
    admission_json TEXT NOT NULL CHECK(json_valid(admission_json))
  );
  CREATE TABLE IF NOT EXISTS run_attempts (
    attempt_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES run_current(run_id) DEFERRABLE INITIALLY DEFERRED,
    admission_id TEXT NOT NULL REFERENCES run_admissions(admission_id) DEFERRABLE INITIALLY DEFERRED,
    ordinal INTEGER NOT NULL CHECK(ordinal=1),
    reason TEXT NOT NULL CHECK(reason='initial'),
    created_at TEXT NOT NULL,
    UNIQUE(run_id,ordinal)
  );
  CREATE TABLE IF NOT EXISTS run_timeline (
    run_id TEXT NOT NULL REFERENCES run_current(run_id) DEFERRABLE INITIALLY DEFERRED,
    sequence INTEGER NOT NULL CHECK(sequence>0),
    at TEXT NOT NULL,
    type TEXT NOT NULL CHECK(length(type)>0),
    text TEXT,
    thread_id TEXT,
    command_id TEXT,
    duration_ms REAL CHECK(duration_ms IS NULL OR duration_ms>=0),
    PRIMARY KEY(run_id,sequence)
  );
  CREATE TABLE IF NOT EXISTS run_workspaces (
    run_id TEXT PRIMARY KEY NOT NULL REFERENCES run_current(run_id),
    admission_id TEXT NOT NULL UNIQUE REFERENCES run_admissions(admission_id),
    attempt_id TEXT NOT NULL REFERENCES run_attempts(attempt_id),
    workspace_path TEXT NOT NULL CHECK(length(workspace_path)>0),
    base_commit TEXT NOT NULL CHECK(length(base_commit)>0),
    created_at TEXT NOT NULL CHECK(length(created_at)>0)
  );
  CREATE TRIGGER IF NOT EXISTS immutable_run_admission_update
    BEFORE UPDATE ON run_admissions BEGIN SELECT RAISE(ABORT,'Run admissions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_run_admission_delete
    BEFORE DELETE ON run_admissions BEGIN SELECT RAISE(ABORT,'Run admissions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_run_attempt_update
    BEFORE UPDATE ON run_attempts BEGIN SELECT RAISE(ABORT,'Run attempts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_run_attempt_delete
    BEFORE DELETE ON run_attempts BEGIN SELECT RAISE(ABORT,'Run attempts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_run_timeline_update
    BEFORE UPDATE ON run_timeline BEGIN SELECT RAISE(ABORT,'Run timeline entries are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_run_timeline_delete
    BEFORE DELETE ON run_timeline BEGIN SELECT RAISE(ABORT,'Run timeline entries are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_run_workspace_update
    BEFORE UPDATE ON run_workspaces BEGIN SELECT RAISE(ABORT,'Run workspace bindings are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_run_workspace_delete
    BEFORE DELETE ON run_workspaces BEGIN SELECT RAISE(ABORT,'Run workspace bindings are immutable'); END;
  CREATE INDEX IF NOT EXISTS project_runs_unresolved ON project_run_index(goal_id,run_id) WHERE unresolved=1;
  CREATE INDEX IF NOT EXISTS active_project_material_grants ON project_materials(material_id) WHERE scope='project' AND active=1;
`;

type Row = Record<string, unknown>;
type RunDatabase = {
  projectId: string;
  get(label: string, sql: string, ...values: SQLInputValue[]): Row | undefined;
  all(label: string, sql: string, ...values: SQLInputValue[]): Row[];
  run(label: string, sql: string, ...values: SQLInputValue[]): { changes: number | bigint };
  json(value: unknown): string;
  mutate<T>(action: () => T): T;
  entities: EntityTransactionStorage;
  materials: MaterialTransactionStorage;
  settings: SettingsTransactionStorage;
  appendChange(change: ProjectRunChange): void;
};
const conflict = () =>
  new DomainError('CONFLICT', 'The run state changed. Refresh before trying again.');
const columns =
  'run_id,goal_id,revision,admission_id,attempt_id,title,summary,status,phase,created_at,updated_at,completed_at,cancel_requested';
function fromRow(row: Row): RunCurrent {
  if (row.cancel_requested !== 0 && row.cancel_requested !== 1)
    throw new DomainError('INVALID_RUN_STATE', 'The saved run cancellation marker is invalid.');
  return validateRunCurrent({
    version: 1,
    id: row.run_id,
    goalId: row.goal_id,
    revision: row.revision,
    admissionId: row.admission_id,
    attemptId: row.attempt_id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    phase: row.phase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    cancelRequested: row.cancel_requested === 1,
  });
}

/** Semantic queue/cancel/lifecycle storage; no full Run replacement or accepted-result method. */
export function createSqliteRunRows(database: RunDatabase): RunTransactionStorage {
  return {
    current: (id) => {
      const row = database.get(
        'run.current',
        `SELECT ${columns} FROM run_current WHERE run_id=?`,
        id,
      );
      return row ? fromRow(row) : undefined;
    },
    workspace: (id) => {
      const row = database.get(
        'run.workspace',
        'SELECT run_id,admission_id,attempt_id,workspace_path,base_commit,created_at FROM run_workspaces WHERE run_id=?',
        id,
      );
      return row
        ? validateRunWorkspaceBinding({
            version: 1,
            runId: row.run_id,
            admissionId: row.admission_id,
            attemptId: row.attempt_id,
            path: row.workspace_path,
            baseCommit: row.base_commit,
            createdAt: row.created_at,
          })
        : undefined;
    },
    goal: (id) => database.entities.goal(id),
    profile: () => database.settings.profile(),
    role: (id) => database.entities.role(id),
    material: (id) => database.materials.material(id),
    activeProjectMaterials: () =>
      database
        .all(
          'run.material-grants',
          "SELECT material_id,material_json FROM project_materials WHERE scope='project' AND active=1 ORDER BY material_id",
        )
        .map((row) => {
          const material = validateProjectMaterial(JSON.parse(String(row.material_json)));
          if (material.id !== row.material_id || material.scope !== 'project' || !material.active)
            throw new DomainError(
              'INVALID_PROJECT_MATERIAL',
              'The saved material grant index differs from its metadata.',
            );
          return material;
        }),
    hasActiveRun: () =>
      !!database.get(
        'run.active',
        "SELECT run_id FROM project_run_index WHERE status IN ('queued','running','canceling') LIMIT 1",
      ),
    unresolvedForGoal: (goalId) =>
      !!database.get(
        'run.unresolved',
        'SELECT run_id FROM project_run_index WHERE goal_id=? AND unresolved=1 LIMIT 1',
        goalId,
      ),
    parentRun: (id) => database.entities.parentRun(id),
    timeline: (query) => {
      if (query.limit > RUN_TIMELINE_PAGE_MAX)
        throw new DomainError('INVALID_RUN_CURSOR', 'The run timeline page is too large.');
      const current = Number(
        database.get(
          'run.timeline.watermark',
          'SELECT COALESCE(MAX(sequence),0) AS sequence FROM run_timeline WHERE run_id=?',
          query.runId,
        )!.sequence,
      );
      const after = query.cursor?.after ?? 0;
      const watermark = query.cursor?.watermark ?? current;
      if (watermark > current)
        throw new DomainError(
          'RUN_CURSOR_AHEAD',
          'The run timeline cursor is ahead of saved history.',
        );
      const rows = database.all(
        'run.timeline.page',
        'SELECT sequence,at,type,text,thread_id,command_id,duration_ms FROM run_timeline WHERE run_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?',
        query.runId,
        after,
        watermark,
        query.limit + 1,
      );
      const entries = rows.slice(0, query.limit).map((row) =>
        validateRunTimelineEntry({
          runId: query.runId,
          sequence: row.sequence,
          at: row.at,
          type: row.type,
          ...(row.text === null ? {} : { text: row.text }),
          ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
          ...(row.command_id === null ? {} : { commandId: row.command_id }),
          ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
        }),
      );
      return {
        entries,
        watermark,
        ...(rows.length > query.limit
          ? {
              next: {
                version: 1 as const,
                projectId: database.projectId,
                runId: query.runId,
                after: entries.at(-1)!.sequence,
                watermark,
              },
            }
          : {}),
      };
    },
    insertAdmission: (candidate) =>
      database.mutate(() => {
        const admission = validateRunAdmission(candidate, database.projectId);
        database.run(
          'run.admission.insert',
          'INSERT INTO run_admissions(admission_id,run_id,attempt_id,admission_json) VALUES (?,?,?,?)',
          admission.id,
          admission.runId,
          admission.attemptId,
          database.json(admission),
        );
      }),
    insertAttempt: (candidate) =>
      database.mutate(() => {
        const attempt = validateRunAttempt(candidate);
        database.run(
          'run.attempt.insert',
          'INSERT INTO run_attempts(attempt_id,run_id,admission_id,ordinal,reason,created_at) VALUES (?,?,?,?,?,?)',
          attempt.id,
          attempt.runId,
          attempt.admissionId,
          attempt.ordinal,
          attempt.reason,
          attempt.createdAt,
        );
      }),
    insertCurrent: (candidate) =>
      database.mutate(() => {
        const current = validateRunCurrent(candidate);
        database.run(
          'run.current.insert',
          `INSERT INTO run_current(${columns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          current.id,
          current.goalId,
          current.revision,
          current.admissionId,
          current.attemptId,
          current.title,
          current.summary,
          current.status,
          current.phase,
          current.createdAt,
          current.updatedAt,
          current.completedAt ?? null,
          Number(current.cancelRequested),
        );
        database.run(
          'run.index.insert',
          'INSERT INTO project_run_index(run_id,goal_id,status,commit_oid,delivery_busy,preview_busy,unresolved) VALUES (?,?,?,NULL,0,0,0)',
          current.id,
          current.goalId,
          current.status,
        );
      }),
    insertWorkspace: (candidate) =>
      database.mutate(() => {
        const binding = validateRunWorkspaceBinding(candidate);
        const inserted = database.run(
          'run.workspace.insert',
          'INSERT INTO run_workspaces(run_id,admission_id,attempt_id,workspace_path,base_commit,created_at) SELECT run_id,admission_id,attempt_id,?,?,? FROM run_current WHERE run_id=? AND admission_id=? AND attempt_id=?',
          binding.path,
          binding.baseCommit,
          binding.createdAt,
          binding.runId,
          binding.admissionId,
          binding.attemptId,
        );
        if (Number(inserted.changes) !== 1) throw conflict();
      }),
    replaceCurrent: (previous, candidate) =>
      database.mutate(() => {
        const before = validateRunCurrent(previous);
        const after = validateRunCurrent(candidate);
        if (
          before.id !== after.id ||
          before.goalId !== after.goalId ||
          before.admissionId !== after.admissionId ||
          before.attemptId !== after.attemptId ||
          before.createdAt !== after.createdAt ||
          before.title !== after.title
        )
          throw conflict();
        const changed = database.run(
          'run.current.update',
          'UPDATE run_current SET revision=?,summary=?,status=?,phase=?,updated_at=?,completed_at=?,cancel_requested=? WHERE run_id=? AND revision=? AND goal_id=? AND admission_id=? AND attempt_id=? AND title=? AND summary=? AND status=? AND phase=? AND created_at=? AND updated_at=? AND completed_at IS ? AND cancel_requested=?',
          after.revision,
          after.summary,
          after.status,
          after.phase,
          after.updatedAt,
          after.completedAt ?? null,
          Number(after.cancelRequested),
          before.id,
          before.revision,
          before.goalId,
          before.admissionId,
          before.attemptId,
          before.title,
          before.summary,
          before.status,
          before.phase,
          before.createdAt,
          before.updatedAt,
          before.completedAt ?? null,
          Number(before.cancelRequested),
        );
        if (Number(changed.changes) !== 1) throw conflict();
        const indexed = database.run(
          'run.index.update',
          'UPDATE project_run_index SET status=? WHERE run_id=? AND goal_id=? AND status=? AND commit_oid IS NULL',
          after.status,
          before.id,
          before.goalId,
          before.status,
        );
        if (Number(indexed.changes) !== 1) throw conflict();
      }),
    linkGoal: (previous, next) => database.entities.replaceGoal(previous, next),
    appendRole: (role, expectedPreviousVersion) =>
      database.entities.insertRole(role, expectedPreviousVersion),
    appendTimeline: (entry) =>
      database.mutate(() => {
        const previous = Number(
          database.get(
            'run.timeline.last',
            'SELECT COALESCE(MAX(sequence),0) AS sequence FROM run_timeline WHERE run_id=?',
            entry.runId,
          )!.sequence,
        );
        const sequence = previous + 1;
        if (!Number.isSafeInteger(sequence))
          throw new DomainError(
            'RUN_SEQUENCE_EXHAUSTED',
            'The run timeline cannot represent another entry.',
          );
        database.run(
          'run.timeline.append',
          'INSERT INTO run_timeline(run_id,sequence,at,type,text,thread_id,command_id,duration_ms) VALUES (?,?,?,?,?,?,?,?)',
          entry.runId,
          sequence,
          entry.at,
          entry.type,
          entry.text ?? null,
          entry.threadId ?? null,
          entry.commandId ?? null,
          entry.durationMs ?? null,
        );
      }),
    appendChange: (change) => database.mutate(() => database.appendChange(change)),
  };
}
