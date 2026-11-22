import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { usageOwnerKey, type ProjectUsageOwner } from '../../core/usage-authority.ts';

/** Test-only corruption of one explicitly marked temporary database; no raw SQL production port. */
export async function saturateUsageRevision(directory: string, owner: ProjectUsageOwner) {
  if (
    !path.basename(directory).startsWith('buro-sqlite-atomicity-') ||
    (await fs.realpath(directory)) !== directory ||
    (await fs.readFile(path.join(directory, '.usage-fault-fixture'), 'utf8')) !== 'synthetic-only'
  )
    throw Error('Fault injection requires this test suite’s marked temporary directory.');
  const db = new DatabaseSync(path.join(directory, 'authority.sqlite'));
  try {
    const row = db
      .prepare('SELECT account_id, account_json FROM usage_accounts WHERE owner_key = ?')
      .get(usageOwnerKey(owner));
    if (!row) throw Error('The synthetic account is missing.');
    const account = JSON.parse(String(row.account_json));
    account.revision = Number.MAX_SAFE_INTEGER;
    const changed = db
      .prepare('UPDATE usage_accounts SET account_json = ? WHERE account_id = ?')
      .run(JSON.stringify(account), row.account_id);
    if (changed.changes !== 1)
      throw Error('The revision fault did not affect exactly one synthetic account.');
  } finally {
    db.close();
  }
}
