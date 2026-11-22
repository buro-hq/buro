import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import { executionPolicy } from '../core/project-settings.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import type { AgentRuntime } from '../core/ports.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import type { DomainEvent, ProjectProfile } from '../protocol/domain.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';
const canonical = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function fixture(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-binding-review-'));
  const project = { id: 'p', name: 'Binding review fixture', root: directory };
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: '',
    scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
    checks: [{ id: 'test', title: 'Test', command: 'never', timeoutMs: 1000 }],
    defaultCheckIds: ['test'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    turnTimeoutMs: 10000,
  };
  const options = { directory, project, profile };
  const store = await FileProjectStore.open(options);
  let id = 0;
  const env = {
    projects: { get: () => store, list: () => [project] },
    id: () => String(++id),
    now: () => new Date(Date.UTC(2026, 0, 1) + id * 1000).toISOString(),
  };
  const forbidden = async (): Promise<never> => {
    throw Error('Review must not dispatch work.');
  };
  const service = new ExecutionService({
    actions: createBuiltinExecutionActions(),
    ...env,
    policies: { p: executionPolicy(profile) },
    workflowRoles: createBuiltinWorkflowRoles(),
    selection: fixtureExecutionSelection('fake', fixtureExecutionCapabilities()),
    workspaces: { prepare: forbidden } as WorkspacePort,
    checks: { run: forbidden } as CheckPort,
    runtime: {
      id: 'fake',
      start: forbidden,
      submit: forbidden,
      turn: forbidden,
      interrupt: forbidden,
      dispose: async () => {},
    } as AgentRuntime,
  });
  service.schedule = () => {};
  const goal = await new GoalService(env).create('goal', 'goal', {
    projectId: 'p',
    title: 'Review binding integrity',
    body: 'Synthetic task',
    criteria: '',
  });
  const { runId } = await service.start('queue', 'queue', { projectId: 'p', goalId: goal.id });
  await service.beginExecution('p', runId);
  await service.phase('p', runId, 'preparing', 'Prepare synthetic workspace');
  const workspace = { path: path.join(directory, 'isolated'), base: 'a'.repeat(40) };
  t.after(async () => {
    await service.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, options, store, service, runId, workspace };
}

test('File admitted Run cannot acquire workspace authority through a legacy callback', async (t) => {
  const f = await fixture(t);
  const before = f.store.snapshot();
  await assert.rejects(
    f.store.transact('bypass', 'bypass', (doc) => {
      const run = doc.runs.find((run) => run.id === f.runId)!;
      run.workspace = f.workspace.path;
      run.baseCommit = f.workspace.base;
      return { result: null, change: { type: 'run.changed', run, goal: doc.goals[0] } };
    }),
    { code: 'IMMUTABLE_RUN_ADMISSION' },
  );
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(await f.store.runs.workspace(f.runId), undefined);
});

test('File reopen rejects a missing immutable workspace binding behind an admitted projection', async (t) => {
  const f = await fixture(t);
  await f.service.bindPreparedWorkspace('p', f.runId, f.workspace);
  await f.store.close();
  const file = path.join(f.directory, 'control-state.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  delete saved.runWorkspaces;
  await fs.writeFile(file, JSON.stringify(saved));
  let reopened: FileProjectStore | undefined;
  try {
    await assert.rejects(
      async () => {
        reopened = await FileProjectStore.open(f.options);
      },
      { code: 'IMMUTABLE_RUN_ADMISSION' },
    );
  } finally {
    await reopened?.close();
  }
});

test('File immutable workspace observations preserve exact mixed legacy replay after reopen', async (t) => {
  const f = await fixture(t);
  const live: DomainEvent[] = [];
  f.store.subscribe(0, (event) => live.push(event));
  await f.store.transact('checkpoint', 'checkpoint', (doc) => ({
    result: null,
    change: { type: 'run.changed', run: doc.runs[0], goal: doc.goals[0] },
  }));
  await f.service.bindPreparedWorkspace('p', f.runId, f.workspace);
  await f.store.transact('observation', 'observation', (doc) => {
    doc.runs[0].summary = 'Observed checks';
    return {
      result: null,
      change: { type: 'run.changed', run: doc.runs[0], goal: doc.goals[0] },
    };
  });
  assert.equal((await f.store.storageInfo()).compactedEvents, 1);
  const replay: DomainEvent[] = [];
  f.store.subscribe(0, (event) => replay.push(event))();
  assert.deepEqual(canonical(replay), canonical(live));
  const snapshot = f.store.snapshot();
  await f.store.close();
  const reopened = await FileProjectStore.open(f.options);
  t.after(() => reopened.close());
  const history: DomainEvent[] = [];
  reopened.subscribe(0, (event) => history.push(event))();
  assert.deepEqual(canonical(history), canonical(live));
  assert.deepEqual(canonical(reopened.snapshot()), canonical(snapshot));
});
