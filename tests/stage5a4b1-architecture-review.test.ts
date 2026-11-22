import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
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
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import { executionPolicy } from '../core/project-settings.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';
import type { AgentRuntime } from '../core/ports.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import type { ProjectProfile } from '../protocol/domain.ts';

const canonical = <T>(value: T): T => JSON.parse(JSON.stringify(value));

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
  const project = { id: 'p', name: 'Synthetic replay fixture', root: directory };
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: 'Synthetic replay regression',
    scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
    checks: [{ id: 'check', title: 'Check', command: 'must-not-run', timeoutMs: 1000 }],
    defaultCheckIds: ['check'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    turnTimeoutMs: 10000,
  };
  const options = { directory, project, profile };
  let store = await FileProjectStore.open(options);
  let ids = 0;
  const env = {
    projects: { get: () => store, list: () => [project] },
    now: () => new Date(Date.UTC(2026, 0, 1) + ids * 1000).toISOString(),
    id: () => String(++ids),
  };
  const blocked = async (): Promise<never> => {
    throw Error('Replay fixture dispatched an external effect.');
  };
  const service = new ExecutionService({
    actions: createBuiltinExecutionActions(),
    ...env,
    policies: { p: executionPolicy(profile) },
    selection: fixtureExecutionSelection('fake', fixtureExecutionCapabilities()),
    workflowRoles: createBuiltinWorkflowRoles(),
    runtime: {
      id: 'fake',
      start: blocked,
      turn: blocked,
      interrupt: blocked,
      dispose: async () => {},
    } as AgentRuntime,
    checks: { run: blocked } as CheckPort,
    workspaces: { prepare: blocked } as WorkspacePort,
  });
  service.schedule = () => {};
  t.after(async () => {
    await service.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const goal = await new GoalService(env).create('goal', 'goal', {
    projectId: 'p',
    title: 'Replay',
    body: 'Synthetic replay regression',
    criteria: '',
  });
  const { runId } = await service.start('queue', 'queue', { projectId: 'p', goalId: goal.id });
  await service.beginExecution('p', runId);
  await service.phase('p', runId, 'planning', 'Planning');
  await store.transact('checkpoint', 'checkpoint', (doc) => {
    const run = doc.runs.find((run) => run.id === runId)!;
    run.summary = 'Planning checkpoint';
    return { result: null, change: { type: 'run.changed', run, goal: doc.goals[0] } };
  });
  const live: DomainEvent[] = [];
  store.subscribe(0, (event) => live.push(event));
  await service.phase('p', runId, 'checking', 'Service checks');
  await store.transact('observation', 'observation', (doc) => {
    doc.runs[0].summary = 'Checks observed';
    return { result: null, change: { type: 'run.changed', run: doc.runs[0], goal } };
  });
  const saved = canonical(store.snapshot());
  assert.equal((await store.storageInfo()).compactedEvents, 1);
  const replay: DomainEvent[] = [];
  store.subscribe(0, (event) => replay.push(event))();
  assert.deepEqual(canonical(replay), canonical(live));
  await store.close();
  store = await FileProjectStore.open(options);
  assert.deepEqual(canonical(store.snapshot()), saved);
  const reopened: DomainEvent[] = [];
  store.subscribe(0, (event) => reopened.push(event))();
  assert.deepEqual(canonical(reopened), canonical(live));
});
