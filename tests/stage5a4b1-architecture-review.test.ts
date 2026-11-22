import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { expandEvent, packEvent } from '../adapters/files/event-log.ts';
import { mergeRunLifecycle } from '../protocol/run-view.ts';
import type { DomainEvent, Goal, Run } from '../protocol/domain.ts';
import type { RunCurrent } from '../protocol/run-state.ts';
import { sampleRun } from './fixtures/sample-run.ts';

test('mixed lifecycle and legacy delta history replays the exact committed Run evidence', () => {
  const run = sampleRun();
  run.status = 'running';
  run.phase = 'planning';
  delete run.completedAt;
  const goal: Goal = {
    id: run.goalId,
    projectId: 'p',
    title: run.title,
    body: 'Synthetic replay regression',
    criteria: '',
    status: 'running',
    createdAt: run.createdAt,
  };
  const event = (seq: number, change: DomainEvent['change']): DomainEvent => ({
    version: 1,
    id: String(seq),
    projectId: 'p',
    seq,
    at: run.createdAt,
    change,
  });
  const current: RunCurrent = {
    version: 1,
    id: run.id,
    goalId: run.goalId,
    admissionId: 'admission',
    attemptId: 'attempt',
    revision: 3,
    title: run.title,
    summary: run.summary,
    status: 'running',
    phase: 'checking',
    createdAt: run.createdAt,
    updatedAt: '2026-01-01T00:02:00.000Z',
    cancelRequested: false,
  };
  const entry = {
    runId: run.id,
    at: current.updatedAt,
    type: 'phase.checking',
    text: 'Service checks',
  };
  const phased = mergeRunLifecycle(run, current, entry);
  const changed = { ...structuredClone(phased), summary: 'Actual checks observed' };
  const checkpoint = event(1, { type: 'run.changed', run, goal });
  const lifecycle = event(2, { type: 'run.lifecycle-changed', current, entry });
  const next = event(3, { type: 'run.changed', run: changed, goal });
  const packed = packEvent(next, phased);
  assert.equal(packed.change.type, 'run.delta');
  const replay = new Map<string, Run>();
  expandEvent(checkpoint, replay);
  expandEvent(lifecycle, replay);
  assert.deepEqual(expandEvent(packed, replay), next);
});

test('File lifecycle between legacy writes preserves live history on replay and reopen', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-lifecycle-replay-review-'));
  const run = sampleRun();
  run.status = 'running';
  run.phase = 'planning';
  delete run.completedAt;
  const project = { id: 'p', name: 'Synthetic replay fixture', root: directory };
  const options = { directory, project, runs: [run] };
  let store = await FileProjectStore.open(options);
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const goal: Goal = {
    id: run.goalId,
    projectId: 'p',
    title: run.title,
    body: 'Synthetic replay regression',
    criteria: '',
    status: 'running',
    createdAt: run.createdAt,
  };
  await store.transact('checkpoint', 'checkpoint', (doc) => {
    doc.goals.push(goal);
    return { result: null, change: { type: 'run.changed', run: doc.runs[0], goal } };
  });
  const current: RunCurrent = {
    version: 1,
    id: run.id,
    goalId: run.goalId,
    admissionId: 'admission',
    attemptId: 'attempt',
    revision: 3,
    title: run.title,
    summary: run.summary,
    status: 'running',
    phase: 'checking',
    createdAt: run.createdAt,
    updatedAt: '2026-01-01T00:02:00.000Z',
    cancelRequested: false,
  };
  const entry = {
    runId: run.id,
    at: current.updatedAt,
    type: 'phase.checking',
    text: 'Service checks',
  };
  const live: DomainEvent[] = [];
  store.subscribe(0, (event) => live.push(event));
  await store.transact('phase', 'phase', (doc) => {
    doc.runs[0] = mergeRunLifecycle(doc.runs[0], current, entry);
    return { result: null, change: { type: 'run.lifecycle-changed', current, entry } };
  });
  await store.transact('observation', 'observation', (doc) => {
    doc.runs[0].summary = 'Checks observed';
    return { result: null, change: { type: 'run.changed', run: doc.runs[0], goal } };
  });
  const saved = store.snapshot();
  assert.equal((await store.storageInfo()).compactedEvents, 1);
  const replay: DomainEvent[] = [];
  store.subscribe(0, (event) => replay.push(event))();
  assert.deepEqual(replay, live);
  await store.close();
  store = await FileProjectStore.open(options);
  assert.deepEqual(store.snapshot(), saved);
  const reopened: DomainEvent[] = [];
  store.subscribe(0, (event) => reopened.push(event))();
  assert.deepEqual(reopened, live);
});
