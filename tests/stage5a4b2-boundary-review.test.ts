import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent } from '../clients/socket-client.ts';
import { parseDomainEvent } from '../protocol/schema.ts';
import type { DomainEvent, Run, Snapshot, Goal } from '../protocol/domain.ts';
import type { RunCurrent, RunWorkspaceBinding } from '../protocol/run-state.ts';
import { validateProjectAuthorityChange } from '../core/usage-authority.ts';
import { expandEvent, packEvent } from '../adapters/files/event-log.ts';
import { mergeRunWorkspace } from '../protocol/run-view.ts';
import { sampleRun } from './fixtures/sample-run.ts';

const current: RunCurrent = {
  version: 1,
  id: 'R-example',
  goalId: 'G-example',
  revision: 4,
  admissionId: 'admission-example',
  attemptId: 'attempt-example',
  title: 'Improve CLI feedback',
  summary: 'Synthetic preparation',
  status: 'running',
  phase: 'preparing',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:02:00.000Z',
  cancelRequested: false,
};
const binding: RunWorkspaceBinding = {
  version: 1,
  runId: current.id,
  admissionId: current.admissionId,
  attemptId: current.attemptId,
  path: '/synthetic/isolated-workspace',
  baseCommit: 'a'.repeat(40),
  createdAt: current.updatedAt,
};
const change = () => ({
  type: 'run.workspace-bound' as const,
  current: structuredClone(current),
  binding: structuredClone(binding),
  entry: {
    runId: current.id,
    at: current.updatedAt,
    type: 'workspace.prepared' as const,
    text: 'Workspace prepared' as const,
  },
});
const wire = (value: unknown, seq = 8): DomainEvent =>
  parseDomainEvent({
    version: 1,
    id: 'event-' + seq,
    seq,
    projectId: 'p',
    at: current.updatedAt,
    change: value,
  });
const preparingRun = (): Run => ({
  ...sampleRun(),
  status: 'running',
  phase: 'preparing',
  completedAt: undefined,
});

test('workspace public and authority validators retain observed cancellation but reject forged binding evidence', () => {
  const observed = change();
  assert.deepEqual(wire(observed).change, observed);
  const cancelled = {
    ...observed,
    current: { ...current, status: 'canceling', cancelRequested: true },
  };
  assert.deepEqual(wire(cancelled).change, cancelled);
  assert.deepEqual(validateProjectAuthorityChange({ projectId: 'p', ...cancelled }, 'p'), {
    projectId: 'p',
    ...cancelled,
  });
  const invalid = [
    { ...observed, current: { ...current, status: 'completed', phase: 'done' } },
    { ...observed, current: { ...current, cancelRequested: true } },
    { ...observed, current: { ...current, status: 'canceling' } },
    { ...observed, current: { ...current, completedAt: current.updatedAt } },
    { ...observed, current: { ...current, phase: 'implementation' } },
    ...['runId', 'admissionId', 'attemptId', 'createdAt'].map((key) => ({
      ...observed,
      binding: { ...binding, [key]: 'foreign' },
    })),
    { ...observed, binding: { ...binding, acceptedCommit: 'forged' } },
    { ...observed, entry: { ...observed.entry, type: 'goal.completed' } },
    { ...observed, entry: { ...observed.entry, runId: 'R-foreign' } },
    { ...observed, entry: { ...observed.entry, at: current.createdAt } },
    { ...observed, entry: { ...observed.entry, text: 'Arbitrary history' } },
    { ...observed, view: { privateSession: 'private' } },
  ];
  for (const value of invalid) {
    assert.throws(() => wire(value));
    assert.throws(() => validateProjectAuthorityChange({ projectId: 'p', ...value }, 'p'));
  }
});

test('workspace client replay retains evidence, cancellation and source branch without manufacturing acceptance', () => {
  const run = { ...preparingRun(), baseBranch: 'source-branch' };
  const snapshot = {
    project: { id: 'p', name: 'Synthetic', root: '/synthetic/source' },
    sequence: 7,
    revision: 19,
    roles: [],
    goals: [],
    runs: [run],
  } as unknown as Snapshot;
  const before = structuredClone(snapshot);
  const event = wire({
    ...change(),
    current: { ...current, status: 'canceling', cancelRequested: true },
  });
  const after = applyEvent(snapshot, event);
  assert.deepEqual(snapshot, before);
  assert.equal(after.runs[0].workspace, binding.path);
  assert.equal(after.runs[0].baseCommit, binding.baseCommit);
  assert.equal(after.runs[0].baseBranch, 'source-branch');
  assert.equal(after.runs[0].status, 'canceling');
  assert.equal(after.runs[0].commit, undefined);
  for (const key of [
    'commands',
    'agents',
    'acceptance',
    'baseline',
    'plan',
    'changedFiles',
  ] as const)
    assert.deepEqual(after.runs[0][key], run[key]);
  assert.equal(
    after.runs[0].events.filter((entry) => entry.type === 'workspace.prepared').length,
    1,
  );
  assert.equal(applyEvent(after, event), after);
  assert.throws(() => applyEvent({ ...snapshot, runs: [] }, event), /current run projection/);
});

test('workspace event updates the File replay baseline before the next packed legacy Run delta', () => {
  const run = preparingRun();
  const goal: Goal = {
    id: current.goalId,
    projectId: 'p',
    title: current.title,
    body: 'Synthetic task',
    criteria: 'Preserve replay evidence',
    status: 'running',
    createdAt: current.createdAt,
  };
  const checkpoint = wire({ type: 'run.changed', run, goal }, 7);
  const boundEvent = wire(change(), 8);
  const bound = mergeRunWorkspace(run, current, binding, change().entry);
  const next: Run = {
    ...bound,
    phase: 'planning',
    events: [...bound.events, { at: current.updatedAt, type: 'phase.planning', text: 'Plan' }],
    agents: bound.agents.map((agent, index) =>
      index === 0 ? { ...agent, messages: [...agent.messages, 'Retain next message'] } : agent,
    ),
  };
  const updated = {
    ...boundEvent,
    id: 'event-9',
    seq: 9,
    change: { type: 'run.changed' as const, run: next, goal },
  };
  const packed = packEvent(updated, bound);
  assert.equal(packed.change.type, 'run.delta');
  const state = new Map<string, Run>();
  expandEvent(checkpoint, state);
  expandEvent(boundEvent, state);
  const expanded = expandEvent(packed, state);
  assert.equal(expanded.change.type, 'run.changed');
  if (expanded.change.type !== 'run.changed') assert.fail();
  assert.deepEqual(expanded.change.run, next);
  assert.equal(expanded.change.run.workspace, binding.path);
  assert.equal(
    expanded.change.run.events.filter((entry) => entry.type === 'workspace.prepared').length,
    1,
  );
});
