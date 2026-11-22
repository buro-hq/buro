import type { SQLInputValue } from 'node:sqlite';
import { DomainError } from '../../core/ports.ts';
import {
  projectMaterialIdentity,
  validateProjectMaterial,
  type MaterialTransactionStorage,
  type ProjectMaterialChange,
} from '../../core/project-materials.ts';

export const projectMaterialSchema = `
  CREATE TABLE IF NOT EXISTS project_materials (
    material_id TEXT PRIMARY KEY NOT NULL,
    identity_key TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL CHECK(scope IN ('project','goal')),
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    material_json TEXT NOT NULL CHECK(json_valid(material_json))
  );
  CREATE TABLE IF NOT EXISTS material_counts (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    total_count INTEGER NOT NULL CHECK(total_count>=0),
    active_project_count INTEGER NOT NULL CHECK(active_project_count>=0 AND active_project_count<=total_count)
  );
`;
type Row = Record<string, unknown>;
type MaterialDatabase = {
  get(label: string, sql: string, ...values: SQLInputValue[]): Row | undefined;
  run(label: string, sql: string, ...values: SQLInputValue[]): { changes: number | bigint };
  json(value: unknown): string;
  mutate<T>(action: () => T): T;
  appendChange(change: ProjectMaterialChange): void;
};
const invalid = () =>
  new DomainError('INVALID_PROJECT_MATERIAL', 'The saved material or its index is invalid.');
const conflict = () =>
  new DomainError('CONTEXT_CONFLICT', 'The saved material changed. Refresh before trying again.');

/** Metadata and existence/count indexes are written only inside the same authority transaction. */
export function createSqliteMaterialRows(database: MaterialDatabase): MaterialTransactionStorage {
  const read = (row: Row | undefined) => {
    if (!row) return undefined;
    const material = validateProjectMaterial(JSON.parse(String(row.material_json)));
    if (
      material.id !== row.material_id ||
      projectMaterialIdentity(material) !== row.identity_key ||
      material.scope !== row.scope ||
      Number(material.active) !== row.active
    )
      throw invalid();
    return material;
  };
  const counts = () => {
    const row = database.get(
      'material.counts',
      'SELECT total_count,active_project_count FROM material_counts WHERE singleton=1',
    );
    if (
      !row ||
      !Number.isSafeInteger(row.total_count) ||
      Number(row.total_count) < 0 ||
      !Number.isSafeInteger(row.active_project_count) ||
      Number(row.active_project_count) < 0 ||
      Number(row.active_project_count) > Number(row.total_count)
    )
      throw invalid();
    return { total: Number(row.total_count), activeProject: Number(row.active_project_count) };
  };
  const changeCounts = (totalDelta: number, activeDelta: number) => {
    const before = counts();
    const total = before.total + totalDelta;
    const active = before.activeProject + activeDelta;
    if (
      !Number.isSafeInteger(total) ||
      total < 0 ||
      !Number.isSafeInteger(active) ||
      active < 0 ||
      active > total
    )
      throw invalid();
    const result = database.run(
      'material.counts.update',
      'UPDATE material_counts SET total_count=?,active_project_count=? WHERE singleton=1 AND total_count=? AND active_project_count=?',
      total,
      active,
      before.total,
      before.activeProject,
    );
    if (Number(result.changes) !== 1) throw conflict();
  };
  return {
    material: (id) =>
      read(
        database.get(
          'material.read',
          'SELECT material_id,identity_key,scope,active,material_json FROM project_materials WHERE material_id=?',
          id,
        ),
      ),
    byIdentity: (candidate) =>
      read(
        database.get(
          'material.identity',
          'SELECT material_id,identity_key,scope,active,material_json FROM project_materials WHERE identity_key=?',
          projectMaterialIdentity(candidate),
        ),
      ),
    count: () => counts().total,
    activeProjectCount: () => counts().activeProject,
    insert: (candidate) =>
      database.mutate(() => {
        const material = validateProjectMaterial(candidate);
        database.run(
          'material.insert',
          'INSERT INTO project_materials(material_id,identity_key,scope,active,material_json) VALUES (?,?,?,?,?)',
          material.id,
          projectMaterialIdentity(material),
          material.scope,
          Number(material.active),
          database.json(material),
        );
        database.run(
          'material.reference.insert',
          'INSERT INTO material_refs(material_id) VALUES (?)',
          material.id,
        );
        changeCounts(1, material.active && material.scope === 'project' ? 1 : 0);
      }),
    replace: (previous, candidate) =>
      database.mutate(() => {
        const before = validateProjectMaterial(previous);
        const after = validateProjectMaterial(candidate);
        if (
          before.id !== after.id ||
          projectMaterialIdentity(before) !== projectMaterialIdentity(after)
        )
          throw conflict();
        const result = database.run(
          'material.update',
          'UPDATE project_materials SET active=?,material_json=? WHERE material_id=? AND identity_key=? AND scope=? AND active=? AND material_json=?',
          Number(after.active),
          database.json(after),
          before.id,
          projectMaterialIdentity(before),
          before.scope,
          Number(before.active),
          database.json(before),
        );
        if (Number(result.changes) !== 1) throw conflict();
        const delta =
          Number(after.active && after.scope === 'project') -
          Number(before.active && before.scope === 'project');
        if (delta) changeCounts(0, delta);
      }),
    appendChange: (change) => database.mutate(() => database.appendChange(change)),
  };
}
