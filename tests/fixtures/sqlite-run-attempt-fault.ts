import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';

async function openMarked(directory: string) {
  if (
    !path.basename(directory).startsWith('buro-run-attempt-') ||
    (await fs.realpath(directory)) !== directory ||
    (await fs.readFile(path.join(directory, '.attempt-fault-fixture'), 'utf8')) !== 'synthetic-only'
  )
    throw Error('Attempt SQL requires the marked temporary suite.');
  const file = path.join(directory, 'authority.sqlite');
  if ((await fs.realpath(file)) !== file) throw Error('The fixture database cannot be an alias.');
  return new DatabaseSync(file);
}
export async function failAttemptTimelineInsert(
  directory: string,
  type: 'stop' | 'continue',
  enabled: boolean,
) {
  const db = await openMarked(directory);
  try {
    db.exec(
      enabled
        ? `CREATE TRIGGER injected_attempt_timeline_failure BEFORE INSERT ON run_timeline WHEN NEW.type='${type === 'stop' ? 'run.failed' : 'run.resume-requested'}' BEGIN SELECT RAISE(FAIL,'injected attempt timeline failure'); END;`
        : 'DROP TRIGGER injected_attempt_timeline_failure',
    );
  } finally {
    db.close();
  }
}
/** Only the indexed unknown fact; no fabricated terminal/result row or effect journal. */
export async function markAttemptUnresolved(directory: string, runId: string) {
  const db = await openMarked(directory);
  try {
    if (
      Number(
        db.prepare('UPDATE project_run_index SET unresolved=1 WHERE run_id=?').run(runId).changes,
      ) !== 1
    )
      throw Error('Unknown fact requires a genuine current Run.');
  } finally {
    db.close();
  }
}
