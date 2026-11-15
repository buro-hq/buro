import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { sampleRun } from './fixtures/sample-run.ts';
import type { Run, Goal, DomainEvent } from '../protocol/domain.ts';
async function fixture(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'event-storage-'));
  const run: Run = sampleRun();
  Object.assign(run, {
    id: 'run',
    goalId: 'goal',
    summary: 'initial',
    events: [],
    commands: [],
    agents: [],
    changedFiles: [],
  });
  const options = { directory, project: { id: 'p', name: 'P', root: directory }, runs: [run] };
  const store = await FileProjectStore.open(options);
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const goal: Goal = {
    id: 'goal',
    projectId: 'p',
    title: 'Goal',
    body: 'Body',
    criteria: '',
    createdAt: run.createdAt,
    status: 'draft',
  };
  await store.transact('g', 'g', (doc) => {
    doc.goals.push(goal);
    return { result: goal, change: { type: 'goal.created', goal } };
  });
  return { directory, options, store, goal };
}
test('event history grows linearly, replays exact historical snapshots and survives reopening', async (t) => {
  const f = await fixture(t),
    live: DomainEvent[] = [];
  f.store.subscribe(f.store.snapshot().sequence, (e) => live.push(e));
  for (let i = 0; i < 30; i++)
    await f.store.transact('step-' + i, 'step-' + i, (doc) => {
      const run = doc.runs[0];
      run.summary = 'step-' + i;
      run.events.push({ at: new Date().toISOString(), type: 'message', text: 'event-' + i });
      if (!i)
        run.commands.push({
          id: 'command',
          threadId: run.threadId,
          command: 'check',
          startedAt: run.createdAt,
          output: 'x'.repeat(128 * 1024),
        });
      return { result: i, change: { type: 'run.changed', run, goal: doc.goals[0] } };
    });
  const file = path.join(f.directory, 'control-state.json'),
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok((await fs.stat(file)).size < 600000);
  assert.equal(data.events.filter((e: any) => e.change.type === 'run.delta').length, 29);
  assert.equal(live[0].change.type, 'run.changed');
  assert.equal((live[0].change as any).run.summary, 'step-0');
  await f.store.close();
  const restored = await FileProjectStore.open(f.options);
  t.after(() => restored.close());
  const replay: DomainEvent[] = [];
  restored.subscribe(0, (e) => replay.push(e));
  const changes = replay.filter((e) => e.change.type === 'run.changed');
  assert.equal(changes.length, 30);
  assert.equal((changes[0].change as any).run.events.length, 1);
  assert.equal((changes[29].change as any).run.summary, 'step-29');
  assert.equal((changes[0].change as any).run.commands[0].output.length, 128 * 1024);
  assert.equal(restored.receipt('step-5', 'step-5'), 5);
});
test('legacy full snapshots compact without losing sequence, receipts, goals or events', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++)
    await f.store.transact('s' + i, 's' + i, (doc) => {
      doc.runs[0].summary = 'revision-' + i;
      return { result: i, change: { type: 'run.changed', run: doc.runs[0], goal: doc.goals[0] } };
    });
  const history: DomainEvent[] = [];
  f.store.subscribe(0, (e) => history.push(e));
  const before = f.store.snapshot();
  await f.store.close();
  const file = path.join(f.directory, 'control-state.json'),
    doc = JSON.parse(await fs.readFile(file, 'utf8'));
  doc.events = history;
  delete doc.eventEncoding;
  await fs.writeFile(file, JSON.stringify(doc));
  const restored = await FileProjectStore.open(f.options);
  t.after(() => restored.close());
  assert.deepEqual(restored.snapshot(), before);
  const replay: DomainEvent[] = [];
  restored.subscribe(0, (e) => replay.push(e));
  assert.deepEqual(replay, history);
  assert.equal(restored.receipt('s3', 's3'), 3);
});
test('GC removes only stale owned temporary files and preserves workspaces, fresh writes and unknown files', async (t) => {
  const f = await fixture(t),
    old = path.join(f.directory, `control-state.json.${randomUUID()}.tmp`),
    fresh = path.join(f.directory, `control-state.json.${randomUUID()}.tmp`),
    unknown = path.join(f.directory, 'user.tmp');
  await fs.writeFile(old, 'stale');
  await fs.writeFile(fresh, 'fresh');
  await fs.writeFile(unknown, 'keep');
  await fs.mkdir(path.join(f.directory, 'worktrees'));
  await fs.writeFile(path.join(f.directory, 'worktrees', 'saved'), 'work');
  await fs.utimes(old, new Date(0), new Date(0));
  const before = f.store.snapshot(),
    result = await f.store.collectGarbage();
  assert.equal(result.removedTempFiles, 1);
  assert.equal(result.reclaimedBytes, 5);
  await assert.rejects(fs.access(old));
  assert.equal(await fs.readFile(fresh, 'utf8'), 'fresh');
  assert.equal(await fs.readFile(unknown, 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(f.directory, 'worktrees', 'saved'), 'utf8'), 'work');
  assert.deepEqual(f.store.snapshot(), before);
});
