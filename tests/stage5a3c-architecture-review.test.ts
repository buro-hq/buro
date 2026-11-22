import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ProjectApplication, type ProjectRepositoryPort } from '../core/project-application.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import type { ProjectStore } from '../core/ports.ts';
import type { ResearchProposal } from '../core/project-settings.ts';
import type { ProjectProfile, ProjectResearch } from '../protocol/domain.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import { seedSettingsProposal } from './fixtures/sqlite-settings-proposal.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

test('automatic base-branch initialization does not claim that the user reviewed ready research', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-settings-autoack-')),
  );
  const directory = path.join(root, 'state');
  const project = { id: 'p', name: 'Synthetic', root, managed: true };
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: 'User context',
    scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
    checks: [],
    defaultCheckIds: [],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    maxRepairs: 0,
    turnTimeoutMs: 10000,
  };
  const role = {
    id: 'coordinator',
    version: 1,
    title: 'Researcher',
    kind: 'coordination' as const,
    instructions: 'Read-only synthetic research.',
    description: 'Fixture role',
    provenance: { origin: 'user' as const },
    createdAt: 'now',
    updatedAt: 'now',
  };
  const resources = fixtureExecutionSelection('fake', fixtureExecutionCapabilities()).forProject(
    'p',
  );
  const research: ProjectResearch = {
    id: 'ready-research',
    status: 'ready',
    analysis: { id: 'setup', revision: 'v1' },
    sourceHead: 'a'.repeat(40),
    profileRevision: 1,
    context: 'Unreviewed suggestions',
    components: [],
    checks: [],
    resources,
    roleSnapshot: role,
    roleResource: {
      resource: resources.coordinator,
      roleVersion: 1,
      preference: { mode: 'auto' },
      source: 'profile',
      reason: 'Fixture selection',
    },
    contextMaterials: [],
    startedAt: 'now',
    completedAt: 'now',
    summary: 'Synthetic ready proposal',
    events: [],
  };
  const store = await FileProjectStore.open({ directory, project, profile, roles: [role] });
  await store.transact('seed-research', 'seed-research', (doc) => {
    doc.research = research;
    return { result: null, change: { type: 'project.research.changed', research } };
  });
  const registry = new ProjectStoreRegistry();
  const unused = async (): Promise<never> => {
    throw Error('No user action or external effect is needed during reopen.');
  };
  const app = new ProjectApplication({
    registry,
    stores: { open: async () => store },
    repository: {
      load: async () => ({ project, profile, branch: 'main', storageAddress: directory }),
      ensureLocal: async () => {},
      exportProfile: async () => {},
      inspect: unused,
      prepareConnection: unused,
      head: unused,
      isAncestor: unused,
      fastForward: unused,
    },
    policies: {},
    catalog: { load: async () => undefined, save: async () => {} },
    id: () => 'synthetic-id',
    now: () => 'now',
  });
  t.after(async () => {
    await app.dispose();
    await registry.close();
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await app.open(root, project.id);
  assert.equal((await store.settings.profile())?.baseBranch, 'main');
  const proposal = await store.settings.researchProposal();
  assert.equal(proposal?.id, research.id);
  assert.equal(proposal?.reviewedProfileRevision, undefined);
  assert.equal(proposal?.appliedProfileRevision, undefined);
  assert.equal(store.snapshot().research?.reviewedProfileRevision, undefined);
});

test('dispose during an awaited active-run check prevents late verification workspace and check dispatch', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-settings-stop-')));
  const project = { id: 'p', name: 'Synthetic', root, managed: true };
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
    baseBranch: 'main',
  };
  const store = await FileProjectStore.open({
    directory: path.join(root, 'state'),
    project,
    profile,
  });
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = new ProjectStoreRegistry([
    {
      project: store.project,
      settings: {
        ...store.settings,
        hasActiveRun: async () => {
          reached();
          await held;
          return false;
        },
      },
      close: () => store.close(),
    } as ProjectStore,
  ]);
  const unexpected = async (): Promise<never> => {
    throw Error('No connection or Git effect is needed.');
  };
  const app = new ProjectApplication({
    registry,
    repository: {
      inspect: async () => ({
        ...project,
        branch: 'main',
        head: 'a'.repeat(40),
        dirty: false,
        warnings: [],
      }),
      load: unexpected,
      prepareConnection: unexpected,
      ensureLocal: unexpected,
      exportProfile: unexpected,
      head: unexpected,
      isAncestor: unexpected,
      fastForward: unexpected,
    },
    policies: {},
    stores: { open: unexpected },
    catalog: { load: async () => undefined, save: async () => {} },
    id: () => 'synthetic-id',
    now: () => 'now',
  });
  t.after(async () => {
    release();
    await app.dispose();
    await registry.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  let workspaces = 0,
    checks = 0;
  const workspacePort = {
    prepare: async () => {
      workspaces++;
      return { path: '/synthetic-verification', base: 'a'.repeat(40) };
    },
  } as unknown as WorkspacePort;
  const checkPort = {
    run: async () => {
      checks++;
      return { passed: 0, total: 0, results: [] };
    },
  } as unknown as CheckPort;
  const command = { id: 'stopping-verification', fingerprint: 'stopping-verification' };
  const verifying = app.verify('p', [], workspacePort, checkPort, command);
  await entered;
  const closing = app.dispose();
  release();
  await assert.rejects(verifying, { code: 'STOPPING' });
  await closing;
  assert.equal(workspaces, 0);
  assert.equal(checks, 0);
  assert.equal(await store.settings.verification(), undefined);
  assert.equal(await store.settings.receipt(command), undefined);
});

test('queued connect captures its input and returned metadata cannot rewrite catalog receipts', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-settings-connect-')),
  );
  const project = { id: 'p', name: 'Original name', root, managed: true };
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
    baseBranch: 'main',
  };
  const store = await FileProjectStore.open({
    directory: path.join(root, 'state'),
    project,
    profile,
  });
  const registry = new ProjectStoreRegistry([store]);
  const unexpected = async (): Promise<never> => {
    throw Error('The existing project must not bootstrap another authority.');
  };
  const repository: ProjectRepositoryPort = {
    inspect: async (input) => {
      assert.equal(input, root);
      return { ...project, branch: 'main', head: 'a'.repeat(40), dirty: false, warnings: [] };
    },
    load: unexpected,
    prepareConnection: unexpected,
    ensureLocal: unexpected,
    exportProfile: unexpected,
    head: unexpected,
    isAncestor: unexpected,
    fastForward: unexpected,
  };
  const app = new ProjectApplication({
    registry,
    repository,
    policies: {},
    stores: { open: unexpected },
    catalog: { load: async () => undefined, save: async () => {} },
    id: () => 'synthetic-id',
    now: () => 'now',
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    release();
    await app.dispose();
    await registry.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const blocker = app.serialize(() => held);
  const input = { root, name: project.name, profile };
  const connecting = app.connect('connect', 'connect', input);
  input.root = '/caller-mutated-root';
  input.name = 'Caller-mutated name';
  input.profile.context = 'Caller-mutated profile';
  release();
  await blocker;
  const connected = await connecting;
  assert.deepEqual(connected, project);
  connected.root = '/result-alias';
  connected.name = 'Result alias';
  const replay = await app.connect('connect', 'connect', { root, name: project.name, profile });
  assert.deepEqual(replay, project);
  replay.name = 'Second result alias';
  assert.deepEqual(
    await app.connect('connect', 'connect', { root, name: project.name, profile }),
    project,
  );
  assert.deepEqual(registry.list(), [project]);
});

test('a same-ID proposal replacement during awaited HEAD cannot apply stale suggestions or consume the command receipt', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-settings-services-review-')),
  );
  const directory = path.join(root, 'sqlite');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, '.settings-fixture'), 'synthetic-only');
  const project = { id: 'p', name: 'Synthetic', root, managed: true };
  const initial: ProjectProfile = {
    version: 1,
    revision: 1,
    context: 'User context',
    scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
    checks: [],
    defaultCheckIds: [],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    maxRepairs: 0,
    turnTimeoutMs: 10000,
    baseBranch: 'main',
  };
  const authority = await SqliteProjectUsageAuthority.open({
    directory,
    project,
    profile: initial,
  });
  const registry = new ProjectStoreRegistry([
    {
      project: authority.project,
      settings: authority.settings,
      close: () => authority.close(),
    } as ProjectStore,
  ]);
  let reachedHead!: () => void, releaseHead!: () => void;
  const reached = new Promise<void>((resolve) => {
    reachedHead = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseHead = resolve;
  });
  const head = 'a'.repeat(40);
  let exports = 0;
  const unused = async (): Promise<never> => {
    throw Error('This settings use case has no repository or execution side effect.');
  };
  const repository: ProjectRepositoryPort = {
    inspect: unused,
    load: unused,
    prepareConnection: unused,
    ensureLocal: unused,
    exportProfile: async () => {
      exports++;
    },
    head: async () => {
      reachedHead();
      await held;
      return head;
    },
    isAncestor: unused,
    fastForward: unused,
  };
  const app = new ProjectApplication({
    registry,
    policies: {},
    repository,
    stores: { open: unused },
    catalog: { load: async () => undefined, save: async () => {} },
    id: () => 'synthetic-id',
    now: () => '2026-11-22T00:00:00Z',
  });
  t.after(async () => {
    releaseHead();
    await registry.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const old: ResearchProposal = {
    id: 'same-research-id',
    status: 'ready',
    analysis: { id: 'setup', revision: 'v1' },
    sourceHead: head,
    profileRevision: 1,
    context: 'Old proposal',
    checks: [],
  };
  await seedSettingsProposal(directory, old);
  const command = { id: 'apply', fingerprint: 'apply' };
  const applying = app.applyResearch(command.id, command.fingerprint, {
    projectId: 'p',
    researchId: old.id,
    expectedRevision: 1,
  });
  await reached;
  const replacement: ResearchProposal = {
    ...old,
    context: 'Replaced while HEAD was awaited',
    checks: [{ id: 'lint', title: 'New suggestion', command: 'synthetic lint', timeoutMs: 1000 }],
  };
  await seedSettingsProposal(directory, replacement);
  releaseHead();
  await assert.rejects(applying, { code: 'RESEARCH_STALE' });
  assert.deepEqual(await authority.settings.profile(), initial);
  assert.deepEqual(await authority.settings.researchProposal(), replacement);
  assert.equal(await authority.settings.receipt(command), undefined);
  assert.deepEqual((await authority.pagedEvents({ after: 0, limit: 10 })).events, []);
  assert.equal(exports, 0);
  const retried = await app.applyResearch(command.id, command.fingerprint, {
    projectId: 'p',
    researchId: old.id,
    expectedRevision: 1,
  });
  assert.equal(retried.revision, 2);
  assert.equal(retried.context, initial.context);
  assert.equal(retried.checks[0].command, 'synthetic lint');
  assert.equal(exports, 1);
  assert.equal((await authority.pagedEvents({ after: 0, limit: 10 })).events.length, 1);
});
