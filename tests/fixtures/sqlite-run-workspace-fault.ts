import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Fail a late workspace event append only in this explicitly marked temporary authority. */
async function openMarked(directory: string) {
  if (
    !path.basename(directory).startsWith('buro-run-workspace-') ||
    (await fs.realpath(directory)) !== directory ||
    (await fs.readFile(path.join(directory, '.workspace-fault-fixture'), 'utf8')) !==
      'synthetic-only'
  )
    throw Error('Workspace fault injection requires the marked temporary suite.');
  const file = path.join(directory, 'authority.sqlite');
  if ((await fs.realpath(file)) !== file) throw Error('The synthetic database cannot be an alias.');
  return new DatabaseSync(file);
}

export async function failWorkspaceTimelineInsert(directory: string, enabled: boolean) {
  const db = await openMarked(directory);
  try {
    db.exec(
      enabled
        ? `CREATE TRIGGER injected_workspace_timeline_failure BEFORE INSERT ON run_timeline
      WHEN NEW.type='workspace.prepared'
      BEGIN SELECT RAISE(FAIL,'injected workspace timeline failure'); END;`
        : 'DROP TRIGGER injected_workspace_timeline_failure',
    );
  } finally {
    db.close();
  }
}

export async function removeWorkspaceTable(directory: string) {
  const db = await openMarked(directory);
  try {
    db.exec('DROP TABLE run_workspaces');
  } finally {
    db.close();
  }
}

export async function workspaceTableExists(directory: string) {
  const db = await openMarked(directory);
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_workspaces'")
        .get() !== undefined
    );
  } finally {
    db.close();
  }
}
