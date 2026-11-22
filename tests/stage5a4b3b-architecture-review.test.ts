import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import { executionPolicy } from '../core/project-settings.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import type { AgentRuntime } from '../core/ports.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

async function fixture(t: any, kind: 'file' | 'sqlite' = 'file') {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-attempt-lineage-review-')),
  );
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
    maxRepairs: 0,
    turnTimeoutMs: 10000,
  };
  const options = { directory, project, profile };
  const store =
    kind === 'file'
      ? await FileProjectStore.open(options)
      : await SqliteProjectUsageAuthority.open(options);
  const facade = {
    project,
    entities: store.entities,
    settings: store.settings,
    materials: store.materials,
    runs: store.runs,
  };
  let id = 0;
  const env = {
    projects: { get: () => facade as any, list: () => [project] },
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
  await service.bindPreparedWorkspace('p', runId, workspace);
  await service.finish('p', runId, 'failed', 'Observed synthetic failure');
  await service.resume('resume', 'resume', {
    projectId: 'p',
    runId,
    mode: 'repair',
    instructions: '',
    useCurrentProfile: false,
  });
  const current = await store.runs.currentAttempt(runId);
  return { directory, options, store, service, runId, workspace, current };
}

async function changeGoal(f: Awaited<ReturnType<typeof fixture>>, key: 'id' | 'projectId') {
  if (f.store instanceof FileProjectStore) {
    (f.store.doc as any).runAttemptContexts[f.current.attempt.id].goal[key] = 'foreign';
    return;
  }
  assert.ok(path.basename(f.directory).startsWith('buro-attempt-lineage-review-'));
  const database = new DatabaseSync(path.join(f.directory, 'authority.sqlite'));
  try {
    database.exec('DROP TRIGGER immutable_run_attempt_contexts_update');
    const goal = { ...f.current.context.goal, [key]: 'foreign' };
    database
      .prepare('UPDATE run_attempt_contexts SET goal_json=? WHERE attempt_id=?')
      .run(JSON.stringify(goal), f.current.attempt.id);
    database.exec(
      "CREATE TRIGGER immutable_run_attempt_contexts_update BEFORE UPDATE ON run_attempt_contexts BEGIN SELECT RAISE(ABORT,'Run attempt records are immutable'); END;",
    );
  } finally {
    database.close();
  }
}

for (const kind of ['file', 'sqlite'] as const) {
  for (const key of ['id', 'projectId'] as const) {
    test(`${kind}: named attempt read rejects foreign context goal ${key}`, async (t) => {
      const f = await fixture(t, kind);
      await changeGoal(f, key);
      await assert.rejects(f.store.runs.currentAttempt(f.runId));
      await assert.rejects(f.store.runs.attempt(f.current.attempt.id));
    });
  }
}

for (const key of ['id', 'projectId'] as const) {
  test(`File OPEN rejects foreign immutable attempt goal ${key}`, async (t) => {
    const f = await fixture(t);
    assert.ok(f.store instanceof FileProjectStore);
    await f.store.close();
    const file = path.join(f.directory, 'control-state.json');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    saved.runAttemptContexts[f.current.attempt.id].goal[key] = 'foreign';
    await fs.writeFile(file, JSON.stringify(saved));
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

const lineageCases = {
  policy: (context: any) => {
    context.policy.context = 'Foreign kept-original policy';
    if (context.policy.profile) context.policy.profile.context = context.policy.context;
  },
  workflow: (context: any) => {
    context.workflow.revision += '-foreign';
  },
  serviceRole: (context: any) => {
    context.roleSnapshots.find((role: any) => role.id === 'coordinator').instructions =
      'Foreign instructions';
  },
  taskMode: (context: any) => {
    context.taskMode = 'original';
  },
  taskChanged: (context: any) => {
    context.taskChanged = true;
  },
  workspaceOrigin: (context: any) => {
    context.workspaceOriginAttemptId = context.attemptId;
  },
};

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: replayed cancellation cannot abort a newer uncanceled attempt`, async (t) => {
    const f = await fixture(t, kind);
    const stop = { projectId: 'p', runId: f.runId };
    await f.service.cancel('prior-cancel', 'prior-cancel', stop);
    await f.service.finish('p', f.runId, 'interrupted', 'Observed prior stop');
    await f.service.resume('later-resume', 'later-resume', {
      ...stop,
      mode: 'repair',
      instructions: '',
      useCurrentProfile: false,
    });
    const current = await f.store.runs.current(f.runId);
    const controller = new AbortController();
    f.service.jobs.set(f.runId, {
      controller,
      promise: Promise.resolve(),
      attemptId: current!.attemptId,
    });
    await f.service.cancel('prior-cancel', 'prior-cancel', stop);
    assert.deepEqual(await f.store.runs.current(f.runId), current);
    assert.equal(current!.cancelRequested, false);
    assert.equal(controller.signal.aborted, false);
  });
}

test('scheduler settles a canceled successor after its predecessor cleanup finishes', async (t) => {
  const f = await fixture(t);
  assert.ok(f.store instanceof FileProjectStore);
  const store = f.store;
  let stopped!: () => void, cleaned!: () => void;
  const stoppedAtCleanup = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    cleaned = resolve;
  });
  let executions = 0;
  f.service.get = (_projectId, runId) => store.snapshot().runs.find((run) => run.id === runId)!;
  f.service.execute = async (_projectId, runId, _signal, owner) => {
    executions++;
    const current = (await store.runs.current(runId))!;
    await f.service.finish(
      'p',
      runId,
      current.cancelRequested ? 'interrupted' : 'failed',
      'Synthetic executor stopped before effects',
      undefined,
      undefined,
      owner,
    );
    if (executions === 1) {
      stopped();
      await cleanup;
    }
  };
  f.service.schedule = ExecutionService.prototype.schedule.bind(f.service);
  f.service.schedule('p', f.runId);
  const oldJob = f.service.jobs.get(f.runId)!;
  try {
    await stoppedAtCleanup;
    await f.service.resume('cleanup-successor', 'cleanup-successor', {
      projectId: 'p',
      runId: f.runId,
      mode: 'repair',
      instructions: '',
      useCurrentProfile: false,
    });
    await f.service.cancel('cancel-successor', 'cancel-successor', {
      projectId: 'p',
      runId: f.runId,
    });
    assert.equal((await store.runs.current(f.runId))!.status, 'canceling');
  } finally {
    cleaned();
    await oldJob.promise;
  }
  await Promise.allSettled([...f.service.jobs.values()].map((job) => job.promise));
  assert.equal((await store.runs.current(f.runId))!.status, 'interrupted');
});

for (const kind of ['file', 'sqlite'] as const) {
  for (const key of Object.keys(lineageCases) as (keyof typeof lineageCases)[]) {
    test(`${kind}: named attempt read rejects altered ${key} lineage`, async (t) => {
      const f = await fixture(t, kind);
      const altered = structuredClone(f.current.context);
      lineageCases[key](altered);
      if (f.store instanceof FileProjectStore) {
        Object.assign((f.store.doc as any).runAttemptContexts[f.current.attempt.id], altered);
      } else {
        assert.ok(path.basename(f.directory).startsWith('buro-attempt-lineage-review-'));
        const database = new DatabaseSync(path.join(f.directory, 'authority.sqlite'));
        try {
          if (key === 'serviceRole') {
            database.exec('DROP TRIGGER immutable_run_attempt_roles_update');
            const role = altered.roleSnapshots.find((role) => role.id === 'coordinator')!;
            database
              .prepare('UPDATE run_attempt_roles SET role_json=? WHERE attempt_id=? AND role_id=?')
              .run(JSON.stringify(role), f.current.attempt.id, 'coordinator');
            database.exec(
              "CREATE TRIGGER immutable_run_attempt_roles_update BEFORE UPDATE ON run_attempt_roles BEGIN SELECT RAISE(ABORT,'Run attempt records are immutable'); END;",
            );
          } else {
            database.exec('DROP TRIGGER immutable_run_attempt_contexts_update');
            const values = {
              policy: ['policy_json', JSON.stringify(altered.policy)],
              workflow: ['workflow_json', JSON.stringify(altered.workflow)],
              taskMode: ['task_mode', altered.taskMode],
              taskChanged: ['task_changed', Number(altered.taskChanged)],
              workspaceOrigin: ['workspace_origin_attempt_id', altered.workspaceOriginAttemptId!],
            } as const;
            const [column, value] = values[key];
            database
              .prepare(`UPDATE run_attempt_contexts SET ${column}=? WHERE attempt_id=?`)
              .run(value, f.current.attempt.id);
            database.exec(
              "CREATE TRIGGER immutable_run_attempt_contexts_update BEFORE UPDATE ON run_attempt_contexts BEGIN SELECT RAISE(ABORT,'Run attempt records are immutable'); END;",
            );
          }
        } finally {
          database.close();
        }
      }
      await assert.rejects(f.store.runs.currentAttempt(f.runId));
    });
  }
}
