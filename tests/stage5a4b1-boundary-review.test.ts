import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent } from '../clients/socket-client.ts';
import { parseDomainEvent } from '../protocol/schema.ts';
import type { DomainEvent, Snapshot } from '../protocol/domain.ts';
import type { RunCurrent } from '../protocol/run-state.ts';
import { validateProjectAuthorityChange } from '../core/usage-authority.ts';
import { sampleRun } from './fixtures/sample-run.ts';

const current: RunCurrent = {
  version: 1,
  id: 'R-example',
  goalId: 'G-example',
  revision: 3,
  admissionId: 'admission-example',
  attemptId: 'attempt-example',
  title: 'Improve CLI feedback',
  summary: 'Running synthetic work',
  status: 'running',
  phase: 'checking',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:02:00.000Z',
  cancelRequested: false,
};
const change = () => ({
  type: 'run.lifecycle-changed' as const,
  current: structuredClone(current),
  entry: {
    runId: current.id,
    at: current.updatedAt,
    type: 'phase.checking',
    text: 'Run immutable checks',
  },
});
const wire = (value: unknown): DomainEvent =>
  parseDomainEvent({
    version: 1,
    id: 'event-8',
    seq: 8,
    projectId: 'p',
    at: current.updatedAt,
    change: value,
  });

test('lifecycle wire and private authority validation reject mismatched or terminal evidence', () => {
  assert.deepEqual(wire(change()).change, change());
  assert.deepEqual(validateProjectAuthorityChange({ projectId: 'p', ...change() }, 'p'), {
    projectId: 'p',
    ...change(),
  });
  const malformed = [
    { ...change(), current: { ...current, status: 'completed', phase: 'done' } },
    { ...change(), current: { ...current, cancelRequested: true } },
    { ...change(), current: { ...current, completedAt: current.updatedAt } },
    { ...change(), entry: { ...change().entry, runId: 'R-foreign' } },
    { ...change(), entry: { ...change().entry, at: current.createdAt } },
    { ...change(), entry: { ...change().entry, type: 'goal.completed' } },
    { ...change(), entry: { ...change().entry, privateContinuation: 'private' } },
    { type: 'run.lifecycle-changed', current },
    { ...change(), view: { privateSession: 'private' } },
  ];
  for (const value of malformed) {
    assert.throws(() => wire(value));
    assert.throws(() => validateProjectAuthorityChange({ projectId: 'p', ...value }, 'p'));
  }
});

test('lifecycle replay preserves retained evidence and applies a committed phase only once', () => {
  const run = {
    ...sampleRun(),
    status: 'running' as const,
    phase: 'implementation' as const,
    completedAt: undefined,
    commands: [
      {
        id: 'command-1',
        threadId: 'fixture-implementer',
        command: 'synthetic check',
        startedAt: current.createdAt,
        output: 'Retain complete displayed output',
      },
    ],
  };
  const snapshot = {
    project: { id: 'p', name: 'Synthetic', root: '/synthetic' },
    sequence: 7,
    revision: 19,
    roles: [],
    goals: [],
    runs: [run],
  } as unknown as Snapshot;
  const before = structuredClone(snapshot);
  const event = wire(change());
  const after = applyEvent(snapshot, event);
  assert.deepEqual(snapshot, before, 'Reducer must not mutate retained source evidence.');
  assert.equal(after.runs[0].phase, 'checking');
  for (const key of [
    'commands',
    'agents',
    'acceptance',
    'baseline',
    'plan',
    'changedFiles',
  ] as const)
    assert.deepEqual(after.runs[0][key], run[key]);
  assert.deepEqual(after.runs[0].events.slice(0, -1), run.events);
  assert.deepEqual(after.runs[0].events.at(-1), {
    at: current.updatedAt,
    type: 'phase.checking',
    text: 'Run immutable checks',
  });
  assert.equal(applyEvent(after, event), after, 'Duplicate replay cannot append another phase.');
  assert.equal(applyEvent(after, { ...event, projectId: 'foreign', seq: 9 }), after);
  assert.throws(() => applyEvent(snapshot, { ...event, seq: 9 }), /Event gap/);
});

test('lifecycle events require an existing public projection and matching goal identity', () => {
  const snapshot = {
    project: { id: 'p' },
    sequence: 7,
    revision: 19,
    runs: [],
  } as unknown as Snapshot;
  assert.throws(() => applyEvent(snapshot, wire(change())), /current run projection/);
  const mismatched = {
    ...snapshot,
    runs: [{ ...sampleRun(), goalId: 'G-other' }],
  };
  assert.throws(() => applyEvent(mismatched, wire(change())), /identity mismatch/);
});
