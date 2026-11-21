import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { parseDomainEvent, parseSnapshot } from '../protocol/schema.ts';
import {
  WorkerEnvelopeSchema,
  WorkerReplanSchema,
  type WorkerEnvelopeV1,
  type WorkerTask,
} from '../protocol/worker-tasks.ts';
import type { DomainEvent, Goal, Run } from '../protocol/domain.ts';
import { sampleRun } from './fixtures/sample-run.ts';

const task: WorkerTask = {
  objective: 'Preserve the exported JSON contract while improving CLI feedback.',
  inputs: ['src/cli.ts', 'src/contracts.ts'],
  expectedResult: 'Only the assigned CLI module changes; existing JSON remains compatible.',
  criteria: ['Keep JSON field names unchanged.', 'Return evidence from the registered checks.'],
};

function workerRun(): Run {
  const run = sampleRun();
  run.status = 'running';
  run.phase = 'implementation';
  delete run.completedAt;
  run.workerTasks = { implementer: structuredClone(task) };
  run.workerReplan = {
    roleId: 'implementer',
    failedSessionId: 'S-first',
    failureCode: 'MODEL_INCOMPLETE',
    requestedAt: run.createdAt,
    status: 'requested',
  };
  const envelope: WorkerEnvelopeV1 = {
    version: 1,
    runId: run.id,
    role: { id: 'implementer', version: 1 },
    goal: { id: run.goalId, title: run.title },
    task: { source: 'coordinator', ...structuredClone(task) },
    scope: { mode: 'advisory', plannedPaths: ['src/cli.ts'], protectedPaths: ['checks/'] },
    steps: ['Improve CLI feedback without changing JSON fields.'],
    checks: {
      collection: 'baseline',
      passed: 0,
      total: 1,
      results: [
        {
          index: 0,
          name: 'CLI contract',
          passed: false,
          command: 'node --test checks/cli.mjs',
          exitCode: 1,
          diagnostic: 'Expected updated feedback; complete log is retained in the run.',
        },
      ],
    },
    materials: [],
  };
  run.agents = [
    {
      session: {
        id: 'S-first',
        roleId: 'implementer',
        roleVersion: 1,
        runtimeId: 'local-worker',
      },
      threadId: 'B-first',
      name: 'implementer',
      agentPath: '/root/implementer',
      startedAt: run.createdAt,
      completedAt: run.createdAt,
      messages: [],
      commands: 0,
      status: 'failed',
      assignment: {
        paths: ['src/cli.ts'],
        envelope,
        knownFailure: { code: 'MODEL_INCOMPLETE', scopeVerified: true },
      },
    },
  ];
  return run;
}

async function fixture(t: any, run = workerRun()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-storage-'));
  const options = { directory, project: { id: 'p', name: 'P', root: directory } };
  let store = await FileProjectStore.open(options);
  const goal: Goal = {
    id: run.goalId!,
    projectId: 'p',
    title: run.title,
    body: run.goalText,
    criteria: 'Keep the JSON contract.',
    status: 'running',
    createdAt: run.createdAt,
  };
  await store.transact('initial', 'initial', (draft) => {
    draft.goals.push(goal);
    draft.runs.push(run);
    return { result: null, change: { type: 'run.changed', run, goal } };
  });
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    options,
    goal,
    async reopen() {
      await store.close();
      store = await FileProjectStore.open(options);
      return store;
    },
  };
}

test('saved worker contract and consumed replan intent survive restart and both transport parsers', async (t) => {
  const f = await fixture(t);
  const first = f.store.snapshot().runs[0];
  await f.reopen();
  const restored = parseSnapshot(JSON.parse(JSON.stringify(f.store.snapshot()))).runs[0];
  assert.deepEqual(restored.workerTasks, first.workerTasks);
  assert.deepEqual(restored.workerReplan, first.workerReplan);
  assert.equal(restored.workerReplan?.status, 'requested');
  assert.deepEqual(restored.agents[0].assignment, first.agents[0].assignment);
  assert.equal(restored.agents[0].assignment!.envelope!.scope.mode, 'advisory');
  assert.deepEqual(restored.agents[0].assignment!.envelope!.scope.plannedPaths, ['src/cli.ts']);

  const refined = { ...structuredClone(task), objective: 'Update only the text feedback branch.' };
  await f.store.transact('refined', 'refined', (draft) => {
    const run = draft.runs[0];
    run.workerTasks!.implementer = refined;
    run.workerReplan = { ...run.workerReplan!, status: 'ready', task: refined };
    return { result: null, change: { type: 'run.changed', run, goal: f.goal } };
  });
  const replayed: DomainEvent[] = [];
  f.store.subscribe(0, (event) =>
    replayed.push(parseDomainEvent(JSON.parse(JSON.stringify(event)))),
  );
  assert.equal(replayed.length, 2);
  for (const event of replayed) {
    assert.equal(event.change.type, 'run.changed');
    if (event.change.type !== 'run.changed') throw Error('Unexpected event');
    assert.deepEqual(event.change.run.agents[0].assignment, first.agents[0].assignment);
  }
  assert.equal(
    replayed.at(-1)?.change.type === 'run.changed' &&
      (replayed.at(-1)!.change as { run: Run }).run.workerReplan?.status,
    'ready',
  );
  await f.reopen();
  const latest = parseSnapshot(f.store.snapshot()).runs[0];
  assert.deepEqual(latest.workerTasks?.implementer, refined);
  assert.deepEqual(latest.workerReplan?.task, refined);
  assert.deepEqual(latest.workerReplan?.task?.criteria, task.criteria);
  // The failed attempt retains its original contract; the refined task cannot rewrite history.
  assert.deepEqual(latest.agents[0].assignment?.envelope?.task.criteria, task.criteria);
  assert.equal(latest.agents[0].assignment?.envelope?.task.objective, task.objective);
});

test('invalid recovery state cannot replace durable intent or publish a transport event', async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.store.file, 'utf8');
  const snapshot = f.store.snapshot();
  let published = 0;
  f.store.subscribe(snapshot.sequence, () => published++);
  await assert.rejects(
    f.store.transact('invalid', 'invalid', (draft) => {
      const run = draft.runs[0];
      (run.workerReplan as any).status = 'ready';
      delete (run.workerReplan as any).task;
      return { result: null, change: { type: 'run.changed', run, goal: f.goal } };
    }),
  );
  assert.equal(published, 0);
  assert.equal(await fs.readFile(f.store.file, 'utf8'), before);
  assert.deepEqual(f.store.snapshot(), snapshot);
  await f.reopen();
  assert.equal(parseSnapshot(f.store.snapshot()).runs[0].workerReplan?.status, 'requested');
});

test('worker transport rejects fabricated recovery eligibility and malformed contracts', async (t) => {
  const f = await fixture(t);
  const snapshot = f.store.snapshot();
  for (const mutate of [
    (run: any) => (run.agents[0].assignment.knownFailure.scopeVerified = false),
    (run: any) => (run.agents[0].assignment.knownFailure.code = 'MODEL_BUDGET_EXHAUSTED'),
    (run: any) => (run.agents[0].assignment.envelope.version = 2),
    (run: any) => (run.agents[0].assignment.envelope.task.criteria = []),
    (run: any) => (run.agents[0].assignment.envelope.scope.mode = 'implicit'),
    (run: any) => {
      run.agents[0].assignment.envelope.scope.mode = 'strict';
      run.agents[0].assignment.envelope.scope.plannedPaths = [];
    },
    (run: any) => (run.workerTasks.implementer.objective = 'x'.repeat(2001)),
    (run: any) => (run.workerReplan.status = 'completed'),
  ]) {
    const value = structuredClone(snapshot);
    mutate(value.runs[0]);
    assert.throws(() => parseSnapshot(value));
    assert.throws(() =>
      parseDomainEvent({
        version: 1,
        id: 'event',
        projectId: 'p',
        seq: 1,
        at: 'now',
        change: { type: 'run.changed', run: value.runs[0], goal: f.goal },
      }),
    );
  }
  const requested = snapshot.runs[0].workerReplan!;
  assert.equal(WorkerReplanSchema.safeParse({ ...requested, status: 'requested' }).success, true);
  assert.equal(
    WorkerReplanSchema.safeParse({ ...requested, status: 'completed', task }).success,
    true,
  );
});

test('legacy runs remain readable without worker metadata or task truncation', async (t) => {
  const run = sampleRun();
  const f = await fixture(t, run);
  const restored = parseSnapshot(f.store.snapshot()).runs[0];
  assert.equal(restored.workerTasks, undefined);
  assert.equal(restored.workerReplan, undefined);
  assert.equal(restored.agents[0].assignment?.envelope, undefined);
  const legacyEnvelope = workerRun().agents[0].assignment!.envelope!;
  legacyEnvelope.task = {
    source: 'legacy-goal',
    objective: 'Full original goal. '.repeat(800),
    inputs: [],
    expectedResult: 'Complete the assigned steps.',
    criteria: [],
  };
  assert.deepEqual(WorkerEnvelopeSchema.parse(legacyEnvelope), legacyEnvelope);
  await f.reopen();
  assert.deepEqual(parseSnapshot(f.store.snapshot()).runs[0], restored);
});
