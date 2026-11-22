import {
  fixtureExecutionSelection,
  fixtureExecutionCapabilities,
} from './fixtures/execution-resources.ts';
import {
  virtualWorkspaceRevision,
  virtualVerificationViews,
  VIRTUAL_BASE_COMMIT,
} from './fixtures/virtual-workspace.ts';
import { observedTurnFailure } from '../core/run-reconciliation.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecutionService } from '../core/execution.ts';
import { resolveTeam, type ExecutionPolicy, type TeamPlan } from '../core/execution-ports.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { GoalService } from '../core/services.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { NodeChecks } from '../adapters/checks/node-checks.ts';
import { CodexRuntime } from '../adapters/codex/runtime.ts';
import type { RuntimeEvent } from '../core/ports.ts';
import { applyRuntimeEvent } from '../core/runtime-projection.ts';
import { assignmentScopePreserved } from '../core/worker-assignments.ts';
import { DomainError } from '../core/ports.ts';

const policy: ExecutionPolicy = {
  scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: [] },
  checks: [{ id: 'suite', title: 'Suite' }],
  defaultCheckIds: ['suite'],
  maxWorkers: 2,
  maxRepairs: 1,
  turnTimeoutMs: 1000,
};
const worker = {
  roleId: 'builder',
  action: 'create' as 'create' | 'reuse',
  title: 'Builder',
  description: 'Implements code',
  instructions: 'Implement the assigned change and check it.',
  kind: 'implementation' as const,
  paths: ['src/code.mjs'],
};
const plan: TeamPlan = {
  summary: 'Plan',
  steps: [
    { step: 'Implement', owner: 'builder' },
    { step: 'Review', owner: 'reviewer' },
  ],
  team: [worker],
};
async function fixture(
  t: any,
  options: {
    rejectReview?: number;
    outOfScope?: boolean;
    pause?: boolean;
    pauseWorker?: boolean;
    noWorkers?: boolean;
    nativeChildren?: boolean;
    direct?: boolean;
    compactTask?: boolean;
    workerFailureCode?: string;
    workerFailures?: number;
    workerFailureRole?: string;
    twoWorkers?: boolean;
    refinement?: unknown;
    refinementFails?: boolean;
  } = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-execution-')),
    store = await FileProjectStore.open({
      directory,
      project: { id: 'p', name: 'P', root: directory },
    }),
    projects = new ProjectStoreRegistry([store]);
  let n = 0,
    reviews = 0,
    workerFailures = 0;
  const starts: { id: string; role?: string }[] = [],
    released: string[] = [];
  const turns: { id: string; text: string }[] = [],
    prepared: (string | undefined)[] = [],
    events = new Set<(e: RuntimeEvent) => void>();
  const runtime = {
    id: 'fake',
    async start(input?: any) {
      const threadId = 'thread-' + ++n;
      const role = input?.assignment?.roleId;
      if (role && store.snapshot().runs[0]?.workerReplan?.status === 'ready') {
        const previous = store.snapshot().runs[0].workerReplan!;
        const failed = store
          .snapshot()
          .runs[0].agents.find((a) => a.session?.id === previous.failedSessionId)!;
        assert.ok(
          released.includes(failed.threadId),
          'Previous worker must be released before replacement',
        );
      }
      starts.push({ id: threadId, role });
      return { threadId };
    },
    async submit() {
      return { turnId: 't' };
    },
    async interrupt() {},
    async dispose() {},
    async release(id: string) {
      released.push(id);
    },
    subscribe(fn: (e: RuntimeEvent) => void) {
      events.add(fn);
      return () => events.delete(fn);
    },
    async turn(id: string, text: string, { signal }: any) {
      turns.push({ id, text });
      if (text.startsWith('Refine the failed worker assignment')) {
        assert.equal(
          store.snapshot().runs[0].workerReplan?.status,
          'requested',
          'Persist refinement intent before model request',
        );
        if (options.refinementFails) throw Error('Refinement transport unavailable');
        return {
          turnId: 'refine',
          text: JSON.stringify(
            options.refinement || {
              objective:
                'Read current src/code.mjs, preserve completed work and finish the assigned edit.',
              inputs: ['src/code.mjs'],
            },
          ),
        };
      }
      if (options.pause || (options.pauseWorker && text.startsWith('Execute your assigned work'))) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw observedTurnFailure(new DOMException('Aborted', 'AbortError'));
      }
      if (text.startsWith('First,'))
        return {
          turnId: 't',
          text: JSON.stringify({
            ...plan,
            ...(options.direct
              ? {
                  steps: [
                    { step: 'Implement', owner: 'coordinator' },
                    { step: 'Review', owner: 'reviewer' },
                  ],
                }
              : {}),
            team: options.direct
              ? []
              : [
                  ...[
                    worker,
                    ...(options.twoWorkers
                      ? [{ ...worker, roleId: 'other_builder', paths: ['src/other.mjs'] }]
                      : []),
                  ].map((worker) => ({
                    ...worker,
                    action: store.snapshot().roles.some((r) => r.id === 'builder')
                      ? 'reuse'
                      : 'create',
                    ...(options.compactTask
                      ? {
                          assignment: {
                            objective: 'Implement only the assigned module.',
                            inputs: [...worker.paths],
                            expectedResult:
                              'The assigned module implements the complete requested change.',
                            criteria: [
                              'Preserve the protected checks.',
                              'Keep the public API unchanged.',
                            ],
                          },
                        }
                      : {}),
                  })),
                ],
          }),
        };
      if (text.startsWith('Review goal'))
        return {
          turnId: 't',
          text: JSON.stringify(
            ++reviews <= (options.rejectReview || 0)
              ? { verdict: 'changes_requested', blockingFindings: ['Fix bug'], summary: 'Bug' }
              : { verdict: 'approved', blockingFindings: [], summary: 'OK' },
          ),
        };
      const runId = store.snapshot().runs[0].id;
      if (
        text.startsWith('Execute your assigned work') &&
        options.workerFailureCode &&
        starts.find((start) => start.id === id)?.role ===
          (options.workerFailureRole || 'builder') &&
        workerFailures++ < (options.workerFailures || 1)
      ) {
        const error = new DomainError(options.workerFailureCode, 'Synthetic worker outcome');
        throw options.workerFailureCode === 'MODEL_INCOMPLETE' ? observedTurnFailure(error) : error;
      }
      if (options.noWorkers && text.startsWith('Execute your assigned work'))
        throw observedTurnFailure(Error('Worker unavailable'));
      if (options.nativeChildren)
        for (const kind of ['started', 'completed'])
          for (const listener of events)
            listener({
              id: 'agent-' + id + '-' + kind,
              runId,
              type: 'agent.activity',
              threadId: 'child-' + id,
              parentThreadId: id,
              completed: kind === 'completed',
              legacyAssignment: { path: '/root/builder' },
            });
      return {
        turnId: 't',
        text: JSON.stringify({
          status: 'success',
          summary: 'Done',
          artifacts: ['src/code.mjs'],
          notesForNextAgent: '',
        }),
      };
    },
  };
  const env = { projects, now: () => new Date().toISOString(), id: () => crypto.randomUUID() },
    engine = new ExecutionService({
      ...env,
      runtime,
      selection: fixtureExecutionSelection(
        runtime.id,
        fixtureExecutionCapabilities({ strictPlannedWrites: !!options.outOfScope }),
      ),
      policies: {
        p: options.outOfScope ? { ...policy, scope: { ...policy.scope, mode: 'strict' } } : policy,
      },
      workspaces: {
        ...virtualVerificationViews,
        async prepare(_p, _r, base) {
          prepared.push(base);
          return { path: directory, base: base || VIRTUAL_BASE_COMMIT };
        },
        async changes() {
          return [
            { path: options.outOfScope ? 'README.md' : 'src/code.mjs', before: '', after: 'ok' },
          ];
        },
        async captureRevision(workspace: string, base: string) {
          return virtualWorkspaceRevision(await this.changes(workspace, base), base);
        },
        async checkpoint() {
          return 'a'.repeat(40);
        },
      },
      checks: {
        async run() {
          return { passed: 1, total: 1, results: [{ name: 'suite', passed: true }] };
        },
      },
    });
  t.after(async () => {
    await engine.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const goals = new GoalService(env);
  async function start(id = 'start') {
    const goal = await goals.create('goal-' + id, id, {
      projectId: 'p',
      title: 'Goal',
      body: 'Implement',
      criteria: 'Works',
    });
    const result = await engine.start(id, id, { projectId: 'p', goalId: goal.id });
    return { ...result, goal };
  }
  async function drain(runId: string) {
    await engine.jobs.get(runId)?.promise;
    return engine.get('p', runId);
  }
  return {
    engine,
    store,
    projects,
    turns,
    prepared,
    start,
    drain,
    goals,
    directory,
    runtime,
    starts,
    released,
  };
}
test('a known worker limit gets one persisted refinement and a fresh released session with the same contract', async (t) => {
  const f = await fixture(t, { compactTask: true, workerFailureCode: 'MODEL_CONTEXT_EXHAUSTED' });
  const { runId } = await f.start();
  const run = await f.drain(runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.workerReplan?.status, 'completed');
  assert.equal(
    f.turns.filter((turn) => turn.text.startsWith('Refine the failed worker assignment')).length,
    1,
  );
  const workers = run.agents.filter((agent) => agent.session?.roleId === 'builder');
  assert.equal(workers.length, 2);
  assert.notEqual(workers[0].session?.id, workers[1].session?.id);
  assert.equal(workers[0].status, 'failed');
  assert.equal(workers[1].status, 'completed');
  assert.deepEqual(workers[0].assignment?.paths, workers[1].assignment?.paths);
  assert.deepEqual(
    workers[0].assignment?.envelope?.task.criteria,
    workers[1].assignment?.envelope?.task.criteria,
  );
  assert.equal(
    workers[0].assignment?.envelope?.task.expectedResult,
    workers[1].assignment?.envelope?.task.expectedResult,
  );
  assert.equal(run.independentReviewer, true);
  assert.equal(run.review?.verdict, 'approved');
});
test('a second known failure cannot start another automatic refinement', async (t) => {
  const f = await fixture(t, {
    compactTask: true,
    workerFailureCode: 'MODEL_INCOMPLETE',
    workerFailures: 2,
  });
  const { runId } = await f.start();
  const run = await f.drain(runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.workerReplan?.status, 'ready');
  assert.equal(
    f.turns.filter((turn) => turn.text.startsWith('Refine the failed worker assignment')).length,
    1,
  );
  assert.equal(run.agents.filter((agent) => agent.session?.roleId === 'builder').length, 2);
  assert.equal(run.commit, undefined);
});
test('unknown outcomes and legacy tasks never trigger an automatic refinement', async (t) => {
  for (const [compactTask, code] of [
    [true, 'MODEL_INTERRUPTED'],
    [true, 'MODEL_BUDGET_EXHAUSTED'],
    [true, 'MODEL_UNAVAILABLE'],
    [false, 'MODEL_INCOMPLETE'],
  ] as const) {
    const f = await fixture(t, { compactTask, workerFailureCode: code });
    const { runId } = await f.start();
    const run = await f.drain(runId);
    assert.equal(
      run.status,
      ['MODEL_INTERRUPTED', 'MODEL_UNAVAILABLE'].includes(code) ? 'needs-attention' : 'failed',
    );
    assert.equal(run.workerReplan, undefined);
    assert.equal(
      f.turns.some((turn) => turn.text.startsWith('Refine the failed worker assignment')),
      false,
    );
    assert.equal(run.agents.filter((agent) => agent.session?.roleId === 'builder').length, 1);
  }
});
test('a later worker refinement preserves successful roles instead of dispatching them again', async (t) => {
  const f = await fixture(t, {
    compactTask: true,
    twoWorkers: true,
    workerFailureCode: 'MODEL_INCOMPLETE',
    workerFailureRole: 'other_builder',
    refinement: {
      objective: 'Read current other module and finish the edit.',
      inputs: ['src/other.mjs'],
    },
  });
  const { runId } = await f.start();
  const run = await f.drain(runId);
  assert.equal(run.status, 'completed');
  assert.equal(f.starts.filter((start) => start.role === 'builder').length, 1);
  assert.equal(f.starts.filter((start) => start.role === 'other_builder').length, 2);
  assert.equal(run.workerReplan?.roleId, 'other_builder');
  const integration = f.turns.find((turn) => turn.text.startsWith('Plan accepted.'))!.text;
  assert.ok(integration.includes('"roleId":"builder"'));
  assert.ok(integration.includes('"roleId":"other_builder"'));
});
test('a failed or weakening refinement retains its durable intent without a replacement', async (t) => {
  for (const options of [
    { refinementFails: true },
    { refinement: { objective: 'Do less', inputs: ['src/code.mjs'], criteria: [] } },
    { refinement: { objective: 'Read new files', inputs: ['src/unapproved.mjs'] } },
  ]) {
    const f = await fixture(t, {
      compactTask: true,
      workerFailureCode: 'MODEL_INCOMPLETE',
      ...options,
    });
    const { runId } = await f.start();
    const run = await f.drain(runId);
    assert.equal(run.status, options.refinementFails ? 'needs-attention' : 'failed');
    assert.equal(run.workerReplan?.status, 'requested');
    assert.equal(f.starts.filter((start) => start.role === 'builder').length, 1);
    assert.equal(
      run.workerTasks?.builder.expectedResult,
      'The assigned module implements the complete requested change.',
    );
  }
});
test('following goals reuse roles but begin independently unless a parent run is selected', async (t) => {
  const f = await fixture(t),
    first = await f.start();
  const result = await f.drain(first.runId);
  assert.equal(result.status, 'completed');
  assert.equal(result.roleOrigins?.builder, 'created');
  assert.equal(f.store.snapshot().roles.find((r) => r.id === 'builder')?.version, 1);
  assert.deepEqual(
    await f.engine.start('start', 'start', { projectId: 'p', goalId: first.goal.id }),
    { runId: first.runId },
  );
  assert.equal(f.store.snapshot().runs.length, 1);
  const second = await f.start('second'),
    next = await f.drain(second.runId);
  assert.equal(next.roleOrigins?.builder, 'reused');
  assert.equal(f.store.doc.roleVersions.filter((r) => r.id === 'builder').length, 1);
  assert.deepEqual(f.prepared, [undefined, undefined]);
  const child = await f.goals.create('child', 'child', {
    projectId: 'p',
    title: 'Child',
    body: 'Continue',
    criteria: '',
    parentRunId: first.runId,
  });
  const childRun = await f.engine.start('child-start', 'child-start', {
    projectId: 'p',
    goalId: child.id,
  });
  await f.drain(childRun.runId);
  assert.deepEqual(f.prepared, [undefined, undefined, 'a'.repeat(40)]);
  assert.ok(
    result.review?.verdict === 'approved' && result.acceptance.total === 1 && result.commit,
  );
  assert.equal(result.roleSnapshots?.find((r) => r.id === 'builder')?.version, 1);
  assert.deepEqual(result.agents.find((a) => a.name === 'builder')?.assignment?.paths, [
    'src/code.mjs',
  ]);
});
test('each run freezes its execution policy and passes project context to coordinator and reviewer', async (t) => {
  const f = await fixture(t),
    instructions: string[] = [];
  f.engine.env.policies.p = { ...policy, context: 'Original project context' };
  const original = f.runtime.start;
  f.runtime.start = async (input?: any) => {
    instructions.push(input.instructions);
    return original(input);
  };
  const first = await f.start();
  f.engine.env.policies.p = {
    ...policy,
    scope: { ...policy.scope, plannedPaths: ['elsewhere/'] },
    context: 'Changed context',
  };
  const run = await f.drain(first.runId);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.executionPolicySnapshot?.scope.plannedPaths, ['src/']);
  assert.equal(run.executionPolicySnapshot?.context, 'Original project context');
  assert.equal(instructions.length, 3);
  const planning = f.turns.find((turn) => turn.text.startsWith('First,'))!;
  assert.match(planning.text, /Original project context/);
  assert.doesNotMatch(planning.text, /Changed context/);
  assert.ok(
    instructions
      .slice(1)
      .every(
        (text) => text.includes('Original project context') && !text.includes('Changed context'),
      ),
  );
});
test('Buro persists assignments before client dispatch and completes workers without native children', async (t) => {
  const f = await fixture(t);
  const start = f.runtime.start;
  let dispatched = 0;
  f.runtime.start = async (input?: any) => {
    if (input.assignment) {
      dispatched++;
      const run = f.store.snapshot().runs[0];
      const pending = run.agents.find((agent) => agent.session?.id === input.assignment.sessionId)!;
      assert.equal(pending.status, 'starting');
      assert.equal(pending.session?.roleId, 'builder');
      assert.equal(pending.session?.roleVersion, 1);
      assert.equal(pending.session?.runtimeId, 'fake');
      assert.equal(pending.session?.parentId, run.coordinatorSession?.id);
      assert.deepEqual(input.assignment.scope.plannedPaths, ['src/code.mjs']);
      assert.equal(input.assignment.scope.mode, run.executionPolicySnapshot?.scope.mode);
      assert.deepEqual(
        input.assignment.scope.protectedPaths,
        run.executionPolicySnapshot?.scope.protectedPaths,
      );
      const saved = JSON.parse(
        await fs.readFile(path.join(f.directory, 'control-state.json'), 'utf8'),
      );
      assert.ok(
        saved.runs[0].agents.some((agent: any) => agent.session?.id === pending.session?.id),
      );
    }
    return start(input);
  };
  const started = await f.start();
  const result = await f.drain(started.runId);
  assert.equal(result.status, 'completed', result.result);
  assert.equal(dispatched, 1);
  const worker = result.agents.find((agent) => agent.session?.roleId === 'builder')!;
  assert.equal(worker.session?.result?.status, 'success');
  assert.notEqual(worker.session?.id, worker.threadId);
  const implementation = f.turns.find((turn) =>
    turn.text.startsWith('Execute your assigned work'),
  )!;
  const coordinator = f.turns.find((turn) => turn.text.startsWith('Plan accepted'))!;
  assert.equal(implementation.id, worker.threadId);
  assert.equal(coordinator.id, result.threadId);
  assert.notEqual(implementation.id, coordinator.id);
  assert.equal(result.agents.filter((agent) => agent.name.startsWith('native:')).length, 0);
});

test('native child names and prompts cannot claim or complete Buro assignments', async (t) => {
  const f = await fixture(t);
  const started = await f.start(),
    run = await f.drain(started.runId);
  const assigned = run.agents.find((agent) => agent.session?.roleId === 'builder')!;
  assigned.status = 'running';
  assigned.session!.result = undefined;
  applyRuntimeEvent(
    run,
    {
      id: 'spoof',
      runId: run.id,
      type: 'agent.activity',
      threadId: 'undeclared',
      parentThreadId: run.threadId,
      completed: true,
      legacyAssignment: { path: '/root/builder', name: 'builder', prompt: 'builder' },
    },
    'now',
  );
  const undeclared = run.agents.find((agent) => agent.threadId === 'undeclared')!;
  assert.equal(undeclared.name, 'native:builder');
  assert.equal(undeclared.session, undefined);
  assert.equal(undeclared.assignment, undefined);
  applyRuntimeEvent(
    run,
    {
      id: 'spoof-known',
      runId: run.id,
      type: 'agent.activity',
      threadId: assigned.threadId,
      parentThreadId: run.threadId,
      completed: true,
    },
    'now',
  );
  assert.equal(assigned.status, 'running');
});

test('cancelling a service-owned worker preserves its session and never promotes its role', async (t) => {
  const f = await fixture(t, { pauseWorker: true });
  const started = await f.start();
  while (!f.turns.some((turn) => turn.text.startsWith('Execute your assigned work')))
    await new Promise((resolve) => setTimeout(resolve, 5));
  await f.engine.cancel('stop-worker', 'stop-worker', { projectId: 'p', runId: started.runId });
  const result = await f.drain(started.runId);
  assert.equal(result.status, 'interrupted');
  const worker = result.agents.find((agent) => agent.session?.roleId === 'builder')!;
  assert.equal(worker.status, 'interrupted');
  assert.equal(worker.session?.result, undefined);
  assert.equal(
    f.store.snapshot().roles.some((role) => role.id === 'builder'),
    false,
  );
  assert.equal(
    f.turns.some((turn) => turn.text.startsWith('Review goal')),
    false,
  );
});

test('worker scope checks detect edits and reversions outside its assignment', () => {
  const previous = [{ path: 'src/first.ts', before: 'old', after: 'earlier worker' }];
  const scope = { mode: 'strict' as const, plannedPaths: ['src/second.ts'], protectedPaths: [] };
  assert.equal(assignmentScopePreserved(previous, [], scope), false);
  assert.equal(assignmentScopePreserved(previous, previous, scope), true);
  assert.equal(
    assignmentScopePreserved([], [{ path: 'src/second.ts', before: '', after: 'work' }], scope),
    true,
  );
  assert.equal(
    assignmentScopePreserved(
      [],
      [{ path: 'src/second.ts', before: '', after: '[symlink outside]' }],
      scope,
    ),
    false,
  );
  assert.equal(
    assignmentScopePreserved([], [{ path: 'src/protected.ts', before: '', after: 'work' }], {
      mode: 'strict',
      plannedPaths: ['src/'],
      protectedPaths: ['src/protected.ts'],
    }),
    false,
  );
});
test('blocking reviewer sends repair to the same coordinator session, then rechecks', async (t) => {
  const f = await fixture(t, { rejectReview: 1 }),
    first = await f.start(),
    run = await f.drain(first.runId);
  assert.equal(run.status, 'completed');
  const work = f.turns.find((t) => t.text.startsWith('Plan accepted'))!,
    repair = f.turns.find((t) => t.text.startsWith('Repair the result'))!;
  assert.equal(work.id, repair.id);
  assert.ok(run.events.some((e) => e.type === 'phase.repair'));
  assert.equal(run.agents.filter((a) => a.name === 'reviewer').length, 2);
});
test('unapproved or out-of-scope work is never accepted and does not save roles', async (t) => {
  for (const options of [{ rejectReview: 99 }, { outOfScope: true }, { noWorkers: true }]) {
    const f = await fixture(t, options),
      first = await f.start(),
      run = await f.drain(first.runId);
    assert.equal(run.status, 'failed');
    assert.equal(run.commit, undefined);
    assert.equal(
      f.store.snapshot().roles.some((r) => r.id === 'builder'),
      false,
    );
    assert.equal(f.store.snapshot().goals[0].status, 'failed');
  }
});
test('cancel is durable, blocks conflicting starts and interrupts the active phase', async (t) => {
  const f = await fixture(t, { pause: true }),
    first = await f.start();
  await assert.rejects(
    f.engine.start('other', 'other', { projectId: 'p', goalId: first.goal.id }),
    { code: 'PROJECT_BUSY' },
  );
  await assert.rejects(f.goals.delete('delete', 'delete', { projectId: 'p', id: first.goal.id }), {
    code: 'GOAL_RUNNING',
  });
  // Wait for the fake runtime to enter its cancellable phase.
  while (!f.turns.length) await new Promise((r) => setTimeout(r, 5));
  await f.engine.cancel('cancel', 'cancel', { projectId: 'p', runId: first.runId });
  const run = await f.drain(first.runId);
  assert.equal(run.status, 'interrupted');
  assert.equal(run.cancelRequested, true);
  assert.equal(run.commit, undefined);
});
test('restart marks in-flight work interrupted without replaying side effects', async (t) => {
  const f = await fixture(t, { pause: true }),
    first = await f.start();
  while (!f.turns.length) await new Promise((r) => setTimeout(r, 5));
  await f.engine.dispose();
  await f.store.transact('crash', 'crash', (doc) => {
    const run = doc.runs[0];
    run.status = 'running';
    return { result: null, change: { type: 'run.changed', run, goal: doc.goals[0] } };
  });
  const calls = f.turns.length;
  await f.engine.recover();
  assert.equal(f.engine.get('p', first.runId).status, 'interrupted');
  assert.equal(f.turns.length, calls);
});
test('team validation rejects overlapping ownership, missing reuse and escaping paths', () => {
  assert.throws(
    () =>
      resolveTeam(
        { ...plan, team: [worker, { ...worker, roleId: 'tester', paths: ['src/'] }] },
        [],
        policy,
        '',
      ),
    /overlapping/,
  );
  assert.throws(
    () => resolveTeam({ ...plan, team: [{ ...worker, action: 'reuse' }] }, [], policy, ''),
    /not in the catalog/,
  );
  assert.throws(
    () =>
      resolveTeam({ ...plan, team: [{ ...worker, paths: ['src/../README.md'] }] }, [], policy, ''),
    /unauthorized path|strict work scope/,
  );
});
test('native JSONL completed-turn contract captures final structured answer and sandbox', async (t) => {
  const f = await fixture(t),
    runtime = new CodexRuntime({
      id: 'codex',
      projects: f.projects,
      executable: process.execPath,
      args: [path.resolve('tests/fixtures/fake-codex.mjs')],
    });
  t.after(() => runtime.dispose());
  const observed: RuntimeEvent[] = [];
  runtime.subscribe((event) => observed.push(event));
  for (const readOnly of [false, true]) {
    const { threadId } = await runtime.start({ projectId: 'p', instructions: 'fixture', readOnly });
    const answer = await runtime.turn(threadId, 'test', {
      schema: { type: 'object' },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    assert.equal(JSON.parse(answer.text).sandbox, readOnly ? 'readOnly' : 'workspaceWrite');
    await runtime.release(threadId);
  }
  assert.ok(observed.some((event) => event.type === 'turn.started'));
  assert.ok(observed.some((event) => event.type === 'message.completed'));
  assert.ok(observed.some((event) => event.type === 'turn.completed'));
  assert.ok(observed.every((event) => !('method' in event) && !('params' in event)));
});

test('runtime events persist once, and failed persistence permits redelivery', async (t) => {
  const f = await fixture(t, { pause: true });
  const started = await f.start();
  while (!f.turns.length) await new Promise((resolve) => setTimeout(resolve, 5));
  const event: RuntimeEvent = {
    id: 'command-result',
    runId: started.runId,
    threadId: 'thread-1',
    type: 'command.completed',
    commandId: 'cmd',
    command: 'check',
    exitCode: 1,
    output: 'failure',
  };
  const persist = f.store.persist.bind(f.store);
  let fail = true;
  f.store.persist = async (doc) => {
    if (fail) {
      fail = false;
      throw Error('disk unavailable');
    }
    return persist(doc);
  };
  await assert.rejects(f.engine.observe(event), /disk unavailable/);
  assert.equal(f.engine.get('p', started.runId).commands.length, 0);
  await f.engine.observe(event);
  const revision = f.store.snapshot().revision;
  await f.engine.observe(event);
  const run = f.engine.get('p', started.runId);
  assert.equal(f.store.snapshot().revision, revision);
  assert.equal(run.commands.length, 1);
  assert.equal(run.commands[0].output, 'failure');
  assert.equal(run.events.filter((event) => event.type === 'command.started').length, 1);
  assert.equal(run.events.filter((event) => event.type === 'command.completed').length, 1);
});
test('Git checkpoints preserve original branch and next worktree begins at accepted commit', async (t) => {
  const f = await fixture(t),
    git = promisify(execFile),
    cwd = f.directory;
  const g = (args: string[]) => git('git', args, { cwd });
  await g(['init', '-b', 'master']);
  await g(['config', 'user.email', 'test@example.invalid']);
  await g(['config', 'user.name', 'Test']);
  await fs.mkdir(path.join(cwd, 'src'));
  await fs.writeFile(path.join(cwd, 'src/code.mjs'), 'old');
  await g(['add', 'src']);
  await g(['commit', '-m', 'initial']);
  const initial = (await g(['rev-parse', 'HEAD'])).stdout.trim(),
    adapter = new GitWorkspaces(f.projects),
    one = await adapter.prepare('p', 'run-one');
  await fs.writeFile(path.join(one.path, 'src/code.mjs'), 'new');
  assert.equal((await adapter.changes(one.path, one.base))[0].path, 'src/code.mjs');
  const commit = await adapter.checkpoint(one.path, 'run-one');
  assert.notEqual(commit, initial);
  assert.equal((await g(['rev-parse', 'HEAD'])).stdout.trim(), initial);
  assert.equal(await fs.readFile(path.join(cwd, 'src/code.mjs'), 'utf8'), 'old');
  const two = await adapter.prepare('p', 'run-two', commit);
  assert.equal(await fs.readFile(path.join(two.path, 'src/code.mjs'), 'utf8'), 'new');
  await fs.writeFile(path.join(two.path, '.git'), 'tampered');
  await assert.rejects(adapter.changes(two.path, two.base), /control data/);
});
test('CLI discovers servers under the same disabled-plugin config and verifies every MCP is off', async (t) => {
  const f = await fixture(t),
    executable = path.resolve('tests/fixtures/configured-codex.mjs');
  await fs.chmod(executable, 0o755);
  const probe = path.join(f.directory, 'discovery-cwd.txt'),
    workspace = path.join(f.directory, 'worktree');
  await fs.mkdir(workspace);
  const previous = process.env.PROJECT_CLI_PROBE_OUTPUT;
  process.env.PROJECT_CLI_PROBE_OUTPUT = probe;
  t.after(() => {
    if (previous === undefined) delete process.env.PROJECT_CLI_PROBE_OUTPUT;
    else process.env.PROJECT_CLI_PROBE_OUTPUT = previous;
  });
  const runtime = new CodexRuntime({
    id: 'codex',
    projects: f.projects,
    executable,
  });
  t.after(() => runtime.dispose());
  const started = await runtime.start({ projectId: 'p', workspace, instructions: 'fixture' });
  assert.equal(started.threadId, 'fixture-thread');
  assert.deepEqual((await fs.readFile(probe, 'utf8')).trim().split('\n'), [
    await fs.realpath(workspace),
    await fs.realpath(workspace),
  ]);
});
test('trusted Node checks run outside the editable area and reject filesystem writes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trusted-check-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'work');
  await fs.mkdir(workspace);
  const script = path.join(directory, 'check.mjs');
  await fs.writeFile(
    script,
    `import fs from 'node:fs';fs.writeFileSync('oops','bad');console.log(JSON.stringify({results:[{name:'should not happen',passed:true}]}));`,
  );
  const adapter = new NodeChecks({ p: [{ id: 'suite', title: 'Suite', script }] });
  const result = await adapter.run('p', workspace, ['suite'], new AbortController().signal);
  assert.equal(result.passed, 0);
  await assert.rejects(fs.access(path.join(workspace, 'oops')));
});

test('hyphenated worker ids validate, while missing ids receive actionable diagnostics', () => {
  const plan = {
    summary: 'Plan',
    steps: [
      { step: 'Build', owner: 'react-developer' },
      { step: 'Review', owner: 'reviewer' },
    ],
    team: [{ ...worker, roleId: 'react-developer' }],
  };
  assert.equal(resolveTeam(plan, [], policy, '').roles[0].id, 'react-developer');
  assert.throws(
    () => resolveTeam({ ...plan, team: [{ ...worker, roleId: '' }] }, [], policy, ''),
    /roleId.*react_developer/,
  );
});

test('runtime allows ongoing child progress beyond a wall deadline but interrupts a stalled turn', async (t) => {
  const f = await fixture(t),
    runtime = new CodexRuntime({
      id: 'codex',
      projects: f.projects,
      executable: process.execPath,
      args: [path.resolve('tests/fixtures/fake-codex.mjs')],
    });
  t.after(() => runtime.dispose());
  const { threadId } = await runtime.start({ projectId: 'p', instructions: 'Fixture' });
  const result = await runtime.turn(threadId, 'long-active', {
    schema: { type: 'object' },
    signal: new AbortController().signal,
    timeoutMs: 300,
  });
  assert.equal(result.text, 'done');
  await assert.rejects(
    runtime.turn(threadId, 'idle', {
      schema: { type: 'object' },
      signal: new AbortController().signal,
      timeoutMs: 80,
    }),
    (error: any) => {
      assert.equal(error.code, 'SESSION_RECONCILIATION_REQUIRED');
      assert.match(error.cause?.message || '', /No coordinator or agent progress/);
      return true;
    },
  );
});

test('run freezes selected context and passes staged paths to planning, workers and independent review', async (t) => {
  const f = await fixture(t),
    { ContextMaterials } = await import('../adapters/files/context-materials.ts'),
    library = new ContextMaterials(f.projects);
  t.after(() => library.dispose());
  const [material] = await library.import('context', 'context', {
    projectId: 'p',
    scope: 'project',
    upload: {
      name: 'requirements.md',
      base64: Buffer.from('Requirements for this goal').toString('base64'),
    },
  });
  const instructions: string[] = [];
  const original = f.runtime.start;
  f.runtime.start = async (input?: any) => {
    instructions.push(input.instructions);
    return original(input);
  };
  const preparedMaterials: any[] = [];
  const prepare = f.engine.env.workspaces.prepare;
  f.engine.env.workspaces.prepare = async (...args) => {
    preparedMaterials.push(args[3]?.materials);
    return prepare(...args);
  };
  const first = await f.start();
  await library.remove('remove-context', 'remove-context', {
    projectId: 'p',
    materialId: material.id,
  });
  const run = await f.drain(first.runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.contextMaterials?.[0].id, material.id);
  assert.equal(run.contextMaterials?.[0].active, true);
  assert.equal(preparedMaterials[0][0].id, material.id);
  assert.equal(instructions.length, 3);
  const workerMaterial = run.agents.find((agent) => agent.session?.roleId === 'builder')?.assignment
    ?.envelope?.materials[0];
  assert.equal(workerMaterial?.id, material.id);
  assert.ok(workerMaterial?.path.includes('/.buro/context/'));
  assert.equal(
    instructions[1].includes('requirements.md'),
    false,
    'Material references are supplied once in the worker envelope',
  );
  assert.ok(
    [
      instructions[0],
      instructions[2],
      f.turns.find((turn) => turn.text.startsWith('Execute your assigned work'))!.text,
    ].every(
      (text) =>
        text.includes('requirements.md') &&
        text.includes('/.buro/context/') &&
        !text.includes('/local/context/'),
    ),
  );
  assert.ok(
    f.turns.find((turn) => turn.text.startsWith('Plan accepted'))?.text.includes('user material'),
  );
});

test('a coherent task can finish directly while still requiring independent checks and a fresh reviewer', async (t) => {
  const f = await fixture(t, { direct: true, noWorkers: true });
  const started = await f.start();
  const result = await f.drain(started.runId);
  assert.equal(result.status, 'completed', result.result);
  assert.equal(result.independentReviewer, true);
  assert.equal(result.agents.filter((agent) => agent.name !== 'reviewer').length, 0);
  assert.equal(result.acceptance.passed, 1);
});

test('environment failure preserves the workspace and stops before planning or source repair', async (t) => {
  const f = await fixture(t);
  f.engine.env.policies.p = {
    ...policy,
    profile: {
      version: 1,
      revision: 1,
      context: '',
      scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: [] },
      setup: [],
      dependencies: 'none',
      checks: [{ id: 'suite', title: 'Suite', command: 'make test', timeoutMs: 1000 }],
      defaultCheckIds: ['suite'],
      maxWorkers: 2,
      maxRepairs: 1,
      turnTimeoutMs: 10000,
    },
  };
  let releases = 0;
  f.engine.env.environments = {
    async prepare() {
      return {
        name: 'Project environment',
        passed: false,
        error: 'Required toolchain is unavailable',
      };
    },
    async release() {
      releases++;
    },
  };
  const started = await f.start(),
    result = await f.drain(started.runId);
  assert.equal(result.status, 'needs-attention');
  assert.equal(result.workspace, f.directory);
  assert.equal(f.turns.length, 0);
  assert.equal(releases, 1);
  assert.match(result.result, /toolchain/);
});
