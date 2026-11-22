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
import type { ProjectProfile } from '../protocol/domain.ts';
import { sessionResource } from '../protocol/resources.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

async function fixture(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-plan-session-review-'));
  const project = { id: 'p', name: 'Planner session review fixture', root: directory };
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
    throw Error('Review must not dispatch work.');
  };
  const service = new ExecutionService({
    ...env,
    policies: { p: executionPolicy(profile) },
    workflowRoles: createBuiltinWorkflowRoles(),
    selection: fixtureExecutionSelection(
      'fake',
      fixtureExecutionCapabilities({ toolsFreeTurns: false }),
    ),
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
    title: 'Review exact planner grant',
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
  await service.bindPreparedWorkspace('p', runId, workspace);
  await service.phase('p', runId, 'planning', 'Plan without write authority');
  await service.update('p', runId, (run) => {
    run.threadId = 'planner-thread';
    run.coordinatorSession = {
      id: 'planner-session',
      roleId: 'coordinator',
      roleVersion: run.roleSnapshots!.find((role) => role.id === 'coordinator')!.version,
      ...sessionResource(run.resources, 'coordination', 'fake', run.roleResources!.coordinator),
      parentId: 'original-parent',
    };
  });
  return { directory, options, store, service, runId, workspace };
}

const candidate = {
  summary: 'A coordinator-only valid plan',
  steps: [
    { step: 'Implement requested change', owner: 'coordinator' },
    { step: 'Independent review', owner: 'reviewer' },
  ],
  team: [],
};

test('same-id planner grant changes are compared before read-only session sealing', async (t) => {
  for (const [field, value] of [
    ['configurationRevision', 'replaced-config'],
    ['runtimeId', 'replaced-runtime'],
    ['roleVersion', 2],
    ['model', 'replaced-model'],
    ['providerId', 'replaced-provider'],
    ['parentId', 'replaced-parent'],
  ] as const) {
    await t.test(field, async (t) => {
      const f = await fixture(t);
      const expected = await f.store.runs.planningInput(f.runId);
      await f.service.update('p', f.runId, (run) => {
        Object.assign(run.coordinatorSession!, { [field]: value });
      });
      const before = f.store.snapshot();
      await assert.rejects(
        f.service.acceptPlan('p', f.runId, candidate, {}, expected),
        (error: any) => ['PLANNING_CONTEXT_CHANGED', 'INVALID_RUN_PLAN'].includes(error.code),
      );
      assert.deepEqual(f.store.snapshot(), before);
      assert.equal(await f.store.runs.plan(f.runId), undefined);
    });
  }
});

test('sealed read-only planner grant cannot be rewritten under the same session id', async (t) => {
  const f = await fixture(t);
  await f.service.acceptPlan('p', f.runId, candidate, {});
  const before = f.store.snapshot();
  await assert.rejects(
    f.service.update('p', f.runId, (run) => {
      run.planningSession!.configurationRevision = 'replaced-config';
    }),
    { code: 'IMMUTABLE_RUN_PLAN' },
  );
  assert.deepEqual(f.store.snapshot(), before);
});

test('File OPEN rejects same-id sealed planner grant replacement', async (t) => {
  const f = await fixture(t);
  await f.service.acceptPlan('p', f.runId, candidate, {});
  await f.store.close();
  const file = path.join(f.directory, 'control-state.json');
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  doc.runs.find((run: any) => run.id === f.runId).planningSession.runtimeId = 'foreign-runtime';
  await fs.writeFile(file, JSON.stringify(doc));
  let reopened: FileProjectStore | undefined;
  try {
    await assert.rejects(
      async () => {
        reopened = await FileProjectStore.open(f.options);
      },
      { code: 'IMMUTABLE_RUN_PLAN' },
    );
  } finally {
    await reopened?.close();
  }
});

test('observed planner output is separate from the frozen handoff grant', async (t) => {
  const f = await fixture(t);
  const expected = await f.store.runs.planningInput(f.runId);
  await f.service.update('p', f.runId, (run) => {
    run.coordinatorSession!.reportedModel = 'observed-response-model';
    run.coordinatorSession!.result = {
      status: 'success',
      summary: 'Observed planner response',
      artifacts: [],
      notesForNextAgent: '',
    };
  });
  await f.service.acceptPlan('p', f.runId, candidate, {}, expected);
  const saved = await f.store.runs.plan(f.runId);
  assert.ok(saved?.readOnlyPlanner);
  assert.equal(Object.hasOwn(saved.readOnlyPlanner.sessionGrant, 'reportedModel'), false);
  assert.equal(Object.hasOwn(saved.readOnlyPlanner.sessionGrant, 'result'), false);
  await f.service.update('p', f.runId, (run) => {
    run.planningSession!.reportedModel = 'later-observed-model';
  });
  assert.deepEqual(await f.store.runs.plan(f.runId), saved);
});

test('initial planning context cannot substitute the legacy projection for immutable admission', async (t) => {
  const f = await fixture(t);
  const admitted = await f.store.runs.planningInput(f.runId);
  await f.service.update('p', f.runId, (run) => {
    run.goalText = 'Replacement task';
  });
  await assert.rejects(f.store.runs.planningInput(f.runId), { code: 'IMMUTABLE_RUN_PLAN' });
  await f.service.update('p', f.runId, (run) => {
    run.goalText = admitted.goalText;
  });
  assert.deepEqual(await f.store.runs.planningInput(f.runId), admitted);
});

for (const reusePlanner of [false, true]) {
  test(`File OPEN rejects deleted read-only handoff${reusePlanner ? ' and planner writer reuse' : ''}`, async (t) => {
    const f = await fixture(t);
    await f.service.acceptPlan('p', f.runId, candidate, {});
    await f.store.close();
    const file = path.join(f.directory, 'control-state.json');
    const doc = JSON.parse(await fs.readFile(file, 'utf8'));
    const saved = doc.runPlans[doc.runPlanHeads[f.runId]];
    delete saved.readOnlyPlanner;
    delete saved.context.readOnlyPlanner;
    if (reusePlanner) {
      const run = doc.runs.find((run: any) => run.id === f.runId);
      run.threadId = 'planner-thread';
      run.coordinatorSession = run.planningSession;
      delete run.planningSession;
    }
    await fs.writeFile(file, JSON.stringify(doc));
    let reopened: FileProjectStore | undefined;
    try {
      await assert.rejects(async () => {
        reopened = await FileProjectStore.open(f.options);
      });
    } finally {
      await reopened?.close();
    }
  });
}
