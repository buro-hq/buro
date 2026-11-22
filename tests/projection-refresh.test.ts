import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { defaultRoles } from './fixtures/roles.ts';
import { createHost } from '../plugins/host.ts';
import { websocketPlugin } from '../daemon/websocket.ts';
import { SocketProjectClient } from '../clients/socket-client.ts';
import { effectiveProjectPolicy, projectRunAutonomy } from '../core/autonomy-policy.ts';
import { sampleRun } from './fixtures/sample-run.ts';
import type { Snapshot } from '../protocol/domain.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  'a refreshed service projection replays concurrent events without rolling back observed history',
  { timeout: 5000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-projection-refresh-'));
    const host = await createHost({
      projects: [
        {
          storageAddress: directory,
          project: { id: 'p', name: 'Projection fixture', root: directory },
          roles: structuredClone(defaultRoles),
        },
      ],
    });
    let client: SocketProjectClient | undefined;
    const captured = deferred<void>(),
      release = deferred<void>();
    t.after(async () => {
      release.resolve();
      client?.close();
      await host.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    });
    host.ctx.on('project/snapshot', (snapshot) => {
      snapshot.effectivePolicy = effectiveProjectPolicy({
        policy: {
          scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: [] },
          checks: [],
          defaultCheckIds: [],
          maxWorkers: 1,
        },
      });
      // The fixture's derived revision makes a role-dependent service refresh observable.
      snapshot.effectivePolicy.origin.revision = snapshot.roles.find(
        (role) => role.id === 'reviewer',
      )!.version;
    });
    const original = host.ctx.commands.bus.handlers.get('project.snapshot')!;
    let hold = false,
      reads = 0;
    host.ctx.commands.bus.handlers.set('project.snapshot', async (...args) => {
      const snapshot = await original(...args);
      reads++;
      if (hold) {
        hold = false;
        captured.resolve();
        await release.promise;
      }
      return snapshot;
    });
    let port = 0;
    await host.ctx.plugin(websocketPlugin, {
      port: 0,
      onListen: (value) => {
        port = value;
      },
    });
    client = new SocketProjectClient(`ws://127.0.0.1:${port}`, 'p');
    await client.connect();
    assert.equal(client.snapshot().effectivePolicy?.origin.revision, 1);
    let invalidated = false;
    client.onChange((snapshot) => {
      if (
        snapshot.roles.find((role) => role.id === 'reviewer')?.version === 2 &&
        !snapshot.effectivePolicy
      )
        invalidated = true;
    });
    const role = client.snapshot().roles.find((item) => item.id === 'reviewer')!;
    hold = true;
    await client.saveRole({
      projectId: 'p',
      id: role.id,
      title: role.title,
      description: role.description,
      instructions: role.instructions,
      kind: role.kind,
      expectedVersion: role.version,
    });
    await captured.promise;
    const goal = await client.createGoal({
      projectId: 'p',
      title: 'Concurrent goal',
      body: 'Must survive the older snapshot response.',
      criteria: '',
    });
    assert.equal(client.snapshot().sequence, 2);
    const refreshed = deferred<void>();
    const unsubscribe = client.onChange((snapshot) => {
      if (snapshot.sequence === 2 && snapshot.effectivePolicy?.origin.revision === 2)
        refreshed.resolve();
    });
    release.resolve();
    await refreshed.promise;
    unsubscribe();
    assert.equal(invalidated, true, 'The client never displays a stale derived policy as current.');
    assert.equal(
      client.snapshot().goals.find((item) => item.id === goal.id)?.title,
      'Concurrent goal',
    );
    assert.equal(client.snapshot().roles.find((item) => item.id === role.id)?.version, 2);
    assert.equal(
      host.ctx.projects.registry.get('p').snapshot().sequence,
      2,
      'Refreshing never replays mutations.',
    );
    assert.ok(reads >= 2);
  },
);

test(
  'machine profile selection refreshes derived policy without inventing a domain mutation or delaying its receipt',
  { timeout: 5000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-machine-projection-'));
    const host = await createHost({
      projects: [
        {
          storageAddress: directory,
          project: { id: 'p', name: 'Machine projection fixture', root: directory },
        },
      ],
    });
    let client: SocketProjectClient | undefined,
      profileRevision = 1;
    t.after(async () => {
      client?.close();
      await host.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    });
    host.ctx.on('project/snapshot', (snapshot) => {
      snapshot.effectivePolicy = effectiveProjectPolicy({
        policy: {
          scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
          checks: [],
          defaultCheckIds: [],
          maxWorkers: 1,
        },
      });
      snapshot.effectivePolicy.origin.revision = profileRevision;
    });
    host.ctx.commands.bus.register('resources.use', (params) => {
      profileRevision++;
      return { profileId: params.profileId, appliesTo: 'new-runs' };
    });
    let port = 0;
    await host.ctx.plugin(websocketPlugin, {
      port: 0,
      onListen: (value) => {
        port = value;
      },
    });
    client = new SocketProjectClient(`ws://127.0.0.1:${port}`, 'p');
    await client.connect();
    const refreshed = deferred<void>();
    let invalidated = false;
    client.onChange((snapshot) => {
      if (!snapshot.effectivePolicy) invalidated = true;
      if (snapshot.effectivePolicy?.origin.revision === 2) refreshed.resolve();
    });
    const receipt = await client.command({
      method: 'resources.use',
      params: { profileId: 'second-profile' },
    });
    assert.deepEqual(receipt, { profileId: 'second-profile', appliesTo: 'new-runs' });
    await refreshed.promise;
    assert.equal(invalidated, true);
    assert.equal(client.snapshot().sequence, 0);
    assert.equal(host.ctx.projects.registry.get('p').snapshot().sequence, 0);
  },
);

test(
  'another run becoming busy and settling refreshes recovery actions on the earlier stopped run',
  { timeout: 5000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-recovery-projection-'));
    const stopped = {
      ...sampleRun(),
      status: 'needs-attention' as const,
      workspace: path.join(directory, 'workspace'),
      baseCommit: 'a'.repeat(40),
    };
    const host = await createHost({
      projects: [
        {
          storageAddress: directory,
          project: { id: 'p', name: 'Recovery projection fixture', root: directory },
          runs: [stopped],
        },
      ],
    });
    let client: SocketProjectClient | undefined;
    t.after(async () => {
      client?.close();
      await host.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const store = host.ctx.projects.registry.get('p');
    const goal = {
      revision: 1,
      id: stopped.goalId!,
      projectId: 'p',
      title: 'Stopped goal',
      body: 'Saved work',
      criteria: '',
      status: 'failed' as const,
      createdAt: stopped.createdAt,
    };
    await store.transact('initial-goal', 'initial-goal', (draft) => {
      draft.goals.push(goal);
      return { result: goal, change: { type: 'goal.created', goal } };
    });
    host.ctx.on('project/snapshot', (snapshot) => {
      for (const run of snapshot.runs)
        Object.assign(
          run,
          projectRunAutonomy(run, {
            goalExists: snapshot.goals.some((item) => item.id === run.goalId),
            projectBusy: snapshot.runs.some(
              (other) =>
                other.id !== run.id &&
                !!other.status &&
                ['queued', 'running', 'canceling'].includes(other.status),
            ),
            resumeSupported: false,
            startSupported: false,
            settingsSupported: false,
          }),
        );
    });
    let port = 0;
    await host.ctx.plugin(websocketPlugin, {
      port: 0,
      onListen: (value) => {
        port = value;
      },
    });
    client = new SocketProjectClient(`ws://127.0.0.1:${port}`, 'p');
    await client.connect();
    assert.deepEqual(client.snapshot().runs.find((run) => run.id === stopped.id)!.stop!.actions, [
      'edit-goal',
    ]);
    const observe = (condition: (snapshot: Snapshot) => boolean) => {
      const done = deferred<void>();
      const off = client!.onChange((snapshot) => {
        if (condition(snapshot)) {
          off();
          done.resolve();
        }
      });
      return done.promise;
    };
    const hidden = observe(
      (snapshot) => snapshot.runs.find((run) => run.id === stopped.id)?.stop?.actions.length === 0,
    );
    await store.transact('other-started', 'other-started', (draft) => {
      const active = {
        ...sampleRun(),
        id: 'R-other',
        goalId: 'G-other',
        status: 'running' as const,
        completedAt: undefined,
      };
      const otherGoal = { ...goal, id: 'G-other', status: 'running' as const };
      draft.runs.push(active);
      draft.goals.push(otherGoal);
      return { result: null, change: { type: 'run.changed', run: active, goal: otherGoal } };
    });
    await hidden;
    const restored = observe(
      (snapshot) =>
        snapshot.runs.find((run) => run.id === stopped.id)?.stop?.actions.includes('edit-goal') ===
        true,
    );
    await store.transact('other-completed', 'other-completed', (draft) => {
      const active = draft.runs.find((run) => run.id === 'R-other')!;
      active.status = 'completed';
      const otherGoal = draft.goals.find((item) => item.id === 'G-other')!;
      otherGoal.status = 'completed';
      return { result: null, change: { type: 'run.changed', run: active, goal: otherGoal } };
    });
    await restored;
    assert.deepEqual(client.snapshot().runs.find((run) => run.id === stopped.id)!.stop!.actions, [
      'edit-goal',
    ]);
    assert.equal(client.snapshot().sequence, 3);
    const removed = observe(
      (snapshot) =>
        !snapshot.goals.some((item) => item.id === goal.id) &&
        snapshot.runs.find((run) => run.id === stopped.id)?.stop?.actions.length === 0,
    );
    await client.deleteGoal('p', goal.id);
    await removed;
    assert.equal(client.snapshot().sequence, 4);
  },
);
