import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';

async function openMarked(directory: string) {
  if (
    !path.basename(directory).startsWith('buro-run-plan-') ||
    (await fs.realpath(directory)) !== directory ||
    (await fs.readFile(path.join(directory, '.plan-fault-fixture'), 'utf8')) !== 'synthetic-only'
  )
    throw Error('Plan SQL requires the marked temporary contract suite.');
  const file = path.join(directory, 'authority.sqlite');
  if ((await fs.realpath(file)) !== file) throw Error('The fixture database cannot be an alias.');
  return new DatabaseSync(file);
}
export async function failPlanTimelineInsert(directory: string, enabled: boolean) {
  const db = await openMarked(directory);
  try {
    db.exec(
      enabled
        ? `CREATE TRIGGER injected_plan_timeline_failure BEFORE INSERT ON run_timeline
    WHEN NEW.type='plan.saved' BEGIN SELECT RAISE(FAIL,'injected plan timeline failure'); END;`
        : 'DROP TRIGGER injected_plan_timeline_failure',
    );
  } finally {
    db.close();
  }
}
/** An indexed unresolved fact only: this does not pretend to be the future SQL effect journal. */
export async function setUnresolvedPlanFact(directory: string, runId: string) {
  const db = await openMarked(directory);
  try {
    if (
      Number(
        db.prepare('UPDATE project_run_index SET unresolved=1 WHERE run_id=?').run(runId).changes,
      ) !== 1
    )
      throw Error('The fact requires a genuine existing queued Run.');
  } finally {
    db.close();
  }
}

/** Noncurrent immutable-row fixtures only; no active pointer, acceptance, effect or event writer. */
export async function seedNoncurrentPlanRows(directory: string, planId: string, count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 2048)
    throw Error('Bounded fixture count required.');
  const db = await openMarked(directory);
  try {
    if (!db.prepare('SELECT plan_id FROM run_plans WHERE plan_id=?').get(planId))
      throw Error('Historical fixtures require a genuine accepted plan first.');
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
    const plan = db.prepare(`INSERT INTO run_plans
      SELECT ?,run_id,admission_id,attempt_id,created_at,summary,context_source,title,goal_text,policy_json,resources_json,coordinator_role_json,coordinator_resource_json,workflow_json,planning_policy_json,repair_environment,planner_thread_id,planner_session_id
      FROM run_plans WHERE plan_id=?`);
    const copies = [
      db.prepare(
        'INSERT INTO run_plan_steps SELECT ?,ordinal,step,owner FROM run_plan_steps WHERE plan_id=?',
      ),
      db.prepare(
        'INSERT INTO run_plan_materials SELECT ?,ordinal,material_id,material_json FROM run_plan_materials WHERE plan_id=?',
      ),
      db.prepare(
        'INSERT INTO run_plan_checks SELECT ?,ordinal,check_id FROM run_plan_checks WHERE plan_id=?',
      ),
    ];
    const assignment = db.prepare(`INSERT INTO run_assignments
      SELECT ? || ':' || role_id,?,run_id,admission_id,attempt_id,role_id,role_version,role_json,origin,task_json,resource_json
      FROM run_assignments WHERE plan_id=?`);
    const paths = db.prepare(`INSERT INTO run_assignment_paths
      SELECT ? || ':' || a.role_id,p.ordinal,p.path FROM run_assignment_paths p JOIN run_assignments a ON a.assignment_id=p.assignment_id WHERE a.plan_id=?`);
    for (let index = 0; index < count; index++) {
      const id = 'inert-history-' + index;
      plan.run(id, planId);
      for (const statement of copies) statement.run(id, planId);
      assignment.run(id, id, planId);
      paths.run(id, planId);
    }
    db.exec('COMMIT');
    const details = [
      ...db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT p.plan_id FROM run_plan_heads h JOIN run_plans p ON p.plan_id=h.plan_id WHERE h.run_id=?',
        )
        .all('unused'),
      ...db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT a.assignment_id FROM run_plan_heads h JOIN run_assignments a ON a.plan_id=h.plan_id WHERE h.run_id=? AND a.role_id=?',
        )
        .all('unused', 'builder'),
    ].map((row) => String(row.detail));
    return { count, details };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}
