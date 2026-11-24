import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { GoalService } from '../core/services.ts';
import { executionPolicy } from '../core/project-settings.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import type { DelegateRunWorker } from '../core/project-run-delegations.ts';
import {
  setUnresolvedDelegationFact,
  failDelegationTimelineInsert,
  forgeInheritedTaskMode,
} from './fixtures/sqlite-run-delegation-fault.ts';
import { applyEvent } from '../clients/socket-client.ts';
import { parseDomainEvent, parseSnapshot } from '../protocol/schema.ts';
import { buildWorkerEnvelope } from '../core/worker-envelope.ts';

const profile: ProjectProfile = {
  version: 1,
  revision: 1,
  context: 'Controlled delegation proof',
  scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['src/private/', 'AGENTS.md'] },
  checks: [{ id: 'test', title: 'Test', command: 'must-not-run', timeoutMs: 1000 }],
  defaultCheckIds: ['test'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 2,
  turnTimeoutMs: 10000,
};
const command = (id: string) => ({ id, fingerprint: 'delegate:' + id });

async function fixture(t: any, kind: 'file' | 'sqlite') {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-run-delegation-direct-')),
  );
  await fs.writeFile(path.join(directory, '.delegation-fault-fixture'), 'synthetic-only');
  const project = { id: 'p', name: 'Direct delegation', root: directory, managed: true };
  let authority: FileProjectStore | SqliteProjectUsageAuthority;
  const open = async () => {
    authority =
      kind === 'file'
        ? await FileProjectStore.open({ directory, project, profile })
        : await SqliteProjectUsageAuthority.open({ directory, project, profile });
  };
  await open();
  let ticks = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1) + ++ticks * 1000).toISOString();
  const goals = new GoalService({
    projects: { get: () => authority as any, list: () => [project] },
    id: () => String(++ticks),
    now,
  });
  const goal = await goals.create('goal', 'goal', {
    projectId: 'p',
    title: 'A complete task',
    body: 'Original body',
    criteria: 'Original criteria',
  });
  const roles = createBuiltinWorkflowRoles();
  const resources = fixtureExecutionSelection(
    'runtime',
    fixtureExecutionCapabilities({ strictPlannedWrites: true }),
  ).forProject('p');
  const policy = executionPolicy(profile);
  const runId = 'R-direct',
    attemptId = 'T-original';
  await authority.runs.transaction(command('admit'), (tx) =>
    tx.admit(
      {
        runId,
        admissionId: 'A-direct',
        attemptId,
        goalId: goal.id,
        now: now(),
        expectedGoalRevision: goal.revision!,
        expectedProfileRevision: 1,
        policy,
        resources,
        workflow: { ...roles.workflow, actionsRevision: 'test-action-catalog' },
        repairCapabilities: { managedEnvironment: false, synchronizeDependencies: false },
      },
      roles,
    ),
  );
  await authority.runs.transaction(command('begin'), (tx) =>
    tx.beginExecution({ runId, now: now(), expectedAttemptId: attemptId }),
  );
  await authority.runs.transaction(command('preparing'), (tx) =>
    tx.advancePhase({
      runId,
      now: now(),
      phase: 'preparing',
      text: 'Prepare workspace',
      expectedAttemptId: attemptId,
    }),
  );
  await authority.runs.transaction(command('workspace'), (tx) =>
    tx.bindPreparedWorkspace({
      runId,
      path: path.join(directory, 'workspace'),
      baseCommit: 'a'.repeat(40),
      now: now(),
      expectedAttemptId: attemptId,
    }),
  );
  await authority.runs.transaction(command('implementation'), (tx) =>
    tx.advancePhase({
      runId,
      now: now(),
      phase: 'implementation',
      text: 'Orchestrate work',
      expectedAttemptId: attemptId,
    }),
  );
  const proposal = async (roleId: string): Promise<DelegateRunWorker> => ({
    runId,
    assignmentId: 'D-' + roleId,
    now: now(),
    expectedRoleVersion: null,
    expectedInput: await authority.runs.delegationContext(runId),
    expectedAttemptId: (await authority.runs.current(runId))!.attemptId,
    worker: {
      roleId,
      action: 'create',
      title: roleId,
      description: 'A focused reusable specialist',
      instructions: 'Complete the assigned bounded task.',
      kind: 'implementation',
      paths: ['src/' + roleId + '.ts'],
      runtimeId: null,
      runtimeReason: '',
      assignment: {
        objective: 'Implement the requested behavior',
        inputs: ['src/' + roleId + '.ts'],
        expectedResult: 'The specified behavior',
        criteria: ['Preserve the complete goal criteria'],
      },
    },
  });
  const events = async () => {
    if (authority instanceof SqliteProjectUsageAuthority)
      return (await authority.pagedEvents({ after: 0, limit: 1000 })).events.map(
        ({ sequence: _sequence, projectId: _projectId, ...value }) => value,
      );
    const result: unknown[] = [];
    authority.subscribe(0, (e) => result.push(e.change))();
    return result;
  };
  t.after(async () => {
    await authority.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    runId,
    attemptId,
    goal,
    goals,
    now,
    policy,
    directory,
    proposal,
    events,
    projection: async () => {
      let snapshot = parseSnapshot({
        version: 1,
        project: authority.project,
        revision: 0,
        sequence: 0,
        roles: [],
        goals: [],
        runs: [],
        capabilities: [],
        profile,
      });
      for (const [index, change] of (await events()).entries())
        snapshot = applyEvent(
          snapshot,
          parseDomainEvent({
            version: 1,
            id: 'actual-event-' + index,
            projectId: project.id,
            seq: index + 1,
            at: now(),
            change,
          }),
        );
      return snapshot;
    },
    store: () => authority,
    runs: () => authority.runs,
    delegate: async (input: DelegateRunWorker, id = input.assignmentId) =>
      authority.runs.transaction(command(id), (tx) => tx.delegateWorker(input)),
    reopen: async () => {
      await authority.close();
      await open();
    },
    stop: async () => {
      const current = (await authority.runs.current(runId))!;
      await authority.runs.transaction(command('stop-' + current.attemptId), (tx) =>
        tx.finishStopped({
          runId,
          attemptId: current.attemptId,
          now: now(),
          status: 'needs-attention',
          text: 'Recorded intervention',
        }),
      );
    },
    resume: async (id: string) => {
      const current = await authority.runs.currentAttempt(runId),
        currentGoal = (await authority.entities.goal(goal.id))!;
      await authority.runs.transaction(command('continue-' + id), (tx) =>
        tx.continueAttempt({
          runId,
          attemptId: id,
          expectedAttemptId: current.attempt.id,
          expectedGoalRevision: currentGoal.revision!,
          expectedProfileRevision: 1,
          mode: 'repair',
          instructions: 'Continue from observed evidence',
          useCurrentProfile: false,
          now: now(),
          policy: current.context.policy,
          repairCapabilities: { managedEnvironment: false, synchronizeDependencies: false },
        }),
      );
      await authority.runs.transaction(command('begin-' + id), (tx) =>
        tx.beginExecution({ runId, now: now(), expectedAttemptId: id }),
      );
    },
    unknown: async () => {
      if (kind === 'sqlite') return setUnresolvedDelegationFact(directory, runId);
      const store = authority as FileProjectStore;
      await store.transact('unknown', 'unknown', (draft) => {
        const run = draft.runs.find((r) => r.id === runId)!;
        run.reconciliation = {
          version: 1,
          status: 'required',
          code: 'SESSION_RECONCILIATION_REQUIRED',
          detectedAt: now(),
          threadId: 'unknown-thread',
          operationId: 'unknown-operation',
        };
        return {
          result: null,
          change: { type: 'run.changed', run, goal: draft.goals.find((g) => g.id === goal.id)! },
        };
      });
    },
    fail: async (enabled: boolean) => {
      if (kind === 'sqlite') return failDelegationTimelineInsert(directory, enabled);
      (authority as FileProjectStore).replace = enabled
        ? async () => {
            throw Error('injected delegation file failure');
          }
        : fs.rename;
    },
  };
}

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: direct grants retain delegation order across repeated continuation when role IDs sort differently`, async (t) => {
    const f = await fixture(t, kind);
    const zeta = await f.delegate(await f.proposal('zeta'));
    const alpha = await f.delegate(await f.proposal('alpha'));
    for (const id of ['T-ordered-first', 'T-ordered-second']) {
      await f.stop();
      await f.resume(id);
      const context = (await f.runs().currentAttempt(f.runId)).context;
      assert.deepEqual(
        context.roleSnapshots.slice(2).map((role) => role.id),
        ['zeta', 'alpha'],
      );
      assert.deepEqual(context.inheritedAssignments, {
        zeta: { id: zeta.id, taskMode: 'original' },
        alpha: { id: alpha.id, taskMode: 'original' },
      });
      await f.reopen();
      assert.deepEqual(await f.runs().assignments(f.runId), [zeta, alpha]);
    }
  });

  test(`${kind}: successive delegation decisions need no accepted plan and preserve every original grant after reopening`, async (t) => {
    const f = await fixture(t, kind),
      first = await f.proposal('builder');
    const before = kind === 'file' ? (f.store() as FileProjectStore).snapshot() : undefined;
    const one = await f.delegate(first);
    assert.equal(first.expectedInput.workflow.actionsRevision, 'test-action-catalog');
    assert.equal(one.role.provenance.workflow?.actionsRevision, 'test-action-catalog');
    const two = await f.delegate(await f.proposal('tester'));
    assert.deepEqual(await f.runs().assignment(f.runId, 'builder'), one);
    assert.deepEqual(await f.runs().assignments(f.runId), [one, two]);
    if (before) {
      let projected = before;
      const changes = (await f.events()).filter(
        (value: any) => value.type === 'run.worker-delegated',
      );
      for (const [index, change] of changes.entries())
        projected = applyEvent(
          projected,
          parseDomainEvent({
            version: 1,
            id: 'delegation-' + index,
            projectId: 'p',
            seq: before.sequence + index + 1,
            at: f.now(),
            change,
          }),
        );
      const actual = (f.store() as FileProjectStore).snapshot();
      assert.deepEqual(projected.runs[0].roleAssignments, actual.runs[0].roleAssignments);
      assert.deepEqual(projected.roles, actual.roles);
      await (f.store() as FileProjectStore).transact('living-plan', 'living-plan', (draft) => {
        const run = draft.runs[0];
        run.plan = [{ step: 'Inspect the new evidence', owner: 'coordinator' }];
        return { result: null, change: { type: 'run.changed', run, goal: draft.goals[0] } };
      });
    }
    await f.reopen();
    assert.deepEqual(await f.runs().assignments(f.runId), [one, two]);
    const replay = await f.delegate(first);
    assert.deepEqual(replay, one);
    const again = { ...(await f.proposal('builder')), expectedRoleVersion: 1 };
    assert.deepEqual(await f.delegate(again, 'reuse-same-grant'), one);
    assert.equal((await f.runs().assignments(f.runId)).length, 2);
  });

  test(`${kind}: captured scope, fixed resources, role version, attempt and team allowance reject before authorizing a worker`, async (t) => {
    const f = await fixture(t, kind),
      before = await f.events();
    for (const [id, change] of [
      [
        'paths',
        (p: DelegateRunWorker) => {
          p.worker.paths = ['src/private/secret.ts'];
        },
      ],
      [
        'runtime',
        (p: DelegateRunWorker) => {
          p.worker.runtimeId = 'not-in-pool';
        },
      ],
      [
        'version',
        (p: DelegateRunWorker) => {
          p.expectedRoleVersion = 3;
        },
      ],
      [
        'attempt',
        (p: DelegateRunWorker) => {
          p.expectedAttemptId = 'T-stale';
        },
      ],
      [
        'input',
        (p: DelegateRunWorker) => {
          p.expectedInput.goalText += ' forged';
        },
      ],
    ] as const) {
      const input = await f.proposal(id);
      change(input);
      await assert.rejects(f.delegate(input));
      assert.equal(await f.runs().receipt(command(input.assignmentId)), undefined);
      assert.equal(await f.store().entities.role(id), undefined);
      assert.equal(await f.runs().assignment(f.runId, id), undefined);
    }
    assert.deepEqual(await f.events(), before);
    await f.delegate(await f.proposal('one'));
    await f.delegate(await f.proposal('two'));
    await assert.rejects(f.delegate(await f.proposal('three')), { code: 'INVALID_ASSIGNMENT' });
    assert.equal(await f.store().entities.role('three'), undefined);
  });

  test(`${kind}: a revised task advances the same role assignment and preserves its predecessor`, async (t) => {
    const f = await fixture(t, kind),
      input = await f.proposal('builder'),
      original = await f.delegate(input);
    const changed = { ...(await f.proposal('builder')), expectedRoleVersion: 1 };
    changed.assignmentId = original.id + '-repair';
    changed.worker.action = 'reuse';
    changed.worker.assignment!.objective = 'A refined repair task';
    const next = await f.delegate(changed, 'retarget');
    assert.notEqual(next.id, original.id);
    assert.equal(next.previousAssignmentId, original.id);
    assert.equal(next.task?.objective, 'A refined repair task');
    assert.deepEqual(next.role, original.role);
    assert.deepEqual(await f.runs().assignment(f.runId, 'builder'), next);
    await f.reopen();
    assert.deepEqual(await f.runs().assignment(f.runId, 'builder'), next);
  });

  test(`${kind}: genuine stop and repair inherit exact assignment IDs without a plan and do not resurrect compact tasks after a goal edit`, async (t) => {
    const f = await fixture(t, kind),
      original = await f.delegate(await f.proposal('builder'));
    await f.stop();
    await f.resume('T-repair');
    let context = (await f.runs().currentAttempt(f.runId)).context;
    assert.equal(context.workflow.actionsRevision, 'test-action-catalog');
    assert.deepEqual(context.inheritedAssignments, {
      builder: { id: original.id, taskMode: 'original' },
    });
    assert.equal(context.taskMode, 'original');
    assert.deepEqual(await f.runs().assignment(f.runId, 'builder'), original);
    const added = await f.delegate(await f.proposal('tester'));
    await f.stop();
    await f.goals.update('edit', 'edit', {
      ...f.goal,
      projectId: 'p',
      id: f.goal.id,
      expectedRevision: 1,
      body: 'Revised complete goal',
    });
    await f.resume('T-edited');
    context = (await f.runs().currentAttempt(f.runId)).context;
    assert.deepEqual(context.inheritedAssignments, {
      builder: { id: original.id, taskMode: 'full-goal' },
      tester: { id: added.id, taskMode: 'full-goal' },
    });
    assert.equal(context.taskMode, 'full-goal');
    assert.equal(context.taskChanged, true);
    await f.reopen();
    assert.deepEqual(await f.runs().assignments(f.runId), [original, added]);
    if (kind === 'file')
      assert.equal((f.store() as FileProjectStore).snapshot().runs[0].workerTasks, undefined);
  });

  test(`${kind}: an indexed unknown outcome rejects additional delegation`, async (t) => {
    const f = await fixture(t, kind);
    const first = await f.delegate(await f.proposal('builder'));
    await f.unknown();
    await assert.rejects(f.delegate(await f.proposal('tester')), {
      code: 'RUN_RECONCILIATION_REQUIRED',
    });
    assert.deepEqual(await f.runs().assignments(f.runId), [first]);
    assert.equal(await f.store().entities.role('tester'), undefined);
  });

  test(`${kind}: cancellation rejects delegation without creating a role or grant`, async (t) => {
    const f = await fixture(t, kind),
      input = await f.proposal('builder');
    await f
      .runs()
      .transaction(command('cancel'), (tx) =>
        tx.requestCancel({ runId: f.runId, now: f.now(), expectedAttemptId: f.attemptId }),
      );
    const before = await f.events();
    await assert.rejects(f.delegate(input), { name: 'AbortError' });
    assert.deepEqual(await f.events(), before);
    assert.equal(await f.store().entities.role('builder'), undefined);
    assert.equal(await f.runs().assignment(f.runId, 'builder'), undefined);
  });

  test(`${kind}: physical failure rolls back grant, role, heads, public event and receipt before an identical retry`, async (t) => {
    const f = await fixture(t, kind),
      input = await f.proposal('builder'),
      before = await f.events();
    await f.fail(true);
    await assert.rejects(
      f.runs().transaction(command(input.assignmentId), (tx) => {
        try {
          return tx.delegateWorker(input);
        } catch {
          return null;
        }
      }),
    );
    await f.fail(false);
    assert.deepEqual(await f.events(), before);
    assert.equal(await f.store().entities.role('builder'), undefined);
    assert.deepEqual(await f.runs().assignments(f.runId), []);
    assert.equal(await f.runs().receipt(command(input.assignmentId)), undefined);
    await f.reopen();
    const grant = await f.delegate(input);
    assert.equal(grant.id, input.assignmentId);
    assert.deepEqual(await f.runs().assignments(f.runId), [grant]);
  });

  test(`${kind}: a new compact task on a revised goal survives the next unchanged continuation`, async (t) => {
    const f = await fixture(t, kind);
    await f.stop();
    await f.goals.update('revise-goal', 'revise-goal', {
      ...f.goal,
      projectId: 'p',
      id: f.goal.id,
      expectedRevision: 1,
      body: 'G2 complete requirement',
    });
    await f.resume('T-G2');
    assert.equal((await f.runs().currentAttempt(f.runId)).context.taskMode, 'full-goal');
    const proposal = await f.proposal('new_builder');
    proposal.worker.assignment!.objective = 'Focused task for G2';
    const grant = await f.delegate(proposal);
    await f.stop();
    await f.resume('T-G2-again');
    const context = (await f.runs().currentAttempt(f.runId)).context;
    assert.deepEqual(context.inheritedAssignments, {
      new_builder: { id: grant.id, taskMode: 'original' },
    });
    assert.deepEqual((await f.projection()).runs[0].workerTasks, { new_builder: grant.task });
    await f.reopen();
    assert.deepEqual((await f.projection()).runs[0].workerTasks, { new_builder: grant.task });
    if (kind === 'file')
      assert.deepEqual((f.store() as FileProjectStore).snapshot().runs[0].workerTasks, {
        new_builder: grant.task,
      });
  });

  test(`${kind}: mixed old-invalid and new-valid tasks inherit individually and a reverted goal cannot revive either old task`, async (t) => {
    const f = await fixture(t, kind);
    const old = await f.delegate(await f.proposal('old_builder'));
    await f.stop();
    await f.goals.update('revise-goal', 'revise-goal', {
      ...f.goal,
      projectId: 'p',
      id: f.goal.id,
      expectedRevision: 1,
      body: 'G2 complete requirement',
    });
    await f.resume('T-G2');
    assert.equal((await f.projection()).runs[0].workerTasks, undefined);
    const proposal = await f.proposal('new_builder');
    proposal.worker.assignment!.objective = 'Focused task for G2';
    const current = await f.delegate(proposal);
    await f.stop();
    await f.resume('T-G2-again');
    let context = (await f.runs().currentAttempt(f.runId)).context;
    assert.equal(
      context.taskMode,
      'full-goal',
      'The aggregate remains conservative for mixed validity.',
    );
    assert.deepEqual(context.inheritedAssignments, {
      old_builder: { id: old.id, taskMode: 'full-goal' },
      new_builder: { id: current.id, taskMode: 'original' },
    });
    assert.deepEqual((await f.projection()).runs[0].workerTasks, { new_builder: current.task });
    const projected = (await f.projection()).runs[0];
    const inheritedEnvelope = (assignment: typeof old) =>
      buildWorkerEnvelope({
        run: projected,
        role: assignment.role,
        paths: assignment.paths,
        policy: f.policy,
        workspace: path.join(f.directory, 'workspace'),
        assignment,
      });
    assert.equal(inheritedEnvelope(old).task.source, 'full-goal');
    assert.ok(inheritedEnvelope(old).task.objective.includes('G2 complete requirement'));
    assert.equal(inheritedEnvelope(current).task.source, 'coordinator');
    assert.equal(inheritedEnvelope(current).task.objective, 'Focused task for G2');
    await f.reopen();
    if (kind === 'file')
      assert.deepEqual((f.store() as FileProjectStore).snapshot().runs[0].workerTasks, {
        new_builder: current.task,
      });
    await f.stop();
    await f.goals.update('revert-goal', 'revert-goal', {
      ...f.goal,
      projectId: 'p',
      id: f.goal.id,
      expectedRevision: 2,
    });
    await f.resume('T-reverted-G1');
    await f.stop();
    await f.resume('T-reverted-G1-again');
    context = (await f.runs().currentAttempt(f.runId)).context;
    assert.deepEqual(context.inheritedAssignments, {
      old_builder: { id: old.id, taskMode: 'full-goal' },
      new_builder: { id: current.id, taskMode: 'full-goal' },
    });
    assert.equal((await f.projection()).runs[0].workerTasks, undefined);
    assert.deepEqual(await f.runs().assignments(f.runId), [old, current]);
    await f.reopen();
    assert.equal((await f.projection()).runs[0].workerTasks, undefined);
  });

  test(`${kind}: named grant reads reject a forged per-role compact-task validity flag`, async (t) => {
    const f = await fixture(t, kind);
    await f.delegate(await f.proposal('old_builder'));
    await f.stop();
    await f.goals.update('revise-goal', 'revise-goal', {
      ...f.goal,
      projectId: 'p',
      id: f.goal.id,
      expectedRevision: 1,
      body: 'G2 complete requirement',
    });
    await f.resume('T-invalidated');
    const context = (await f.runs().currentAttempt(f.runId)).context;
    assert.equal(context.inheritedAssignments?.old_builder.taskMode, 'full-goal');
    if (kind === 'sqlite')
      await forgeInheritedTaskMode(f.directory, 'T-invalidated', 'old_builder');
    else {
      const document = (f.store() as FileProjectStore).doc as unknown as {
        runAttemptContexts: Record<
          string,
          { inheritedAssignments: Record<string, { id: string; taskMode: string }> }
        >;
      };
      document.runAttemptContexts['T-invalidated'].inheritedAssignments.old_builder.taskMode =
        'original';
    }
    await assert.rejects(f.runs().currentAttempt(f.runId), { code: 'INVALID_RUN_ATTEMPT' });
    await assert.rejects(f.runs().assignment(f.runId, 'old_builder'), {
      code: 'INVALID_RUN_ATTEMPT',
    });
  });
}
