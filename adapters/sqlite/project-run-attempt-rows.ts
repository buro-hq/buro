import type { SQLInputValue } from 'node:sqlite';
import type { RunTransactionStorage } from '../../core/project-runs.ts';
import { validateRunAdmission, validateRunAttempt } from '../../core/project-runs.ts';
import {
  validateRunAttemptContext,
  validateRunAttemptStop,
} from '../../core/project-run-attempts.ts';
import { DomainError } from '../../core/ports.ts';

export const projectRunAttemptSchema = `
  CREATE TABLE IF NOT EXISTS run_attempt_contexts (
    attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES run_attempts(attempt_id),
    run_id TEXT NOT NULL REFERENCES run_current(run_id),
    admission_id TEXT NOT NULL REFERENCES run_admissions(admission_id),
    goal_json TEXT NOT NULL CHECK(json_valid(goal_json)),
    goal_text TEXT NOT NULL,
    policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
    policy_source TEXT NOT NULL CHECK(policy_source IN ('retained-attempt','project-profile','configured-host')),
    resources_json TEXT NOT NULL CHECK(json_valid(resources_json)),
    workflow_json TEXT NOT NULL CHECK(json_valid(workflow_json)),
    planning_policy_json TEXT NOT NULL CHECK(json_valid(planning_policy_json)),
    repair_environment INTEGER NOT NULL CHECK(repair_environment IN (0,1)),
    time_policy_json TEXT NOT NULL CHECK(json_valid(time_policy_json)),
    continuation_json TEXT NOT NULL CHECK(json_valid(continuation_json)),
    workspace_origin_attempt_id TEXT NOT NULL REFERENCES run_attempts(attempt_id),
    inherited_plan_id TEXT REFERENCES run_plans(plan_id),
    plan_origin_attempt_id TEXT REFERENCES run_attempts(attempt_id),
    task_mode TEXT NOT NULL CHECK(task_mode IN ('original','full-goal')),
    task_changed INTEGER NOT NULL CHECK(task_changed IN (0,1)),
    CHECK((inherited_plan_id IS NULL)=(plan_origin_attempt_id IS NULL))
  );
  CREATE TABLE IF NOT EXISTS run_attempt_materials (
    attempt_id TEXT NOT NULL REFERENCES run_attempt_contexts(attempt_id),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    material_id TEXT NOT NULL REFERENCES material_refs(material_id),
    material_json TEXT NOT NULL CHECK(json_valid(material_json)),
    PRIMARY KEY(attempt_id,ordinal), UNIQUE(attempt_id,material_id)
  );
  CREATE TABLE IF NOT EXISTS run_attempt_checks (
    attempt_id TEXT NOT NULL REFERENCES run_attempt_contexts(attempt_id),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    check_id TEXT NOT NULL,
    PRIMARY KEY(attempt_id,ordinal), UNIQUE(attempt_id,check_id)
  );
  CREATE TABLE IF NOT EXISTS run_attempt_roles (
    attempt_id TEXT NOT NULL REFERENCES run_attempt_contexts(attempt_id),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    role_id TEXT NOT NULL,
    role_version INTEGER NOT NULL,
    role_json TEXT NOT NULL CHECK(json_valid(role_json)),
    resource_json TEXT CHECK(resource_json IS NULL OR json_valid(resource_json)),
    PRIMARY KEY(attempt_id,ordinal), UNIQUE(attempt_id,role_id),
    FOREIGN KEY(role_id,role_version) REFERENCES role_versions(role_id,version)
  );
  CREATE TABLE IF NOT EXISTS run_attempt_stops (
    stop_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES run_current(run_id),
    attempt_id TEXT NOT NULL UNIQUE REFERENCES run_attempts(attempt_id),
    created_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('failed','interrupted','needs-attention')),
    text TEXT NOT NULL,
    issue_json TEXT CHECK(issue_json IS NULL OR json_valid(issue_json)),
    error_code TEXT
  );
  ${[
    'run_attempt_contexts',
    'run_attempt_materials',
    'run_attempt_checks',
    'run_attempt_roles',
    'run_attempt_stops',
  ]
    .map(
      (table) => `
  CREATE TRIGGER IF NOT EXISTS immutable_${table}_update
    BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Run attempt records are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_${table}_delete
    BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Run attempt records are immutable'); END;`,
    )
    .join('')}
`;
type Row = Record<string, unknown>;
type AttemptDatabase = {
  projectId: string;
  get(label: string, sql: string, ...values: SQLInputValue[]): Row | undefined;
  all(label: string, sql: string, ...values: SQLInputValue[]): Row[];
  run(label: string, sql: string, ...values: SQLInputValue[]): { changes: number | bigint };
  json(value: unknown): string;
  mutate<T>(action: () => T): T;
};
const invalid = () =>
  new DomainError('INVALID_RUN_ATTEMPT', 'The saved attempt authority is invalid.');
const parsed = (value: unknown) => JSON.parse(String(value));
export function createSqliteRunAttemptRows(
  database: AttemptDatabase,
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
  const stop: RunTransactionStorage['attemptStop'] = (attemptId) => {
    const row = database.get(
      'run.attempt-stop',
      'SELECT stop_id,run_id,attempt_id,created_at,status,text,issue_json,error_code FROM run_attempt_stops WHERE attempt_id=?',
      attemptId,
    );
    return row
      ? validateRunAttemptStop({
          version: 1,
          id: row.stop_id,
          runId: row.run_id,
          attemptId: row.attempt_id,
          createdAt: row.created_at,
          status: row.status,
          text: row.text,
          ...(row.issue_json === null ? {} : { issue: parsed(row.issue_json) }),
          ...(row.error_code === null ? {} : { errorCode: row.error_code }),
        })
      : undefined;
  };
  return {
    admission: (id) => {
      const row = database.get(
        'run.admission',
        'SELECT admission_json FROM run_admissions WHERE admission_id=?',
        id,
      );
      if (!row) return undefined;
      const value = validateRunAdmission(parsed(row.admission_json), database.projectId);
      if (value.id !== id) throw invalid();
      return value;
    },
    attempt: (id) => {
      const row = database.get(
        'run.attempt',
        'SELECT attempt_id,run_id,admission_id,ordinal,reason,created_at,prior_attempt_id FROM run_attempts WHERE attempt_id=?',
        id,
      );
      return row
        ? validateRunAttempt({
            version: 1,
            id: row.attempt_id,
            runId: row.run_id,
            admissionId: row.admission_id,
            ordinal: row.ordinal,
            reason: row.reason,
            createdAt: row.created_at,
            ...(row.prior_attempt_id === null ? {} : { priorAttemptId: row.prior_attempt_id }),
          })
        : undefined;
    },
    attemptContext: (id) => {
      const row = database.get(
        'run.attempt-context.header',
        'SELECT attempt_id,run_id,admission_id,goal_json,goal_text,policy_json,policy_source,resources_json,workflow_json,planning_policy_json,repair_environment,time_policy_json,continuation_json,workspace_origin_attempt_id,inherited_plan_id,plan_origin_attempt_id,task_mode,task_changed FROM run_attempt_contexts WHERE attempt_id=?',
        id,
      );
      if (!row) return undefined;
      const materials = database.all(
        'run.attempt-context.materials',
        'SELECT ordinal,material_json FROM run_attempt_materials WHERE attempt_id=? ORDER BY ordinal',
        id,
      );
      const checks = database.all(
        'run.attempt-context.checks',
        'SELECT ordinal,check_id FROM run_attempt_checks WHERE attempt_id=? ORDER BY ordinal',
        id,
      );
      const roles = database.all(
        'run.attempt-context.roles',
        'SELECT ordinal,role_id,role_version,role_json,resource_json FROM run_attempt_roles WHERE attempt_id=? ORDER BY ordinal',
        id,
      );
      if (
        [materials, checks, roles].some((rows) =>
          rows.some((row, index) => row.ordinal !== index),
        ) ||
        ![0, 1].includes(Number(row.repair_environment)) ||
        ![0, 1].includes(Number(row.task_changed))
      )
        throw invalid();
      const roleSnapshots = roles.map((row) => {
        const role = parsed(row.role_json);
        if (role.id !== row.role_id || role.version !== row.role_version) throw invalid();
        return role;
      });
      return validateRunAttemptContext({
        version: 1,
        attemptId: row.attempt_id,
        runId: row.run_id,
        admissionId: row.admission_id,
        goal: parsed(row.goal_json),
        goalText: row.goal_text,
        policy: parsed(row.policy_json),
        policySource: row.policy_source,
        resources: parsed(row.resources_json),
        workflow: parsed(row.workflow_json),
        planningPolicy: parsed(row.planning_policy_json),
        roleSnapshots,
        roleResources: Object.fromEntries(
          roles
            .filter((row) => row.resource_json !== null)
            .map((row) => [row.role_id, parsed(row.resource_json)]),
        ),
        contextMaterials: materials.map((row) => parsed(row.material_json)),
        checkIds: checks.map((row) => row.check_id),
        repairEnvironment: row.repair_environment === 1,
        timePolicy: parsed(row.time_policy_json),
        continuation: parsed(row.continuation_json),
        workspaceOriginAttemptId: row.workspace_origin_attempt_id,
        ...(row.inherited_plan_id === null
          ? {}
          : {
              inheritedPlanId: row.inherited_plan_id,
              planOriginAttemptId: row.plan_origin_attempt_id,
            }),
        taskMode: row.task_mode,
        taskChanged: row.task_changed === 1,
      });
    },
    attemptStop: stop,
    insertAttemptContext: (candidate) =>
      database.mutate(() => {
        const value = validateRunAttemptContext(candidate);
        if (!value.continuation || !value.workspaceOriginAttemptId) throw invalid();
        database.run(
          'run.attempt-context.insert',
          'INSERT INTO run_attempt_contexts(attempt_id,run_id,admission_id,goal_json,goal_text,policy_json,policy_source,resources_json,workflow_json,planning_policy_json,repair_environment,time_policy_json,continuation_json,workspace_origin_attempt_id,inherited_plan_id,plan_origin_attempt_id,task_mode,task_changed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          value.attemptId,
          value.runId,
          value.admissionId,
          database.json(value.goal),
          value.goalText,
          database.json(value.policy),
          value.policySource,
          database.json(value.resources),
          database.json(value.workflow),
          database.json(value.planningPolicy),
          Number(value.repairEnvironment),
          database.json(value.timePolicy),
          database.json(value.continuation),
          value.workspaceOriginAttemptId,
          value.inheritedPlanId ?? null,
          value.planOriginAttemptId ?? null,
          value.taskMode,
          Number(value.taskChanged),
        );
        for (const [ordinal, material] of value.contextMaterials.entries())
          database.run(
            'run.attempt-context.material.insert',
            'INSERT INTO run_attempt_materials(attempt_id,ordinal,material_id,material_json) VALUES (?,?,?,?)',
            value.attemptId,
            ordinal,
            material.id,
            database.json(material),
          );
        for (const [ordinal, id] of value.checkIds.entries())
          database.run(
            'run.attempt-context.check.insert',
            'INSERT INTO run_attempt_checks(attempt_id,ordinal,check_id) VALUES (?,?,?)',
            value.attemptId,
            ordinal,
            id,
          );
        for (const [ordinal, role] of value.roleSnapshots.entries())
          database.run(
            'run.attempt-context.role.insert',
            'INSERT INTO run_attempt_roles(attempt_id,ordinal,role_id,role_version,role_json,resource_json) VALUES (?,?,?,?,?,?)',
            value.attemptId,
            ordinal,
            role.id,
            role.version,
            database.json(role),
            value.roleResources[role.id] === undefined
              ? null
              : database.json(value.roleResources[role.id]),
          );
      }),
    insertStop: (candidate) =>
      database.mutate(() => {
        const value = validateRunAttemptStop(candidate);
        const row = database.get(
          'run.attempt-stop.owner',
          'SELECT run_id FROM run_attempts WHERE attempt_id=?',
          value.attemptId,
        );
        if (row?.run_id !== value.runId) throw invalid();
        database.run(
          'run.attempt-stop.insert',
          'INSERT INTO run_attempt_stops(stop_id,run_id,attempt_id,created_at,status,text,issue_json,error_code) VALUES (?,?,?,?,?,?,?,?)',
          value.id,
          value.runId,
          value.attemptId,
          value.createdAt,
          value.status,
          value.text,
          value.issue === undefined ? null : database.json(value.issue),
          value.errorCode ?? null,
        );
      }),
    // No SQL execution accounting owner is created by the queue-only proof.
    budgetBlocked: () => false,
    runIssue: (runId) => {
      const row = database.get(
        'run.attempt-stop.current',
        'SELECT attempt_id FROM run_current WHERE run_id=?',
        runId,
      );
      return row ? stop(String(row.attempt_id))?.issue : undefined;
    },
    unresolvedForRun: (runId) =>
      !!database.get(
        'run.unresolved-current',
        'SELECT run_id FROM project_run_index WHERE run_id=? AND unresolved=1',
        runId,
      ),
  };
}
