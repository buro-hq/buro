import type { SQLInputValue } from 'node:sqlite';
import { DomainError } from '../../core/ports.ts';
import type { RunTransactionStorage } from '../../core/project-runs.ts';
import { validateRunAdmission } from '../../core/project-runs.ts';
import { validateRunPlan, validateRunWorkerAssignment } from '../../core/project-run-plans.ts';
import { createSqliteRunAttemptRows } from './project-run-attempt-rows.ts';

/** Immutable decision packets are separate from the mutable current-plan pointer and Run state. */
export const projectRunPlanSchema = `
  CREATE TABLE IF NOT EXISTS run_plans (
    plan_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES run_current(run_id),
    admission_id TEXT NOT NULL REFERENCES run_admissions(admission_id),
    attempt_id TEXT NOT NULL REFERENCES run_attempts(attempt_id),
    created_at TEXT NOT NULL CHECK(length(created_at)>0),
    summary TEXT NOT NULL,
    context_source TEXT NOT NULL CHECK(context_source IN ('initial-admission','legacy-continuation','continuation-attempt')),
    title TEXT NOT NULL,
    goal_text TEXT NOT NULL,
    policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
    resources_json TEXT NOT NULL CHECK(json_valid(resources_json)),
    coordinator_role_json TEXT NOT NULL CHECK(json_valid(coordinator_role_json)),
    coordinator_resource_json TEXT NOT NULL CHECK(json_valid(coordinator_resource_json)),
    workflow_json TEXT NOT NULL CHECK(json_valid(workflow_json)),
    planning_policy_json TEXT NOT NULL CHECK(json_valid(planning_policy_json)),
    repair_environment INTEGER NOT NULL CHECK(repair_environment IN (0,1)),
    planner_thread_id TEXT,
    planner_session_id TEXT,
    CHECK((planner_thread_id IS NULL)=(planner_session_id IS NULL))
  );
  CREATE TABLE IF NOT EXISTS run_plan_steps (
    plan_id TEXT NOT NULL REFERENCES run_plans(plan_id),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    step TEXT NOT NULL CHECK(length(step)>0),
    owner TEXT NOT NULL CHECK(length(owner)>0),
    PRIMARY KEY(plan_id,ordinal)
  );
  CREATE TABLE IF NOT EXISTS run_plan_materials (
    plan_id TEXT NOT NULL REFERENCES run_plans(plan_id),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    material_id TEXT NOT NULL REFERENCES material_refs(material_id),
    material_json TEXT NOT NULL CHECK(json_valid(material_json)),
    PRIMARY KEY(plan_id,ordinal),
    UNIQUE(plan_id,material_id)
  );
  CREATE TABLE IF NOT EXISTS run_plan_checks (
    plan_id TEXT NOT NULL REFERENCES run_plans(plan_id),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    check_id TEXT NOT NULL,
    PRIMARY KEY(plan_id,ordinal),
    UNIQUE(plan_id,check_id)
  );
  CREATE TABLE IF NOT EXISTS run_assignments (
    assignment_id TEXT PRIMARY KEY NOT NULL,
    plan_id TEXT NOT NULL REFERENCES run_plans(plan_id),
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
    FOREIGN KEY(role_id,role_version) REFERENCES role_versions(role_id,version),
    UNIQUE(plan_id,role_id),
    UNIQUE(plan_id,ordinal)
  );
  CREATE TABLE IF NOT EXISTS run_assignment_paths (
    assignment_id TEXT NOT NULL REFERENCES run_assignments(assignment_id),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    path TEXT NOT NULL,
    PRIMARY KEY(assignment_id,ordinal)
  );
  CREATE TABLE IF NOT EXISTS run_plan_heads (
    run_id TEXT PRIMARY KEY NOT NULL REFERENCES run_current(run_id),
    plan_id TEXT NOT NULL UNIQUE REFERENCES run_plans(plan_id)
  );
  ${[
    'run_plans',
    'run_plan_steps',
    'run_plan_materials',
    'run_plan_checks',
    'run_assignments',
    'run_assignment_paths',
  ]
    .map(
      (table) => `
  CREATE TRIGGER IF NOT EXISTS immutable_${table}_update
    BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Run planning records are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_${table}_delete
    BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Run planning records are immutable'); END;`,
    )
    .join('')}
`;
type Row = Record<string, unknown>;
type PlanDatabase = {
  projectId: string;
  get(label: string, sql: string, ...values: SQLInputValue[]): Row | undefined;
  all(label: string, sql: string, ...values: SQLInputValue[]): Row[];
  run(label: string, sql: string, ...values: SQLInputValue[]): { changes: number | bigint };
  json(value: unknown): string;
  mutate<T>(action: () => T): T;
};
const invalid = () =>
  new DomainError('INVALID_RUN_STATE', 'The saved planning records are invalid.');

export function createSqliteRunPlanRows(
  database: PlanDatabase,
): Pick<
  RunTransactionStorage,
  'planningInput' | 'plan' | 'assignment' | 'planAssignments' | 'insertPlan' | 'sealPlanningSession'
> {
  const plan: RunTransactionStorage['plan'] = (runId) => {
    const row = database.get(
      'run.plan.header',
      'SELECT p.plan_id,p.run_id,p.admission_id,p.attempt_id,p.created_at,p.summary,p.context_source,p.title,p.goal_text,p.policy_json,p.resources_json,p.coordinator_role_json,p.coordinator_resource_json,p.workflow_json,p.planning_policy_json,p.repair_environment,p.planner_thread_id,p.planner_session_id FROM run_plan_heads h JOIN run_plans p ON p.plan_id=h.plan_id WHERE h.run_id=?',
      runId,
    );
    if (!row) return undefined;
    const steps = database.all(
      'run.plan.steps',
      'SELECT ordinal,step,owner FROM run_plan_steps WHERE plan_id=? ORDER BY ordinal',
      String(row.plan_id),
    );
    if (steps.some((step, index) => step.ordinal !== index)) throw invalid();
    const materials = database.all(
      'run.plan.materials',
      'SELECT ordinal,material_id,material_json FROM run_plan_materials WHERE plan_id=? ORDER BY ordinal',
      String(row.plan_id),
    );
    const checks = database.all(
      'run.plan.checks',
      'SELECT ordinal,check_id FROM run_plan_checks WHERE plan_id=? ORDER BY ordinal',
      String(row.plan_id),
    );
    if (
      materials.some((entry, index) => entry.ordinal !== index) ||
      checks.some((entry, index) => entry.ordinal !== index) ||
      ![0, 1].includes(Number(row.repair_environment))
    )
      throw invalid();
    const readOnlyPlanner =
      row.planner_thread_id === null && row.planner_session_id === null
        ? {}
        : {
            readOnlyPlanner: { threadId: row.planner_thread_id, sessionId: row.planner_session_id },
          };
    return validateRunPlan({
      version: 1,
      id: row.plan_id,
      runId: row.run_id,
      admissionId: row.admission_id,
      attemptId: row.attempt_id,
      createdAt: row.created_at,
      summary: row.summary,
      context: {
        contextSource: row.context_source,
        title: row.title,
        goalText: row.goal_text,
        policy: JSON.parse(String(row.policy_json)),
        resources: JSON.parse(String(row.resources_json)),
        coordinator: {
          role: JSON.parse(String(row.coordinator_role_json)),
          resource: JSON.parse(String(row.coordinator_resource_json)),
        },
        workflow: JSON.parse(String(row.workflow_json)),
        planningPolicy: JSON.parse(String(row.planning_policy_json)),
        repairEnvironment: row.repair_environment === 1,
        contextMaterials: materials.map((entry) => {
          const material = JSON.parse(String(entry.material_json));
          if (material.id !== entry.material_id) throw invalid();
          return material;
        }),
        checkIds: checks.map((entry) => entry.check_id),
        ...readOnlyPlanner,
      },
      steps: steps.map(({ step, owner }) => ({ step, owner })),
      ...readOnlyPlanner,
    });
  };
  const rows: Pick<
    RunTransactionStorage,
    | 'planningInput'
    | 'plan'
    | 'assignment'
    | 'planAssignments'
    | 'insertPlan'
    | 'sealPlanningSession'
  > = {
    planningInput: (runId) => {
      const row = database.get(
        'run.planning-input',
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
          planningPolicy: context.planningPolicy,
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
        planningPolicy: admission.planningPolicy,
        repairEnvironment: admission.repairEnvironment,
      };
    },
    plan,
    planAssignments: (runId) =>
      database
        .all(
          'run.assignments.current',
          'SELECT a.role_id,a.ordinal FROM run_plan_heads h JOIN run_assignments a ON a.plan_id=h.plan_id WHERE h.run_id=? ORDER BY a.ordinal',
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
        'SELECT a.assignment_id,a.plan_id,a.run_id,a.admission_id,a.attempt_id,a.role_id,a.role_version,a.role_json,a.origin,a.task_json,a.resource_json FROM run_plan_heads h JOIN run_assignments a ON a.plan_id=h.plan_id WHERE h.run_id=? AND a.role_id=?',
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
        planId: row.plan_id,
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
    insertPlan: (candidate, candidates) =>
      database.mutate(() => {
        const saved = validateRunPlan(candidate);
        const inserted = database.run(
          'run.plan.insert',
          'INSERT INTO run_plans(plan_id,run_id,admission_id,attempt_id,created_at,summary,context_source,title,goal_text,policy_json,resources_json,coordinator_role_json,coordinator_resource_json,workflow_json,planning_policy_json,repair_environment,planner_thread_id,planner_session_id) SELECT ?,run_id,admission_id,attempt_id,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM run_current WHERE run_id=? AND admission_id=? AND attempt_id=?',
          saved.id,
          saved.createdAt,
          saved.summary,
          saved.context.contextSource,
          saved.context.title,
          saved.context.goalText,
          database.json(saved.context.policy),
          database.json(saved.context.resources),
          database.json(saved.context.coordinator.role),
          database.json(saved.context.coordinator.resource),
          database.json(saved.context.workflow),
          database.json(saved.context.planningPolicy),
          Number(saved.context.repairEnvironment),
          saved.readOnlyPlanner?.threadId ?? null,
          saved.readOnlyPlanner?.sessionId ?? null,
          saved.runId,
          saved.admissionId,
          saved.attemptId,
        );
        if (Number(inserted.changes) !== 1) throw invalid();
        for (const [ordinal, material] of saved.context.contextMaterials.entries())
          database.run(
            'run.plan.material.insert',
            'INSERT INTO run_plan_materials(plan_id,ordinal,material_id,material_json) VALUES (?,?,?,?)',
            saved.id,
            ordinal,
            material.id,
            database.json(material),
          );
        for (const [ordinal, check] of saved.context.checkIds.entries())
          database.run(
            'run.plan.check.insert',
            'INSERT INTO run_plan_checks(plan_id,ordinal,check_id) VALUES (?,?,?)',
            saved.id,
            ordinal,
            check,
          );
        for (const [ordinal, step] of saved.steps.entries())
          database.run(
            'run.plan.step.insert',
            'INSERT INTO run_plan_steps(plan_id,ordinal,step,owner) VALUES (?,?,?,?)',
            saved.id,
            ordinal,
            step.step,
            step.owner,
          );
        for (const [ordinal, candidate] of candidates.entries()) {
          const assignment = validateRunWorkerAssignment(candidate);
          if (
            assignment.planId !== saved.id ||
            assignment.runId !== saved.runId ||
            assignment.admissionId !== saved.admissionId ||
            assignment.attemptId !== saved.attemptId
          )
            throw invalid();
          database.run(
            'run.assignment.insert',
            'INSERT INTO run_assignments(assignment_id,plan_id,run_id,admission_id,attempt_id,ordinal,role_id,role_version,role_json,origin,task_json,resource_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            assignment.id,
            saved.id,
            saved.runId,
            saved.admissionId,
            saved.attemptId,
            ordinal,
            assignment.role.id,
            assignment.role.version,
            database.json(assignment.role),
            assignment.origin,
            assignment.task === undefined ? null : database.json(assignment.task),
            database.json(assignment.resource),
          );
          for (const [ordinal, path] of assignment.paths.entries())
            database.run(
              'run.assignment.path.insert',
              'INSERT INTO run_assignment_paths(assignment_id,ordinal,path) VALUES (?,?,?)',
              assignment.id,
              ordinal,
              path,
            );
        }
        database.run(
          'run.plan.head.update',
          'INSERT INTO run_plan_heads(run_id,plan_id) VALUES (?,?)',
          saved.runId,
          saved.id,
        );
      }),
    // Session authority has not moved here. Core rejects readonly handoff without a real session fact.
    sealPlanningSession: () => {
      throw new DomainError(
        'PLANNING_SESSION_UNAVAILABLE',
        'This authority has no persisted planner session.',
      );
    },
  };
  return rows;
}
