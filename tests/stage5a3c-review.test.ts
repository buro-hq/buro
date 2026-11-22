import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { ProjectApplication, type ProjectRepositoryPort } from '../core/project-application.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import type { ProjectStore } from '../core/ports.ts';
import type { ExecutionPolicy, WorkspacePort, CheckPort } from '../core/execution-ports.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import { seedSettingsProposal } from './fixtures/sqlite-settings-proposal.ts';

const head = 'a'.repeat(40);
const profile = (): ProjectProfile => ({
  version: 1,
  revision: 1,
  context: 'Initial',
  scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
  checks: [{ id: 'test', title: 'Tests', command: 'synthetic-only', timeoutMs: 1000 }],
  defaultCheckIds: ['test'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 1,
  maxRepairs: 0,
  turnTimeoutMs: 10000,
  baseBranch: 'main',
});
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(t: any, kind: 'file' | 'sqlite') {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-settings-services-e-')),
  );
  const directory = path.join(root, kind);
  await fs.mkdir(directory);
  if (kind === 'sqlite')
    await fs.writeFile(path.join(directory, '.settings-fixture'), 'synthetic-only');
  const project = { id: 'p', name: 'Synthetic', root, managed: true };
  const authority =
    kind === 'file'
      ? await FileProjectStore.open({ directory, project, profile: profile() })
      : await SqliteProjectUsageAuthority.open({ directory, project, profile: profile() });
  const unavailable = () => {
    throw Error('No whole document or repository effects in settings test.');
  };
  const store = {
    get project() {
      return authority.project;
    },
    settings: authority.settings,
    snapshot: unavailable,
    transact: unavailable,
    receipt: unavailable,
    close: () => authority.close(),
  } as ProjectStore;
  const registry = new ProjectStoreRegistry([store]);
  const policies: Record<string, ExecutionPolicy> = {};
  const exports: ProjectProfile[] = [];
  let inspected = 0,
    denyRepository = false;
  const repository: ProjectRepositoryPort = {
    inspect: async () => {
      inspected++;
      if (denyRepository)
        throw Error('Committed replay must not inspect changed repository facts.');
      return { ...project, branch: 'main', head, dirty: false, warnings: [] };
    },
    load: unavailable,
    prepareConnection: unavailable,
    ensureLocal: unavailable,
    exportProfile: async (_project, value) => {
      exports.push(structuredClone(value));
    },
    head: async () => {
      if (denyRepository) throw Error('Committed replay must not recheck changed HEAD.');
      return head;
    },
    isAncestor: unavailable,
    fastForward: unavailable,
  };
  const app = new ProjectApplication({
    registry,
    repository,
    policies,
    stores: { open: unavailable },
    catalog: { load: async () => undefined, save: async () => {} },
    id: () => 'verification',
    now: () => '2026-11-22T00:00:00Z',
  });
  t.after(async () => {
    await app.dispose();
    await registry.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    authority,
    directory,
    app,
    exports,
    policies,
    inspections: () => inspected,
    denyRepository: () => {
      denyRepository = true;
    },
    async events() {
      if (kind === 'sqlite')
        return (
          await (authority as SqliteProjectUsageAuthority).pagedEvents({ after: 0, limit: 100 })
        ).events;
      const seen: unknown[] = [];
      const stop = (authority as FileProjectStore).subscribe(0, (event) => {
        seen.push(event);
      });
      stop();
      return seen;
    },
  };
}

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: held verification retains its checked revision across a real settings edit and duplicate requests do not redispatch`, async (t) => {
    const reached = latch(),
      held = latch();
    t.after(() => held.release());
    const f = await fixture(t, kind);
    let prepared = 0,
      checked = 0;
    const workspaces = {
      prepare: async (_p, _r, _parent, options) => {
        prepared++;
        assert.equal(options?.profile?.revision, 1);
        return { path: '/synthetic-private-workspace', base: head };
      },
    } as WorkspacePort;
    const checks = {
      run: async (_p, _w, ids, _signal, frozen) => {
        checked++;
        assert.deepEqual(ids, ['test']);
        assert.equal(frozen?.revision, 1);
        assert.equal(frozen?.context, 'Initial');
        reached.release();
        await held.promise;
        assert.equal(frozen?.revision, 1);
        return { passed: 1, total: 1, results: [{ name: 'Tests', passed: true }] };
      },
    } as CheckPort;
    const meta = { id: 'verify-held', fingerprint: 'verify-held' };
    const first = f.app.verify('p', ['test'], workspaces, checks, meta);
    await reached.promise;
    const duplicate = f.app.verify('p', ['test'], workspaces, checks, meta);
    await assert.rejects(
      f.app.verify('p', ['test'], workspaces, checks, { ...meta, fingerprint: 'different' }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const next = await f.app.configure('settings-during-checks', 'settings-during-checks', {
      projectId: 'p',
      expectedRevision: 1,
      profile: { ...profile(), context: 'Changed while old checks run' },
    });
    assert.equal(next.revision, 2);
    held.release();
    const result = await first;
    assert.deepEqual(await duplicate, result);
    assert.equal(result.profileRevision, 1);
    assert.deepEqual(await f.authority.settings.verification(), result);
    assert.deepEqual(await f.authority.settings.profile(), next);
    assert.equal(prepared, 1);
    assert.equal(checked, 1);
    const before = await f.events(),
      inspected = f.inspections();
    f.denyRepository();
    assert.deepEqual(
      await f.app.verify('p', ['no-longer-valid'], workspaces, checks, meta),
      result,
    );
    assert.equal(f.inspections(), inspected);
    assert.equal(checked, 1);
    assert.deepEqual(await f.events(), before);
  });
}

test('SQL actual API replays committed settings before busy, new research and malformed candidate admission, exporting only the current profile', async (t) => {
  const f = await fixture(t, 'sqlite');
  const saved = await f.app.configure('saved', 'saved', {
    projectId: 'p',
    expectedRevision: 1,
    profile: { ...profile(), context: 'Receipt revision' },
  });
  const current = await f.app.configure('current', 'current', {
    projectId: 'p',
    expectedRevision: 2,
    profile: { ...profile(), context: 'Current revision' },
  });
  const newerProposal = {
    id: 'new-research',
    status: 'ready' as const,
    analysis: { id: 'synthetic', revision: 'v2' },
    sourceHead: 'b'.repeat(40),
    profileRevision: current.revision,
    context: 'New proposal',
    checks: [],
  };
  await seedSettingsProposal(f.directory, newerProposal);
  // The production Run writer is not SQL-backed in this slice. Seed only its bounded guard index.
  const db = new DatabaseSync(path.join(f.directory, 'authority.sqlite'));
  try {
    db.prepare('INSERT INTO project_run_index(run_id,status) VALUES (?,?)').run(
      'new-active-run',
      'canceling',
    );
  } finally {
    db.close();
  }
  assert.equal(await f.authority.settings.hasActiveRun(), true);
  const before = await f.events();
  f.denyRepository();
  const invalidReplay = {
    projectId: 'p',
    expectedRevision: -1,
    researchId: 'gone',
    profile: null,
  } as any;
  assert.deepEqual(await f.app.configure('saved', 'saved', invalidReplay), saved);
  assert.deepEqual(f.exports.at(-1), current);
  assert.deepEqual(f.policies.p.profile, current);
  assert.deepEqual(await f.authority.settings.profile(), current);
  assert.deepEqual(await f.authority.settings.researchProposal(), newerProposal);
  assert.deepEqual(await f.events(), before);
  await assert.rejects(
    f.app.configure('new-command', 'new-command', {
      projectId: 'p',
      expectedRevision: current.revision,
      profile: profile(),
    }),
    { code: 'PROJECT_BUSY' },
  );
  assert.equal(
    await f.authority.settings.receipt({ id: 'new-command', fingerprint: 'new-command' }),
    undefined,
  );
  assert.deepEqual(await f.events(), before);
});

test('SQL caught acknowledgement failure cannot commit its earlier profile write or command receipt', async (t) => {
  const f = await fixture(t, 'sqlite');
  const proposal = {
    id: 'research-to-acknowledge',
    status: 'ready' as const,
    analysis: { id: 'synthetic', revision: 'v1' },
    sourceHead: head,
    profileRevision: 1,
    context: 'Suggestion',
    checks: [],
  };
  await seedSettingsProposal(f.directory, proposal);
  const changeTrigger = (install: boolean) => {
    const db = new DatabaseSync(path.join(f.directory, 'authority.sqlite'));
    try {
      db.exec(
        install
          ? `CREATE TRIGGER fixture_ack_failure BEFORE UPDATE OF ack_json ON project_research_proposals
        BEGIN SELECT RAISE(ABORT, 'synthetic ack storage failure'); END;`
          : 'DROP TRIGGER fixture_ack_failure',
      );
    } finally {
      db.close();
    }
  };
  changeTrigger(true);
  const command = { id: 'ack-fails', fingerprint: 'ack-fails' };
  let caught = false;
  await assert.rejects(
    f.authority.settings.transaction(command, (tx) => {
      try {
        tx.configure({ expectedRevision: 1, profile: { ...profile(), context: 'Must roll back' } });
      } catch (error) {
        caught = true;
        assert.match(String(error), /synthetic ack storage failure/);
      }
      return 'Callback attempted to suppress the storage failure';
    }),
    /synthetic ack storage failure/,
  );
  assert.equal(caught, true);
  assert.deepEqual(await f.authority.settings.profile(), profile());
  assert.deepEqual(await f.authority.settings.researchProposal(), proposal);
  assert.equal(await f.authority.settings.receipt(command), undefined);
  assert.deepEqual(await f.events(), []);
  changeTrigger(false);
  const saved = await f.authority.settings.transaction(command, (tx) =>
    tx.configure({ expectedRevision: 1, profile: { ...profile(), context: 'Retry succeeded' } }),
  );
  assert.equal(saved.revision, 2);
  assert.deepEqual(await f.authority.settings.researchProposal(), {
    ...proposal,
    reviewedProfileRevision: 2,
  });
  assert.equal((await f.events()).length, 1);
  assert.deepEqual(await f.authority.settings.receipt(command), { result: saved });
});
