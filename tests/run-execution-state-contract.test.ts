import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import type { AgentRuntime, ProjectStore } from '../core/ports.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import { executionPolicy } from '../core/project-settings.ts';
import { failLifecycleTimelineInsert } from './fixtures/sqlite-run-lifecycle-fault.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

const command = (id: string) => ({ id, fingerprint: 'state:' + id });
const profile: ProjectProfile = {
  version: 1,
  revision: 1,
  context: 'Synthetic lifecycle proof',
  scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
  checks: [{ id: 'test', title: 'Test', command: 'must-not-run', timeoutMs: 1000 }],
  defaultCheckIds: ['test'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 1,
  turnTimeoutMs: 10000,
};

async function fixture(t: any, kind: 'file' | 'sqlite') {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-run-state-')));
  const project = { id: 'p', name: 'Synthetic execution lifecycle', root: directory };
  let authority: FileProjectStore | SqliteProjectUsageAuthority;
  const open = async () => {
    authority =
      kind === 'file'
        ? await FileProjectStore.open({ directory, project, profile })
        : await SqliteProjectUsageAuthority.open({ directory, project, profile });
  };
  await open();
  await fs.writeFile(path.join(directory, '.lifecycle-fault-fixture'), 'synthetic-only');
  let allowLegacy = false,
    effects = 0,
    ids = 0;
  let afterActivation: (() => Promise<void>) | undefined;
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
          cmd: { id: string; fingerprint: string },
          apply: Parameters<typeof authority.runs.transaction<T>>[1],
        ) {
          const result = await authority.runs.transaction(cmd, apply);
          if (cmd.fingerprint === 'run.begin-execution') await afterActivation?.();
          return result;
        },
      };
    },
    snapshot() {
      assert.ok(
        allowLegacy && authority instanceof FileProjectStore,
        'Lifecycle consumer hydrated a legacy snapshot.',
      );
      return authority.snapshot();
    },
    transact(...args: Parameters<FileProjectStore['transact']>) {
      assert.ok(
        allowLegacy && authority instanceof FileProjectStore,
        'Lifecycle consumer used a document callback.',
      );
      return authority.transact(...args);
    },
  } as ProjectStore;
  const projects = { get: () => store, list: () => [project] };
  const env = {
    projects,
    id: () => String(++ids),
    now: () => new Date(Date.UTC(2026, 0, 1) + ids * 1000).toISOString(),
  };
  const blocked = async (): Promise<never> => {
    effects++;
    throw Error('Lifecycle proof dispatched an external effect.');
  };
  const service = new ExecutionService({
    actions: createBuiltinExecutionActions(),
    ...env,
    policies: { p: executionPolicy(profile) },
    selection: fixtureExecutionSelection('fake', fixtureExecutionCapabilities()),
    workflowRoles: createBuiltinWorkflowRoles(),
    runtime: {
      id: 'fake',
      start: blocked,
      submit: blocked,
      turn: blocked,
      interrupt: blocked,
      dispose: async () => {},
    } as AgentRuntime,
    checks: { run: blocked } as CheckPort,
    workspaces: { prepare: blocked } as WorkspacePort,
  });
  service.schedule = () => {};
  const goal = await new GoalService(env).create('goal', 'goal', {
    projectId: 'p',
    title: 'A real queued goal',
    body: 'Retain this task.',
    criteria: 'No external effect.',
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
    runId,
    service,
    store,
    events,
    effects: () => effects,
    runs: () => authority.runs,
    async reopen() {
      await authority.close();
      await open();
    },
    async failStorage(enabled: boolean) {
      if (authority instanceof SqliteProjectUsageAuthority)
        await failLifecycleTimelineInsert(directory, enabled);
      else
        authority.replace = enabled
          ? async () => {
              throw Error('injected lifecycle file failure');
            }
          : fs.rename;
    },
    async finish() {
      allowLegacy = true;
      try {
        await service.finish('p', runId, 'failed', 'Synthetic terminal result');
      } finally {
        allowLegacy = false;
      }
    },
    async cancelWhileActivationReturns() {
      let committed!: () => void, release!: () => void;
      const activationCommitted = new Promise<void>((resolve) => {
        committed = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      afterActivation = async () => {
        committed();
        await released;
      };
      allowLegacy = true;
      const execution = service.execute('p', runId, new AbortController().signal);
      try {
        await activationCommitted;
        await service.cancel('awaited-stop', 'awaited-stop', { projectId: 'p', runId });
      } finally {
        release();
        await execution;
        afterActivation = undefined;
        allowLegacy = false;
      }
    },
  };
}

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: actual activation and phase consumers use only narrow authority and survive reopen`, async (t) => {
    const f = await fixture(t, kind);
    await f.service.beginExecution('p', f.runId);
    await f.service.phase('p', f.runId, 'preparing', 'Prepare synthetic workspace');
    const current = await f.runs().current(f.runId);
    assert.equal(current?.status, 'running');
    assert.equal(current?.phase, 'preparing');
    assert.equal(current?.revision, 3);
    const timeline = await f.runs().timeline({ runId: f.runId, limit: 10 });
    assert.deepEqual(
      timeline.entries.map((entry) => entry.type),
      ['run.queued', 'phase.preparing'],
    );
    const before = await f.events();
    await f.reopen();
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(await f.runs().timeline({ runId: f.runId, limit: 10 }), timeline);
    assert.deepEqual(await f.events(), before);
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: competing activation commands have one winner and cannot activate twice`, async (t) => {
    const f = await fixture(t, kind);
    const outcomes = await Promise.allSettled(
      ['first', 'second'].map((id) =>
        f.runs().transaction(command(id), (tx) => tx.beginExecution({ runId: f.runId, now: id })),
      ),
    );
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.equal(rejected.reason.code, 'INVALID_STATE');
    assert.equal((await f.runs().current(f.runId))?.revision, 2);
    assert.equal((await f.runs().timeline({ runId: f.runId, limit: 10 })).entries.length, 1);
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: cancellation wins over queued activation and later phase requests`, async (t) => {
    const f = await fixture(t, kind);
    await f.service.cancel('stop', 'stop', { projectId: 'p', runId: f.runId });
    const stopped = await f.runs().current(f.runId),
      before = await f.events();
    await assert.rejects(f.service.beginExecution('p', f.runId), { name: 'AbortError' });
    await assert.rejects(f.service.phase('p', f.runId, 'preparing', 'Too late'), {
      name: 'AbortError',
    });
    assert.deepEqual(await f.runs().current(f.runId), stopped);
    assert.deepEqual(await f.events(), before);
    await f.reopen();
    assert.deepEqual(await f.runs().current(f.runId), stopped);
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: phase receipt replay is canonical after later cancellation and reopen`, async (t) => {
    const f = await fixture(t, kind);
    await f.service.beginExecution('p', f.runId);
    const result = await f.runs().transaction(command('phase'), (tx) =>
      tx.advancePhase({
        runId: f.runId,
        phase: 'planning',
        now: 'phase-time',
        text: 'Planning complete task',
      }),
    );
    await f.service.cancel('stop', 'stop', { projectId: 'p', runId: f.runId });
    const before = await f.events(),
      current = await f.runs().current(f.runId);
    await f.reopen();
    assert.deepEqual(
      await f.runs().transaction(command('phase'), () => {
        throw Error('Replay executed callback.');
      }),
      result,
    );
    await assert.rejects(
      f.runs().transaction({ id: 'phase', fingerprint: 'foreign' }, () => null),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(await f.events(), before);
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: an in-flight phase and cancellation serialize without losing the stop request`, async (t) => {
    const f = await fixture(t, kind);
    await f.service.beginExecution('p', f.runId);
    const [phase, stop] = await Promise.allSettled([
      f.service.phase('p', f.runId, 'checking', 'Concurrent check phase'),
      f.service.cancel('stop-race', 'stop-race', { projectId: 'p', runId: f.runId }),
    ]);
    assert.equal(stop.status, 'fulfilled');
    if (phase.status === 'rejected') assert.equal(phase.reason.name, 'AbortError');
    const current = await f.runs().current(f.runId);
    assert.equal(current?.cancelRequested, true);
    assert.equal(current?.status, 'canceling');
    const entries = (await f.runs().timeline({ runId: f.runId, limit: 10 })).entries;
    const phaseEntries = entries.filter((entry) => entry.type === 'phase.checking');
    assert.equal(current?.phase, phaseEntries.length ? 'checking' : 'queued');
    assert.equal(entries.filter((entry) => entry.type === 'run.cancel-requested').length, 1);
    assert.ok(phaseEntries.length <= 1);
    if (phase.status === 'fulfilled') assert.equal(phaseEntries.length, 1);
    await assert.rejects(f.service.phase('p', f.runId, 'review', 'After stop'), {
      name: 'AbortError',
    });
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: physical phase write failure rolls back current, timeline, event and receipt`, async (t) => {
    const f = await fixture(t, kind);
    await f.service.beginExecution('p', f.runId);
    const before = await f.events(),
      current = await f.runs().current(f.runId);
    await f.failStorage(true);
    await assert.rejects(
      f.runs().transaction(command('physical-fault'), (tx) => {
        try {
          tx.advancePhase({
            runId: f.runId,
            phase: 'planning',
            now: 'fault-time',
            text: 'Must not publish',
          });
        } catch {
          // A caught physical SQLite failure must still invalidate the entire transaction.
        }
        return { attempted: true };
      }),
      /injected lifecycle/,
    );
    await f.failStorage(false);
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(await f.events(), before);
    assert.equal(await f.runs().receipt(command('physical-fault')), undefined);
    await f.reopen();
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(
      (await f.runs().timeline({ runId: f.runId, limit: 10 })).entries.map((entry) => entry.type),
      ['run.queued'],
    );
    await f.runs().transaction(command('physical-fault'), (tx) =>
      tx.advancePhase({
        runId: f.runId,
        phase: 'planning',
        now: 'retry-time',
        text: 'Successful retry',
      }),
    );
    assert.equal((await f.runs().current(f.runId))?.phase, 'planning');
    assert.equal(f.effects(), 0);
  });

  test(`${kind}: rolled-back activation/phase transaction publishes no state, entry or receipt`, async (t) => {
    const f = await fixture(t, kind);
    const before = await f.events(),
      current = await f.runs().current(f.runId);
    await assert.rejects(
      f.runs().transaction(command('rollback'), (tx) => {
        tx.beginExecution({ runId: f.runId, now: 'start-time' });
        tx.advancePhase({
          runId: f.runId,
          phase: 'planning',
          now: 'phase-time',
          text: 'Must roll back',
        });
        throw Error('Injected outer failure');
      }),
      /Injected outer failure/,
    );
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(await f.events(), before);
    assert.equal(await f.runs().receipt(command('rollback')), undefined);
    await f.reopen();
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(
      (await f.runs().timeline({ runId: f.runId, limit: 10 })).entries.map((entry) => entry.type),
      ['run.queued'],
    );
  });

  test(`${kind}: phase commands cannot activate queued work or manufacture a terminal result`, async (t) => {
    const f = await fixture(t, kind);
    await assert.rejects(f.service.phase('p', f.runId, 'planning', 'Not activated'), {
      code: 'INVALID_STATE',
    });
    await f.service.beginExecution('p', f.runId);
    const before = await f.events(),
      current = await f.runs().current(f.runId);
    for (const phase of ['queued', 'done'])
      await assert.rejects(
        f.runs().transaction(command('invalid-' + phase), (tx) =>
          tx.advancePhase({
            runId: f.runId,
            phase: phase as 'planning',
            now: 'invalid-time',
            text: 'No forged lifecycle',
          }),
        ),
      );
    assert.deepEqual(await f.runs().current(f.runId), current);
    assert.deepEqual(await f.events(), before);
    assert.equal(f.effects(), 0);
  });
}

test('file: delayed lifecycle commands cannot resurrect a result settled by the actual executor', async (t) => {
  const f = await fixture(t, 'file');
  await f.service.beginExecution('p', f.runId);
  await f.finish();
  const terminal = await f.runs().current(f.runId),
    before = await f.events();
  assert.equal(terminal?.status, 'failed');
  assert.equal(terminal?.phase, 'done');
  await assert.rejects(f.service.beginExecution('p', f.runId), { code: 'INVALID_STATE' });
  await assert.rejects(f.service.phase('p', f.runId, 'repair', 'Stale callback'), {
    code: 'INVALID_STATE',
  });
  assert.deepEqual(await f.runs().current(f.runId), terminal);
  assert.deepEqual(await f.events(), before);
  assert.equal(f.effects(), 0);
});

test('file: cancellation committed while activation returns prevents actual workspace dispatch', async (t) => {
  const f = await fixture(t, 'file');
  await f.cancelWhileActivationReturns();
  assert.equal(f.effects(), 0);
  const current = await f.runs().current(f.runId);
  assert.equal(current?.status, 'interrupted');
  assert.equal(current?.cancelRequested, true);
  const entries = (await f.runs().timeline({ runId: f.runId, limit: 10 })).entries;
  assert.equal(
    entries.some((entry) => entry.type === 'phase.preparing'),
    false,
  );
  assert.equal(entries.at(-1)?.type, 'run.interrupted');
});
