import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { applyEvent } from '../clients/socket-client.ts';
import type { ContextMaterial } from '../protocol/context.ts';

const material = (): ContextMaterial => ({
  id: 'M-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'design.txt',
  mimeType: 'text/plain',
  size: 4,
  hash: 'a'.repeat(64),
  relativePath: `local/context/${'a'.repeat(64)}.txt`,
  scope: 'project',
  active: true,
  createdAt: '2026-11-22T00:00:00Z',
  loader: { id: 'text', revision: 'one' },
  representation: 'text',
});
async function fixture(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-file-materials-'));
  let fail = false;
  const store = await FileProjectStore.open({
    directory,
    project: { id: 'p', name: 'Synthetic', root: directory },
    replace: async (from, to) => {
      if (fail) throw Error('Synthetic persistence failure');
      await fs.rename(from, to);
    },
  });
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}

test('material persistence failure rolls back metadata, receipt and publication before retry', async (t) => {
  const f = await fixture(t),
    before = f.store.snapshot();
  const seen: unknown[] = [];
  f.store.subscribe(0, (event) => seen.push(event));
  const command = { id: 'attach', fingerprint: 'attach' };
  f.fail(true);
  await assert.rejects(
    f.store.materials.transaction(command, (tx) => tx.attach([material()])),
    /Synthetic persistence/,
  );
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(await f.store.materials.receipt(command), undefined);
  assert.equal(await f.store.materials.material(material().id), undefined);
  assert.deepEqual(seen, []);
  f.fail(false);
  const attached = await f.store.materials.transaction(command, (tx) => tx.attach([material()]));
  assert.deepEqual(attached, [material()]);
  assert.equal(seen.length, 1);
});

test('material reactivation updates the existing connected-client row and preserves frozen removed snapshots', async (t) => {
  const f = await fixture(t);
  let client = f.store.snapshot();
  f.store.subscribe(0, (event) => {
    client = applyEvent(client, event);
  });
  const [first] = await f.store.materials.transaction({ id: 'first', fingerprint: 'first' }, (tx) =>
    tx.attach([material()]),
  );
  const captured = structuredClone(first);
  await f.store.materials.transaction({ id: 'remove', fingerprint: 'remove' }, (tx) =>
    tx.remove(first.id),
  );
  assert.equal(client.contextMaterials?.[0].active, false);
  const [again] = await f.store.materials.transaction({ id: 'again', fingerprint: 'again' }, (tx) =>
    tx.attach([
      { ...material(), id: 'M-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', createdAt: 'later' },
    ]),
  );
  assert.deepEqual(again, captured);
  assert.deepEqual(client.contextMaterials, [captured]);
  assert.deepEqual(f.store.snapshot().contextMaterials, [captured]);
});

test('material facets reject an async callback and close its retained capability after rollback', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending!: Promise<void>;
  const command = { id: 'async', fingerprint: 'async' };
  await assert.rejects(
    f.store.materials.transaction(command, (tx) => {
      pending = (async () => {
        tx.attach([material()]);
        await held;
        assert.throws(() => tx.material(material().id), { code: 'ENTITY_TRANSACTION_CLOSED' });
        assert.throws(() => tx.remove(material().id), { code: 'ENTITY_TRANSACTION_CLOSED' });
      })();
      return pending;
    }),
    { code: 'ASYNC_ENTITY_TRANSACTION' },
  );
  release();
  await pending;
  assert.equal(await f.store.materials.receipt(command), undefined);
  assert.deepEqual(f.store.snapshot().contextMaterials, undefined);
  await f.store.materials.transaction(command, () => undefined);
  assert.deepEqual(await f.store.materials.receipt(command), { result: undefined });
});
