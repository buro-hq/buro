// Synthetic preflight probe. Creates and removes only a private temporary File authority.
// No runtime/provider/tool/workspace effect is dispatched; this calls Core observe directly.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { ExecutionService } = await import(repo + '/core/execution.ts');
const { GoalService } = await import(repo + '/core/services.ts');
const { FileProjectStore } = await import(repo + '/adapters/files/project-store.ts');
const { createBuiltinWorkflowRoles } = await import(repo + '/adapters/workflows/builtins.ts');
const { fixtureExecutionSelection, fixtureExecutionCapabilities } = await import(
  repo + '/tests/fixtures/execution-resources.ts'
);
const directory = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'buro-preflight-journal-')),
);
let first, second, store;
try {
  const root = path.join(directory, 'source');
  await fs.mkdir(root);
  const project = { id: 'p', name: 'Journal preflight synthetic fixture', root, managed: true };
  store = await FileProjectStore.open({ directory, project });
  let id = 0,
    tick = 0;
  const forbidden = async () => {
    throw Error('External effect forbidden');
  };
  const env = {
    projects: { get: () => store, list: () => [project] },
    id: () => String(++id),
    now: () => new Date(Date.UTC(2026, 0, 1) + 1000 * ++tick).toISOString(),
    policies: {
      p: {
        scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
        checks: [{ id: 'suite', title: 'Suite' }],
        defaultCheckIds: ['suite'],
        maxWorkers: 1,
        maxRepairs: 0,
        turnTimeoutMs: 1000,
      },
    },
    workflowRoles: createBuiltinWorkflowRoles(),
    selection: fixtureExecutionSelection('fake', fixtureExecutionCapabilities()),
    runtime: {
      id: 'fake',
      start: forbidden,
      turn: forbidden,
      submit: forbidden,
      interrupt: forbidden,
      dispose: async () => {},
    },
    checks: { run: forbidden },
    workspaces: { prepare: forbidden },
  };
  const create = () => {
    const s = new ExecutionService(env);
    s.schedule = () => {};
    return s;
  };
  first = create();
  const goal = await new GoalService(env).create('g', 'g', {
    projectId: 'p',
    title: 'Synthetic observation',
    body: 'Do no work',
    criteria: 'No external effects',
  });
  const { runId } = await first.start('start', 'start', { projectId: 'p', goalId: goal.id });
  await first.beginExecution('p', runId);
  await first.phase('p', runId, 'preparing', 'Synthetic workspace');
  await first.bindPreparedWorkspace('p', runId, {
    path: path.join(directory, 'workspace'),
    base: 'a'.repeat(40),
  });
  const event = {
    id: 'duplicate-observation',
    runId,
    threadId: 'thread-initial',
    type: 'message.completed',
    text: 'same durable observation',
  };
  await first.observe(event);
  await first.observe(event);
  const count = () =>
    store
      .snapshot()
      .runs[0].events.filter((e) => e.type === 'message' && e.threadId === 'thread-initial').length;
  assert.equal(count(), 1);
  const before = store.snapshot().revision;
  second = create();
  await second.observe(event);
  assert.equal(count(), 2);
  const recreatedInstanceCount = count();
  assert.ok(store.snapshot().revision > before);
  const initial = (await store.runs.current(runId)).attemptId;
  await second.finish('p', runId, 'failed', 'Synthetic known failure');
  await second.resume('resume', 'resume', {
    projectId: 'p',
    runId,
    mode: 'repair',
    instructions: 'Continue synthetic fixture',
    useCurrentProfile: false,
  });
  await second.beginExecution('p', runId);
  const successor = (await store.runs.current(runId)).attemptId;
  assert.notEqual(successor, initial);
  // Represent the normal acquired owner map for the new attempt without dispatching an executor.
  second.executionOwners.set(runId, successor);
  const old = {
    id: 'late-old-thread-observation',
    runId,
    threadId: 'thread-initial',
    type: 'message.completed',
    text: 'late predecessor observation',
  };
  const rev = store.snapshot().revision;
  await second.observe(old);
  assert.ok(store.snapshot().revision > rev);
  assert.equal(store.snapshot().runs[0].attemptId, successor);
  assert.ok(
    store.snapshot().runs[0].events.some((e) => e.type === 'message' && e.text === old.text),
  );
  console.log(
    JSON.stringify({
      sameInstanceCount: 1,
      recreatedInstanceCount,
      initialAttempt: initial,
      successorAttempt: successor,
      lateOldThreadPersistedInCurrentRun: true,
      externalEffects: 0,
    }),
  );
} finally {
  await first?.dispose();
  await second?.dispose();
  await store?.close();
  await fs.rm(directory, { recursive: true, force: true });
}
