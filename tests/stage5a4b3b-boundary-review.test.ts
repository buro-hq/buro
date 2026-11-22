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
import { applyEvent } from '../clients/socket-client.ts';
import { parseDomainEvent } from '../protocol/schema.ts';
import { validateProjectAuthorityChange } from '../core/usage-authority.ts';
import type { DomainEvent, ProjectProfile, Snapshot } from '../protocol/domain.ts';
import type { AgentRuntime } from '../core/ports.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

const canonical = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-attempt-boundary-')),
  );
  const project = { id: 'p', name: 'Attempt boundary fixture', root: directory };
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: '',
    scope: { mode: 'advisory', plannedPaths: [], protectedPaths: ['AGENTS.md'] },
    checks: [{ id: 'test', title: 'Test', command: 'never', timeoutMs: 1000 }],
    defaultCheckIds: ['test'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    maxRepairs: 0,
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
    throw Error('No external dispatch in attempt boundary proof.');
  };
  const service = new ExecutionService({
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
  t.after(async () => {
    await service.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const goals = new GoalService(env);
  const goal = await goals.create('goal', 'goal', {
    projectId: 'p',
    title: 'Initial task',
    body: 'Original complete task',
    criteria: 'Preserve complete evidence',
  });
  const { runId } = await service.start('queue', 'queue', { projectId: 'p', goalId: goal.id });
  await service.beginExecution('p', runId);
  await service.phase('p', runId, 'preparing', 'Prepare synthetic input');
  await service.bindPreparedWorkspace('p', runId, {
    path: path.join(directory, 'workspace'),
    base: 'a'.repeat(40),
  });
  await service.update('p', runId, (run) => {
    run.review = {
      verdict: 'changes_requested',
      blockingFindings: ['Synthetic finding'],
      summary: 'Synthetic review',
    };
    run.agents.push({
      threadId: 'worker',
      name: 'worker',
      agentPath: '/root/worker',
      startedAt: env.now(),
      completedAt: '',
      messages: ['Retain worker evidence'],
      commands: 1,
      status: 'running',
    });
    run.commands.push({
      id: 'command',
      threadId: 'worker',
      command: 'synthetic command',
      startedAt: env.now(),
      output: 'Retain command evidence',
    });
  });
  const before = store.snapshot();
  const live: DomainEvent[] = [];
  store.subscribe(before.sequence, (event) => live.push(parseDomainEvent(event)));
  await service.cancel('stop-request', 'stop-request', { projectId: 'p', runId });
  const result = 'Complete unsuccessful result. '.repeat(1500);
  await service.finish('p', runId, 'interrupted', result);
  const stopped = store.snapshot();
  const updated = await goals.update('updated-goal', 'updated-goal', {
    projectId: 'p',
    id: goal.id,
    expectedRevision: 1,
    title: 'Updated full task',
    body: 'Updated complete body. '.repeat(400),
    criteria: 'Updated exact criterion. '.repeat(250),
  });
  await service.resume('resume', 'resume', {
    projectId: 'p',
    runId,
    mode: 'repair',
    instructions: 'Complete clarification. '.repeat(300),
    useCurrentProfile: false,
  });
  const resumed = store.snapshot();
  const stopEvent = live.find((event) => event.change.type === 'run.attempt-stopped')!;
  const resumeEvent = live.find((event) => event.change.type === 'run.attempt-continued')!;
  assert.ok(stopEvent && resumeEvent);
  return {
    directory,
    options,
    store,
    service,
    runId,
    goal,
    before,
    stopped,
    resumed,
    live,
    stopEvent,
    resumeEvent,
    result,
    updated,
  };
}

test('actual stop and continuation preserve complete result/evidence and reset stopped presentation across mixed replay', async (t) => {
  const f = await fixture(t);
  const stopped = f.stopped.runs[0],
    resumed = f.resumed.runs[0];
  assert.equal(stopped.result, f.result);
  assert.equal(stopped.cancelRequested, true);
  assert.equal(stopped.stop?.code, 'USER_INTERRUPTED');
  assert.ok(stopped.stop?.actions.includes('repair'));
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.cancelRequested, false);
  assert.equal(resumed.completedAt, undefined);
  assert.equal(resumed.review, undefined);
  assert.equal(resumed.issue, undefined);
  assert.equal(resumed.stop, undefined);
  assert.equal(resumed.independentReviewer, false);
  assert.equal(resumed.attempts?.[0].result, f.result);
  assert.equal(
    resumed.goalText,
    f.updated.body + '\n\nAcceptance criteria:\n' + f.updated.criteria,
  );
  assert.deepEqual(resumed.commands, stopped.commands);
  assert.deepEqual(resumed.agents, stopped.agents);
  let view = f.before;
  for (const event of f.live) view = applyEvent(view, event);
  assert.deepEqual(canonical(view.runs), canonical(f.resumed.runs));
  assert.deepEqual(canonical(view.goals), canonical(f.resumed.goals));
  assert.equal(applyEvent(view, f.resumeEvent), view);
  await f.service.update('p', f.runId, (run) =>
    run.events.push({ at: 'later', type: 'observation', text: 'After continuation' }),
  );
  const replay: DomainEvent[] = [];
  f.store.subscribe(0, (event) => replay.push(parseDomainEvent(event)))();
  let replayed = {
    ...f.before,
    sequence: 0,
    revision: 0,
    runs: [],
    goals: [],
    roles: [],
  } as Snapshot;
  for (const event of replay) replayed = applyEvent(replayed, event);
  assert.deepEqual(canonical(replayed.runs), canonical(f.store.snapshot().runs));
  await f.store.close();
  const reopened = await FileProjectStore.open(f.options);
  t.after(() => reopened.close());
  const reopenedEvents: DomainEvent[] = [];
  reopened.subscribe(0, (event) => reopenedEvents.push(parseDomainEvent(event)))();
  assert.deepEqual(canonical(reopenedEvents), canonical(replay));
});

test('attempt event wire and authority reject foreign goal project identity and invented stop history', async (t) => {
  const f = await fixture(t);
  for (const event of [f.stopEvent, f.resumeEvent]) {
    const change = event.change;
    assert.ok(change.type === 'run.attempt-stopped' || change.type === 'run.attempt-continued');
    assert.deepEqual(validateProjectAuthorityChange({ projectId: 'p', ...change }, 'p'), {
      ...change,
      projectId: 'p',
    });
    const invalid = [
      { ...change, goal: { ...change.goal, projectId: 'foreign-project' } },
      { ...change, entries: change.entries.map((entry) => ({ ...entry, type: 'goal.completed' })) },
      { ...change, current: { ...change.current, status: 'completed' } },
      { ...change, privateSession: 'hidden' },
    ];
    if (change.type === 'run.attempt-continued')
      invalid.push({
        ...change,
        context: {
          ...change.context,
          goal: { ...change.context.goal, projectId: 'foreign-project' },
        },
      } as any);
    if (change.type === 'run.attempt-continued')
      for (const policySource of ['admission', 'configured-host', 'unknown-source'])
        invalid.push({
          ...change,
          context: { ...change.context, policySource },
        } as any);
    for (const value of invalid) {
      assert.throws(() => parseDomainEvent({ ...event, change: value }));
      assert.throws(() => validateProjectAuthorityChange({ projectId: 'p', ...value }, 'p'));
    }
  }
});

test('attempt client changes require the exact projected predecessor attempt', async (t) => {
  const f = await fixture(t);
  for (const event of [f.stopEvent, f.resumeEvent]) {
    const source = structuredClone(f.before);
    source.sequence = event.seq - 1;
    source.runs[0].attemptId = 'foreign-prior-attempt';
    assert.throws(() => applyEvent(source, event), /attempt|identity/i);
  }
});
