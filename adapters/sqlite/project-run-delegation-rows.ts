import type { SQLInputValue } from 'node:sqlite';
import { DomainError } from '../../core/ports.ts';
import type { RunTransactionStorage } from '../../core/project-runs.ts';
import { validateRunAdmission } from '../../core/project-runs.ts';
import { validateRunWorkerAssignment } from '../../core/project-run-delegations.ts';
import { createSqliteRunAttemptRows } from './project-run-attempt-rows.ts';

/** Immutable worker grants and ordered current assignment heads. */
export const projectRunDelegationSchema = `
  CREATE TABLE IF NOT EXISTS run_assignments (
    assignment_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES run_current(run_id),
    admission_id TEXT NOT NULL REFERENCES run_admissions(admission_id),
    attempt_id TEXT NOT NULL REFERENCES run_attempts(attempt_id),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    role_id TEXT NOT NULL,
    role_version INTEGER NOT NULL,
    role_json TEXT NOT NULL CHECK(json_valid(role_json)),
    origin TEXT NOT NULL CHECK(origin IN ('created','reused')),
    task_json TEXT CHECK(task_json IS NULL OR json_valid(task_json)),
    resource_json TEXT NOT NULL CHECK(json_valid(resource_json)),
    FOREIGN KEY(role_id,role_version) REFERENCES role_versions(role_id,version)
  );
  CREATE TABLE IF NOT EXISTS run_assignment_paths (
    assignment_id TEXT NOT NULL REFERENCES run_assignments(assignment_id),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    path TEXT NOT NULL,
    PRIMARY KEY(assignment_id,ordinal)
  );
  CREATE TABLE IF NOT EXISTS run_assignment_heads (
    run_id TEXT NOT NULL REFERENCES run_current(run_id),
    role_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL UNIQUE REFERENCES run_assignments(assignment_id),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    PRIMARY KEY(run_id,role_id),
    UNIQUE(run_id,ordinal)
  );
  ${['run_assignments', 'run_assignment_heads', 'run_assignment_paths']
    .map(
      (table) => `
  CREATE TRIGGER IF NOT EXISTS immutable_${table}_update
    BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Run delegation records are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_${table}_delete
    BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Run delegation records are immutable'); END;`,
    )
    .join('')}
`;
type Row = Record<string, unknown>;
type DelegationDatabase = {
  projectId: string;
  get(label: string, sql: string, ...values: SQLInputValue[]): Row | undefined;
  all(label: string, sql: string, ...values: SQLInputValue[]): Row[];
  run(label: string, sql: string, ...values: SQLInputValue[]): { changes: number | bigint };
  json(value: unknown): string;
  mutate<T>(action: () => T): T;
};
const invalid = () =>
  new DomainError('INVALID_RUN_STATE', 'The saved delegation records are invalid.');

export function createSqliteRunDelegationRows(
  database: DelegationDatabase,
): Pick<
  RunTransactionStorage,
  'delegationContext' | 'assignment' | 'assignments' | 'insertAssignment'
> {
  const insertAssignment: RunTransactionStorage['insertAssignment'] = (candidate) =>
    database.mutate(() => {
      const assignment = validateRunWorkerAssignment(candidate);
      const count = database.get(
        'run.assignment.count',
        'SELECT count(*) AS total FROM run_assignment_heads WHERE run_id=?',
        assignment.runId,
      );
      const ordinal = Number(count?.total ?? 0);
      const inserted = database.run(
        'run.assignment.insert',
        'INSERT INTO run_assignments(assignment_id,run_id,admission_id,attempt_id,ordinal,role_id,role_version,role_json,origin,task_json,resource_json) SELECT ?,run_id,admission_id,attempt_id,?,?,?,?,?,?,? FROM run_current WHERE run_id=? AND admission_id=? AND attempt_id=?',
        assignment.id,
        ordinal,
        assignment.role.id,
        assignment.role.version,
        database.json(assignment.role),
        assignment.origin,
        assignment.task === undefined ? null : database.json(assignment.task),
        database.json(assignment.resource),
        assignment.runId,
        assignment.admissionId,
        assignment.attemptId,
      );
      if (Number(inserted.changes) !== 1) throw invalid();
      for (const [ordinal, path] of assignment.paths.entries())
        database.run(
          'run.assignment.path.insert',
          'INSERT INTO run_assignment_paths(assignment_id,ordinal,path) VALUES (?,?,?)',
          assignment.id,
          ordinal,
          path,
        );
      database.run(
        'run.assignment.head.insert',
        'INSERT INTO run_assignment_heads(run_id,role_id,assignment_id,ordinal) VALUES (?,?,?,?)',
        assignment.runId,
        assignment.role.id,
        assignment.id,
        ordinal,
      );
    });
  const rows: Pick<
    RunTransactionStorage,
    'delegationContext' | 'assignment' | 'assignments' | 'insertAssignment'
  > = {
    insertAssignment,
    delegationContext: (runId) => {
      const row = database.get(
        'run.delegation-context',
        'SELECT c.attempt_id,a.admission_json FROM run_current c JOIN run_admissions a ON a.admission_id=c.admission_id WHERE c.run_id=?',
        runId,
      );
      if (!row) throw invalid();
      const admission = validateRunAdmission(
        JSON.parse(String(row.admission_json)),
        database.projectId,
      );
      if (admission.runId !== runId) throw invalid();
      if (row.attempt_id !== admission.attemptId) {
        const context = createSqliteRunAttemptRows(database).attemptContext(String(row.attempt_id));
        if (!context || context.runId !== runId || context.admissionId !== admission.id)
          throw invalid();
        return {
          contextSource: 'continuation-attempt',
          title: context.goal.title,
          goalText: context.goalText,
          contextMaterials: context.contextMaterials,
          checkIds: context.checkIds,
          policy: context.policy,
          resources: context.resources,
          coordinator: {
            role: context.roleSnapshots.find((role) => role.id === 'coordinator')!,
            resource: context.roleResources.coordinator,
          },
          workflow: context.workflow,
          repairEnvironment: context.repairEnvironment,
        };
      }
      const coordinatorRole = admission.roleSnapshots.find((role) => role.id === 'coordinator');
      const coordinatorResource = admission.roleResources.coordinator;
      if (!coordinatorRole || !coordinatorResource) throw invalid();
      return {
        contextSource: 'initial-admission',
        title: admission.goal.title,
        goalText: admission.goalText,
        contextMaterials: admission.contextMaterials,
        checkIds: admission.checkIds,
        policy: admission.policy,
        resources: admission.resources,
        coordinator: { role: coordinatorRole, resource: coordinatorResource },
        workflow: admission.workflow,
        repairEnvironment: admission.repairEnvironment,
      };
    },
    assignments: (runId) =>
      database
        .all(
          'run.assignments.current',
          'SELECT h.role_id,h.ordinal FROM run_assignment_heads h WHERE h.run_id=? ORDER BY h.ordinal',
          runId,
        )
        .map((row, index) => {
          if (row.ordinal !== index) throw invalid();
          const value = rows.assignment(runId, String(row.role_id));
          if (!value) throw invalid();
          return value;
        }),
    assignment: (runId, roleId) => {
      const row = database.get(
        'run.assignment',
        'SELECT a.assignment_id,a.run_id,a.admission_id,a.attempt_id,a.role_id,a.role_version,a.role_json,a.origin,a.task_json,a.resource_json FROM run_assignment_heads h JOIN run_assignments a ON a.assignment_id=h.assignment_id WHERE h.run_id=? AND h.role_id=?',
        runId,
        roleId,
      );
      if (!row) return undefined;
      const paths = database.all(
        'run.assignment.paths',
        'SELECT ordinal,path FROM run_assignment_paths WHERE assignment_id=? ORDER BY ordinal',
        String(row.assignment_id),
      );
      if (paths.some((entry, index) => entry.ordinal !== index)) throw invalid();
      const assignment = validateRunWorkerAssignment({
        version: 1,
        id: row.assignment_id,
        runId: row.run_id,
        admissionId: row.admission_id,
        attemptId: row.attempt_id,
        role: JSON.parse(String(row.role_json)),
        origin: row.origin,
        paths: paths.map(({ path }) => path),
        ...(row.task_json === null ? {} : { task: JSON.parse(String(row.task_json)) }),
        resource: JSON.parse(String(row.resource_json)),
      });
      if (assignment.role.id !== row.role_id || assignment.role.version !== row.role_version)
        throw invalid();
      return assignment;
    },
  };
  return rows;
}
