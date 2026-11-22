import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';

async function openMarked(directory: string) {
  if (
    !path.basename(path.dirname(directory)).startsWith('buro-material-ports-') ||
    path.basename(directory) !== 'sqlite' ||
    (await fs.realpath(directory)) !== directory ||
    (await fs.readFile(path.join(directory, '.material-fault-fixture'), 'utf8')) !==
      'synthetic-only'
  )
    throw Error('The material fault requires this suite’s marked temporary database.');
  const file = path.join(directory, 'authority.sqlite');
  if ((await fs.realpath(file)) !== file) throw Error('The temporary database cannot be an alias.');
  return new DatabaseSync(file);
}

/** Physical storage fault restricted to this suite's explicitly marked temporary authority. */
export async function failMaterialReferenceInsert(directory: string, enabled: boolean) {
  const db = await openMarked(directory);
  try {
    db.exec(
      enabled
        ? `CREATE TRIGGER injected_material_ref_failure BEFORE INSERT ON material_refs
      BEGIN SELECT RAISE(FAIL,'injected material reference failure'); END;`
        : 'DROP TRIGGER injected_material_ref_failure',
    );
  } finally {
    db.close();
  }
}

export async function removeMaterialCounterRow(directory: string) {
  const db = await openMarked(directory);
  try {
    db.prepare('DELETE FROM material_counts WHERE singleton=1').run();
  } finally {
    db.close();
  }
}

export async function materialCounterRowExists(directory: string) {
  const db = await openMarked(directory);
  try {
    return (
      db.prepare('SELECT singleton FROM material_counts WHERE singleton=1').get() !== undefined
    );
  } finally {
    db.close();
  }
}
