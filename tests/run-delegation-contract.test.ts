import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ExecutionService } from '../core/execution.ts';
import { validateProjectRunChange } from '../core/project-runs.ts';
import { GoalService, RoleService } from '../core/services.ts';
import { executionPolicy } from '../core/project-settings.ts';
import type { AgentRuntime, ProjectStore } from '../core/ports.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import type { ContextMaterial, ProjectProfile } from '../protocol/domain.ts';
import type { WorkerProposal } from '../protocol/execution.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';
import {
  failDelegationTimelineInsert,
  seedNoncurrentAssignmentRows,
  setUnresolvedDelegationFact,
} from './fixtures/sqlite-run-delegation-fault.ts';

const command = (id: string) => ({ id, fingerprint: 'delegation:' + id });
const profile: ProjectProfile = {
  version: 1,
  revision: 1,
  context: 'Retain trusted delegation scope',
  scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['AGENTS.md'] },
  checks: [{ id: 'test', title: 'Test', command: 'must-not-run', timeoutMs: 1000 }],
  defaultCheckIds: ['test'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 1,
  turnTimeoutMs: 10000,
  baseBranch: 'synthetic-source',
};
function candidate(action: 'create' | 'reuse' = 'reuse'): WorkerProposal {
  return {
    roleId: 'builder',
    action,
    title: 'Proposed builder',
    description: 'A scoped implementation worker',
    instructions: 'Use the immutable task and scope.',
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
  };
}

async function fixture(
  t: any,
  kind: 'file' | 'sqlite',
  options: {
    writerOnly?: boolean;
    createRole?: boolean;
    ready?: boolean;
    nondefaultCoordinator?: boolean;
    maxWorkers?: number;
  } = {},
) {
  const configuredProfile = { ...profile, maxWorkers: options.maxWorkers ?? profile.maxWorkers };
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-run-delegation-')),
  );
  const root = path.join(directory, 'source');
  await fs.mkdir(root);
  const project = { id: 'p', name: 'Synthetic immutable delegations', root, managed: true };
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
  await fs.writeFile(path.join(directory, '.delegation-fault-fixture'), 'synthetic-only');
  let allowLegacy = false,
    ids = 0,
    effects = 0;
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
        transaction: authority.runs.transaction.bind(authority.runs),
      };
    },
    snapshot() {
      assert.ok(
        allowLegacy && authority instanceof FileProjectStore,
        'Delegation consumer hydrated a legacy document.',
      );
      return authority.snapshot();
    },
    transact(...args: Parameters<FileProjectStore['transact']>) {
      assert.ok(
        allowLegacy && authority instanceof FileProjectStore,
        'Delegation consumer used document mutations.',
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
    throw Error('No model/workspace/check effect in delegation contract.');
  };
  const selection = fixtureExecutionSelection('fake', fixtureExecutionCapabilities());
  const resources = selection.forProject('p');
  if (options.writerOnly) {
    const coordinator = {
      ...resources.coordinator,
      id: 'writer-only-coordinator',
      capabilities: {
        ...resources.coordinator.capabilities,
        toolsFreeTurns: false,
        readOnlySessions: false,
        immutableReview: false,
      },
    };
    resources.coordinator = coordinator;
    resources.workerPool = [...(resources.workerPool ?? [resources.worker]), coordinator];
  }
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
    actions: createBuiltinExecutionActions(),
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
    title: 'Complete delegation task',
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
    delegate: async (
      worker = candidate(options.createRole ? 'create' : 'reuse'),
      expectedRoleVersion: number | null = options.createRole ? null : 1,
      expectedInput?: Awaited<ReturnType<typeof authority.runs.delegationContext>>,
    ) =>
      authority.runs.transaction(command('delegate-' + ++ids), (tx) =>
        tx.delegateWorker({
          runId,
          assignmentId: 'grant-' + ids,
          now: 'delegated-' + ids,
          worker,
          expectedRoleVersion,
          expectedInput: expectedInput ?? tx.delegationContext(runId),
          expectedAttemptId: tx.current(runId)!.attemptId,
        }),
      ),
    async reopen() {
      await authority.close();
      await open();
    },
    async failStorage(enabled: boolean) {
      if (authority instanceof SqliteProjectUsageAuthority)
        await failDelegationTimelineInsert(directory, enabled);
      else
        authority.replace = enabled
          ? async () => {
              throw Error('injected delegation file failure');
            }
          : fs.rename;
    },
    async unresolved() {
      if (authority instanceof SqliteProjectUsageAuthority)
        await setUnresolvedDelegationFact(directory, runId);
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
    fileSnapshot() {
      assert.ok(authority instanceof FileProjectStore);
      return authority.snapshot();
    },
  };
}

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: action coordinator admission requires structured scoped writing, not readonly planning`, async (t) => {
    const f = await fixture(t, kind, { writerOnly: true });
    const context = await f.runs().delegationContext(f.runId);
    assert.equal(context.coordinator.resource.resource.capabilities.readOnlySessions, false);
    assert.equal(context.coordinator.resource.resource.capabilities.toolsFreeTurns, false);
    assert.equal(context.coordinator.resource.resource.capabilities.structuredTurns, true);
    assert.equal(Object.hasOwn(context, 'planningPolicy'), false);
    await f.delegate();
    await f.reopen();
    assert.deepEqual((await f.runs().delegationContext(f.runId)).coordinator, context.coordinator);
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: fixed coordinator pin and complete admitted task/material context survive delegation and reopen`, async (t) => {
    const f = await fixture(t, kind, { nondefaultCoordinator: true });
    const input = await f.runs().delegationContext(f.runId);
    assert.equal(input.resources.coordinator.id, 'fake');
    assert.deepEqual(input.coordinator.resource.resource, f.pinnedCoordinator);
    assert.deepEqual(input.coordinator.role, f.coordinatorRole);
    assert.equal(input.coordinator.resource.source, 'fixed');
    assert.equal(input.goalText, f.goal.body + '\n\nAcceptance criteria:\n' + f.goal.criteria);
    assert.deepEqual(input.contextMaterials, [f.material]);
    assert.deepEqual(input.checkIds, ['test']);
    assert.deepEqual(input.policy.scope, profile.scope);
    const grant = await f.delegate();
    await f.store.materials.transaction(command('remove-material'), (tx) =>
      tx.remove(f.material.id),
    );
    await f.roles.save('builder-v2', 'builder-v2', {
      ...f.role!,
      projectId: 'p',
      expectedVersion: 1,
      instructions: 'Future role only',
    });
    await f.reopen();
    assert.deepEqual(await f.runs().assignment(f.runId, 'builder'), grant);
    assert.deepEqual(await f.runs().delegationContext(f.runId), input);
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: missing reused role rejects without writes and explicit create freezes the original grant`, async (t) => {
    const f = await fixture(t, kind, { createRole: true });
    const proposed = { ...candidate(), roleId: 'worker' };
    const before = await f.events();
    await assert.rejects(f.delegate(proposed, null), { code: 'INVALID_ASSIGNMENT' });
    assert.deepEqual(await f.events(), before);
    assert.equal(await f.runs().assignment(f.runId, 'worker'), undefined);
    const granted = await f.delegate({ ...proposed, action: 'create' }, null);
    assert.equal(granted.role.id, 'worker');
    assert.equal(granted.origin, 'created');
    assert.deepEqual(granted.task, proposed.assignment);
    await f.reopen();
    assert.deepEqual(await f.runs().assignment(f.runId, 'worker'), granted);
  });

  test(`${kind}: changed role version and forged task/material/scope context cannot authorize a worker`, async (t) => {
    const f = await fixture(t, kind);
    const captured = await f.runs().delegationContext(f.runId);
    const before = await f.events();
    for (const changed of [
      { ...captured, goalText: 'truncated' },
      { ...captured, contextMaterials: [] },
      {
        ...captured,
        policy: { ...captured.policy, scope: { ...captured.policy.scope, protectedPaths: [] } },
      },
    ]) {
      await assert.rejects(f.delegate(candidate(), 1, changed), {
        code: 'DELEGATION_CONTEXT_CHANGED',
      });
    }
    await f.roles.save('builder-v2', 'builder-v2', {
      ...f.role!,
      projectId: 'p',
      expectedVersion: 1,
      instructions: 'New instructions',
    });
    await assert.rejects(f.delegate(), { code: 'ROLE_CHANGED' });
    assert.equal(await f.runs().assignment(f.runId, 'builder'), undefined);
    const grant = await f.delegate(candidate(), 2);
    assert.equal(grant.role.version, 2);
    assert.equal(before.filter((event: any) => event.type === 'run.worker-delegated').length, 0);
  });

  test(`${kind}: callback-caught persistence failure rolls back role, grant, current, event and receipt`, async (t) => {
    const f = await fixture(t, kind, { createRole: true });
    const current = await f.runs().current(f.runId),
      before = await f.events();
    const input = {
      runId: f.runId,
      assignmentId: 'fault-grant',
      now: 'fault',
      worker: candidate('create'),
      expectedRoleVersion: null,
      expectedInput: await f.runs().delegationContext(f.runId),
      expectedAttemptId: current!.attemptId,
    };
    await f.failStorage(true);
    await assert.rejects(
      f.runs().transaction(command('fault'), (tx) => {
        try {
          tx.delegateWorker(input);
        } catch {}
        return true;
      }),
      /injected delegation/,
    );
    await f.failStorage(false);
    assert.equal(await f.store.entities.role('builder'), undefined);
    assert.equal(await f.runs().assignment(f.runId, 'builder'), undefined);
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(await f.events(), before);
    assert.equal(await f.runs().receipt(command('fault')), undefined);
    await f.reopen();
    const grant = await f.runs().transaction(command('fault'), (tx) => tx.delegateWorker(input));
    await f.service.cancel('later-stop', 'later-stop', { projectId: 'p', runId: f.runId });
    await f.reopen();
    assert.deepEqual(
      await f.runs().transaction(command('fault'), () => {
        throw Error('replay');
      }),
      grant,
    );
    await assert.rejects(
      f.runs().transaction({ id: 'fault', fingerprint: 'foreign' }, () => null),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  });

  test(`${kind}: delegated event rejects foreign IDs and hidden authority, and File reopen rejects projection drift`, async (t) => {
    const f = await fixture(t, kind);
    await f.delegate();
    const change: any = (await f.events()).find(
      (value: any) => value.type === 'run.worker-delegated',
    );
    assert.ok(change);
    for (const altered of [
      { ...change, hiddenGrant: true },
      { ...change, assignment: { ...change.assignment, runId: 'foreign' } },
      { ...change, assignment: { ...change.assignment, attemptId: 'foreign' } },
      { ...change, entries: [] },
    ]) {
      assert.throws(() => validateProjectRunChange(altered, 'p'));
    }
    if (kind === 'file') {
      const raw = JSON.parse(
        await fs.readFile(path.join(f.directory, 'control-state.json'), 'utf8'),
      );
      raw.runs.find((r: any) => r.id === f.runId).goalText = 'changed projection';
      await fs.writeFile(path.join(f.directory, 'control-state.json'), JSON.stringify(raw));
      await assert.rejects(f.reopen());
    }
  });
}

test('sqlite: named assignment reads remain indexed with 1024 noncurrent immutable grants', async (t) => {
  const f = await fixture(t, 'sqlite');
  const grant = await f.delegate();
  const probe = async () => {
    f.queries.length = 0;
    const assignment = await f.runs().assignment(f.runId, 'builder');
    return { assignment, trace: f.queries.map(({ operation, rows }) => ({ operation, rows })) };
  };
  const before = await probe();
  const evidence = await seedNoncurrentAssignmentRows(f.directory, grant.id, 1024);
  assert.ok(evidence.details.every((value: string) => /SEARCH/.test(value) && !/SCAN/.test(value)));
  await f.reopen();
  assert.deepEqual(await probe(), before);
});

test('file: the dispatcher uses the original named grant after later role and material-library edits', async (t) => {
  const f = await fixture(t, 'file');
  const grant = await f.delegate();
  await f.roles.save('builder-after-delegation', 'builder-after-delegation', {
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
    return { threadId: 'delegated-builder-thread' };
  };
  f.service.env.runtime.release = async () => {};
  const result = await f.withLegacy(() =>
    f.service.dispatchWorkers(
      'p',
      f.runId,
      [grant.role],
      f.workspace,
      executionPolicy(profile),
      new AbortController().signal,
      [],
      async (_thread, prompt) => {
        assert.ok(prompt.includes(f.material.hash));
        assert.ok(prompt.includes(candidate().assignment!.criteria[0]));
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
  assert.equal(result[0].runtimeId, grant.resource.resource.id);
  const run = f.fileSnapshot().runs.find((run) => run.id === f.runId)!;
  assert.equal(run.agents[0].assignment?.envelope?.materials[0].hash, f.material.hash);
  assert.deepEqual(run.agents[0].assignment?.paths, grant.paths);
  assert.equal(f.effects(), 0);
});
