import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import type { ManagedSession } from '../core/model-ports.ts';

async function fixture(t: any) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-journal-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const scope: ManagedSession['scope'] = {
    projectId: 'p',
    sessionId: 'M-journal',
    workspace: '/fixture',
    readOnly: false,
    writeScope: { mode: 'advisory', plannedPaths: [], protectedPaths: ['checks/'] },
    materials: [],
    commands: [],
  };
  const seed: ManagedSession = {
    version: 1,
    id: 'M-journal',
    runtimeId: 'fixture',
    providerId: 'fixture',
    providerRevision: 'v1',
    requestedModel: 'fixture',
    toolRevision: 'v1',
    limits: { contextTokens: 32768, maxOutputTokens: 4096 },
    scope,
    scopeRevisions: [
      { revision: 1, scope: structuredClone(scope), instructions: 'Keep actual history.' },
    ],
    messages: [{ role: 'system', content: 'Keep actual history.' }],
    status: 'ready',
    requests: 0,
    usage: { requestsWithUsage: 0, inputTokens: 0, outputTokens: 0 },
    actions: [],
  };
  return {
    directory,
    seed,
    store: new FileManagedSessions(directory),
    filename: path.join(directory, seed.id + '.json'),
  };
}

test('a small checkpoint update appends without rewriting a large conversation and reopening restores it exactly', async (t) => {
  const f = await fixture(t);
  await f.store.save(f.seed);
  const large = structuredClone(f.seed);
  large.status = 'running';
  large.messages.push({ role: 'user', content: 'Длинная история '.repeat(40000) });
  large.turnAuthorities = [
    { turnId: 'T-first', toolPolicy: 'normal', startedAtRequest: 0, scopeRevision: 1 },
  ];
  await f.store.save(large);
  const before = await fs.stat(f.filename);
  const next = { ...large, cancelRequested: true };
  await f.store.save(next);
  const after = await fs.stat(f.filename);
  assert.equal(after.ino, before.ino);
  assert.ok(after.size - before.size < 1000, 'A status change must not rewrite the large history.');
  assert.equal(after.mode & 0o777, 0o600);
  assert.deepEqual(await new FileManagedSessions(f.directory).load(next.id), next);
});

test('an incomplete crash tail is ignored and removed before the next durable append', async (t) => {
  const f = await fixture(t);
  await f.store.save(f.seed);
  await fs.appendFile(f.filename, '{"sequence":1,"patch":[');
  const reopened = new FileManagedSessions(f.directory);
  assert.deepEqual(await reopened.load(f.seed.id), f.seed);
  const next = { ...f.seed, cancelRequested: true };
  await reopened.save(next);
  assert.deepEqual(await new FileManagedSessions(f.directory).load(f.seed.id), next);
});

test('a failed journal fsync rolls back its append and preserves the last acknowledged checkpoint', async (t) => {
  const f = await fixture(t);
  await f.store.save(f.seed);
  const bytes = await fs.readFile(f.filename, 'utf8');
  const handle = await fs.open(f.filename, 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const fault = t.mock.method(prototype, 'sync', async () => {
    throw Error('journal sync failure');
  });
  await assert.rejects(f.store.save({ ...f.seed, cancelRequested: true }), /journal sync failure/);
  fault.mock.restore();
  assert.equal(await fs.readFile(f.filename, 'utf8'), bytes);
  assert.deepEqual(await new FileManagedSessions(f.directory).load(f.seed.id), f.seed);
  await f.store.save({ ...f.seed, cancelRequested: true });
});

test('a complete corrupt record is rejected even by an instance that cached an earlier checkpoint', async (t) => {
  const f = await fixture(t);
  await f.store.save(f.seed);
  await fs.appendFile(f.filename, '{"sequence":999,"patch":[]}\n');
  await assert.rejects(f.store.load(f.seed.id), { code: 'INVALID_CHECKPOINT' });
});

test('legacy pretty-printed snapshots migrate on save without losing their history', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.filename, JSON.stringify(f.seed, null, 2), { mode: 0o600 });
  assert.deepEqual(await f.store.load(f.seed.id), f.seed);
  const next = { ...f.seed, cancelRequested: true };
  await f.store.save(next);
  assert.deepEqual(await new FileManagedSessions(f.directory).load(f.seed.id), next);
});
