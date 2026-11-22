import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ExecutionService } from '../core/execution.ts';
import { GoalService, RoleService } from '../core/services.ts';
import { executionPolicy } from '../core/project-settings.ts';
import type { AgentRuntime, ProjectStore } from '../core/ports.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import type { ContextMaterial, ProjectProfile } from '../protocol/domain.ts';
import type { TeamPlan } from '../protocol/execution.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';
import {
  failAttemptTimelineInsert,
  markAttemptUnresolved,
} from './fixtures/sqlite-run-attempt-fault.ts';
import { pendingWorkerRoles } from '../core/worker-recovery.ts';

const command = (id: string) => ({ id, fingerprint: 'attempt:' + id });
const profile: ProjectProfile = {
  version: 1,
  revision: 1,
  context: 'Original trusted context',
  scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['AGENTS.md'] },
  checks: [{ id: 'test', title: 'Test', command: 'must-not-run', timeoutMs: 1000 }],
  defaultCheckIds: ['test'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 1,
  turnTimeoutMs: 10000,
  baseBranch: 'original-source',
};
const plan: TeamPlan = {
  summary: 'Original immutable worker plan',
  steps: [
    { step: 'Change scoped value', owner: 'builder' },
    { step: 'Review', owner: 'reviewer' },
  ],
  team: [
    {
      roleId: 'builder',
      action: 'create',
      title: 'Builder',
      description: 'Change one value',
      instructions: 'Retain original public contract.',
      kind: 'implementation',
      paths: ['src/value.ts'],
      runtimeId: null,
      runtimeReason: '',
      assignment: {
        objective: 'Change the specified value.',
        inputs: ['src/value.ts'],
        expectedResult: 'Original value contract retained.',
        criteria: ['Keep the public contract.'],
      },
    },
  ],
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function material(index: number, scope: ContextMaterial['scope']): ContextMaterial {
  const hash = createHash('sha256')
    .update('Complete reference ' + index)
    .digest('hex');
  return {
    id: 'M-' + String(index).padStart(6, '0'),
    name: 'Reference ' + index,
    mimeType: 'text/plain',
    size: 20,
    hash,
    relativePath: 'local/context/' + hash + '.txt',
    scope,
    active: true,
    representation: 'text',
    loader: { id: 'text', revision: 'v1' },
    createdAt: '2026-01-01',
  };
}

async function fixture(t: any, kind: 'file' | 'sqlite', ready = true) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-run-attempt-')),
  );
  const root = path.join(directory, 'source');
  await fs.mkdir(root);
  const project = { id: 'p', name: 'Synthetic attempt transitions', root, managed: true };
  const workspace = { path: path.join(directory, 'workspace'), base: 'a'.repeat(40) };
  const queries: { operation: string; rows: number }[] = [];
  let authority: FileProjectStore | SqliteProjectUsageAuthority;
  const open = async () => {
    authority =
      kind === 'file'
        ? await FileProjectStore.open({ directory, project, profile })
        : await SqliteProjectUsageAuthority.open({
            directory,
            project,
            profile,
            onQuery: (q) => queries.push(q),
          });
  };
  await open();
  await fs.writeFile(path.join(directory, '.attempt-fault-fixture'), 'synthetic-only');
  let allowLegacy = false,
    ids = 0,
    ticks = 0,
    effects = 0;
  const store = {
    get project() {
      return authority.project;
    },
    get runs() {
      return authority.runs;
    },
    get entities() {
      return authority.entities;
    },
    get materials() {
      return authority.materials;
    },
    get settings() {
      return authority.settings;
    },
    snapshot() {
      assert.ok(
        allowLegacy && authority instanceof FileProjectStore,
        'Attempt consumer hydrated a legacy document.',
      );
      return authority.snapshot();
    },
    transact(...args: Parameters<FileProjectStore['transact']>) {
      assert.ok(
        allowLegacy && authority instanceof FileProjectStore,
        'Attempt consumer used legacy mutation.',
      );
      return authority.transact(...args);
    },
  } as ProjectStore;
  const env = {
    projects: { get: () => store, list: () => [project] },
    id: () => String(++ids),
    now: () => new Date(Date.UTC(2026, 0, 1) + ++ticks * 1000).toISOString(),
  };
  const resources = fixtureExecutionSelection('fake', fixtureExecutionCapabilities()).forProject(
    'p',
  );
  const pinned = {
    ...resources.coordinator,
    id: 'pinned-coordinator',
    model: 'original-pinned-model',
    configurationRevision: 'original-pinned-config',
    capabilities: {
      ...resources.coordinator.capabilities,
      revision: 'original-pinned-capabilities',
    },
  };
  resources.workerPool = [resources.worker, pinned];
  const forbidden = async (): Promise<never> => {
    effects++;
    throw Error('Attempt contract cannot dispatch external effects.');
  };
  const service = new ExecutionService({
    actions: createBuiltinExecutionActions(),
    ...env,
    policies: { p: executionPolicy(profile) },
    selection: { forProject: () => structuredClone(resources) },
    workflowRoles: createBuiltinWorkflowRoles(),
    runtime: {
      id: 'fake',
      start: forbidden,
      turn: forbidden,
      submit: forbidden,
      interrupt: forbidden,
      dispose: async () => {},
    } as AgentRuntime,
    checks: { run: forbidden } as CheckPort,
    workspaces: { prepare: forbidden } as WorkspacePort,
  });
  const scheduled: { projectId: string; runId: string }[] = [];
  service.schedule = (projectId, runId) => {
    scheduled.push({ projectId, runId });
  };
  const goals = new GoalService(env),
    roles = new RoleService(env);
  const coordinator = await roles.save('coordinator', 'coordinator', {
    projectId: 'p',
    id: 'coordinator',
    expectedVersion: 0,
    title: 'Original coordinator',
    description: 'Keep pinned coordinator',
    instructions: 'Original coordinator instructions',
    kind: 'coordination',
    runtimePreference: { mode: 'fixed', runtimeId: pinned.id },
  });
  const shared = material(1, 'project'),
    selected = material(2, 'goal');
  await authority.materials.transaction(command('materials'), (tx) =>
    tx.attach([shared, selected]),
  );
  const goal = await goals.create('goal', 'goal', {
    projectId: 'p',
    title: 'Complete attempt task',
    body: 'Original full task. '.repeat(400),
    criteria: 'Original exact criterion. '.repeat(200),
    materialIds: [selected.id],
  });
  const { runId } = await service.start('queue', 'queue', { projectId: 'p', goalId: goal.id });
  const initial = await authority.runs.current(runId);
  if (ready) {
    await service.beginExecution('p', runId);
    await service.phase('p', runId, 'preparing', 'Prepare original workspace');
    await service.bindPreparedWorkspace('p', runId, workspace);
    await service.phase('p', runId, 'planning', 'Accept original plan');
    await service.acceptPlan('p', runId, plan, { builder: null });
  }
  const events = async () => {
    if (authority instanceof SqliteProjectUsageAuthority)
      return (await authority.pagedEvents({ after: 0, limit: 1000 })).events.map(
        ({ sequence: _, projectId: __, ...change }) => change,
      );
    const changes: unknown[] = [];
    authority.subscribe(0, (event) => changes.push(event.change))();
    return changes;
  };
  t.after(async () => {
    await service.dispose();
    await authority.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    project,
    workspace,
    runId,
    initial: initial!,
    goal,
    coordinator,
    pinned,
    resources,
    shared,
    selected,
    service,
    store,
    goals,
    roles,
    scheduled,
    queries,
    events,
    runs: () => authority.runs,
    effects: () => effects,
    async stop(text = 'Observed unsuccessful attempt') {
      return service.finish('p', runId, 'failed', text);
    },
    async resume(
      id: string,
      mode: 'repair' | 'recheck' = 'repair',
      useCurrentProfile = false,
      instructions = 'Complete clarification. '.repeat(100),
    ) {
      return service.resume(id, id, {
        projectId: 'p',
        runId,
        mode,
        instructions,
        useCurrentProfile,
      });
    },
    async reopen() {
      await authority.close();
      await open();
    },
    async proposal(
      attemptId: string,
      mode: 'repair' | 'recheck' = 'repair',
      useCurrentProfile = false,
    ) {
      const current = await authority.runs.currentAttempt(runId),
        savedProfile = await authority.settings.profile(),
        savedGoal = await authority.entities.goal(goal.id);
      return {
        runId,
        attemptId,
        expectedAttemptId: current.attempt.id,
        expectedGoalRevision: savedGoal!.revision!,
        expectedProfileRevision: savedProfile?.revision ?? null,
        mode,
        instructions: 'Complete immutable continuation instructions. '.repeat(100),
        useCurrentProfile,
        now: env.now(),
        policy: useCurrentProfile ? executionPolicy(savedProfile!) : current.context.policy,
        repairCapabilities: { managedEnvironment: false, synchronizeDependencies: false },
      };
    },
    async failStorage(type: 'stop' | 'continue', enabled: boolean) {
      if (authority instanceof SqliteProjectUsageAuthority)
        await failAttemptTimelineInsert(directory, type, enabled);
      else
        authority.replace = enabled
          ? async () => {
              throw Error('injected attempt file failure');
            }
          : fs.rename;
    },
    async unresolved(targetRunId = runId) {
      if (authority instanceof SqliteProjectUsageAuthority)
        await markAttemptUnresolved(directory, targetRunId);
      else {
        allowLegacy = true;
        try {
          await service.update('p', targetRunId, (run) => {
            run.reconciliation = {
              version: 1,
              status: 'required',
              code: 'SESSION_RECONCILIATION_REQUIRED',
              detectedAt: 'unknown-time',
              threadId: 'unknown-thread',
              operationId: 'unknown-operation',
            };
          });
        } finally {
          allowLegacy = false;
        }
      }
    },
    async withLegacy<T>(action: () => Promise<T>): Promise<T> {
      allowLegacy = true;
      try {
        return await action();
      } finally {
        allowLegacy = false;
      }
    },
    async schedulerRace(
      options: { cancelBeforeRelease?: boolean; environmentReleaseFailure?: boolean } = {},
    ) {
      assert.ok(authority instanceof FileProjectStore);
      const firstStopped = deferred(),
        resumeCommitted = deferred(),
        staleChecked = deferred(),
        cleanupRelease = deferred(),
        secondStopped = deferred();
      let runs = 0,
        cleanupDone = false;
      let prepares = 0,
        restores = 0;
      const dispatchedAttempts: string[] = [];
      const limit = async (promise: Promise<void>, label: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(Error('Timed out waiting for ' + label)), 5000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      service.env.workspaces.prepare = async () => {
        prepares++;
        return { ...workspace };
      };
      service.env.workspaces.restore = async (_p, _r, path, base) => {
        restores++;
        return { path, base };
      };
      if (options.environmentReleaseFailure)
        service.env.environments = {
          prepare: async () => ({ name: 'Synthetic environment readiness', passed: true }),
          release: async () => {
            throw Error('Observed synthetic environment release failure');
          },
        };
      service.env.runtime.release = async (thread) => {
        assert.equal(thread, 'old-runtime');
        await resumeCommitted.promise;
        const currentBefore = await authority.runs.current(runId);
        await assert.rejects(
          service.update(
            'p',
            runId,
            (run) => {
              run.summary = 'Old job must not overwrite new attempt';
            },
            undefined,
            initial!.attemptId,
          ),
        );
        await assert.rejects(
          service.finish(
            'p',
            runId,
            'failed',
            'Stale old completion',
            undefined,
            undefined,
            initial!.attemptId,
          ),
        );
        assert.deepEqual(await authority.runs.current(runId), currentBefore);
        staleChecked.resolve();
        await cleanupRelease.promise;
        cleanupDone = true;
      };
      service.orchestrate = async (_projectId, _runId, _workspace, _policy, _signal, threads) => {
        runs++;
        dispatchedAttempts.push((await authority.runs.current(runId))!.attemptId);
        if (runs === 1) {
          threads.push('old-runtime');
          await service.finish('p', runId, 'failed', 'Stopped before old runtime cleanup');
          firstStopped.resolve();
        } else {
          assert.equal(cleanupDone, true, 'New attempt dispatched before old cleanup finished.');
          await service.finish('p', runId, 'failed', 'Synthetic second attempt stopped');
          secondStopped.resolve();
        }
      };
      service.schedule = ExecutionService.prototype.schedule.bind(service);
      allowLegacy = true;
      try {
        service.schedule('p', runId);
        await limit(firstStopped.promise, 'real first stop');
        const oldJob = service.jobs.get(runId)!;
        await service.resume('during-cleanup', 'during-cleanup', {
          projectId: 'p',
          runId,
          mode: 'repair',
          instructions: 'Continue after cleanup',
          useCurrentProfile: false,
        });
        const queued = await authority.runs.current(runId);
        assert.notEqual(queued!.attemptId, initial!.attemptId);
        assert.equal(queued!.status, 'queued');
        if (options.cancelBeforeRelease) {
          await service.cancel('cancel-new-before-release', 'cancel-new-before-release', {
            projectId: 'p',
            runId,
          });
          assert.equal((await authority.runs.current(runId))?.status, 'canceling');
        }
        resumeCommitted.resolve();
        await limit(staleChecked.promise, 'stale old callback guards');
        assert.equal(runs, 1);
        cleanupRelease.resolve();
        if (options.cancelBeforeRelease) {
          await Promise.allSettled([oldJob.promise]);
          const current = await authority.runs.current(runId),
            stop = await authority.runs.attemptStop(queued!.attemptId);
          assert.equal(current?.attemptId, queued!.attemptId);
          assert.equal(current?.status, 'interrupted');
          assert.equal(stop?.attemptId, queued!.attemptId);
          assert.equal(stop?.status, 'interrupted');
          assert.equal(
            (await authority.runs.attemptStop(initial!.attemptId))?.text,
            'Stopped before old runtime cleanup',
          );
          assert.equal(runs, 1);
          assert.equal(prepares, 1);
          assert.equal(restores, 0);
          assert.equal(service.jobs.size, 0);
          return dispatchedAttempts;
        }
        await limit(secondStopped.promise, 'new attempt scheduled after cleanup');
        await Promise.allSettled([...service.jobs.values()].map((job) => job.promise));
        if (options.environmentReleaseFailure)
          assert.equal((await Promise.allSettled([oldJob.promise]))[0].status, 'rejected');
        assert.equal(runs, 2);
        assert.equal(new Set(dispatchedAttempts).size, 2);
        assert.equal(service.jobs.size, 0);
        return dispatchedAttempts;
      } finally {
        resumeCommitted.resolve();
        cleanupRelease.resolve();
        await Promise.allSettled([...service.jobs.values()].map((job) => job.promise));
        allowLegacy = false;
      }
    },
    fileSnapshot() {
      assert.ok(authority instanceof FileProjectStore);
      return authority.snapshot();
    },
  };
}

test('file: a real continuation queued during old cleanup dispatches once after release and stale old callbacks cannot settle it', async (t) => {
  const f = await fixture(t, 'file', false);
  const attempts = await f.schedulerRace();
  assert.equal(attempts[0], f.initial.attemptId);
  assert.equal((await f.runs().currentAttempt(f.runId)).attempt.id, attempts[1]);
  assert.equal(f.effects(), 0);
});

test('file: canceling the queued new attempt during old cleanup settles that exact attempt without restore or dispatch', async (t) => {
  const f = await fixture(t, 'file', false);
  const attempts = await f.schedulerRace({ cancelBeforeRelease: true });
  assert.deepEqual(attempts, [f.initial.attemptId]);
  assert.equal((await f.runs().current(f.runId))?.status, 'interrupted');
  assert.equal(f.effects(), 0);
});

test('file: rejecting old environment cleanup does not lose the queued successor or surface an unhandled detached job', async (t) => {
  const f = await fixture(t, 'file', false);
  const attempts = await f.schedulerRace({ environmentReleaseFailure: true });
  assert.equal(attempts.length, 2);
  assert.equal((await f.runs().currentAttempt(f.runId)).attempt.id, attempts[1]);
  assert.equal(f.effects(), 0);
});

test('file: unchanged-goal repair retains actual successful worker evidence and does not request that worker again', async (t) => {
  const f = await fixture(t, 'file');
  const grant = await f.runs().assignment(f.runId, 'builder');
  f.service.env.workspaces.changes = async () => [];
  f.service.env.runtime.start = async () => ({ threadId: 'successful-builder-thread' });
  f.service.env.runtime.release = async () => {};
  await f.withLegacy(() =>
    f.service.dispatchWorkers(
      'p',
      f.runId,
      [grant!.role],
      f.workspace,
      executionPolicy(profile),
      new AbortController().signal,
      [],
      async () => ({
        status: 'success',
        summary: 'Observed successful scoped worker',
        artifacts: [],
        notesForNextAgent: '',
      }),
    ),
  );
  const completed = f
    .fileSnapshot()
    .runs.find((run) => run.id === f.runId)!
    .agents.find((agent) => agent.session?.roleId === 'builder')!;
  assert.equal(completed.status, 'completed');
  await f.stop('Coordinator needs another attempt');
  await f.resume('retain-successful-worker');
  const current = await f.runs().currentAttempt(f.runId),
    run = f.fileSnapshot().runs.find((run) => run.id === f.runId)!;
  assert.equal(current.context.taskChanged, false);
  assert.deepEqual(
    run.agents.find((agent) => agent.session?.id === completed.session!.id),
    completed,
  );
  assert.deepEqual(pendingWorkerRoles(run, [grant!.role]), []);
  assert.equal(f.effects(), 0);
});

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: competing actual continuation commands authorize exactly one successor of a stopped attempt`, async (t) => {
    const f = await fixture(t, kind);
    await f.stop();
    const initial = await f.runs().currentAttempt(f.runId);
    const results = await Promise.allSettled([
      f.resume('competing-first'),
      f.resume('competing-second'),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const current = await f.runs().currentAttempt(f.runId);
    assert.equal(current.attempt.ordinal, initial.attempt.ordinal + 1);
    assert.equal(current.attempt.priorAttemptId, initial.attempt.id);
    assert.equal(
      (await f.events()).filter((event: any) => event.type === 'run.attempt-continued').length,
      1,
    );
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: indexed active work and an older unresolved Run block actual continuation without replaying effects`, async (t) => {
    const f = await fixture(t, kind);
    await f.stop();
    const secondGoal = await f.goals.create('second-goal', 'second-goal', {
      projectId: 'p',
      title: 'Other active goal',
      body: 'Synthetic work',
      criteria: 'No dispatch',
    });
    const second = await f.service.start('second-run', 'second-run', {
      projectId: 'p',
      goalId: secondGoal.id,
    });
    await assert.rejects(f.resume('busy-continuation'), { code: 'PROJECT_BUSY' });
    await f.service.finish('p', second.runId, 'failed', 'Genuine queue stopped before dispatch');
    const newer = await f.service.start('newer-same-goal', 'newer-same-goal', {
      projectId: 'p',
      goalId: f.goal.id,
    });
    await f.service.beginExecution('p', newer.runId);
    await f.service.phase('p', newer.runId, 'preparing', 'Prepare newer sibling');
    await f.service.bindPreparedWorkspace('p', newer.runId, {
      path: f.workspace.path + '-newer',
      base: f.workspace.base,
    });
    await f.service.finish('p', newer.runId, 'failed', 'Genuine newer sibling stopped');
    await f.unresolved(f.runId);
    const before = await f.events();
    await assert.rejects(
      f.service.resume('unknown-continuation', 'unknown-continuation', {
        projectId: 'p',
        runId: newer.runId,
        mode: 'repair',
        instructions: 'Older unresolved sibling must block this named newer Run',
        useCurrentProfile: false,
      }),
      { code: 'RUN_RECONCILIATION_REQUIRED' },
    );
    assert.deepEqual(await f.events(), before);
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: genuine stop and repeated repair/recheck append distinct monotonic attempts with original workspace/plan lineage`, async (t) => {
    const f = await fixture(t, kind);
    const original = await f.runs().currentAttempt(f.runId),
      workspace = await f.runs().workspace(f.runId),
      savedPlan = await f.runs().plan(f.runId),
      grant = await f.runs().assignment(f.runId, 'builder');
    assert.equal(original.attempt.ordinal, 1);
    await f.stop();
    let previous = original;
    for (const [index, mode] of (['repair', 'recheck', 'repair'] as const).entries()) {
      const instructions = 'Complete clarification ' + index + '. '.repeat(200);
      await f.resume('resume-' + index, mode, false, instructions);
      const next = await f.runs().currentAttempt(f.runId);
      assert.notEqual(next.attempt.id, previous.attempt.id);
      assert.equal(next.attempt.ordinal, index + 2);
      assert.equal(next.attempt.reason, mode);
      assert.equal(next.attempt.priorAttemptId, previous.attempt.id);
      assert.equal(next.context.continuation?.instructions, instructions);
      assert.equal(next.context.workspaceOriginAttemptId, original.attempt.id);
      assert.equal(next.context.inheritedPlanId, savedPlan?.id);
      assert.equal(next.context.planOriginAttemptId, original.attempt.id);
      assert.deepEqual(await f.runs().workspace(f.runId), workspace);
      assert.deepEqual(await f.runs().plan(f.runId), savedPlan);
      assert.deepEqual(await f.runs().assignment(f.runId, 'builder'), grant);
      assert.deepEqual(await f.runs().attempt(original.attempt.id), original);
      assert.equal((await f.runs().current(f.runId))?.status, 'queued');
      await f.service.beginExecution('p', f.runId);
      await f.service.phase('p', f.runId, 'repair', 'Resume inherited workspace');
      await f.stop('Stopped attempt ' + next.attempt.ordinal);
      previous = next;
    }
    await f.reopen();
    assert.equal((await f.runs().currentAttempt(f.runId)).attempt.ordinal, 4);
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: continuation keeps complete task/material context and frozen selected coordinator while honoring retained/current profile`, async (t) => {
    const f = await fixture(t, kind);
    const original = await f.runs().currentAttempt(f.runId);
    await f.stop();
    const newShared = material(3, 'project'),
      newSelected = material(4, 'goal');
    await f.store.materials.transaction(command('new-materials'), (tx) =>
      tx.attach([newShared, newSelected]),
    );
    await f.store.materials.transaction(command('remove-old-shared'), (tx) =>
      tx.remove(f.shared.id),
    );
    const updated = await f.goals.update('edit-goal', 'edit-goal', {
      projectId: 'p',
      id: f.goal.id,
      expectedRevision: 1,
      title: 'Updated complete task',
      body: 'Updated complete requirement. '.repeat(400),
      criteria: 'Updated exact criteria. '.repeat(200),
      materialIds: [newSelected.id],
    });
    const newProfile = await f.store.settings.transaction(command('profile-v2'), (tx) =>
      tx.configure({
        expectedRevision: 1,
        profile: {
          ...profile,
          context: 'New project context',
          scope: { ...profile.scope, plannedPaths: ['src/', 'docs/'] },
        },
      }),
    );
    await f.roles.save('coordinator-v2', 'coordinator-v2', {
      ...f.coordinator,
      projectId: 'p',
      expectedVersion: 1,
      instructions: 'New team coordinator only',
      runtimePreference: { mode: 'fixed', runtimeId: 'fake' },
    });
    await f.resume('retained-policy', 'repair', false);
    const retained = await f.runs().currentAttempt(f.runId);
    assert.equal(
      retained.context.goalText,
      updated.body + '\n\nAcceptance criteria:\n' + updated.criteria,
    );
    assert.deepEqual(retained.context.goal, updated);
    assert.deepEqual(retained.context.policy, original.context.policy);
    assert.deepEqual(retained.context.resources, original.context.resources);
    assert.deepEqual(
      retained.context.roleResources.coordinator,
      original.context.roleResources.coordinator,
    );
    assert.equal(retained.context.roleResources.coordinator.resource.id, f.pinned.id);
    assert.deepEqual(
      retained.context.roleSnapshots.filter((role) =>
        ['coordinator', 'reviewer'].includes(role.id),
      ),
      original.context.roleSnapshots,
    );
    assert.equal(retained.context.taskMode, 'full-goal');
    assert.equal(retained.context.taskChanged, true);
    assert.deepEqual(
      retained.context.contextMaterials.map((item) => item.id).sort(),
      [f.shared.id, newSelected.id].sort(),
    );
    await f.stop();
    await f.resume('current-policy', 'repair', true);
    const current = await f.runs().currentAttempt(f.runId);
    assert.equal(current.context.policy.profile?.revision, newProfile.revision);
    assert.deepEqual(current.context.policy.scope, newProfile.scope);
    assert.equal(current.context.taskMode, 'full-goal');
    assert.equal(current.context.taskChanged, false);
    assert.deepEqual(
      current.context.contextMaterials.map((item) => item.id).sort(),
      [newShared.id, newSelected.id].sort(),
    );
    assert.deepEqual(
      current.context.roleResources.coordinator,
      original.context.roleResources.coordinator,
    );
    assert.deepEqual((await f.runs().attempt(f.initial.attemptId))?.context.goal, f.goal);
    if (kind === 'file')
      assert.equal(f.fileSnapshot().runs.find((run) => run.id === f.runId)?.workerTasks, undefined);
    await f.reopen();
    assert.deepEqual(await f.runs().currentAttempt(f.runId), current);
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: stale attempt stop/phase and changed goal/profile CAS cannot mutate a later continuation`, async (t) => {
    const f = await fixture(t, kind);
    const old = await f.runs().currentAttempt(f.runId);
    await f.stop();
    const stale = await f.proposal('T-stale');
    await f.goals.update('goal-v2', 'goal-v2', {
      ...f.goal,
      projectId: 'p',
      id: f.goal.id,
      expectedRevision: 1,
      body: 'New exact complete goal',
    });
    await assert.rejects(
      f.runs().transaction(command('stale-context'), (tx) => tx.continueAttempt(stale)),
    );
    assert.equal(await f.runs().receipt(command('stale-context')), undefined);
    await f.resume('legitimate-continuation');
    const before = await f.events(),
      current = await f.runs().currentAttempt(f.runId);
    await assert.rejects(
      f.runs().transaction(command('stale-stop'), (tx) =>
        tx.finishStopped({
          runId: f.runId,
          attemptId: old.attempt.id,
          now: 'stale-time',
          status: 'failed',
          text: 'Old owner must not settle new work',
        }),
      ),
    );
    await assert.rejects(
      f.runs().transaction(command('stale-phase'), (tx) =>
        tx.advancePhase({
          runId: f.runId,
          expectedAttemptId: old.attempt.id,
          now: 'stale-time',
          phase: 'repair',
          text: 'Stale phase',
        }),
      ),
    );
    await assert.rejects(
      f
        .runs()
        .transaction(command('stale-predecessor'), (tx) =>
          tx.continueAttempt({ ...stale, expectedGoalRevision: 2 }),
        ),
    );
    assert.deepEqual(await f.runs().currentAttempt(f.runId), current);
    assert.deepEqual(await f.events(), before);
  });

  test(`${kind}: semantic stop cannot manufacture completion and unknown effects remain needs-attention`, async (t) => {
    const f = await fixture(t, kind);
    const initial = await f.runs().currentAttempt(f.runId);
    await assert.rejects(
      f.runs().transaction(command('forged-completion'), (tx) =>
        tx.finishStopped({
          runId: f.runId,
          attemptId: initial.attempt.id,
          now: 'invalid-time',
          status: 'completed' as 'failed',
          text: 'No acceptance evidence',
        }),
      ),
    );
    assert.equal(await f.runs().attemptStop(initial.attempt.id), undefined);
    await f.unresolved();
    await f.stop('An observed failure cannot clear an older unknown effect');
    assert.equal((await f.runs().current(f.runId))?.status, 'needs-attention');
    assert.equal((await f.runs().attemptStop(initial.attempt.id))?.status, 'needs-attention');
    await assert.rejects(f.resume('unknown-retry'), { code: 'RUN_RECONCILIATION_REQUIRED' });
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: callers cannot supply foreign origin grants or an outdated current profile`, async (t) => {
    const f = await fixture(t, kind);
    await f.stop();
    const initial = await f.runs().currentAttempt(f.runId),
      proposal = await f.proposal('T-forged-origin');
    await assert.rejects(
      f.runs().transaction(command('forged-origin'), (tx) =>
        tx.continueAttempt({
          ...proposal,
          workspaceOriginAttemptId: 'foreign-attempt',
          inheritedPlanId: 'foreign-plan',
        } as typeof proposal),
      ),
    );
    const currentPolicy = await f.proposal('T-stale-policy', 'repair', true);
    await f.store.settings.transaction(command('new-profile'), (tx) =>
      tx.configure({
        expectedRevision: 1,
        profile: { ...profile, context: 'Latest authoritative profile' },
      }),
    );
    await assert.rejects(
      f.runs().transaction(command('stale-policy'), (tx) => tx.continueAttempt(currentPolicy)),
      { code: 'CONFLICT' },
    );
    assert.deepEqual(await f.runs().currentAttempt(f.runId), initial);
    assert.equal(await f.runs().attempt('T-forged-origin'), undefined);
    assert.equal(await f.runs().attempt('T-stale-policy'), undefined);
  });

  test(`${kind}: reverting the goal cannot resurrect compact tasks from an older attempt`, async (t) => {
    const f = await fixture(t, kind);
    await f.stop();
    await f.goals.update('goal-change', 'goal-change', {
      ...f.goal,
      projectId: 'p',
      id: f.goal.id,
      expectedRevision: 1,
      body: 'A genuinely different goal',
    });
    await f.resume('changed-goal');
    assert.equal((await f.runs().currentAttempt(f.runId)).context.taskMode, 'full-goal');
    await f.stop();
    await f.goals.update('goal-revert', 'goal-revert', {
      ...f.goal,
      projectId: 'p',
      id: f.goal.id,
      expectedRevision: 2,
    });
    await f.resume('reverted-goal');
    assert.equal((await f.runs().currentAttempt(f.runId)).context.taskMode, 'full-goal');
    if (kind === 'file')
      assert.equal(f.fileSnapshot().runs.find((run) => run.id === f.runId)?.workerTasks, undefined);
  });

  test(`${kind}: a genuine first plan on the continued task authorizes its compact tasks for the next attempt`, async (t) => {
    const f = await fixture(t, kind, false);
    await f.service.beginExecution('p', f.runId);
    await f.service.phase('p', f.runId, 'preparing', 'Prepare');
    await f.service.bindPreparedWorkspace('p', f.runId, f.workspace);
    await f.stop('Observed failure before a plan existed');
    await f.goals.update('new-goal-before-plan', 'new-goal-before-plan', {
      ...f.goal,
      projectId: 'p',
      id: f.goal.id,
      expectedRevision: 1,
      body: 'Updated task with its own first real plan',
    });
    await f.resume('first-repair');
    const firstRepair = await f.runs().currentAttempt(f.runId);
    assert.equal(firstRepair.context.taskMode, 'full-goal');
    await f.service.beginExecution('p', f.runId);
    await f.service.phase('p', f.runId, 'planning', 'Plan actual continued task');
    const accepted = await f.service.acceptPlan('p', f.runId, plan, { builder: null });
    assert.equal(accepted.plan.attemptId, firstRepair.attempt.id);
    await f.stop();
    await f.resume('repair-after-real-plan');
    const next = await f.runs().currentAttempt(f.runId);
    assert.equal(next.context.taskMode, 'original');
    assert.equal(next.context.planOriginAttemptId, firstRepair.attempt.id);
    assert.equal(next.context.workspaceOriginAttemptId, f.initial.attemptId);
    assert.deepEqual(
      (await f.runs().assignment(f.runId, 'builder'))?.task,
      plan.team[0].assignment,
    );
  });

  test(`${kind}: canonical continuation replay precedes newer state and conflicting command identity`, async (t) => {
    const f = await fixture(t, kind);
    await f.stop();
    const first = await f.resume('canonical');
    const current = await f.runs().currentAttempt(f.runId);
    await f.stop();
    await f.resume('later');
    await f.reopen();
    const before = await f.events();
    assert.deepEqual(await f.resume('canonical'), first);
    assert.equal((await f.runs().currentAttempt(f.runId)).attempt.ordinal, 3);
    assert.notEqual((await f.runs().currentAttempt(f.runId)).attempt.id, current.attempt.id);
    assert.deepEqual(await f.events(), before);
    await assert.rejects(
      f.service.resume('canonical', 'foreign-fingerprint', {
        projectId: 'p',
        runId: f.runId,
        mode: 'repair',
        instructions: '',
        useCurrentProfile: false,
      }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  });

  test(`${kind}: physical stop and continuation failures rollback rows, goal state, current, timeline and receipt before retry`, async (t) => {
    const f = await fixture(t, kind);
    const initial = await f.runs().currentAttempt(f.runId);
    const stop = {
      runId: f.runId,
      attemptId: initial.attempt.id,
      now: 'stop-time',
      status: 'failed' as const,
      text: 'Complete observed stop text. '.repeat(300),
    };
    const beforeStop = await f.events();
    await f.failStorage('stop', true);
    await assert.rejects(
      f.runs().transaction(command('stop-fault'), (tx) => {
        try {
          tx.finishStopped(stop);
        } catch {}
        return { attempted: true };
      }),
      /injected attempt/,
    );
    await f.failStorage('stop', false);
    assert.equal(await f.runs().attemptStop(initial.attempt.id), undefined);
    assert.deepEqual(await f.runs().currentAttempt(f.runId), initial);
    assert.deepEqual(await f.events(), beforeStop);
    assert.equal(await f.runs().receipt(command('stop-fault')), undefined);
    await f.reopen();
    await f.runs().transaction(command('stop-fault'), (tx) => tx.finishStopped(stop));
    const proposal = await f.proposal('T-after-fault');
    const beforeContinue = await f.events();
    await f.failStorage('continue', true);
    await assert.rejects(
      f.runs().transaction(command('continue-fault'), (tx) => {
        try {
          tx.continueAttempt(proposal);
        } catch {}
        return { attempted: true };
      }),
      /injected attempt/,
    );
    await f.failStorage('continue', false);
    assert.equal(await f.runs().attempt('T-after-fault'), undefined);
    assert.equal(await f.runs().receipt(command('continue-fault')), undefined);
    assert.deepEqual(await f.events(), beforeContinue);
    await f.reopen();
    await f.runs().transaction(command('continue-fault'), (tx) => tx.continueAttempt(proposal));
    assert.equal((await f.runs().currentAttempt(f.runId)).attempt.id, 'T-after-fault');
    assert.equal(f.effects(), 0);
  });
}

test('sqlite: named current-attempt reads stay bounded after 64 genuine stop/continuation cycles', async (t) => {
  const f = await fixture(t, 'sqlite');
  await f.stop();
  await f.resume('history-first');
  // Both probes validate an immediate predecessor with a stored continuation context.
  // The initial predecessor instead derives its context from immutable admission.
  await f.stop();
  await f.resume('history-second');
  f.queries.length = 0;
  const first = await f.runs().currentAttempt(f.runId);
  const before = f.queries.map(({ operation, rows }) => ({ operation, rows }));
  for (let index = 0; index < 64; index++) {
    await f.stop();
    await f.resume('history-' + index, index % 2 ? 'repair' : 'recheck');
  }
  await f.reopen();
  f.queries.length = 0;
  const latest = await f.runs().currentAttempt(f.runId);
  const after = f.queries.map(({ operation, rows }) => ({ operation, rows }));
  assert.equal(latest.attempt.ordinal, first.attempt.ordinal + 64);
  assert.deepEqual(after, before);
  assert.ok(after.every((query) => !/timeline|history|all|list/.test(query.operation)));
  assert.equal(f.effects(), 0);
});
