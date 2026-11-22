import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';

/** A late write fault, restricted to an explicitly marked synthetic lifecycle authority. */
export async function failLifecycleTimelineInsert(directory: string, enabled: boolean) {
  if (
    !path.basename(directory).startsWith('buro-run-state-') ||
    (await fs.realpath(directory)) !== directory ||
    (await fs.readFile(path.join(directory, '.lifecycle-fault-fixture'), 'utf8')) !==
      'synthetic-only'
  )
    throw Error('Lifecycle fault injection requires the marked temporary suite.');
  const file = path.join(directory, 'authority.sqlite');
  if ((await fs.realpath(file)) !== file) throw Error('The synthetic database cannot be an alias.');
  const db = new DatabaseSync(file);
  try {
    db.exec(
      enabled
        ? `CREATE TRIGGER injected_lifecycle_timeline_failure BEFORE INSERT ON run_timeline
        WHEN NEW.type LIKE 'phase.%'
        BEGIN SELECT RAISE(FAIL,'injected lifecycle timeline failure'); END;`
        : 'DROP TRIGGER injected_lifecycle_timeline_failure',
    );
  } finally {
    db.close();
  }
}
