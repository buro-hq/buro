import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextMaterials } from '../adapters/files/context-materials.ts';
import { createDocumentProjectMaterials } from '../adapters/files/project-materials.ts';
import type { DocumentFacetHost } from '../adapters/files/document-facet.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { ContextLoaderCatalog } from '../core/context-loaders.ts';
import type { ProjectRegistry, ProjectStore } from '../core/ports.ts';
import type { ContextMaterial } from '../protocol/domain.ts';
import type { ProjectMaterialChange } from '../core/project-materials.ts';
import { applyEvent } from '../clients/socket-client.ts';

test('zero-change and multi-change material commands keep the connected snapshot identical to file authority metadata', async (t) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-material-revision-')),
  );
  const store = await FileProjectStore.open({
    directory,
    project: { id: 'p', name: 'Synthetic', root: directory },
  });
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const hash = 'c'.repeat(64);
  const prepared: ContextMaterial = {
    id: 'M-c',
    name: 'Revision proof.txt',
    hash,
    relativePath: `local/context/${hash}.txt`,
    size: 4,
    mimeType: 'text/plain',
    scope: 'project',
    active: true,
    createdAt: 'now',
    loader: { id: 'text', revision: 'v1' },
    representation: 'text',
  };
  let client = store.snapshot();
  store.subscribe(0, (event) => {
    client = applyEvent(client, event);
  });
  await store.materials.transaction({ id: 'first', fingerprint: 'first' }, (tx) =>
    tx.attach([prepared]),
  );
  assert.deepEqual(client, store.snapshot());
  await store.materials.transaction({ id: 'duplicate', fingerprint: 'duplicate' }, (tx) =>
    tx.attach([prepared]),
  );
  assert.deepEqual(
    client,
    store.snapshot(),
    'A receipt-only command has no missing public revision.',
  );
  await store.materials.transaction({ id: 'multi', fingerprint: 'multi' }, (tx) => {
    tx.remove(prepared.id);
    tx.attach([prepared]);
  });
  assert.deepEqual(
    client,
    store.snapshot(),
    'Every committed change replays exact public metadata.',
  );
});

test('a document material facet captures its original host callbacks for writes, reads and receipt lookup', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-material-alias-')));
  const stores: FileProjectStore[] = [];
  for (const id of ['p', 'q'])
    stores.push(
      await FileProjectStore.open({
        directory: path.join(root, id),
        project: { id, name: id, root },
      }),
    );
  t.after(async () => {
    await Promise.all(stores.map((store) => store.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const hostFor = (store: FileProjectStore): DocumentFacetHost<ProjectMaterialChange> => ({
    projectId: store.doc.project.id,
    read: (query) => store.queue.then(() => query(store.doc)),
    transaction: (command, apply) =>
      store.transact(command.id, command.fingerprint, (doc) => {
        const { result, changes } = apply(doc);
        assert.equal(changes.length, 1, 'This regression writes exactly one material event.');
        return { result, change: changes[0] };
      }),
  });
  const host = hostFor(stores[0]);
  const materialFacet = createDocumentProjectMaterials(host);
  const replacement = hostFor(stores[1]);
  host.transaction = replacement.transaction;
  host.read = replacement.read;
  const hash = 'b'.repeat(64);
  const prepared: ContextMaterial = {
    id: 'M-b',
    name: 'Captured host.txt',
    hash,
    relativePath: `local/context/${hash}.txt`,
    size: 4,
    mimeType: 'text/plain',
    scope: 'project',
    active: true,
    createdAt: 'now',
    loader: { id: 'text', revision: 'v1' },
    representation: 'text',
  };
  const command = { id: 'captured-host', fingerprint: 'captured-host' };
  const result = await materialFacet.transaction(command, (tx) => tx.attach([prepared]));
  assert.equal(materialFacet.projectId, 'p');
  assert.deepEqual(await stores[0].materials.material(prepared.id), prepared);
  assert.equal(await stores[1].materials.material(prepared.id), undefined);
  assert.deepEqual(await materialFacet.material(prepared.id), prepared);
  assert.deepEqual(await materialFacet.receipt(command), { result });
  assert.equal(await stores[1].materials.receipt(command), undefined);
});

for (const kind of ['file', 'sqlite'] as const)
  test(`${kind}: a foreign material facet is rejected before receipt lookup, project projection, loaders or publication`, async (t) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'buro-material-owner-')),
    );
    const directory = path.join(root, 'state');
    const foreign =
      kind === 'file'
        ? await FileProjectStore.open({
            directory,
            project: { id: 'q', name: 'Foreign project', root },
          })
        : await SqliteProjectUsageAuthority.open({
            directory,
            project: { id: 'q', name: 'Synthetic project', root: directory },
          });
    const hash = 'a'.repeat(64);
    const saved: ContextMaterial = {
      id: 'M-a',
      name: 'Foreign material.txt',
      hash,
      relativePath: `local/context/${hash}.txt`,
      size: 4,
      mimeType: 'text/plain',
      scope: 'project',
      active: true,
      createdAt: 'now',
      loader: { id: 'text', revision: 'v1' },
      representation: 'text',
    };
    await foreign.materials.transaction({ id: 'seed', fingerprint: 'seed' }, (tx) =>
      tx.attach([saved]),
    );
    let receiptReads = 0,
      projections = 0,
      loaderCalls = 0;
    const registry: ProjectRegistry = {
      get(id) {
        assert.equal(id, 'p');
        return {
          materials: {
            ...foreign.materials,
            receipt(command) {
              receiptReads++;
              return foreign.materials.receipt(command);
            },
          },
        } as ProjectStore;
      },
      list() {
        projections++;
        throw Error('Do not project source paths for a foreign facet.');
      },
    };
    const loaders = new ContextLoaderCatalog();
    loaders.register({
      id: 'text',
      revision: 'v1',
      matches() {
        loaderCalls++;
        return true;
      },
      async load() {
        loaderCalls++;
        return { mimeType: 'text/plain', representation: 'text', text: 'test' };
      },
    });
    const importer = new ContextMaterials(registry, loaders.seal());
    t.after(async () => {
      await importer.dispose();
      await foreign.close();
      await fs.rm(root, { recursive: true, force: true });
    });
    await assert.rejects(
      importer.import('wrong-import', 'wrong-import', {
        projectId: 'p',
        scope: 'project',
        upload: { name: 'new.txt', base64: Buffer.from('test').toString('base64') },
      }),
      { code: 'INVALID_PROJECT_MATERIAL' },
    );
    await assert.rejects(
      Promise.resolve().then(() =>
        importer.remove('wrong-remove', 'wrong-remove', { projectId: 'p', materialId: saved.id }),
      ),
      { code: 'INVALID_PROJECT_MATERIAL' },
    );
    assert.equal(receiptReads, 0);
    assert.equal(projections, 0);
    assert.equal(loaderCalls, 0);
    assert.deepEqual(await foreign.materials.material(saved.id), saved);
    for (const id of ['wrong-import', 'wrong-remove'])
      assert.equal(await foreign.materials.receipt({ id, fingerprint: id }), undefined);
    await assert.rejects(fs.access(path.join(root, '.buro')), { code: 'ENOENT' });
  });
