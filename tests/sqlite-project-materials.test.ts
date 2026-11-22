import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import type { MaterialTransaction } from '../core/project-materials.ts';
import type { ContextMaterial } from '../protocol/domain.ts';

const command = (id: string) => ({ id, fingerprint: id });
const hash = 'a'.repeat(64);
const material = (suffix = 'a', patch: Partial<ContextMaterial> = {}): ContextMaterial => ({
  id: 'M-' + suffix,
  name: 'Material ' + suffix,
  mimeType: 'text/plain',
  size: 5,
  hash,
  relativePath: 'local/context/' + hash + '.txt',
  scope: 'project',
  active: true,
  createdAt: '2026-11-22T00:00:00Z',
  representation: 'text',
  loader: { id: 'text', revision: 'v1' },
  ...patch,
});
async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-sql-materials-')),
  );
  const authority = await SqliteProjectUsageAuthority.open({ directory, projectId: 'p' });
  t.after(async () => {
    await authority.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return authority;
}

test('SQLite material identity deduplicates and reactivates the original row without losing goal references', async (t) => {
  const authority = await fixture(t);
  const original = material();
  await authority.materials.transaction(command('attach'), (tx) => tx.attach([original]));
  const duplicate = await authority.materials.transaction(command('duplicate'), (tx) =>
    tx.attach([material('b', { name: original.name, createdAt: 'later' })]),
  );
  assert.deepEqual(duplicate, [original]);
  assert.equal((await authority.pagedEvents({ after: 0, limit: 10 })).events.length, 1);
  await authority.materials.transaction(command('remove'), (tx) => tx.remove(original.id));
  assert.equal((await authority.materials.material(original.id))?.active, false);
  await authority.entities.transaction(command('reference-inactive'), (tx) =>
    tx.createGoal({
      id: 'G-reference',
      projectId: 'p',
      title: 'Referenced material',
      body: 'Retain known reference',
      criteria: '',
      status: 'draft',
      revision: 1,
      createdAt: 'now',
      materialIds: [original.id],
    }),
  );
  const restored = await authority.materials.transaction(command('reactivate'), (tx) =>
    tx.attach([material('c', { name: original.name })]),
  );
  assert.deepEqual(restored, [original]);
  assert.equal(await authority.materials.material('M-c'), undefined);
  assert.deepEqual(
    (await authority.pagedEvents({ after: 0, limit: 10 })).events.map((event) => event.type),
    [
      'context.materials.added',
      'context.material.removed',
      'goal.created',
      'context.materials.added',
    ],
  );
});

test('material count summaries preserve the active-project limit through remove, insert and reactivation', async (t) => {
  const authority = await fixture(t);
  const originals = Array.from({ length: 64 }, (_, index) => material(index.toString(16)));
  await authority.materials.transaction(command('full-active'), (tx) => tx.attach(originals));
  await assert.rejects(
    authority.materials.transaction(command('too-many'), (tx) => tx.attach([material('ff')])),
    { code: 'CONTEXT_LIMIT' },
  );
  await authority.materials.transaction(command('free-slot'), (tx) => tx.remove(originals[0].id));
  await authority.materials.transaction(command('replacement'), (tx) =>
    tx.attach([material('ff')]),
  );
  await assert.rejects(
    authority.materials.transaction(command('reactivate-full'), (tx) => tx.attach([originals[0]])),
    { code: 'CONTEXT_LIMIT' },
  );
  assert.equal((await authority.materials.material(originals[0].id))?.active, false);
  assert.equal((await authority.materials.material('M-ff'))?.active, true);
  assert.equal((await authority.pagedEvents({ after: 0, limit: 10 })).events.length, 3);
});

test('receipt lookup distinguishes absent from a saved void and uses the same command namespace', async (t) => {
  const authority = await fixture(t);
  assert.equal(await authority.materials.receipt(command('missing')), undefined);
  await authority.transaction(command('void'), () => undefined);
  const foundVoid = await authority.materials.receipt(command('void'));
  assert.deepEqual(foundVoid, { result: undefined });
  const created = await authority.materials.transaction(command('save'), (tx) =>
    tx.attach([material()]),
  );
  assert.deepEqual(await authority.materials.receipt(command('save')), { result: created });
  await assert.rejects(authority.materials.receipt({ id: 'save', fingerprint: 'other' }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  const found = await authority.materials.receipt(command('save'));
  (found!.result as ContextMaterial[])[0].name = 'Caller mutation';
  assert.equal(
    ((await authority.materials.receipt(command('save')))!.result as ContextMaterial[])[0].name,
    'Material a',
  );
});

test('combined material, goal and usage writes roll back and retry under one receipt and sequence', async (t) => {
  const authority = await fixture(t);
  const owner = { kind: 'run' as const, runId: 'R-one' };
  const create = (tx: Parameters<Parameters<typeof authority.transaction>[1]>[0]) => {
    tx.materials.attach([material()]);
    tx.entities.createGoal({
      id: 'G-one',
      projectId: 'p',
      title: 'Atomic goal',
      body: 'Uses fresh material',
      criteria: '',
      status: 'draft',
      revision: 1,
      createdAt: 'now',
      materialIds: ['M-a'],
    });
    return tx.usage.createAccount(owner, {
      id: 'account',
      policy: {
        version: 1,
        maxRequests: 5,
        maxReservedOutputTokens: 50,
        maxToolCalls: 5,
        reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
      },
    });
  };
  await assert.rejects(
    authority.transaction(command('combined'), (tx) => {
      create(tx);
      throw Error('Injected rollback');
    }),
    /Injected rollback/,
  );
  assert.equal(await authority.materials.material('M-a'), undefined);
  assert.equal(await authority.entities.goal('G-one'), undefined);
  assert.equal(await authority.account(owner), undefined);
  assert.equal(await authority.materials.receipt(command('combined')), undefined);
  assert.deepEqual((await authority.pagedEvents({ after: 0, limit: 10 })).events, []);
  await authority.transaction(command('combined'), create);
  const events = (await authority.pagedEvents({ after: 0, limit: 10 })).events;
  assert.deepEqual(
    events.map((event) => [event.sequence, event.type]),
    [
      [1, 'context.materials.added'],
      [2, 'goal.created'],
      [3, 'usage.changed'],
    ],
  );
});

test('material metadata cannot drift under a saved identity and retained material capabilities expire', async (t) => {
  const authority = await fixture(t);
  let retained!: MaterialTransaction;
  await authority.materials.transaction(command('original'), (tx) => {
    retained = tx;
    return tx.attach([material()]);
  });
  assert.throws(() => retained.material('M-a'), { code: 'USAGE_TRANSACTION_CLOSED' });
  assert.throws(() => Object.defineProperty(authority, 'materials', { value: {} }), TypeError);
  await assert.rejects(
    authority.materials.transaction(command('metadata-drift'), (tx) =>
      tx.attach([material('b', { name: 'Material a', mimeType: 'text/changed' })]),
    ),
    { code: 'CONTEXT_CONFLICT' },
  );
  await assert.rejects(
    authority.materials.transaction(command('hash-path'), (tx) =>
      tx.attach([material('c', { relativePath: 'local/context/' + 'b'.repeat(64) + '.txt' })]),
    ),
    { code: 'INVALID_PROJECT_MATERIAL' },
  );
  assert.equal((await authority.materials.material('M-a'))?.mimeType, 'text/plain');
  assert.equal(await authority.materials.material('M-b'), undefined);
  assert.equal((await authority.pagedEvents({ after: 0, limit: 10 })).events.length, 1);
});
