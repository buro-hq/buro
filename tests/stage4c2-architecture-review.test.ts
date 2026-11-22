import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { ProjectResearchService } from '../core/project-research.ts';
import { createBuiltinProjectAnalyses } from '../adapters/analysis/project-setup.ts';
import type { AgentRuntime } from '../core/ports.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import { fixtureExecutionSelection } from './fixtures/execution-resources.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const profile: ProjectProfile = {
  version: 1,
  revision: 1,
  context: '',
  scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
  checks: [],
  defaultCheckIds: [],
  setup: [],
  dependencies: 'none',
  maxWorkers: 1,
  maxRepairs: 0,
  turnTimeoutMs: 10000,
};

async function fixture(t: any, start: AgentRuntime['start'], onRelease?: () => Promise<void>) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-research-lifetime-')),
  );
  const store = await FileProjectStore.open({
    directory: path.join(directory, 'state'),
    project: { id: 'p', name: 'Project', root: directory, managed: true },
    profile,
  });
  const projects = new ProjectStoreRegistry([store]);
  let turns = 0;
  const released: string[] = [];
  const runtime: AgentRuntime = {
    id: 'synthetic',
    start,
    submit: async () => {
      throw Error('Research cannot submit an unstructured turn.');
    },
    turn: async () => {
      turns++;
      return {
        turnId: 'unexpected',
        text: '{"summary":"Unexpected","context":"","components":[],"checks":[],"questions":[]}',
      };
    },
    interrupt: async () => {},
    release: async (id) => {
      released.push(id);
      await onRelease?.();
    },
    dispose: async () => {},
  };
  const service = new ProjectResearchService({
    projects,
    runtime,
    selection: fixtureExecutionSelection(
      'synthetic',
      fixtureCapabilities({ structuredTurns: true, readOnlySessions: true }),
    ),
    head: async () => 'a'.repeat(40),
    analysis: createBuiltinProjectAnalyses().get('project-setup'),
    materials: async () => [],
  });

  t.after(async () => {
    await service.dispose();
    await projects.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { store, service, released, turns: () => turns };
}

test(
  'research disposal owns a committed admission whose command receipt has not returned',
  { timeout: 5000 },
  async (t) => {
    const committed = deferred(),
      release = deferred();
    t.after(() => release.resolve());
    let starts = 0;
    const f = await fixture(t, async () => {
      starts++;
      return { threadId: 'unexpected' };
    });
    const transact = f.store.transact.bind(f.store);
    f.store.transact = async (id, fingerprint, apply) => {
      const result = await transact(id, fingerprint, apply);
      if (id === 'admit') {
        committed.resolve();
        await release.promise;
      }
      return result;
    };
    const starting = f.service.start('admit', 'admit', 'p');
    void starting.catch(() => {});
    await committed.promise;
    assert.equal(f.store.snapshot().research?.status, 'running');
    let disposed = false;
    const stopping = f.service.dispose().then(() => {
      disposed = true;
    });
    await setImmediate();
    const prematurelyDisposed = disposed;
    release.resolve();
    await Promise.allSettled([starting]);
    await stopping;
    await setImmediate();
    assert.equal(
      prematurelyDisposed,
      false,
      'Disposal must wait for its admitted but unresolved command.',
    );
    assert.equal(starts, 0);
    assert.equal(f.turns(), 0);
    assert.equal(f.store.snapshot().research?.status, 'interrupted');
  },
);

test(
  'a research session acquired after cancellation is released without starting a model turn',
  { timeout: 5000 },
  async (t) => {
    const entered = deferred(),
      release = deferred<{ threadId: string }>();
    t.after(() => release.resolve({ threadId: 'late-session' }));
    const f = await fixture(t, async () => {
      entered.resolve();
      return release.promise;
    });
    await f.service.start('admit', 'admit', 'p');
    await entered.promise;
    const completed = f.service.jobs.get('p')!.promise;
    f.service.cancel('p');
    release.resolve({ threadId: 'late-session' });
    await completed;
    assert.equal(f.turns(), 0);
    assert.deepEqual(f.released, ['late-session']);
    assert.equal(f.store.snapshot().research?.status, 'interrupted');
  },
);

test(
  'another admission cannot replace a ready research job while its session cleanup is still pending',
  { timeout: 5000 },
  async (t) => {
    const firstHead = deferred<string>(),
      secondHead = deferred<string>();
    const enteredRelease = deferred(),
      release = deferred();
    t.after(() => release.resolve());
    let starts = 0;
    const f = await fixture(
      t,
      async () => {
        starts++;
        return { threadId: 'session-' + starts };
      },
      async () => {
        enteredRelease.resolve();
        await release.promise;
      },
    );
    let heads = 0;
    f.service.head = async () => {
      heads++;
      if (heads === 1) return firstHead.promise;
      if (heads === 2) return secondHead.promise;
      return 'a'.repeat(40);
    };
    const first = f.service.start('first', 'first', 'p');
    const second = f.service.start('second', 'second', 'p');
    void second.catch(() => {});
    t.after(() => {
      firstHead.resolve('a'.repeat(40));
      secondHead.resolve('a'.repeat(40));
    });
    firstHead.resolve('a'.repeat(40));
    await first;
    await enteredRelease.promise;
    assert.equal(f.store.snapshot().research?.status, 'ready');
    const owningJob = f.service.jobs.get('p')!.promise;
    secondHead.resolve('a'.repeat(40));
    await assert.rejects(second, { code: 'PROJECT_BUSY' });
    assert.equal(f.service.jobs.get('p')!.promise, owningJob);
    let disposed = false;
    const stopping = f.service.dispose().then(() => {
      disposed = true;
    });
    await setImmediate();
    assert.equal(disposed, false, 'A ready proposal does not mean its session has been released.');
    release.resolve();
    await stopping;
    assert.equal(starts, 1);
    assert.equal(f.turns(), 1);
    assert.deepEqual(f.released, ['session-1']);
  },
);
