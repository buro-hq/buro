import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { ContextMaterials } from '../adapters/files/context-materials.ts';
import { ContextLoaderCatalog } from '../core/context-loaders.ts';
import type { ProjectStore, ProjectRegistry } from '../core/ports.ts';
import type { ProjectMaterials } from '../core/project-materials.ts';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const command = (id: string) => ({ id, fingerprint: id });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: any, kind: 'file' | 'sqlite', text: (input: string) => string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-material-review-'))),
    state = path.join(root, 'state'),
    repository = path.join(root, 'repository');
  await fs.mkdir(repository);
  const opened: (FileProjectStore | SqliteProjectUsageAuthority)[] = [];
  let authority =
    kind === 'file'
      ? await FileProjectStore.open({
          directory: state,
          project: { id: 'p', name: 'Fixture', root: repository },
        })
      : await SqliteProjectUsageAuthority.open({
          directory: state,
          project: { id: 'p', name: 'Synthetic project', root: state },
        });
  opened.push(authority);
  const materials = (): ProjectMaterials => authority.materials;
  const registry: ProjectRegistry = {
    get(id) {
      assert.equal(id, 'p');
      return {
        get materials() {
          return materials();
        },
        snapshot() {
          throw Error('Importer cannot read whole state.');
        },
        transact() {
          throw Error('Importer cannot write whole state.');
        },
        receipt() {
          throw Error('Importer must use the material receipt facet.');
        },
      } as unknown as ProjectStore;
    },
    list: () => [{ id: 'p', name: 'Fixture', root: repository }],
  };
  const loaders = new ContextLoaderCatalog();
  loaders.register({
    id: 'review-loader',
    revision: 'fixed-revision',
    matches: () => true,
    async load({ bytes }) {
      return {
        mimeType: 'text/plain',
        representation: 'text',
        text: text(new TextDecoder().decode(bytes)),
      };
    },
  });
  const importer = new ContextMaterials(registry, loaders.seal());
  t.after(async () => {
    await importer.dispose();
    await Promise.all(opened.map((item) => item.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const events = async () => {
    if (kind === 'sqlite')
      return (
        await (authority as SqliteProjectUsageAuthority).pagedEvents({ after: 0, limit: 100 })
      ).events.map(({ sequence, projectId, ...change }) => change);
    const values: unknown[] = [];
    const unsubscribe = (authority as FileProjectStore).subscribe(0, (event) =>
      values.push(event.change),
    );
    unsubscribe();
    return values;
  };
  const count = async () => {
    if (kind === 'file')
      return (authority as FileProjectStore).snapshot().contextMaterials?.length ?? 0;
    const database = new DatabaseSync(path.join(state, 'authority.sqlite'), { readOnly: true });
    try {
      return Number(
        database.prepare('SELECT COUNT(*) AS count FROM project_materials').get()!.count,
      );
    } finally {
      database.close();
    }
  };
  return {
    root,
    state,
    repository,
    importer,
    materials,
    events,
    count,
    async reopen() {
      await authority.close();
      authority =
        kind === 'file'
          ? await FileProjectStore.open({
              directory: state,
              project: { id: 'p', name: 'Fixture', root: repository },
            })
          : await SqliteProjectUsageAuthority.open({
              directory: state,
              project: { id: 'p', name: 'Synthetic project', root: state },
            });
      opened.push(authority);
    },
  };
}

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: a changed extraction under the same loader revision cannot reactivate or replace canonical material or partly attach its batch`, async (t) => {
    let changed = false;
    const f = await fixture(t, kind, (input) =>
      input === 'Original bytes'
        ? changed
          ? 'Different extracted text'
          : 'Original extracted text'
        : 'Fresh extracted text',
    );
    const originalSource = path.join(f.root, 'document.custom'),
      freshSource = path.join(f.root, 'fresh.custom');
    await fs.writeFile(originalSource, 'Original bytes');
    await fs.writeFile(freshSource, 'Fresh bytes');
    const [original] = await f.importer.import('original', 'original', {
      projectId: 'p',
      scope: 'project',
      paths: [originalSource],
    });
    assert.ok(original.textPath);
    assert.equal(original.textHash, digest('Original extracted text'));
    await f.importer.remove('remove', 'remove', { projectId: 'p', materialId: original.id });
    const before = await f.events();
    changed = true;
    await assert.rejects(
      f.importer.import('conflict', 'conflict', {
        projectId: 'p',
        scope: 'project',
        paths: [freshSource, originalSource],
      }),
      { code: 'CONTEXT_CONFLICT' },
    );
    assert.equal(await f.count(), 1);
    assert.deepEqual(await f.materials().material(original.id), { ...original, active: false });
    assert.equal(await f.materials().receipt(command('conflict')), undefined);
    assert.deepEqual(await f.events(), before);
    assert.equal(
      await fs.readFile(path.join(f.repository, '.buro', original.textPath!), 'utf8'),
      'Original extracted text',
    );
    const directory = path.join(f.repository, '.buro/local/context');
    assert.equal(
      (await fs.readdir(directory)).some((name) => name.endsWith('.tmp')),
      false,
    );
    changed = false;
    const retry = await f.importer.import('conflict', 'conflict', {
      projectId: 'p',
      scope: 'project',
      paths: [freshSource, originalSource],
    });
    assert.equal(retry[1].id, original.id);
    assert.equal(retry[1].createdAt, original.createdAt);
    assert.equal(retry[1].active, true);
    assert.equal(await f.count(), 2);
    await f.reopen();
    assert.deepEqual(await f.materials().material(original.id), original);
    assert.deepEqual((await f.materials().receipt(command('conflict')))!.result, retry);
    assert.equal((await f.events()).length, before.length + 1);
  });

  test(
    `${kind}: partial blob writes remain private temporary files until complete publication and material admission`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t, kind, (input) => input),
        arrived = deferred(),
        release = deferred();
      t.after(() => release.resolve());
      const content = 'Complete immutable material bytes',
        directory = path.join(f.repository, '.buro/local/context'),
        target = path.join(directory, digest(content) + '.txt');
      const originalOpen = fs.open.bind(fs);
      t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).startsWith(directory + path.sep) && String(args[0]).endsWith('.tmp')) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (data: any) => {
            const bytes = Buffer.from(data),
              middle = Math.floor(bytes.length / 2);
            await write(bytes.subarray(0, middle));
            arrived.resolve();
            await release.promise;
            await write(bytes.subarray(middle));
          };
        }
        return handle;
      });
      const pending = f.importer.import('partial', 'partial', {
        projectId: 'p',
        scope: 'project',
        upload: { name: 'material.txt', base64: Buffer.from(content).toString('base64') },
      });
      void pending.catch(() => {});
      try {
        await arrived.promise;
        await assert.rejects(fs.stat(target), { code: 'ENOENT' });
        assert.equal(
          (await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')).length,
          1,
        );
        assert.equal(await f.count(), 0);
        assert.equal(await f.materials().receipt(command('partial')), undefined);
        assert.deepEqual(await f.events(), []);
        release.resolve();
        const [saved] = await pending;
        assert.equal(saved.hash, digest(content));
        assert.equal(await fs.readFile(target, 'utf8'), content);
        assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(target)).nlink, 1);
        assert.equal(
          (await fs.readdir(directory)).some((name) => name.endsWith('.tmp')),
          false,
        );
        assert.equal(await f.count(), 1);
        assert.deepEqual(await f.materials().material(saved.id), saved);
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
      }
    },
  );
}
