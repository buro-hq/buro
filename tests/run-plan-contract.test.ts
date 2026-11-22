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
  failPlanTimelineInsert,
  seedNoncurrentPlanRows,
  setUnresolvedPlanFact,
} from './fixtures/sqlite-run-plan-fault.ts';

const command = (id: string) => ({ id, fingerprint: 'plan:' + id });
const profile: ProjectProfile = {
  version: 1,
  revision: 1,
  context: 'Retain trusted plan scope',
  scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['AGENTS.md'] },
  checks: [{ id: 'test', title: 'Test', command: 'must-not-run', timeoutMs: 1000 }],
  defaultCheckIds: ['test'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 1,
  maxRepairs: 0,
  turnTimeoutMs: 10000,
  baseBranch: 'synthetic-source',
};
function candidate(action: 'create' | 'reuse' = 'reuse'): TeamPlan {
  return {
    summary: 'Preserve the complete admitted task and frozen grant',
    steps: [
      { step: 'Implement assigned change', owner: 'builder' },
      { step: 'Verify immutable result', owner: 'reviewer' },
    ],
    team: [
      {
        roleId: 'builder',
        action,
        title: 'Proposed builder',
        description: 'A scoped implementation worker',
        instructions: 'Use the accepted immutable task and scope.',
        kind: 'implementation',
        paths: ['src/value.ts'],
        runtimeId: null,
        runtimeReason: '',
        assignment: {
          objective: 'Implement the requested value change.',
          inputs: ['src/value.ts'],
          expectedResult: 'A complete change satisfying original criteria.',
          criteria: ['Preserve the specified value contract.'],
        },
      },
    ],
  };
}

async function fixture(
  t: any,
  kind: 'file' | 'sqlite',
  options: {
    readonly?: boolean;
    createRole?: boolean;
    ready?: boolean;
    nondefaultCoordinator?: boolean;
    maxWorkers?: number;
  } = {},
) {
  const configuredProfile = { ...profile, maxWorkers: options.maxWorkers ?? profile.maxWorkers };
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-run-plan-')));
  const root = path.join(directory, 'source');
  await fs.mkdir(root);
  const project = { id: 'p', name: 'Synthetic immutable plans', root, managed: true };
  const workspace = { path: path.join(directory, 'workspace'), base: 'a'.repeat(40) };
  const queries: { operation: string; rows: number }[] = [];
  let authority: FileProjectStore | SqliteProjectUsageAuthority;
  const open = async () => {
    authority =
      kind === 'file'
        ? await FileProjectStore.open({ directory, project, profile: configuredProfile })
        : await SqliteProjectUsageAuthority.open({
            directory,
            project,
            profile: configuredProfile,
            onQuery: (query) => queries.push(query),
          });
  };
  await open();
  await fs.writeFile(path.join(directory, '.plan-fault-fixture'), 'synthetic-only');
  let allowLegacy = false,
    ids = 0,
    effects = 0;
  let failObservedPlanCommit = false;
  let afterPlanCommit: (() => Promise<void>) | undefined;
  const grantReads: string[] = [];
  const store = {
    get project() {
      return authority.project;
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
    get runs() {
      return {
        ...authority.runs,
        assignment(runId: string, roleId: string) {
          grantReads.push(roleId);
          return authority.runs.assignment(runId, roleId);
        },
        async transaction<T>(
          cmd: { id: string; fingerprint: string },
          apply: Parameters<typeof authority.runs.transaction<T>>[1],
        ) {
          if (!failObservedPlanCommit || cmd.fingerprint !== 'run.accept-plan') {
            const result = await authority.runs.transaction(cmd, apply);
            if (cmd.fingerprint === 'run.accept-plan') await afterPlanCommit?.();
            return result;
          }
          assert.ok(authority instanceof FileProjectStore);
          failObservedPlanCommit = false;
          authority.replace = async () => {
            throw Error('injected observed valid plan commit failure');
          };
          try {
            return await authority.runs.transaction(cmd, apply);
          } finally {
            authority.replace = fs.rename;
          }
        },
      };
    },
    snapshot() {
      assert.ok(
        allowLegacy && authority instanceof FileProjectStore,
        'Plan consumer hydrated a legacy document.',
      );
      return authority.snapshot();
    },
    transact(...args: Parameters<FileProjectStore['transact']>) {
      assert.ok(
        allowLegacy && authority instanceof FileProjectStore,
        'Plan consumer used document mutations.',
      );
      return authority.transact(...args);
    },
  } as ProjectStore;
  const env = {
    projects: { get: () => store, list: () => [project] },
    id: () => String(++ids),
    now: () => new Date(Date.UTC(2026, 0, 1) + ids * 1000).toISOString(),
  };
  const forbidden = async (): Promise<never> => {
    effects++;
    throw Error('No model/workspace/check effect in plan contract.');
  };
  const selection = fixtureExecutionSelection(
    'fake',
    fixtureExecutionCapabilities({ toolsFreeTurns: !options.readonly }),
  );
  const resources = selection.forProject('p');
  const pinnedCoordinator = {
    ...resources.coordinator,
    id: 'pinned-coordinator',
    configurationRevision: 'pinned-coordinator-configuration-v2',
    model: 'pinned-coordinator-model',
    capabilities: {
      ...resources.coordinator.capabilities,
      revision: 'pinned-coordinator-capabilities-v2',
    },
  };
  if (options.nondefaultCoordinator) resources.workerPool = [resources.worker, pinnedCoordinator];
  const service = new ExecutionService({
    ...env,
    policies: { p: executionPolicy(configuredProfile) },
    workflowRoles: createBuiltinWorkflowRoles(),
    selection: { forProject: () => structuredClone(resources) },
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
  service.schedule = () => {};
  const roleService = new RoleService(env);
  const coordinatorRole = options.nondefaultCoordinator
    ? await roleService.save('pinned-coordinator-role', 'pinned-coordinator-role', {
        projectId: 'p',
        id: 'coordinator',
        expectedVersion: 0,
        title: 'User-pinned coordinator',
        description: 'Use another eligible frozen pool runtime',
        instructions: 'Keep the selected coordinator identity.',
        kind: 'coordination',
        runtimePreference: { mode: 'fixed', runtimeId: pinnedCoordinator.id },
      })
    : undefined;
  const role = options.createRole
    ? undefined
    : await roleService.save('builder', 'builder', {
        projectId: 'p',
        id: 'builder',
        expectedVersion: 0,
        title: 'User builder',
        description: 'Keep authoritative user role',
        instructions: 'Original immutable builder instructions',
        kind: 'implementation',
        runtimePreference: { mode: 'fixed', runtimeId: 'fake' },
      });
  const hash = createHash('sha256').update('complete reference').digest('hex');
  const material: ContextMaterial = {
    id: 'M-000001',
    name: 'Complete reference',
    mimeType: 'text/plain',
    size: 18,
    hash,
    relativePath: 'local/context/' + hash + '.txt',
    scope: 'goal',
    active: true,
    representation: 'text',
    loader: { id: 'text', revision: 'v1' },
    createdAt: '2026-01-01',
  };
  await authority.materials.transaction(command('material'), (tx) => tx.attach([material]));
  const goal = await new GoalService(env).create('goal', 'goal', {
    projectId: 'p',
    title: 'Complete plan task',
    body: 'Original complete requirement. '.repeat(350),
    criteria: 'Original exact acceptance criterion. '.repeat(180),
    materialIds: [material.id],
  });
  const { runId } = await service.start('queue', 'queue', { projectId: 'p', goalId: goal.id });
  if (options.ready !== false) {
    await service.beginExecution('p', runId);
    await service.phase('p', runId, 'preparing', 'Prepare admitted workspace');
    await service.bindPreparedWorkspace('p', runId, workspace);
    await service.phase('p', runId, 'planning', 'Choose trusted worker grants');
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
    runId,
    goal,
    role,
    coordinatorRole,
    pinnedCoordinator,
    resources,
    material,
    workspace,
    directory,
    profile: configuredProfile,
    service,
    store,
    queries,
    grantReads,
    events,
    runs: () => authority.runs,
    roles: roleService,
    effects: () => effects,
    accept: (
      plan = candidate(options.createRole ? 'create' : 'reuse'),
      expectedRoleVersions = { builder: options.createRole ? null : 1 } as Record<
        string,
        number | null
      >,
    ) => service.acceptPlan('p', runId, plan, expectedRoleVersions),
    async reopen() {
      await authority.close();
      await open();
    },
    async failStorage(enabled: boolean) {
      if (authority instanceof SqliteProjectUsageAuthority)
        await failPlanTimelineInsert(directory, enabled);
      else
        authority.replace = enabled
          ? async () => {
              throw Error('injected plan file failure');
            }
          : fs.rename;
    },
    async unresolved() {
      if (authority instanceof SqliteProjectUsageAuthority)
        await setUnresolvedPlanFact(directory, runId);
      else {
        allowLegacy = true;
        try {
          await service.update('p', runId, (run) => {
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
    async actualPlanning(
      failCommit = false,
      cancelAfterCommit = false,
      changeTaskDuringTurn = false,
    ) {
      assert.ok(authority instanceof FileProjectStore);
      const starts: { readOnly: boolean | undefined; threadId: string }[] = [];
      const handoffs: {
        threadId: string;
        plannerId: string | undefined;
        coordinatorId: string | undefined;
        parentId: string | undefined;
        planId: string | undefined;
      }[] = [];
      let planTurns = 0,
        otherTurns = 0,
        dispatches = 0,
        resultBoundaries = 0;
      service.env.workspaces.prepare = async () => ({ ...workspace });
      service.env.runtime.start = async (input) => {
        const threadId = 'thread-' + (starts.length + 1);
        starts.push({ readOnly: input.readOnly, threadId });
        if (input.readOnly === false) {
          const run = (authority as FileProjectStore)
            .snapshot()
            .runs.find((run) => run.id === runId)!;
          handoffs.push({
            threadId: run.threadId,
            plannerId: run.planningSession?.id,
            coordinatorId: run.coordinatorSession?.id,
            parentId: run.coordinatorSession?.parentId,
            planId: (await authority.runs.plan(runId))?.id,
          });
        }
        return { threadId };
      };
      service.env.runtime.release = async () => {};
      service.verify = async () => ({ checks: { passed: 0, total: 0, results: [] } }) as any;
      service.completedTurn = async (_projectId, _runId, _threadId, text) => {
        if (text.startsWith('First,')) {
          planTurns++;
          if (changeTaskDuringTurn)
            await service.update('p', runId, (run) => {
              run.goalText += '\nLater task clarification.';
            });
          return candidate();
        }
        otherTurns++;
        return {
          status: 'success',
          summary: 'Synthetic downstream boundary only',
          artifacts: [],
          notesForNextAgent: '',
        };
      };
      service.dispatchWorkers = async () => {
        dispatches++;
        return [];
      };
      service.validateAndAccept = async () => {
        resultBoundaries++;
      };
      failObservedPlanCommit = failCommit;
      let committed!: () => void, release!: () => void;
      const retained = new Promise<void>((resolve) => {
        committed = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (cancelAfterCommit)
        afterPlanCommit = async () => {
          committed();
          await released;
        };
      allowLegacy = true;
      const execution = service.execute('p', runId, new AbortController().signal);
      try {
        if (cancelAfterCommit) {
          await retained;
          await service.cancel('cancel-accepted-plan', 'cancel-accepted-plan', {
            projectId: 'p',
            runId,
          });
        }
      } finally {
        release();
        await execution;
        afterPlanCommit = undefined;
        allowLegacy = false;
      }
      return { starts, handoffs, planTurns, otherTurns, dispatches, resultBoundaries };
    },
    fileSnapshot() {
      assert.ok(authority instanceof FileProjectStore);
      return authority.snapshot();
    },
  };
}

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: team size follows the captured project allowance and preserves every grant on reopen`, async (t) => {
    const f = await fixture(t, kind, { createRole: true, maxWorkers: 3 });
    const plan = candidate('create');
    plan.team = ['builder', 'tester', 'researcher'].map((roleId) => ({
      ...candidate('create').team[0],
      roleId,
      paths: ['src/' + roleId + '.ts'],
    }));
    const versions = { builder: null, tester: null, researcher: null };
    const excessive = structuredClone(plan);
    excessive.team.push({ ...plan.team[0], roleId: 'extra', paths: ['src/extra.ts'] });
    const before = await f.events();
    await assert.rejects(f.accept(excessive, { ...versions, extra: null }), {
      code: 'INVALID_PLAN',
    });
    assert.deepEqual(await f.events(), before);
    assert.equal(await f.runs().plan(f.runId), undefined);
    const accepted = await f.accept(plan, versions);
    assert.deepEqual(
      accepted.assignments.map((assignment) => assignment.role.id),
      ['builder', 'tester', 'researcher'],
    );
    assert.equal((await f.runs().planningInput(f.runId)).policy.maxWorkers, 3);
    await f.reopen();
    for (const assignment of accepted.assignments)
      assert.deepEqual(await f.runs().assignment(f.runId, assignment.role.id), assignment);
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: actual plan rejection identifies a missing reused role and a corrected create preserves its original grant`, async (t) => {
    const f = await fixture(t, kind, { createRole: true });
    const proposed = candidate('reuse');
    proposed.team[0].roleId = 'worker';
    proposed.steps[0].owner = 'worker';
    const before = await f.events();
    const current = await f.runs().current(f.runId);
    await assert.rejects(f.accept(proposed, { worker: null }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /roleId "worker".*not in the catalog/);
      assert.match(error.message, /reuse Brief.roles/);
      assert.ok(error.message.includes('action="create"'));
      return (error as { code?: string }).code === 'INVALID_PLAN';
    });
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(await f.events(), before);
    assert.equal(await f.runs().plan(f.runId), undefined);
    assert.equal(await f.runs().assignment(f.runId, 'worker'), undefined);
    assert.equal(f.effects(), 0);

    const corrected = structuredClone(proposed);
    corrected.team[0].action = 'create';
    const accepted = await f.accept(corrected, { worker: null });
    assert.equal(accepted.assignments[0].role.id, 'worker');
    assert.equal(accepted.assignments[0].origin, 'created');
    assert.deepEqual(accepted.assignments[0].task, proposed.team[0].assignment);
    assert.deepEqual(accepted.assignments[0].paths, proposed.team[0].paths);
    assert.equal(accepted.assignments[0].resource.resource.id, 'fake');
    await f.reopen();
    assert.deepEqual(await f.runs().assignment(f.runId, 'worker'), accepted.assignments[0]);
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: a real coordinator fixed pin preserves its selected nondefault pool resource through planning acceptance and reopen`, async (t) => {
    const f = await fixture(t, kind, { nondefaultCoordinator: true });
    const input = await f.runs().planningInput(f.runId);
    assert.equal(input.resources.coordinator.id, 'fake');
    assert.equal(input.coordinator.resource.resource.id, f.pinnedCoordinator.id);
    assert.notEqual(input.planningPolicy.runtimeId, input.resources.coordinator.id);
    assert.equal(input.planningPolicy.runtimeId, f.pinnedCoordinator.id);
    assert.equal(
      input.planningPolicy.configurationRevision,
      f.pinnedCoordinator.configurationRevision,
    );
    assert.equal(
      input.planningPolicy.capabilitiesRevision,
      f.pinnedCoordinator.capabilities.revision,
    );
    assert.deepEqual(input.coordinator.role, f.coordinatorRole);
    assert.deepEqual(input.coordinator.resource.resource, f.pinnedCoordinator);
    assert.equal(input.coordinator.resource.source, 'fixed');
    const saved = await f.accept();
    assert.deepEqual(saved.plan.context.coordinator, input.coordinator);
    assert.equal(
      saved.plan.context.coordinator.resource.resource.model,
      'pinned-coordinator-model',
    );
    await f.reopen();
    assert.deepEqual((await f.runs().planningInput(f.runId)).coordinator, input.coordinator);
    assert.deepEqual((await f.runs().plan(f.runId))?.context.coordinator, input.coordinator);
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: actual plan command freezes complete assignment decisions and named reads survive library/team changes and reopen`, async (t) => {
    const f = await fixture(t, kind);
    const saved = await f.accept();
    const plan = await f.runs().plan(f.runId),
      assignment = await f.runs().assignment(f.runId, 'builder');
    assert.deepEqual(saved.plan, plan);
    assert.deepEqual(saved.assignments, [assignment]);
    assert.equal(assignment?.role.instructions, f.role!.instructions);
    assert.equal(assignment?.role.version, 1);
    assert.equal(assignment?.resource.resource.id, 'fake');
    assert.deepEqual(assignment?.paths, ['src/value.ts']);
    assert.deepEqual(assignment?.task, candidate().team[0].assignment);
    assert.equal(
      plan?.context.goalText,
      f.goal.body + '\n\nAcceptance criteria:\n' + f.goal.criteria,
    );
    assert.deepEqual(plan?.context.contextMaterials, [f.material]);
    assert.deepEqual(plan?.context.policy.scope, profile.scope);
    assert.deepEqual(plan?.context.checkIds, ['test']);
    assert.equal(plan?.context.contextSource, 'initial-admission');
    const before = await f.events();
    await f.store.materials.transaction(command('remove-material'), (tx) =>
      tx.remove(f.material.id),
    );
    await f.roles.save('builder-v2', 'builder-v2', {
      ...f.role!,
      projectId: 'p',
      expectedVersion: 1,
      instructions: 'Future worker instructions only',
    });
    await f.reopen();
    f.queries.length = 0;
    assert.deepEqual(await f.runs().plan(f.runId), plan);
    assert.deepEqual(await f.runs().assignment(f.runId, 'builder'), assignment);
    assert.ok(f.queries.every((query) => !/admission|timeline|history|goal/.test(query.operation)));
    assert.ok(f.queries.every((query) => query.rows <= 12));
    assert.equal(f.effects(), 0);
    assert.ok(before.some((event: any) => event.type === 'run.plan-accepted'));
  });

  test(`${kind}: user role version changes during planning reject stale acceptance with zero partial writes`, async (t) => {
    const f = await fixture(t, kind);
    await f.roles.save('builder-v2', 'builder-v2', {
      ...f.role!,
      projectId: 'p',
      expectedVersion: 1,
      instructions: 'Changed pin/instructions during planning',
    });
    const before = await f.events(),
      current = await f.runs().current(f.runId);
    await assert.rejects(f.accept(), { code: 'ROLE_CHANGED' });
    assert.equal(await f.runs().plan(f.runId), undefined);
    assert.equal(await f.runs().assignment(f.runId, 'builder'), undefined);
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(await f.events(), before);
    await f.accept(candidate(), { builder: 2 });
    assert.equal((await f.runs().assignment(f.runId, 'builder'))?.role.version, 2);
  });

  test(`${kind}: cancellation and unresolved effects block plan acceptance before granting assignment authority`, async (t) => {
    const canceled = await fixture(t, kind);
    await canceled.service.cancel('stop', 'stop', { projectId: 'p', runId: canceled.runId });
    const cancelEvents = await canceled.events();
    await assert.rejects(canceled.accept(), { name: 'AbortError' });
    assert.equal(await canceled.runs().plan(canceled.runId), undefined);
    assert.deepEqual(await canceled.events(), cancelEvents);
    const unknown = await fixture(t, kind);
    await unknown.unresolved();
    const before = await unknown.events();
    await assert.rejects(unknown.accept(), { code: 'RUN_RECONCILIATION_REQUIRED' });
    assert.equal(await unknown.runs().plan(unknown.runId), undefined);
    assert.deepEqual(await unknown.events(), before);
    assert.equal(canceled.effects() + unknown.effects(), 0);
  });

  test(`${kind}: caught late persistence failure rolls back newly minted role, plan, assignments, head, event and receipt`, async (t) => {
    const f = await fixture(t, kind, { createRole: true });
    const current = await f.runs().current(f.runId),
      before = await f.events();
    await f.failStorage(true);
    const input = {
      runId: f.runId,
      planId: 'P-fault',
      now: 'fault-time',
      plan: candidate('create'),
      expectedRoleVersions: { builder: null },
      expectedInput: await f.runs().planningInput(f.runId),
    };
    await assert.rejects(
      f.runs().transaction(command('fault'), (tx) => {
        try {
          tx.acceptPlan(input);
        } catch {}
        return { attempted: true };
      }),
      /injected plan/,
    );
    await f.failStorage(false);
    assert.equal(await f.store.entities.role('builder'), undefined);
    assert.equal(await f.runs().plan(f.runId), undefined);
    assert.equal(await f.runs().assignment(f.runId, 'builder'), undefined);
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(await f.events(), before);
    assert.equal(await f.runs().receipt(command('fault')), undefined);
    await f.reopen();
    const result = await f
      .runs()
      .transaction(command('fault'), (tx) => tx.acceptPlan({ ...input, now: 'retry-time' }));
    await f.service.cancel('later-stop', 'later-stop', { projectId: 'p', runId: f.runId });
    await f.reopen();
    assert.deepEqual(
      await f.runs().transaction(command('fault'), () => {
        throw Error('Replay callback executed');
      }),
      result,
    );
    await assert.rejects(
      f.runs().transaction({ id: 'fault', fingerprint: 'foreign' }, () => null),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  });
}

test('sqlite: readonly plan cannot invent an authoritative planner-session handoff', async (t) => {
  const f = await fixture(t, 'sqlite', { readonly: true });
  const before = await f.events();
  await assert.rejects(f.accept(), { code: 'PLANNING_HANDOFF_UNAVAILABLE' });
  assert.equal(await f.runs().plan(f.runId), undefined);
  assert.deepEqual(await f.events(), before);
});

test('file: actual readonly planner acceptance clears the exact planner before a fresh writer starts', async (t) => {
  const f = await fixture(t, 'file', { readonly: true, ready: false });
  const observed = await f.actualPlanning();
  assert.equal(observed.planTurns, 1);
  assert.deepEqual(
    observed.starts.map((start) => start.readOnly),
    [true, false],
  );
  assert.equal(observed.handoffs.length, 1);
  const plan = await f.runs().plan(f.runId),
    handoff = observed.handoffs[0];
  assert.equal(handoff.threadId, '');
  assert.equal(handoff.plannerId, plan?.readOnlyPlanner?.sessionId);
  assert.equal(handoff.parentId, plan?.readOnlyPlanner?.sessionId);
  assert.equal(plan?.readOnlyPlanner?.threadId, observed.starts[0].threadId);
  assert.notEqual(handoff.coordinatorId, handoff.plannerId);
  assert.equal(handoff.planId, plan?.id);
  assert.equal(f.effects(), 0);
});

test('file: actual readonly planning retains a fixed nondefault coordinator through the planner-to-writer handoff', async (t) => {
  const f = await fixture(t, 'file', { readonly: true, ready: false, nondefaultCoordinator: true });
  const observed = await f.actualPlanning();
  assert.equal(observed.planTurns, 1);
  assert.deepEqual(
    observed.starts.map((start) => start.readOnly),
    [true, false],
  );
  const plan = await f.runs().plan(f.runId);
  assert.deepEqual(plan?.context.coordinator.role, f.coordinatorRole);
  assert.deepEqual(plan?.context.coordinator.resource.resource, f.pinnedCoordinator);
  assert.equal(plan?.readOnlyPlanner?.sessionGrant.runtimeId, f.pinnedCoordinator.id);
  assert.equal(
    plan?.readOnlyPlanner?.sessionGrant.configurationRevision,
    f.pinnedCoordinator.configurationRevision,
  );
  assert.equal(plan?.readOnlyPlanner?.sessionGrant.model, f.pinnedCoordinator.model);
  assert.equal(f.effects(), 0);
});

test('file: failed observed-plan commit triggers no corrective model turn, writer or worker dispatch', async (t) => {
  const f = await fixture(t, 'file', { readonly: true, ready: false });
  const observed = await f.actualPlanning(true);
  assert.equal(observed.planTurns, 1);
  assert.equal(observed.otherTurns, 0);
  assert.deepEqual(
    observed.starts.map((start) => start.readOnly),
    [true],
  );
  assert.equal(observed.dispatches, 0);
  assert.equal(observed.resultBoundaries, 0);
  assert.equal(await f.runs().plan(f.runId), undefined);
  assert.equal(await f.runs().assignment(f.runId, 'builder'), undefined);
  const run = f.fileSnapshot().runs.find((run) => run.id === f.runId)!;
  assert.equal(
    run.events.some((event) => event.type === 'plan.rejected'),
    false,
  );
  assert.equal(
    run.events.some((event) => event.type === 'plan.saved'),
    false,
  );
  assert.equal(f.effects(), 0);
});

test('file: actual task change during the model turn rejects stale acceptance without corrective generation', async (t) => {
  const f = await fixture(t, 'file', { readonly: true, ready: false });
  const observed = await f.actualPlanning(false, false, true);
  assert.equal(observed.planTurns, 1);
  assert.deepEqual(
    observed.starts.map((start) => start.readOnly),
    [true],
  );
  assert.equal(observed.dispatches, 0);
  assert.equal(observed.resultBoundaries, 0);
  assert.equal(await f.runs().plan(f.runId), undefined);
  const run = f.fileSnapshot().runs.find((run) => run.id === f.runId)!;
  assert.equal(
    run.events.some((event) => event.type === 'plan.rejected'),
    false,
  );
  assert.ok(run.goalText?.endsWith('Later task clarification.'));
  assert.equal(f.effects(), 0);
});

test('file: cancellation after accepted readonly plan commit prevents fresh writer dispatch', async (t) => {
  const f = await fixture(t, 'file', { readonly: true, ready: false });
  const observed = await f.actualPlanning(false, true);
  assert.deepEqual(
    observed.starts.map((start) => start.readOnly),
    [true],
  );
  assert.equal(observed.dispatches, 0);
  assert.equal(observed.resultBoundaries, 0);
  assert.equal(observed.otherTurns, 0);
  const plan = await f.runs().plan(f.runId);
  assert.ok(plan?.readOnlyPlanner);
  const run = f.fileSnapshot().runs.find((run) => run.id === f.runId)!;
  assert.equal(run.threadId, '');
  assert.equal(run.coordinatorSession, undefined);
  assert.equal(run.planningSession?.id, plan.readOnlyPlanner.sessionId);
  assert.equal(run.status, 'interrupted');
  assert.equal(f.effects(), 0);
});

test('file: actual dispatcher reads the accepted named grant after later role and material-library edits', async (t) => {
  const f = await fixture(t, 'file');
  const accepted = await f.accept();
  await f.roles.save('builder-after-plan', 'builder-after-plan', {
    ...f.role!,
    projectId: 'p',
    expectedVersion: 1,
    instructions: 'Future role only',
  });
  await f.store.materials.transaction(command('remove-dispatch-material'), (tx) =>
    tx.remove(f.material.id),
  );
  await f.service.phase('p', f.runId, 'implementation', 'Dispatch original grant');
  let starts = 0;
  f.service.env.workspaces.changes = async () => [];
  f.service.env.runtime.start = async (input) => {
    starts++;
    assert.deepEqual(input.assignment?.scope, { ...profile.scope, plannedPaths: ['src/value.ts'] });
    assert.ok(input.instructions.includes(f.role!.instructions));
    return { threadId: 'accepted-builder-thread' };
  };
  f.service.env.runtime.release = async () => {};
  const result = await f.withLegacy(() =>
    f.service.dispatchWorkers(
      'p',
      f.runId,
      [accepted.assignments[0].role],
      f.workspace,
      executionPolicy(profile),
      new AbortController().signal,
      [],
      async (_thread, prompt) => {
        assert.ok(prompt.includes(f.material.hash));
        assert.ok(prompt.includes(candidate().team[0].assignment!.criteria[0]));
        return {
          status: 'success',
          summary: 'Synthetic worker completion',
          artifacts: [],
          notesForNextAgent: '',
        };
      },
    ),
  );
  assert.deepEqual(f.grantReads, ['builder']);
  assert.equal(starts, 1);
  assert.equal(result[0].roleVersion, 1);
  assert.equal(result[0].runtimeId, accepted.assignments[0].resource.resource.id);
  const run = f.fileSnapshot().runs.find((run) => run.id === f.runId)!;
  assert.equal(run.agents[0].assignment?.envelope?.materials[0].hash, f.material.hash);
  assert.deepEqual(run.agents[0].assignment?.paths, accepted.assignments[0].paths);
  assert.equal(f.effects(), 0);
});

test('sqlite: current plan and assignment reads remain indexed with 1024 noncurrent immutable-row fixtures', async (t) => {
  const f = await fixture(t, 'sqlite');
  const accepted = await f.accept();
  const probe = async () => {
    f.queries.length = 0;
    const plan = await f.runs().plan(f.runId),
      assignment = await f.runs().assignment(f.runId, 'builder');
    return {
      plan,
      assignment,
      trace: f.queries.map(({ operation, rows }) => ({ operation, rows })),
    };
  };
  const before = await probe();
  const evidence = await seedNoncurrentPlanRows(f.directory, accepted.plan.id, 1024);
  assert.equal(evidence.count, 1024);
  assert.ok(evidence.details.every((detail) => /SEARCH/.test(detail) && !/SCAN/.test(detail)));
  await f.reopen();
  const after = await probe();
  assert.deepEqual(after, before);
  assert.equal(f.effects(), 0);
});

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: plan context CAS rejects altered task, material and scope before writes`, async (t) => {
    const f = await fixture(t, kind);
    const captured = await f.runs().planningInput(f.runId);
    const before = await f.events();
    for (const [id, changed] of [
      ['task', { ...captured, goalText: 'Truncated task' }],
      ['materials', { ...captured, contextMaterials: [] }],
      [
        'scope',
        {
          ...captured,
          policy: { ...captured.policy, scope: { ...captured.policy.scope, protectedPaths: [] } },
        },
      ],
    ] as const) {
      await assert.rejects(
        f.runs().transaction(command('forged-' + id), (tx) =>
          tx.acceptPlan({
            runId: f.runId,
            planId: 'P-' + id,
            now: 'forged-time',
            plan: candidate(),
            expectedRoleVersions: { builder: 1 },
            expectedInput: changed,
          }),
        ),
      );
      assert.equal(await f.runs().receipt(command('forged-' + id)), undefined);
    }
    assert.equal(await f.runs().plan(f.runId), undefined);
    assert.deepEqual(await f.events(), before);
    const saved = await f.service.acceptPlan('p', f.runId, candidate(), { builder: 1 }, captured);
    assert.deepEqual(saved.plan.context, captured);
  });

  test(`${kind}: one initial plan is authoritative and another command cannot replace its assignment`, async (t) => {
    const f = await fixture(t, kind);
    const saved = await f.accept();
    const before = await f.events();
    await assert.rejects(f.accept({ ...candidate(), summary: 'Replace the prior grant' }), {
      code: 'PLAN_EXISTS',
    });
    assert.deepEqual(await f.runs().plan(f.runId), saved.plan);
    assert.deepEqual(await f.runs().assignment(f.runId, 'builder'), saved.assignments[0]);
    assert.deepEqual(await f.events(), before);
  });
}
