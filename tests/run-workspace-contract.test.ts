import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import { executionPolicy } from '../core/project-settings.ts';
import type { AgentRuntime, ProjectStore } from '../core/ports.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import type { ExecutionEnvironmentPort } from '../core/environment-ports.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';
import {
  failWorkspaceTimelineInsert,
  removeWorkspaceTable,
  workspaceTableExists,
} from './fixtures/sqlite-run-workspace-fault.ts';

const cmd = (id: string) => ({ id, fingerprint: 'workspace:' + id });
const profile: ProjectProfile = {
  version: 1,
  revision: 1,
  context: 'Synthetic workspace ownership',
  scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
  checks: [{ id: 'test', title: 'Test', command: 'must-not-run', timeoutMs: 1000 }],
  defaultCheckIds: ['test'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 1,
  turnTimeoutMs: 10000,
  baseBranch: 'retained-source-branch',
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

async function fixture(t: any, kind: 'file' | 'sqlite') {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-run-workspace-')),
  );
  const root = path.join(directory, 'source');
  await fs.mkdir(root);
  const project = { id: 'p', name: 'Synthetic workspace project', root, managed: true };
  const prepared = { path: path.join(directory, 'isolated-workspace'), base: 'a'.repeat(40) };
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
            onQuery: (query) => queries.push(query),
          });
  };
  await open();
  await fs.writeFile(path.join(directory, '.workspace-fault-fixture'), 'synthetic-only');
  let allowLegacy = false,
    ids = 0,
    externalEffects = 0,
    planning = 0;
  let preparation: (() => Promise<void>) | undefined;
  let afterBinding: (() => Promise<void>) | undefined;
  let restored = prepared;
  const releases: string[] = [],
    bases: (string | undefined)[] = [];
  const bindingObservations: {
    status: string | undefined;
    canceled: boolean | undefined;
    path: string | undefined;
  }[] = [];
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
        async transaction<T>(
          command: { id: string; fingerprint: string },
          apply: Parameters<typeof authority.runs.transaction<T>>[1],
        ) {
          const result = await authority.runs.transaction(command, apply);
          if (command.fingerprint === 'run.bind-workspace') {
            const current = await authority.runs.current((result as { runId: string }).runId);
            const binding = await authority.runs.workspace((result as { runId: string }).runId);
            bindingObservations.push({
              status: current?.status,
              canceled: current?.cancelRequested,
              path: binding?.path,
            });
            await afterBinding?.();
          }
          return result;
        },
      };
    },
    snapshot() {
      assert.ok(
        allowLegacy && authority instanceof FileProjectStore,
        'Workspace consumer hydrated a document.',
      );
      return authority.snapshot();
    },
    transact(...args: Parameters<FileProjectStore['transact']>) {
      assert.ok(
        allowLegacy && authority instanceof FileProjectStore,
        'Workspace consumer used a document callback.',
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
    externalEffects++;
    throw Error('No model/check dispatch in workspace proof.');
  };
  const workspaces = {
    async prepare(_projectId: string, _runId: string, base?: string) {
      bases.push(base);
      await preparation?.();
      return { ...prepared };
    },
    async restore(_projectId: string, _runId: string, workspace: string, base: string) {
      assert.equal(workspace, prepared.path);
      assert.equal(base, prepared.base);
      return { ...restored };
    },
  } as WorkspacePort;
  const service = new ExecutionService({
    actions: createBuiltinExecutionActions(),
    ...env,
    policies: { p: executionPolicy(profile) },
    workflowRoles: createBuiltinWorkflowRoles(),
    selection: fixtureExecutionSelection('fake', fixtureExecutionCapabilities()),
    workspaces,
    checks: { run: forbidden } as CheckPort,
    runtime: {
      id: 'fake',
      start: forbidden,
      submit: forbidden,
      turn: forbidden,
      interrupt: forbidden,
      dispose: async () => {},
    } as AgentRuntime,
    environments: {
      prepare: forbidden,
      release: async (workspace: string) => {
        releases.push(workspace);
      },
    } as ExecutionEnvironmentPort,
  });
  service.schedule = () => {};
  service.orchestrate = async (_projectId, runId) => {
    planning++;
    assert.deepEqual(await authority.runs.workspace(runId), {
      version: 1,
      runId,
      admissionId: (await authority.runs.current(runId))!.admissionId,
      attemptId: (await authority.runs.current(runId))!.attemptId,
      path: prepared.path,
      baseCommit: prepared.base,
      createdAt: (await authority.runs.workspace(runId))!.createdAt,
    });
  };
  const goal = await new GoalService(env).create('goal', 'goal', {
    projectId: 'p',
    title: 'Bind observed workspace',
    body: 'Keep complete task',
    criteria: 'Never dispatch a model.',
  });
  const { runId } = await service.start('queue', 'queue', { projectId: 'p', goalId: goal.id });
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
    root,
    project,
    prepared,
    runId,
    service,
    store,
    queries,
    events,
    releases,
    bases,
    bindingObservations,
    runs: () => authority.runs,
    counts: () => ({ externalEffects, planning }),
    async ready() {
      await service.beginExecution('p', runId);
      await service.phase('p', runId, 'preparing', 'Prepare retained workspace');
    },
    async bind() {
      return service.bindPreparedWorkspace('p', runId, prepared);
    },
    async reopen() {
      await authority.close();
      await open();
    },
    async rejectMissingWorkspaceTable() {
      assert.ok(authority instanceof SqliteProjectUsageAuthority);
      await authority.close();
      await removeWorkspaceTable(directory);
      await assert.rejects(open(), { code: 'USAGE_AUTHORITY_FORMAT' });
      assert.equal(await workspaceTableExists(directory), false);
    },
    async failStorage(enabled: boolean) {
      if (authority instanceof SqliteProjectUsageAuthority)
        await failWorkspaceTimelineInsert(directory, enabled);
      else
        authority.replace = enabled
          ? async () => {
              throw Error('injected workspace file failure');
            }
          : fs.rename;
    },
    async execute(cancelAt?: 'prepare' | 'binding') {
      allowLegacy = true;
      const reached = deferred(),
        release = deferred();
      if (cancelAt === 'prepare')
        preparation = async () => {
          reached.resolve();
          await release.promise;
        };
      if (cancelAt === 'binding')
        afterBinding = async () => {
          reached.resolve();
          await release.promise;
        };
      const execution = service.execute('p', runId, new AbortController().signal);
      try {
        if (cancelAt) {
          await reached.promise;
          await service.cancel('during-' + cancelAt, 'during-' + cancelAt, {
            projectId: 'p',
            runId,
          });
        }
      } finally {
        release.resolve();
        await execution;
        allowLegacy = false;
        preparation = undefined;
        afterBinding = undefined;
      }
    },
    async executeWithFailedBinding() {
      assert.ok(authority instanceof FileProjectStore);
      allowLegacy = true;
      preparation = async () => {
        (authority as FileProjectStore).replace = async () => {
          throw Error('injected observed binding failure');
        };
      };
      try {
        await assert.rejects(
          service.execute('p', runId, new AbortController().signal),
          /injected observed binding failure/,
        );
      } finally {
        (authority as FileProjectStore).replace = fs.rename;
        preparation = undefined;
        allowLegacy = false;
      }
    },
    async restoreMismatch(value: typeof prepared) {
      allowLegacy = true;
      try {
        await service.finish('p', runId, 'failed', 'Stopped before model work');
        await service.resume('resume', 'resume', {
          projectId: 'p',
          runId,
          mode: 'repair',
          instructions: '',
          useCurrentProfile: false,
        });
        restored = value;
        await service.execute('p', runId, new AbortController().signal);
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
  test(`${kind}: actual workspace binder and named read preserve source identity across reopen without aggregate access`, async (t) => {
    const f = await fixture(t, kind);
    await f.ready();
    await f.bind();
    const binding = await f.runs().workspace(f.runId),
      current = await f.runs().current(f.runId);
    assert.equal(binding?.path, f.prepared.path);
    assert.equal(binding?.baseCommit, f.prepared.base);
    assert.equal(binding?.admissionId, current?.admissionId);
    assert.equal(binding?.attemptId, current?.attemptId);
    assert.notEqual(binding?.path, f.root);
    assert.deepEqual(
      Object.keys(binding!).sort(),
      ['version', 'runId', 'admissionId', 'attemptId', 'path', 'baseCommit', 'createdAt'].sort(),
    );
    assert.equal(Object.hasOwn(current!, 'commit'), false);
    const before = await f.events();
    binding!.path = 'caller-mutated-path';
    assert.equal((await f.runs().workspace(f.runId))?.path, f.prepared.path);
    binding!.path = f.prepared.path;
    await f.reopen();
    f.queries.length = 0;
    assert.deepEqual(await f.runs().workspace(f.runId), binding);
    await assert.rejects(f.runs().workspace('R-missing'), { code: 'NOT_FOUND' });
    assert.ok(f.queries.every((query) => query.rows <= 1));
    assert.ok(
      f.queries.every((query) => ['run.current', 'run.workspace'].includes(query.operation)),
      'Named workspace reads cannot hydrate admission, task or history.',
    );
    assert.deepEqual(await f.events(), before);
    assert.deepEqual(f.counts(), { externalEffects: 0, planning: 0 });
  });

  test(`${kind}: identical binding retries keep original identity and conflicting observations cannot replace it`, async (t) => {
    const f = await fixture(t, kind);
    await f.ready();
    await f.bind();
    const binding = await f.runs().workspace(f.runId),
      current = await f.runs().current(f.runId),
      before = await f.events();
    assert.deepEqual(
      await f.runs().transaction(cmd('same'), (tx) =>
        tx.bindPreparedWorkspace({
          runId: f.runId,
          path: f.prepared.path,
          baseCommit: f.prepared.base,
          now: 'later',
        }),
      ),
      binding,
    );
    for (const change of [{ path: f.prepared.path + '-other' }, { baseCommit: 'b'.repeat(40) }])
      await assert.rejects(
        f.runs().transaction(cmd('conflict-' + Object.keys(change)[0]), (tx) =>
          tx.bindPreparedWorkspace({
            runId: f.runId,
            path: f.prepared.path,
            baseCommit: f.prepared.base,
            now: 'later',
            ...change,
          }),
        ),
      );
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(await f.events(), before);
    await f.reopen();
    assert.deepEqual(await f.runs().workspace(f.runId), binding);
  });

  test(`${kind}: unstarted work cannot invent a prepared binding`, async (t) => {
    const f = await fixture(t, kind);
    const before = await f.events();
    await assert.rejects(f.bind(), { code: 'INVALID_STATE' });
    assert.equal(await f.runs().workspace(f.runId), undefined);
    assert.deepEqual(await f.events(), before);
  });

  test(`${kind}: prepared observations retain canceled workspace ownership without restarting work`, async (t) => {
    const f = await fixture(t, kind);
    await f.ready();
    await f.service.cancel('stop', 'stop', { projectId: 'p', runId: f.runId });
    await f.bind();
    assert.equal((await f.runs().workspace(f.runId))?.path, f.prepared.path);
    assert.equal((await f.runs().current(f.runId))?.status, 'canceling');
    assert.equal((await f.runs().current(f.runId))?.cancelRequested, true);
    await assert.rejects(f.service.phase('p', f.runId, 'planning', 'Canceled work'), {
      name: 'AbortError',
    });
    assert.deepEqual(f.counts(), { externalEffects: 0, planning: 0 });
  });

  test(`${kind}: failed binding transactions leave no row, event or receipt and retry cleanly`, async (t) => {
    const f = await fixture(t, kind);
    await f.ready();
    const current = await f.runs().current(f.runId),
      before = await f.events();
    await f.failStorage(true);
    await assert.rejects(
      f.runs().transaction(cmd('fault'), (tx) => {
        try {
          tx.bindPreparedWorkspace({
            runId: f.runId,
            path: f.prepared.path,
            baseCommit: f.prepared.base,
            now: 'fault-time',
          });
        } catch {}
        return { attempted: true };
      }),
      /injected workspace/,
    );
    await f.failStorage(false);
    assert.equal(await f.runs().workspace(f.runId), undefined);
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(await f.events(), before);
    assert.equal(await f.runs().receipt(cmd('fault')), undefined);
    await f.reopen();
    assert.equal(await f.runs().workspace(f.runId), undefined);
    const result = await f.runs().transaction(cmd('fault'), (tx) =>
      tx.bindPreparedWorkspace({
        runId: f.runId,
        path: f.prepared.path,
        baseCommit: f.prepared.base,
        now: 'retry-time',
      }),
    );
    await f.service.cancel('later-stop', 'later-stop', { projectId: 'p', runId: f.runId });
    await f.reopen();
    assert.deepEqual(
      await f.runs().transaction(cmd('fault'), () => {
        throw Error('Replayed callback');
      }),
      result,
    );
  });
}

test('file: actual prepare binds observed path/base before downstream planning and keeps original source branch', async (t) => {
  const f = await fixture(t, 'file');
  await f.execute();
  assert.deepEqual(f.counts(), { externalEffects: 0, planning: 1 });
  assert.deepEqual(f.bases, ['retained-source-branch']);
  assert.deepEqual(f.releases, [f.prepared.path]);
  const run = f.fileSnapshot().runs.find((run) => run.id === f.runId)!;
  assert.equal(run.workspace, f.prepared.path);
  assert.equal(run.baseCommit, f.prepared.base);
  assert.equal(run.baseBranch, 'retained-source-branch');
  assert.equal(run.commit, undefined);
});

test('file: cancellation before execution acquires no workspace or binding', async (t) => {
  const f = await fixture(t, 'file');
  await f.service.cancel('before-prepare', 'before-prepare', { projectId: 'p', runId: f.runId });
  await f.execute();
  assert.deepEqual(f.bases, []);
  assert.deepEqual(f.releases, []);
  assert.equal(await f.runs().workspace(f.runId), undefined);
  assert.deepEqual(f.counts(), { externalEffects: 0, planning: 0 });
});

for (const cancelAt of ['prepare', 'binding'] as const) {
  test(`file: cancellation during ${cancelAt} retains observed binding and releases exact acquired workspace`, async (t) => {
    const f = await fixture(t, 'file');
    await f.execute(cancelAt);
    assert.deepEqual(f.counts(), { externalEffects: 0, planning: 0 });
    assert.equal((await f.runs().workspace(f.runId))?.path, f.prepared.path);
    assert.equal((await f.runs().current(f.runId))?.status, 'interrupted');
    assert.deepEqual(f.releases, [f.prepared.path]);
    if (cancelAt === 'prepare')
      assert.deepEqual(f.bindingObservations, [
        { status: 'canceling', canceled: true, path: f.prepared.path },
      ]);
  });
}

test('file: restore cannot adopt a different returned workspace identity', async (t) => {
  const f = await fixture(t, 'file');
  await f.ready();
  await f.bind();
  const binding = await f.runs().workspace(f.runId);
  await f.restoreMismatch({ path: f.prepared.path + '-foreign', base: 'b'.repeat(40) });
  assert.deepEqual(await f.runs().workspace(f.runId), binding);
  const run = f.fileSnapshot().runs.find((run) => run.id === f.runId)!;
  assert.equal(run.workspace, f.prepared.path);
  assert.equal(run.baseCommit, f.prepared.base);
  assert.deepEqual(f.counts(), { externalEffects: 0, planning: 0 });
  assert.notEqual(run.status, 'completed');
  assert.deepEqual(f.releases, [f.prepared.path + '-foreign']);
});

test('file: observed prepared workspace is released even when binding and failure persistence both fail', async (t) => {
  const f = await fixture(t, 'file');
  await f.executeWithFailedBinding();
  assert.deepEqual(f.releases, [f.prepared.path]);
  assert.deepEqual(f.counts(), { externalEffects: 0, planning: 0 });
  assert.equal(await f.runs().workspace(f.runId), undefined);
  assert.equal((await f.runs().current(f.runId))?.phase, 'preparing');
});

test('sqlite: reopening a missing required workspace table fails before rebuilding empty authority', async (t) => {
  const f = await fixture(t, 'sqlite');
  await f.ready();
  await f.bind();
  await f.rejectMissingWorkspaceTable();
});
