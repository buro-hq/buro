import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectApplication, type ProjectRepositoryPort } from '../core/project-application.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import type { ProjectStore } from '../core/ports.ts';
import type { CheckPort, WorkspacePort, ExecutionPolicy } from '../core/execution-ports.ts';
import type { ResearchProposal } from '../core/project-settings.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { parseDomainEvent, parseSnapshot, ResearchProposalSchema } from '../protocol/schema.ts';
import type { ProjectProfile, ProjectResearch, Snapshot, DomainEvent } from '../protocol/domain.ts';
import { policyView } from '../core/project-settings.ts';
import { resolveRoleResource } from '../core/role-routing.ts';
import { serviceOperationContext, operationIds } from '../core/operation-catalog.ts';
import { applyEvent } from '../clients/socket-client.ts';
import {
  fixtureExecutionSelection,
  fixtureExecutionCapabilities,
} from './fixtures/execution-resources.ts';
import { seedSettingsProposal } from './fixtures/sqlite-settings-proposal.ts';

const head = 'a'.repeat(40);
const profile = (): ProjectProfile => ({
  version: 1,
  revision: 1,
  context: 'User context',
  scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['AGENTS.md'] },
  checks: [{ id: 'test', title: 'User tests', command: 'synthetic-user-test', timeoutMs: 1000 }],
  defaultCheckIds: ['test'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 1,
  maxRepairs: 0,
  turnTimeoutMs: 10000,
  baseBranch: 'main',
});
const proposal = (): ResearchProposal => ({
  id: 'analysis-1',
  status: 'ready',
  analysis: { id: 'custom-analysis', revision: 'custom-v7' },
  sourceHead: head,
  profileRevision: 1,
  context: 'Suggested context',
  components: [],
  checks: [
    {
      id: 'test',
      title: 'Suggested replacement',
      command: 'must-not-replace-user-command',
      timeoutMs: 1000,
    },
    { id: 'lint', title: 'Suggested lint', command: 'synthetic-lint', timeoutMs: 1000 },
  ],
});
function research(body = proposal()): ProjectResearch {
  const resources = fixtureExecutionSelection('fake', fixtureExecutionCapabilities()).forProject(
    'p',
  );
  const role = {
    id: 'coordinator',
    version: 1,
    title: 'Researcher',
    kind: 'coordination' as const,
    instructions: 'Synthetic research fixture only.',
    description: 'Read-only researcher',
    provenance: { origin: 'user' as const },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  return {
    ...body,
    roleSnapshot: role,
    roleResource: resolveRoleResource(
      resources,
      role,
      serviceOperationContext(operationIds.research),
    ),
    resources,
    contextMaterials: [],
    startedAt: '2026-01-01',
    completedAt: '2026-01-02',
    summary: 'Synthetic proposal',
    events: [
      { at: '2026-01-01', text: 'Private research history retained in its own projection.' },
    ],
  };
}
const cmd = (id: string) => ({ id, fingerprint: 'fp:' + id });
async function fixture(t: any, kind: 'file' | 'sqlite') {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-settings-services-')),
  );
  const directory = path.join(base, kind),
    root = path.join(base, 'source');
  await fs.mkdir(root);
  await fs.mkdir(directory);
  if (kind === 'sqlite')
    await fs.writeFile(path.join(directory, '.settings-fixture'), 'synthetic-only');
  const project = { id: 'p', name: 'Saved project', root, managed: true };
  let current: FileProjectStore | SqliteProjectUsageAuthority;
  const open = async (bootstrap = profile()) => {
    current =
      kind === 'file'
        ? await FileProjectStore.open({ directory, project, profile: bootstrap })
        : await SqliteProjectUsageAuthority.open({ directory, project, profile: bootstrap });
  };
  await open();
  const store = {
    get project() {
      return current.project;
    },
    get settings() {
      return current.settings;
    },
    snapshot() {
      throw Error('Settings application must not load whole snapshots.');
    },
    transact() {
      throw Error('Settings application must not use legacy document transactions.');
    },
    receipt() {
      throw Error('Settings application must use the settings receipt port.');
    },
    close: () => current.close(),
  } as ProjectStore;
  const registry = new ProjectStoreRegistry([store]);
  const exports: ProjectProfile[] = [],
    policies: Record<string, ExecutionPolicy> = {};
  let repoHead = head,
    failExport = false,
    ticks = 0,
    headCalls = 0;
  const repository: ProjectRepositoryPort = {
    inspect: async () => ({
      ...project,
      branch: 'main',
      head: repoHead,
      dirty: false,
      warnings: [],
    }),
    load: async () => {
      throw Error('No connection bootstrap is needed.');
    },
    prepareConnection: async () => {
      throw Error('No new connection is needed.');
    },
    ensureLocal: async () => {},
    exportProfile: async (savedProject, saved) => {
      assert.deepEqual(savedProject, project);
      exports.push(structuredClone(saved));
      if (failExport) throw Error('Synthetic export failure');
    },
    head: async () => {
      headCalls++;
      return repoHead;
    },
    isAncestor: async () => true,
    fastForward: async () => {},
  };
  const app = new ProjectApplication({
    registry,
    repository,
    policies,
    stores: {
      open: async () => {
        throw Error('No new store needed.');
      },
    },
    catalog: { load: async () => undefined, save: async () => {} },
    id: () => 'id-' + ++ticks,
    now: () => '2026-01-01T00:00:00Z',
  });
  t.after(async () => {
    await current.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const events = async () => {
    if (kind === 'sqlite')
      return (
        await (current as SqliteProjectUsageAuthority).pagedEvents({ after: 0, limit: 1000 })
      ).events.map(({ sequence, projectId, ...change }) => change);
    const changes: DomainEvent['change'][] = [];
    const stop = (current as FileProjectStore).subscribe(0, (event) => changes.push(event.change));
    stop();
    return changes;
  };
  return {
    app,
    project,
    store,
    policies,
    exports,
    events,
    settings: () => current.settings,
    failExport(value: boolean) {
      failExport = value;
    },
    setHead(value: string) {
      repoHead = value;
    },
    headCalls: () => headCalls,
    async reopen() {
      await current.close();
      await open({ ...profile(), revision: 999, context: 'Stale bootstrap must not win' });
    },
    async seed(body: ResearchProposal) {
      if (kind === 'sqlite') await seedSettingsProposal(directory, body);
      else
        await (current as FileProjectStore).transact(
          'fixture:' + body.id,
          'fixture:' + body.id,
          (doc) => {
            doc.research = research(body);
            doc.roleVersions.push(doc.research.roleSnapshot);
            return {
              result: null,
              change: { type: 'project.research.changed', research: doc.research },
            };
          },
        );
    },
  };
}
for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: actual configure replay returns its canonical receipt but exports the current authoritative profile after reopen`, async (t) => {
    const f = await fixture(t, kind),
      first = cmd('first');
    const input = {
      projectId: 'p',
      profile: { ...profile(), context: 'Saved version two' },
      expectedRevision: 1,
    };
    f.failExport(true);
    await assert.rejects(f.app.configure(first.id, first.fingerprint, input), {
      code: 'PROFILE_EXPORT_FAILED',
    });
    assert.equal((await f.settings().profile())?.revision, 2);
    assert.equal(
      (await f.settings().receipt(first))?.result &&
        ((await f.settings().receipt(first))!.result as ProjectProfile).context,
      'Saved version two',
    );
    f.failExport(false);
    const second = await f.app.configure('second', 'second', {
      ...input,
      expectedRevision: 2,
      profile: { ...profile(), context: 'Current version three' },
    });
    assert.equal(second.revision, 3);
    await f.reopen();
    const before = await f.events();
    assert.equal(before.filter((event) => event.type === 'project.configured').length, 2);
    const replay = await f.app.configure(first.id, first.fingerprint, input);
    assert.equal(replay.revision, 2);
    assert.equal(replay.context, 'Saved version two');
    assert.equal(f.exports.at(-1)?.revision, 3);
    assert.equal(f.exports.at(-1)?.context, 'Current version three');
    assert.equal(f.policies.p.context, 'Current version three');
    assert.deepEqual(await f.events(), before);
    await assert.rejects(f.app.configure(first.id, 'different', input), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await assert.rejects(f.app.configure('stale', 'stale', input), { code: 'CONFLICT' });
    assert.equal(await f.settings().receipt(cmd('stale')), undefined);
    assert.deepEqual((await f.app.info('p')).profile, second);
  });
  test(`${kind}: actual research application preserves user settings and publishes only a bounded matching acknowledgement`, async (t) => {
    const f = await fixture(t, kind),
      body = proposal();
    await f.seed(body);
    const saved = await f.app.applyResearch('apply', 'apply', {
      projectId: 'p',
      researchId: body.id,
      expectedRevision: 1,
    });
    assert.equal(saved.context, 'User context');
    assert.equal(saved.checks[0].command, 'synthetic-user-test');
    assert.equal(saved.checks[1].command, 'synthetic-lint');
    assert.deepEqual(saved.defaultCheckIds, ['test']);
    assert.deepEqual(saved.scope, profile().scope);
    assert.deepEqual(await f.settings().researchProposal(), {
      ...body,
      reviewedProfileRevision: 2,
      appliedProfileRevision: 2,
    });
    const event = (await f.events()).filter((x) => x.type === 'project.configured').at(-1)!;
    assert.deepEqual(event.researchAcknowledgement, {
      id: body.id,
      reviewedProfileRevision: 2,
      appliedProfileRevision: 2,
    });
    assert.equal(Object.hasOwn(event, 'research'), false);
    assert.equal(JSON.stringify(event).includes('Private research history'), false);
    await f.reopen();
    f.setHead('b'.repeat(40));
    const calls = f.headCalls();
    assert.deepEqual(
      await f.app.applyResearch('apply', 'apply', {
        projectId: 'p',
        researchId: body.id,
        expectedRevision: 1,
      }),
      saved,
    );
    assert.equal(
      f.headCalls(),
      calls,
      'A committed replay does not re-admit against changed Git facts.',
    );
    await assert.rejects(
      f.app.applyResearch('stale-research', 'stale-research', {
        projectId: 'p',
        researchId: body.id,
        expectedRevision: 2,
      }),
      { code: 'RESEARCH_STALE' },
    );
    assert.equal((await f.settings().profile())?.revision, 2);
  });
  test(`${kind}: actual verification freezes the checked profile and replays after reopen without repeating workspace or check effects`, async (t) => {
    const f = await fixture(t, kind);
    let prepared = 0,
      checked = 0;
    const workspaces = {
      prepare: async (_project, _id, _parent, options) => {
        prepared++;
        assert.equal(options?.profile?.revision, 1);
        return { path: '/synthetic-isolated-workspace', base: head };
      },
    } as WorkspacePort;
    const checks = {
      run: async (_project, workspace, ids, _signal, frozen) => {
        checked++;
        assert.equal(workspace, '/synthetic-isolated-workspace');
        assert.deepEqual(ids, ['test']);
        assert.equal(frozen?.revision, 1);
        return { passed: 1, total: 1, results: [{ name: 'User tests', passed: true }] };
      },
    } as CheckPort;
    const first = await f.app.verify('p', ['test'], workspaces, checks, cmd('verify'));
    assert.equal(first.profileRevision, 1);
    assert.equal(first.passed, 1);
    await f.app.configure('new-profile', 'new-profile', {
      projectId: 'p',
      expectedRevision: 1,
      profile: { ...profile(), context: 'After verification' },
    });
    await f.reopen();
    assert.deepEqual(await f.app.verify('p', ['test'], workspaces, checks, cmd('verify')), first);
    assert.deepEqual(await f.settings().verification(), first);
    assert.equal(prepared, 1);
    assert.equal(checked, 1);
    await assert.rejects(
      f.app.verify('p', ['test'], workspaces, checks, { id: 'verify', fingerprint: 'other' }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal((await f.settings().profile())?.revision, 2);
  });
}
function snapshot(): Snapshot {
  return parseSnapshot({
    version: 1,
    project: { id: 'p', name: 'Project', root: '/synthetic' },
    revision: 0,
    sequence: 0,
    roles: [],
    goals: [],
    runs: [],
    capabilities: [],
    profile: profile(),
    research: research(),
  });
}
function configured(seq: number, id = 'analysis-1'): DomainEvent {
  const saved = { ...profile(), revision: seq + 1 };
  return parseDomainEvent({
    version: 1,
    id: 'event-' + seq,
    projectId: 'p',
    seq,
    at: 'now',
    change: {
      type: 'project.configured',
      profile: saved,
      executionPolicy: policyView(saved),
      researchAcknowledgement: {
        id,
        reviewedProfileRevision: seq + 1,
        appliedProfileRevision: seq + 1,
      },
    },
  });
}
test('client acknowledgement replay preserves frozen research evidence and cannot replace a newer or absent research record', () => {
  const original = snapshot(),
    event = configured(1),
    next = applyEvent(original, event);
  assert.deepEqual(next.research, {
    ...original.research,
    reviewedProfileRevision: 2,
    appliedProfileRevision: 2,
  });
  assert.equal(next.research?.resources, original.research?.resources);
  assert.equal(next.research?.roleResource, original.research?.roleResource);
  assert.equal(next.research?.events, original.research?.events);
  assert.equal(original.research?.reviewedProfileRevision, undefined);
  assert.equal(applyEvent(next, event), next);
  const manual = configured(2);
  if (manual.change.type !== 'project.configured') throw Error('Expected configuration event');
  delete manual.change.researchAcknowledgement!.appliedProfileRevision;
  const acknowledged = applyEvent(next, manual);
  assert.equal(acknowledged.research?.reviewedProfileRevision, 3);
  assert.equal(acknowledged.research?.appliedProfileRevision, 2);
  const newer = { ...original, research: research({ ...proposal(), id: 'analysis-newer' }) };
  assert.equal(applyEvent(newer, event).research, newer.research);
  assert.equal(applyEvent({ ...original, research: undefined }, event).research, undefined);
});
test('protocol rejects legacy full-research configured events and bounded proposals reject history or execution authority', () => {
  const event = configured(1);
  assert.throws(() =>
    parseDomainEvent({ ...event, change: { ...event.change, research: research() } }),
  );
  assert.equal(ResearchProposalSchema.safeParse(proposal()).success, true);
  for (const privateField of [
    { events: [] },
    { resources: research().resources },
    { roleSnapshot: research().roleSnapshot },
  ])
    assert.equal(
      ResearchProposalSchema.safeParse({ ...proposal(), ...privateField }).success,
      false,
    );
});
