import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContextMaterial } from '../protocol/domain.ts';
import {
  createMaterialTransaction,
  projectMaterialIdentity,
  validateProjectMaterial,
  validateProjectMaterialChange,
  type MaterialTransactionStorage,
  type ProjectMaterialChange,
} from '../core/project-materials.ts';

function material(index = 1, patch: Partial<ContextMaterial> = {}): ContextMaterial {
  const hash = index.toString(16).padStart(64, '0');
  return {
    id: 'M-' + index.toString(16).padStart(8, '0'),
    name: `File ${index}.txt`,
    mimeType: 'text/plain',
    size: 5,
    hash,
    relativePath: `local/context/${hash}.txt`,
    representation: 'text',
    loader: { id: 'text', revision: 'v1' },
    scope: 'project',
    active: true,
    createdAt: 'original-created',
    ...patch,
  };
}
function fixture(initial: ContextMaterial[] = []) {
  const rows = new Map(initial.map((row) => [row.id, structuredClone(row)]));
  const changes: ProjectMaterialChange[] = [];
  let active = true,
    writes = 0;
  const storage: MaterialTransactionStorage = {
    material: (id) => rows.get(id),
    byIdentity: (candidate) =>
      [...rows.values()].find(
        (row) => projectMaterialIdentity(row) === projectMaterialIdentity(candidate),
      ),
    count: () => rows.size,
    activeProjectCount: () =>
      [...rows.values()].filter((row) => row.active && row.scope === 'project').length,
    insert: (row) => {
      assert.equal(rows.has(row.id), false);
      rows.set(row.id, row);
      writes++;
    },
    replace: (previous, next) => {
      assert.deepEqual(rows.get(previous.id), previous);
      rows.set(next.id, next);
      writes++;
    },
    appendChange: (change) => {
      changes.push(change);
    },
  };
  const tx = createMaterialTransaction({
    projectId: 'project',
    storage,
    assertActive() {
      if (!active) throw Error('closed');
    },
  });
  return {
    tx,
    rows,
    changes,
    writes: () => writes,
    close: () => {
      active = false;
    },
  };
}

test('material metadata binds raw and extracted hashes to exact saved blob names', () => {
  const original = material();
  assert.deepEqual(validateProjectMaterial(original, { prepared: true }), original);
  const { loader: _loader, representation: _representation, ...known } = original;
  assert.deepEqual(validateProjectMaterial(known), known);
  assert.throws(() => validateProjectMaterial(known, { prepared: true }), {
    code: 'INVALID_PROJECT_MATERIAL',
  });
  const textHash = 'a'.repeat(64);
  const extracted = { ...original, textHash, textPath: `local/context/${textHash}.txt` };
  assert.deepEqual(validateProjectMaterial(extracted), extracted);
  for (const invalid of [
    { ...original, relativePath: `local/context/${textHash}.txt` },
    { ...original, textHash },
    { ...original, textPath: extracted.textPath },
    { ...extracted, textHash: original.hash },
    { ...original, active: false },
    { ...original, private: 'unexpected' },
  ])
    assert.throws(() => validateProjectMaterial(invalid, { prepared: true }), {
      code: 'INVALID_PROJECT_MATERIAL',
    });
});

test('active duplicate and inactive reactivation return the actual immutable canonical record', () => {
  const canonical = material();
  const f = fixture([canonical]);
  const duplicate = { ...canonical, id: material(2).id, createdAt: 'new-preparation' };
  assert.deepEqual(f.tx.attach([duplicate]), [canonical]);
  assert.equal(f.writes(), 0);
  assert.equal(f.changes.length, 0);
  f.tx.remove(canonical.id);
  assert.equal(f.rows.get(canonical.id)?.active, false);
  const restored = f.tx.attach([duplicate, { ...duplicate, id: material(3).id }]);
  assert.deepEqual(restored, [canonical, canonical]);
  assert.equal(f.rows.size, 1);
  assert.equal(f.changes.length, 2);
  assert.deepEqual(f.changes[1], { type: 'context.materials.added', materials: [canonical] });
  restored[0].loader!.revision = 'caller-mutated';
  assert.equal(f.tx.material(canonical.id)?.loader?.revision, 'v1');
  f.tx.remove(canonical.id);
  const before = f.changes.length;
  f.tx.remove(canonical.id);
  assert.equal(f.changes.length, before);
});

test('whole-batch preflight rejects extraction conflicts and reused IDs before any write', () => {
  const textHash = 'a'.repeat(64),
    otherTextHash = 'b'.repeat(64);
  const canonical = material(1, { textHash, textPath: `local/context/${textHash}.txt` });
  const f = fixture([canonical]);
  const changedExtraction = {
    ...canonical,
    id: material(5).id,
    textHash: otherTextHash,
    textPath: `local/context/${otherTextHash}.txt`,
  };
  assert.throws(() => f.tx.attach([material(2), changedExtraction]), { code: 'CONTEXT_CONFLICT' });
  assert.equal(f.writes(), 0);
  assert.equal(f.changes.length, 0);
  assert.throws(() => f.tx.attach([material(2), material(3, { id: material(2).id })]), {
    code: 'CONTEXT_CONFLICT',
  });
  assert.throws(() => f.tx.attach([material(2, { id: canonical.id })]), {
    code: 'CONTEXT_CONFLICT',
  });
  assert.equal(f.rows.size, 1);
  assert.equal(f.writes(), 0);
});

test('batch deduplication consumes one slot and loader revisions retain separate immutable identities', () => {
  const f = fixture();
  const one = material();
  const duplicate = { ...one, id: material(2).id, createdAt: 'later' };
  const actual = f.tx.attach([one, duplicate]);
  assert.deepEqual(actual, [one, one]);
  assert.equal(f.rows.size, 1);
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.changes, [{ type: 'context.materials.added', materials: [one] }]);
  const nextLoader = { ...duplicate, loader: { id: 'text', revision: 'v2' } };
  assert.notEqual(projectMaterialIdentity(one), projectMaterialIdentity(nextLoader));
  assert.deepEqual(f.tx.attach([nextLoader]), [nextLoader]);
  assert.equal(f.rows.size, 2);
});

test('material collections pass the former lifetime limits while identity and reactivation remain exact', () => {
  const active = Array.from({ length: 63 }, (_, i) => material(i + 1));
  const f = fixture(active);
  f.tx.attach([material(64), material(65)]);
  assert.equal(f.rows.size, 65);
  assert.equal(f.writes(), 2);
  f.tx.attach([material(64), material(64, { id: material(66).id })]);
  assert.equal(f.rows.size, 65);
  const canonical = active[0];
  f.tx.remove(canonical.id);
  assert.equal(f.tx.attach([{ ...canonical, id: material(67).id }])[0].id, canonical.id);
  const full = fixture(
    Array.from({ length: 1000 }, (_, i) => material(i + 1, { scope: 'goal', active: false })),
  );
  full.tx.attach([material(1001, { scope: 'goal' })]);
  assert.equal(full.rows.size, 1001);
  assert.equal(full.tx.attach([material(1, { scope: 'goal' })])[0].id, material(1).id);
  assert.equal(full.rows.size, 1001);
});

test('public material changes reject private extras and expired transaction capabilities cannot access rows', () => {
  const f = fixture();
  f.tx.attach([material()]);
  assert.deepEqual(validateProjectMaterialChange(f.changes[0]), f.changes[0]);
  assert.throws(() => validateProjectMaterialChange({ ...f.changes[0], private: 'unexpected' }), {
    code: 'INVALID_PROJECT_MATERIAL',
  });
  f.close();
  for (const call of [
    () => f.tx.attach([material(2)]),
    () => f.tx.remove(material().id),
    () => f.tx.material(material().id),
  ])
    assert.throws(call, /closed/);
});
