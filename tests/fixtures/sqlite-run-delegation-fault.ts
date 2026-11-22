import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';

async function openMarked(directory: string) {
  if (
    !path.basename(directory).startsWith('buro-run-delegation-') ||
    (await fs.realpath(directory)) !== directory ||
    (await fs.readFile(path.join(directory, '.delegation-fault-fixture'), 'utf8')) !==
      'synthetic-only'
  )
    throw Error('Delegation SQL requires the marked temporary contract suite.');
  const file = path.join(directory, 'authority.sqlite');
  if ((await fs.realpath(file)) !== file) throw Error('The fixture database cannot be an alias.');
  return new DatabaseSync(file);
}
export async function failDelegationTimelineInsert(directory: string, enabled: boolean) {
  const db = await openMarked(directory);
  try {
    db.exec(
      enabled
        ? `CREATE TRIGGER injected_delegation_failure BEFORE INSERT ON run_timeline
      WHEN NEW.type='worker.delegated' BEGIN SELECT RAISE(FAIL,'injected delegation timeline failure'); END;`
        : 'DROP TRIGGER injected_delegation_failure',
    );
  } finally {
    db.close();
  }
}
/** Corruption probe against an actual invalidated reference, never a production writer. */
export async function forgeInheritedTaskMode(directory: string, attemptId: string, roleId: string) {
  const db = await openMarked(directory);
  try {
    const row = db
      .prepare('SELECT inherited_assignment_refs_json FROM run_attempt_contexts WHERE attempt_id=?')
      .get(attemptId);
    if (!row) throw Error('The probe requires a genuine continued attempt.');
    const references = JSON.parse(String(row.inherited_assignment_refs_json));
    if (references[roleId]?.taskMode !== 'full-goal')
      throw Error('The probe requires an invalidated task reference.');
    references[roleId].taskMode = 'original';
    db.exec('DROP TRIGGER immutable_run_attempt_contexts_update');
    try {
      db.prepare(
        'UPDATE run_attempt_contexts SET inherited_assignment_refs_json=? WHERE attempt_id=?',
      ).run(JSON.stringify(references), attemptId);
    } finally {
      db.exec(
        "CREATE TRIGGER immutable_run_attempt_contexts_update BEFORE UPDATE ON run_attempt_contexts BEGIN SELECT RAISE(ABORT,'Run attempt records are immutable'); END;",
      );
    }
  } finally {
    db.close();
  }
}
/** An indexed unresolved fact only: this does not pretend to be the future SQL effect journal. */
export async function setUnresolvedDelegationFact(directory: string, runId: string) {
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

/** Noncurrent immutable grants only; no active pointer, acceptance, effect or event writer. */
export async function seedNoncurrentAssignmentRows(
  directory: string,
  assignmentId: string,
  count: number,
) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 2048)
    throw Error('Bounded fixture count required.');
  const db = await openMarked(directory);
  try {
    if (
      !db
        .prepare('SELECT assignment_id FROM run_assignments WHERE assignment_id=?')
        .get(assignmentId)
    )
      throw Error('Genuine grant required.');
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
    const insert = db.prepare(
      `INSERT INTO run_assignments SELECT ?,run_id,admission_id,attempt_id,ordinal,role_id,role_version,role_json,origin,task_json,resource_json FROM run_assignments WHERE assignment_id=?`,
    );
    const paths = db.prepare(
      'INSERT INTO run_assignment_paths SELECT ?,ordinal,path FROM run_assignment_paths WHERE assignment_id=?',
    );
    for (let i = 0; i < count; i++) {
      const id = 'inert-grant-' + i;
      insert.run(id, assignmentId);
      paths.run(id, assignmentId);
    }
    db.exec('COMMIT');
    const details = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT a.assignment_id FROM run_assignment_heads h JOIN run_assignments a ON a.assignment_id=h.assignment_id WHERE h.run_id=? AND h.role_id=?',
      )
      .all('unused', 'builder')
      .map((row) => String(row.detail));
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
