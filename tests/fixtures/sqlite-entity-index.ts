import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Run } from '../../protocol/domain.ts';

export type RunReferenceFixture = {
  id: string;
  goalId?: string;
  status?: Run['status'];
  commit?: string;
  deliveryBusy?: boolean;
  previewBusy?: boolean;
};
async function openMarked(directory: string) {
  if (
    !path.basename(path.dirname(directory)).startsWith('buro-entity-ports-') ||
    path.basename(directory) !== 'sqlite' ||
    (await fs.realpath(directory)) !== directory ||
    (await fs.readFile(path.join(directory, '.entity-index-fixture'), 'utf8')) !== 'synthetic-only'
  )
    throw Error('Index/fault SQL is restricted to this suite’s marked temporary database.');
  const file = path.join(directory, 'authority.sqlite');
  if ((await fs.realpath(file)) !== file) throw Error('The test database cannot be an alias.');
  return new DatabaseSync(file);
}

/** Future run/material writers are not implemented; seed only their read-only reference indexes. */
export async function seedEntityIndexes(
  directory: string,
  input: { materialIds?: string[]; runs?: RunReferenceFixture[] },
) {
  const db = await openMarked(directory);
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
    for (const id of input.materialIds || [])
      db.prepare('INSERT OR IGNORE INTO material_refs(material_id) VALUES (?)').run(id);
    const statement =
      db.prepare(`INSERT INTO project_run_index(run_id,goal_id,status,commit_oid,delivery_busy,preview_busy)
      VALUES (?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET goal_id=excluded.goal_id,status=excluded.status,
      commit_oid=excluded.commit_oid,delivery_busy=excluded.delivery_busy,preview_busy=excluded.preview_busy`);
    for (const run of input.runs || [])
      statement.run(
        run.id,
        run.goalId || null,
        run.status || null,
        run.commit || null,
        run.deliveryBusy ? 1 : 0,
        run.previewBusy ? 1 : 0,
      );
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}

/** A physical mid-role-write failure, not a production mutation or accepted-result API. */
export async function failRoleHeadInsert(directory: string, enabled: boolean) {
  const db = await openMarked(directory);
  try {
    db.exec(
      enabled
        ? `CREATE TRIGGER injected_role_head_failure BEFORE INSERT ON role_heads BEGIN SELECT RAISE(FAIL,'injected role head failure'); END;`
        : 'DROP TRIGGER injected_role_head_failure',
    );
  } finally {
    db.close();
  }
}
