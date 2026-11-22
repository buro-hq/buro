import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { ContextMaterials } from '../adapters/files/context-materials.ts';
import { ContextLoaderCatalog } from '../core/context-loaders.ts';
import { GoalService } from '../core/services.ts';
import type { ProjectRegistry, ProjectStore } from '../core/ports.ts';
import type { ContextMaterial } from '../protocol/context.ts';
import type { ProjectMaterials, ProjectMaterialChange } from '../core/project-materials.ts';
import {
  failMaterialReferenceInsert,
  removeMaterialCounterRow,
  materialCounterRowExists,
} from './fixtures/sqlite-material-fault.ts';

const command = (id: string) => ({ id, fingerprint: 'fp:' + id });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const prepared = (index: number, scope: 'project' | 'goal' = 'project'): ContextMaterial => {
  const bytes = 'Material ' + index,
    hash = digest(bytes);
  return {
    id: 'M-' + index.toString(16).padStart(6, '0'),
    name: 'material-' + index + '.txt',
    mimeType: 'text/plain',
    size: Buffer.byteLength(bytes),
    hash,
    relativePath: 'local/context/' + hash + '.txt',
    scope,
    active: true,
    representation: 'text',
    loader: { id: 'text', revision: 'text-v1' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function reached(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error('The actual importer did not reach its loader barrier.')),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function loaders(load: (bytes: Uint8Array) => Promise<string>) {
  const catalog = new ContextLoaderCatalog();
  catalog.register({
    id: 'controlled-text',
    revision: 'controlled-text-v1',
    matches: () => true,
    async load({ bytes }) {
      return { mimeType: 'text/plain', representation: 'text', text: await load(bytes) };
    },
  });
  return catalog.seal();
}
async function fixture(t: any, kind: 'file' | 'sqlite') {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-material-ports-')));
  const root = path.join(base, 'repository'),
    directory = path.join(base, kind);
  await fs.mkdir(root);
  await fs.mkdir(directory);
  if (kind === 'sqlite')
    await fs.writeFile(path.join(directory, '.material-fault-fixture'), 'synthetic-only');
  const project = { id: 'project', name: 'Materials fixture', root };
  let file: FileProjectStore | undefined, sql: SqliteProjectUsageAuthority | undefined;
  const importers: ContextMaterials[] = [];
  const open = async () => {
    if (kind === 'file') file = await FileProjectStore.open({ directory, project });
    else sql = await SqliteProjectUsageAuthority.open({ directory, projectId: project.id });
  };
  const close = () => (kind === 'file' ? file!.close() : sql!.close());
  const materials = (): ProjectMaterials => (kind === 'file' ? file!.materials : sql!.materials);
  const entities = () => (kind === 'file' ? file!.entities : sql!.entities);
  await open();
  t.after(async () => {
    await Promise.all(importers.map((importer) => importer.dispose()));
    await close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const projects: ProjectRegistry = {
    get(id) {
      assert.equal(id, project.id);
      return {
        get materials() {
          return materials();
        },
        get entities() {
          return entities();
        },
        snapshot() {
          throw Error('ContextMaterials must not load a project snapshot.');
        },
        transact() {
          throw Error('ContextMaterials must use the material transaction facet.');
        },
        receipt() {
          throw Error('Material receipts belong to the narrow facet.');
        },
        subscribe() {
          throw Error('The importer does not need legacy subscriptions.');
        },
        close,
      } as ProjectStore;
    },
    list: () => [structuredClone(project)],
  };
  let goals = 0;
  const goalService = new GoalService({
    projects,
    id: () => String(++goals),
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return {
    kind,
    base,
    root,
    directory,
    materials,
    entities,
    goalService,
    get sql() {
      return sql;
    },
    get file() {
      return file;
    },
    importer(catalog?: ContextLoaderCatalog) {
      const importer = new ContextMaterials(projects, catalog);
      importers.push(importer);
      return importer;
    },
    async events(): Promise<ProjectMaterialChange[]> {
      if (file) {
        const events: ProjectMaterialChange[] = [];
        const stop = file.subscribe(0, (event) => {
          if (
            event.change.type === 'context.materials.added' ||
            event.change.type === 'context.material.removed'
          )
            events.push(event.change);
        });
        stop();
        return events;
      }
      const page = await sql!.pagedEvents({ after: 0, limit: 1000 });
      const events: ProjectMaterialChange[] = [];
      for (const event of page.events) {
        if (event.type === 'context.materials.added')
          events.push({ type: event.type, materials: event.materials });
        else if (event.type === 'context.material.removed')
          events.push({ type: event.type, id: event.id });
      }
      return events;
    },
    async reopen() {
      await close();
      await open();
    },
  };
}

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: material batches return committed identities, preserve goal references and reactivate the canonical record`, async (t) => {
    const f = await fixture(t, kind);
    const original = prepared(1),
      duplicate = { ...original, id: prepared(2).id, createdAt: '2026-02-01T00:00:00.000Z' };
    const first = await f
      .materials()
      .transaction(command('attach'), (tx) => tx.attach([original, duplicate, original]));
    assert.deepEqual(first, [original, original, original]);
    assert.equal(await f.materials().material(duplicate.id), undefined);
    assert.deepEqual(await f.events(), [
      { type: 'context.materials.added', materials: [original] },
    ]);
    assert.deepEqual(await f.materials().receipt(command('attach')), { result: first });
    await assert.rejects(f.materials().receipt({ id: 'attach', fingerprint: 'changed' }));
    const goal = await f.goalService.create('goal', 'goal', {
      projectId: 'project',
      title: 'Use the attached document',
      body: 'Keep its saved reference.',
      criteria: '',
      materialIds: [original.id],
    });
    await f.materials().transaction(command('remove'), (tx) => tx.remove(original.id));
    const inactive = await f.materials().material(original.id);
    assert.equal(inactive!.active, false);
    assert.deepEqual((await f.entities().goal(goal.id))!.materialIds, [original.id]);
    await f.goalService.update('edit-goal', 'edit-goal', {
      projectId: 'project',
      id: goal.id,
      expectedRevision: 1,
      title: goal.title,
      body: 'Inactive explicit references remain valid.',
      criteria: '',
      materialIds: [original.id],
    });
    const eventsBefore = await f.events();
    assert.deepEqual(
      await f.materials().transaction(command('attach'), () => {
        throw Error('The original receipt must replay.');
      }),
      first,
    );
    assert.equal(
      (await f.materials().material(original.id))!.active,
      false,
      'Receipt replay is historical, not a new reactivation.',
    );
    const activated = await f
      .materials()
      .transaction(command('reactivate'), (tx) => tx.attach([duplicate]));
    assert.deepEqual(activated, [original]);
    assert.equal(activated[0].createdAt, original.createdAt);
    assert.deepEqual((await f.events()).slice(eventsBefore.length), [
      { type: 'context.materials.added', materials: [original] },
    ]);
    activated[0].loader!.revision = 'Caller mutation';
    assert.deepEqual(await f.materials().material(original.id), original);
    await f.reopen();
    assert.deepEqual(await f.materials().material(original.id), original);
    assert.equal(await f.materials().material(duplicate.id), undefined);
    const beforeDuplicate = await f.events();
    await f.materials().transaction(command('same-active'), (tx) => tx.attach([duplicate]));
    assert.deepEqual(await f.events(), beforeDuplicate);
    await f.materials().transaction(command('remove-again'), (tx) => tx.remove(original.id));
    const beforeInactive = await f.events();
    await f.materials().transaction(command('already-inactive'), (tx) => tx.remove(original.id));
    assert.deepEqual(await f.events(), beforeInactive);
  });

  test(`${kind}: material conflicts and callback rollback leave no new canonical row, reference or event`, async (t) => {
    const f = await fixture(t, kind);
    const original = prepared(1),
      fresh = prepared(3);
    await f.materials().transaction(command('original'), (tx) => tx.attach([original]));
    const before = await f.events();
    const conflict = { ...original, id: prepared(2).id, mimeType: 'application/json' };
    await assert.rejects(
      f.materials().transaction(command('conflict'), (tx) => tx.attach([fresh, conflict])),
      { code: 'CONTEXT_CONFLICT' },
    );
    assert.equal(await f.materials().material(fresh.id), undefined);
    assert.equal(
      await f.entities().transaction(command('no-ref'), (tx) => tx.materialExists(fresh.id)),
      false,
    );
    assert.deepEqual(await f.events(), before);
    await assert.rejects(
      f.materials().transaction(command('rollback'), (tx) => {
        tx.attach([fresh]);
        throw Error('Abort metadata.');
      }),
      /Abort metadata/,
    );
    assert.equal(await f.materials().material(fresh.id), undefined);
    assert.deepEqual(await f.events(), before);
    assert.deepEqual(
      await f.materials().transaction(command('rollback'), (tx) => tx.attach([fresh])),
      [fresh],
    );
    await assert.rejects(
      f
        .materials()
        .transaction(command('id-reuse'), (tx) => tx.attach([{ ...prepared(5), id: original.id }])),
      { code: 'CONTEXT_CONFLICT' },
    );
    assert.deepEqual(await f.materials().material(original.id), original);
  });

  test(`${kind}: existing project-library bounds count canonical activations rather than duplicate inputs`, async (t) => {
    const f = await fixture(t, kind);
    const first = Array.from({ length: 63 }, (_value, index) => prepared(index + 1));
    await f.materials().transaction(command('63'), (tx) => tx.attach(first));
    const duplicate = { ...first[0], id: prepared(99).id };
    await f.materials().transaction(command('64'), (tx) => tx.attach([duplicate, prepared(64)]));
    await assert.rejects(
      f
        .materials()
        .transaction(command('too-many'), (tx) => tx.attach([prepared(65), prepared(66)])),
      { code: 'CONTEXT_LIMIT' },
    );
    assert.equal(await f.materials().material(prepared(65).id), undefined);
    await f.materials().transaction(command('free-slot'), (tx) => tx.remove(first[0].id));
    const canonical = await f
      .materials()
      .transaction(command('reuse-slot'), (tx) => tx.attach([duplicate, duplicate]));
    assert.deepEqual(canonical, [first[0], first[0]]);
    assert.equal(await f.materials().material(duplicate.id), undefined);
  });

  test(`${kind}: two actual importer instances converge on one canonical row on a fresh filesystem`, async (t) => {
    const f = await fixture(t, kind);
    const ready = deferred(),
      release = deferred();
    let arrived = 0;
    const catalog = loaders(async (bytes) => {
      if (++arrived === 2) ready.resolve();
      await release.promise;
      return new TextDecoder().decode(bytes);
    });
    const a = f.importer(catalog),
      b = f.importer(catalog);
    const input = {
      projectId: 'project',
      scope: 'project' as const,
      upload: {
        name: 'shared.txt',
        base64: Buffer.from('Shared immutable bytes').toString('base64'),
      },
    };
    const jobs = [
      a.import('first-instance', 'first-instance', input),
      b.import('second-instance', 'second-instance', input),
    ];
    for (const job of jobs) void job.catch(() => {});
    try {
      await reached(ready.promise);
      release.resolve();
      const [left, right] = await Promise.all(jobs);
      assert.deepEqual(left, right);
      assert.deepEqual(await f.materials().material(left[0].id), left[0]);
      assert.equal(left[0].active, true);
      assert.deepEqual(await f.events(), [{ type: 'context.materials.added', materials: left }]);
      assert.equal(
        await fs.readFile(path.join(f.root, '.buro', left[0].relativePath), 'utf8'),
        'Shared immutable bytes',
      );
    } finally {
      release.resolve();
      await Promise.allSettled(jobs);
    }
  });

  test(`${kind}: a held real import reactivates a concurrently removed canonical material and returns committed active metadata`, async (t) => {
    const f = await fixture(t, kind);
    const ready = deferred(),
      release = deferred();
    let held = false;
    const catalog = loaders(async (bytes) => {
      if (held) {
        ready.resolve();
        await release.promise;
      }
      return new TextDecoder().decode(bytes);
    });
    const a = f.importer(catalog),
      b = f.importer(catalog);
    const input = {
      projectId: 'project',
      scope: 'project' as const,
      upload: { name: 'document.txt', base64: Buffer.from('User document').toString('base64') },
    };
    const [original] = await a.import('initial', 'initial', input);
    held = true;
    const pending = b.import('held', 'held', input);
    void pending.catch(() => {});
    try {
      await reached(ready.promise);
      await a.remove('remove', 'remove', { projectId: 'project', materialId: original.id });
      assert.equal((await f.materials().material(original.id))!.active, false);
      release.resolve();
      const returned = await pending;
      assert.deepEqual(returned, [original]);
      assert.deepEqual(await f.materials().material(original.id), original);
      assert.deepEqual(await f.events(), [
        { type: 'context.materials.added', materials: [original] },
        { type: 'context.material.removed', id: original.id },
        { type: 'context.materials.added', materials: [original] },
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  test(`${kind}: concurrent identical command receipts return the winning copied bytes even when the source changes during preparation`, async (t) => {
    const f = await fixture(t, kind);
    const oldReady = deferred(),
      newReady = deferred(),
      oldRelease = deferred(),
      newRelease = deferred();
    const catalog = loaders(async (bytes) => {
      const text = new TextDecoder().decode(bytes);
      if (text === 'Old source') {
        oldReady.resolve();
        await oldRelease.promise;
      } else {
        assert.equal(text, 'New source');
        newReady.resolve();
        await newRelease.promise;
      }
      return text;
    });
    const a = f.importer(catalog),
      b = f.importer(catalog),
      source = path.join(f.base, 'source.txt');
    await fs.writeFile(source, 'Old source');
    const input = { projectId: 'project', scope: 'goal' as const, paths: [source] };
    const first = a.import('same-command', 'same-fingerprint', input);
    void first.catch(() => {});
    const jobs = [first];
    try {
      await reached(oldReady.promise);
      await fs.writeFile(source, 'New source');
      const second = b.import('same-command', 'same-fingerprint', input);
      jobs.push(second);
      void second.catch(() => {});
      await reached(newReady.promise);
      newRelease.resolve();
      const winner = await second;
      oldRelease.resolve();
      assert.deepEqual(await first, winner);
      assert.equal(winner[0].hash, digest('New source'));
      assert.deepEqual(await f.events(), [{ type: 'context.materials.added', materials: winner }]);
      assert.equal(
        await fs.readFile(path.join(f.root, '.buro', winner[0].relativePath), 'utf8'),
        'New source',
      );
      assert.equal(
        await fs.readFile(
          path.join(f.root, '.buro/local/context', digest('Old source') + '.txt'),
          'utf8',
        ),
        'Old source',
      );
      await f.reopen();
      await fs.rm(source);
      assert.deepEqual(
        await a.import('same-command', 'same-fingerprint', input),
        winner,
        'A committed retry must not reread a deleted source.',
      );
      assert.deepEqual(
        await f.materials().receipt({ id: 'same-command', fingerprint: 'same-fingerprint' }),
        { result: winner },
      );
    } finally {
      oldRelease.resolve();
      newRelease.resolve();
      await Promise.allSettled(jobs);
    }
  });
}

test('SQL material metadata, reference and counters cannot partly commit when a caught physical reference insert fails', async (t) => {
  const f = await fixture(t, 'sqlite');
  const initial = prepared(1);
  const attempt = () =>
    f.materials().transaction(command('physical-fault'), (tx) => {
      try {
        tx.attach([initial]);
      } catch {}
      return 'caught';
    });
  await failMaterialReferenceInsert(f.directory, true);
  await assert.rejects(attempt());
  assert.equal(await f.materials().material(initial.id), undefined);
  assert.equal(
    await f
      .entities()
      .transaction(command('absent-reference'), (tx) => tx.materialExists(initial.id)),
    false,
  );
  assert.deepEqual(await f.events(), []);
  assert.equal(await f.materials().receipt(command('physical-fault')), undefined);
  await failMaterialReferenceInsert(f.directory, false);
  assert.equal(await attempt(), 'caught');
  const remainder = Array.from({ length: 63 }, (_value, index) => prepared(index + 2));
  await f.materials().transaction(command('fill'), (tx) => tx.attach(remainder));
  await assert.rejects(
    f.materials().transaction(command('full'), (tx) => tx.attach([prepared(65)])),
    { code: 'CONTEXT_LIMIT' },
  );
  await f.reopen();
  assert.deepEqual(await f.materials().material(initial.id), initial);
  assert.equal(
    await f
      .entities()
      .transaction(command('known-reference'), (tx) => tx.materialExists(initial.id)),
    true,
  );
});

test('an existing SQL material library with a missing counter row is rejected without silently resetting its totals', async (t) => {
  const f = await fixture(t, 'sqlite');
  await f.materials().transaction(command('saved-material'), (tx) => tx.attach([prepared(1)]));
  await f.sql!.close();
  await removeMaterialCounterRow(f.directory);
  assert.equal(await materialCounterRowExists(f.directory), false);
  await assert.rejects(f.reopen(), { code: 'USAGE_AUTHORITY_FORMAT' });
  assert.equal(await materialCounterRowExists(f.directory), false);
});
