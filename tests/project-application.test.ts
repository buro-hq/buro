import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectApplication,
  type ProjectCatalog,
  type ProjectRepositoryPort,
} from '../core/project-application.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import {
  DomainError,
  type ProjectDocument,
  type ProjectStore,
  type ProjectStoreOpenSpec,
} from '../core/ports.ts';
import type { ExecutionPolicy, WorkspacePort, CheckPort } from '../core/execution-ports.ts';
import type { ProjectProfile } from '../protocol/domain.ts';

const profile: ProjectProfile = {
  version: 1,
  revision: 1,
  context: 'Use the project tests.',
  scope: { mode: 'advisory', plannedPaths: [], protectedPaths: ['AGENTS.md'] },
  checks: [{ id: 'test', title: 'Tests', command: 'synthetic test', timeoutMs: 1000 }],
  defaultCheckIds: ['test'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 2,
  maxRepairs: 1,
  turnTimeoutMs: 10000,
  baseBranch: 'main',
};

function memoryStore(spec: ProjectStoreOpenSpec): ProjectStore {
  let doc: ProjectDocument = {
    version: 1,
    revision: 0,
    sequence: 0,
    project: structuredClone(spec.project),
    profile: structuredClone(spec.profile),
    roleVersions: structuredClone(spec.roles || []),
    goals: [],
    runs: [],
    receipts: {},
  };
  const receipt = (id: string, fingerprint: string) => {
    const saved = doc.receipts[id];
    if (saved && saved.fingerprint !== fingerprint)
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'Different request.');
    return structuredClone(saved?.result);
  };
  return {
    snapshot: () => ({
      ...structuredClone(doc),
      roles: structuredClone(doc.roleVersions),
      capabilities: [],
    }),
    receipt,
    transact: async (id, fingerprint, apply) => {
      const saved = receipt(id, fingerprint);
      if (saved !== undefined) return saved as any;
      const draft = structuredClone(doc);
      const { result } = apply(draft);
      draft.receipts[id] = { fingerprint, result: structuredClone(result) };
      draft.revision++;
      doc = draft;
      return result;
    },
    subscribe: () => () => {},
    close: async () => {},
  };
}

function fixture(
  saved?: ProjectCatalog,
  storedSpec: (spec: ProjectStoreOpenSpec) => ProjectStoreOpenSpec = (spec) => spec,
) {
  const project = { id: 'sample', name: 'Sample', root: 'repository:sample', managed: true };
  const registry = new ProjectStoreRegistry();
  const policies: Record<string, ExecutionPolicy> = {};
  const opened: ProjectStoreOpenSpec[] = [];
  const calls = { prepare: 0, exports: [] as ProjectProfile[], saves: 0, closes: 0 };
  let persisted = structuredClone(saved);
  let failSave = false;
  let failExport = false;
  let ensureFailure: Error | undefined;
  let closeFailure: Error | undefined;
  let nextId = 0;
  const repository: ProjectRepositoryPort = {
    inspect: async () => ({
      root: project.root,
      name: project.name,
      branch: 'main',
      head: 'a'.repeat(40),
      dirty: false,
      managed: true,
      warnings: [],
      profile: structuredClone(profile),
    }),
    load: async () => ({
      project,
      profile: structuredClone(profile),
      branch: 'main',
      storageAddress: 'memory://sample/state',
    }),
    prepareConnection: async () => {
      calls.prepare++;
      return { root: project.root, id: project.id };
    },
    ensureLocal: async () => {
      if (ensureFailure) throw ensureFailure;
    },
    exportProfile: async (_project, current) => {
      calls.exports.push(structuredClone(current));
      if (failExport) throw Error('Synthetic export failure');
    },
    head: async () => 'a'.repeat(40),
    isAncestor: async () => true,
    fastForward: async () => {},
  };
  const app = new ProjectApplication({
    registry,
    policies,
    repository,
    stores: {
      open: async (spec) => {
        opened.push(structuredClone(spec));
        return {
          ...memoryStore(storedSpec(spec)),
          close: async () => {
            calls.closes++;
            if (closeFailure) throw closeFailure;
          },
        };
      },
    },
    catalog: {
      load: async () => persisted,
      save: async (catalog) => {
        calls.saves++;
        if (failSave) throw Error('Synthetic catalog failure');
        persisted = structuredClone(catalog);
      },
    },
    id: () => `id-${++nextId}`,
    now: () => '2026-11-22T00:00:00Z',
  });
  const connect = (id = 'connect', fingerprint = id) =>
    app.connect(id, fingerprint, { root: project.root, name: project.name, profile });
  return {
    app,
    project,
    registry,
    policies,
    opened,
    calls,
    connect,
    persisted: () => persisted,
    failSave: (value: boolean) => {
      failSave = value;
    },
    failExport: (value: boolean) => {
      failExport = value;
    },
    failEnsure: (error?: Error) => {
      ensureFailure = error;
    },
    failClose: (error?: Error) => {
      closeFailure = error;
    },
  };
}

test('a foreign factory store is rejected and closed before any workflow mutation or registration', async () => {
  for (const patch of [
    { id: 'foreign' },
    { root: 'repository:foreign' },
    { managed: false },
    { dataDirectory: 'memory://foreign' },
  ]) {
    const f = fixture(undefined, (spec) => ({ ...spec, project: { ...spec.project, ...patch } }));
    await assert.rejects(f.connect(), { code: 'PROJECT_STORAGE_MISMATCH' });
    assert.equal(f.calls.closes, 1);
    assert.deepEqual(f.registry.list(), []);
    assert.deepEqual(f.policies, {});
    assert.equal(f.calls.saves, 0);
    await f.app.dispose();
    await f.registry.close();
  }
});

test('connect and restore use injected storage with opaque addresses and durable receipts', async () => {
  const f = fixture();
  await f.connect();
  await f.connect();
  assert.equal(f.calls.prepare, 1);
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].storageAddress, 'memory://sample/state');
  assert.deepEqual(f.registry.list(), [f.project]);
  await assert.rejects(f.connect('connect', 'different'), { code: 'IDEMPOTENCY_CONFLICT' });
  const restored = fixture(f.persisted());
  await restored.app.restore();
  await restored.connect();
  assert.equal(restored.opened.length, 1);
  assert.equal(restored.calls.prepare, 0);
  assert.equal(restored.policies.sample.profile?.revision, 1);
  await Promise.all([f.registry.close(), restored.registry.close()]);
});

test('failed admission closes the unregistered store and retries without hiding the original error', async () => {
  const f = fixture();
  const original = Error('Local preparation failed');
  f.failEnsure(original);
  f.failClose(Error('Cleanup failed too'));
  await assert.rejects(f.connect(), (error) => error === original);
  assert.deepEqual(f.registry.list(), []);
  assert.equal(f.calls.closes, 1);
  assert.equal(f.app.catalog.receipts.connect, undefined);
  f.failEnsure();
  f.failClose();
  await f.connect();
  assert.equal(f.opened.length, 2);
  assert.equal(f.calls.closes, 1, 'the accepted store is now owned by the registry');
  await f.registry.close();
  assert.equal(f.calls.closes, 2);
});

test('registry admission rejection retains caller ownership until the store has been closed', async () => {
  const f = fixture();
  const add = f.registry.add.bind(f.registry);
  f.registry.add = () => {
    throw new DomainError('PROJECT_REGISTRY_CLOSED', 'Registry stopped during open.');
  };
  await assert.rejects(f.connect(), { code: 'PROJECT_REGISTRY_CLOSED' });
  assert.equal(f.calls.closes, 1);
  assert.deepEqual(f.registry.list(), []);
  f.registry.add = add;
  await f.connect();
  assert.equal(f.opened.length, 2);
  await f.registry.close();
  assert.equal(f.calls.closes, 2);
});

test('failed catalog persistence cannot create an in-memory successful connection receipt', async () => {
  const f = fixture();
  await f.app.open(f.project.root, f.project.id);
  f.failSave(true);
  await assert.rejects(f.connect(), /Synthetic catalog failure/);
  assert.equal(f.app.catalog.receipts.connect, undefined);
  f.failSave(false);
  await f.connect();
  assert.equal(f.calls.saves, 2);
  assert.equal(f.persisted()?.receipts.connect.project.id, f.project.id);
  assert.equal(f.opened.length, 1);
  await f.registry.close();
});

test('configuration export retries preserve the committed store profile and exact receipt', async () => {
  const f = fixture();
  await f.connect();
  const input = {
    projectId: f.project.id,
    expectedRevision: 1,
    profile: { ...profile, context: 'New context' },
  };
  f.failExport(true);
  await assert.rejects(f.app.configure('configure', 'same', input), {
    code: 'PROFILE_EXPORT_FAILED',
  });
  assert.equal(f.registry.get(f.project.id).snapshot().profile?.revision, 2);
  assert.equal(f.policies.sample.profile?.context, 'New context');
  f.failExport(false);
  const result = await f.app.configure('configure', 'same', input);
  assert.equal(result.revision, 2);
  assert.equal(f.calls.exports.at(-1)?.context, 'New context');
  assert.equal(f.registry.get(f.project.id).snapshot().profile?.revision, 2);
  await assert.rejects(f.app.configure('other', 'other', input), { code: 'CONFLICT' });
  await f.registry.close();
});

test('verification admits selected checks before workspace I/O and reuses only durable receipts', async () => {
  const f = fixture();
  await f.connect();
  let prepares = 0;
  let runs = 0;
  const workspaces = {
    prepare: async (_projectId: string, _runId: string, _base: unknown, options: any) => {
      prepares++;
      assert.deepEqual(options.profile, profile);
      return { path: 'workspace:verification', base: 'a'.repeat(40) };
    },
  } as unknown as WorkspacePort;
  const checks = {
    run: async (_projectId: string, _workspace: string, ids: string[]) => {
      runs++;
      assert.deepEqual(ids, ['test']);
      return { passed: 1, total: 1, results: [{ name: 'Tests', passed: true }] };
    },
  } as CheckPort;
  await assert.rejects(f.app.verify('sample', ['missing'], workspaces, checks), {
    code: 'INVALID_CHECK',
  });
  assert.equal(prepares, 0);
  const meta = { id: 'verify', fingerprint: 'selected-test' };
  const first = await f.app.verify('sample', ['test'], workspaces, checks, meta);
  const second = await f.app.verify('sample', ['test'], workspaces, checks, meta);
  assert.deepEqual(second, first);
  assert.equal(first.profileRevision, 1);
  assert.equal(prepares, 1);
  assert.equal(runs, 1);
  await assert.rejects(
    f.app.verify('sample', ['test'], workspaces, checks, { ...meta, fingerprint: 'changed' }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  await f.registry.close();
});
