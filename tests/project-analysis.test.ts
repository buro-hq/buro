import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import { fixtureExecutionSelection } from './fixtures/execution-resources.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ProjectAnalysisCatalog, type ProjectAnalyzer } from '../core/project-analysis.ts';
import { ProjectResearchService } from '../core/project-research.ts';
import { createBuiltinProjectAnalyses } from '../adapters/analysis/project-setup.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { createHost } from '../plugins/host.ts';
import { runtimePlugin } from '../plugins/runtime.ts';
import { projectManagementPlugin } from '../plugins/project-management.ts';
import { projectOperationsPlugin } from '../plugins/project-operations.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import type { RegisteredRuntime } from '../core/ports.ts';
import { ContextMaterials } from '../adapters/files/context-materials.ts';
import { readAuthorizedMaterialText } from '../adapters/files/context-material-text.ts';
import { serviceOperationContext, operationIds } from '../core/operation-catalog.ts';
import { resolveRoleResource } from '../core/role-routing.ts';
const exec = promisify(execFile);
const profile = (): ProjectProfile => ({
  version: 1,
  revision: 1,
  context: 'Manual context',
  scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
  checks: [{ id: 'manual', title: 'Manual test', command: 'manual-command', timeoutMs: 10000 }],
  defaultCheckIds: ['manual'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 1,
  maxRepairs: 0,
  turnTimeoutMs: 10000,
  baseBranch: 'main',
  components: [],
});
const proposal = () => ({
  summary: 'Third analysis proposal',
  context: 'Suggested context',
  components: [
    {
      id: 'web',
      name: 'Web',
      kind: 'web' as const,
      path: './',
      command: 'never-execute',
      port: 0,
      readyPath: '',
      instructions: 'Proposal only',
      evidence: 'README.md',
    },
  ],
  checks: [
    { id: 'manual', title: 'Suggested test', command: 'never-execute-check', timeoutMs: 10000 },
  ],
  questions: [],
});
const analyzer = (): ProjectAnalyzer => ({
  id: 'third-analysis',
  revision: 'third-v1',
  purpose: 'project-setup',
  build: () => ({
    instructions: 'Third analyzer instructions',
    prompt: 'Third prompt',
    schema: { type: 'object' },
  }),
  parse: () => proposal(),
});
const input = () => ({
  project: { id: 'p', name: 'Project' },
  sourceHead: 'a'.repeat(40),
  profile: profile(),
  materials: [],
});

test('project analysis requires sealed explicit registrations and captures callback and result aliases', () => {
  const catalog = new ProjectAnalysisCatalog(),
    registration = analyzer();
  catalog.register(registration);
  assert.throws(() => catalog.get(registration.id), { code: 'PROJECT_ANALYSES_UNSEALED' });
  assert.throws(() => catalog.register(registration), { code: 'PROJECT_ANALYSIS_EXISTS' });
  catalog.seal();
  registration.revision = 'mutated';
  registration.parse = () => {
    throw Error('Rebound');
  };
  const resolved = catalog.get('third-analysis');
  assert.equal(resolved.revision, 'third-v1');
  assert.equal(resolved.parse('wire').summary, 'Third analysis proposal');
  assert.throws(() => catalog.get('missing'), { code: 'PROJECT_ANALYSIS_UNAVAILABLE' });
  assert.throws(() => catalog.register({ ...registration, id: 'late' }), {
    code: 'PROJECT_ANALYSES_SEALED',
  });
  const retained = proposal(),
    request = {
      instructions: 'Instructions',
      prompt: 'Prompt',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    };
  const other = new ProjectAnalysisCatalog();
  other.register({
    ...analyzer(),
    build: (packet) => {
      assert.ok(Object.isFrozen(packet.profile));
      return request;
    },
    parse: () => retained,
  });
  other.seal();
  const built = other.get('third-analysis').build(input()),
    parsed = other.get('third-analysis').parse('wire');
  request.schema.properties.ok.type = 'string';
  retained.components[0].name = 'mutated';
  assert.equal((built.schema.properties as any).ok.type, 'boolean');
  assert.equal(parsed.components[0].name, 'Web');
});

test('every analyzer is normalized through the bounded proposal contract without accepting permissions or duplicate IDs', () => {
  for (const bad of [
    { ...proposal(), delivery: { enabled: true } },
    { ...proposal(), components: [proposal().components[0], proposal().components[0]] },
    { ...proposal(), checks: [proposal().checks[0], proposal().checks[0]] },
    { ...proposal(), context: 'x'.repeat(16001) },
  ]) {
    const catalog = new ProjectAnalysisCatalog();
    catalog.register({ ...analyzer(), parse: () => bad });
    catalog.seal();
    assert.throws(() => catalog.get('third-analysis').parse('wire'), {
      code: 'PROJECT_ANALYSIS_INVALID_RESULT',
    });
  }
  const catalog = new ProjectAnalysisCatalog();
  catalog.register({
    ...analyzer(),
    build: () => {
      throw Error('PRIVATE_SENTINEL');
    },
  });
  catalog.seal();
  assert.throws(
    () => catalog.get('third-analysis').build(input()),
    (error: any) => {
      assert.equal(error.code, 'PROJECT_ANALYSIS_INVALID_REQUEST');
      assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/);
      assert.match(error.cause.message, /PRIVATE_SENTINEL/);
      return true;
    },
  );
});

test('builtin setup analysis describes only supplied material representations and explicitly marks excerpts', () => {
  const packet = input() as any;
  packet.materials = [
    {
      id: 'M-text',
      name: 'Notes',
      mimeType: 'text/plain',
      hash: 'a'.repeat(64),
      representation: 'text',
      text: 'T'.repeat(5000),
    },
    {
      id: 'M-image',
      name: 'Screenshot',
      mimeType: 'image/png',
      hash: 'b'.repeat(64),
      representation: 'reference',
      note: 'Reference only; no visual interpretation.',
    },
  ];
  const request = createBuiltinProjectAnalyses().get('project-setup').build(packet);
  assert.match(request.prompt, /Only 4000 of 5000 characters/);
  assert.match(request.prompt, /reference-only entries are not visual input/);
  assert.match(request.prompt, /no visual interpretation/);
  assert.doesNotMatch(request.prompt, /T{5000}/);
});

async function repositoryFixture(t: any, custom: ProjectAnalyzer = analyzer()) {
  const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'buro-project-analysis-')),
    ),
    root = path.join(directory, 'repo');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'README.md'), 'Repository fixture');
  await fs.writeFile(path.join(root, '.gitignore'), '.buro/\n');
  const git = (args: string[]) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture']);
  const host = await createHost({
    projects: [
      {
        storageAddress: path.join(root, '.buro', 'state'),
        project: { id: 'p', name: 'Project', root, managed: true },
        profile: profile(),
      },
    ],
    async configure(ctx) {
      await ctx.plugin({
        name: 'third-analysis-registration',
        inject: ['projectContributions'],
        apply(ctx) {
          ctx.projectContributions.analyses.register(custom);
        },
      });
    },
  });
  t.after(async () => {
    await host.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const starts: any[] = [],
    turns: any[] = [],
    releases: string[] = [];
  let released!: () => void;
  const complete = new Promise<void>((resolve) => {
    released = resolve;
  });
  const runtime: RegisteredRuntime = {
    id: 'synthetic',
    capabilities: fixtureCapabilities({ structuredTurns: true, readOnlySessions: true }),
    async start(input) {
      starts.push(structuredClone(input));
      return { threadId: 'research-thread' };
    },
    async submit() {
      return { turnId: 'turn' };
    },
    async turn(_thread, prompt, options) {
      turns.push({ prompt, schema: structuredClone(options.schema) });
      return { turnId: 'turn', text: 'CUSTOM-WIRE' };
    },
    async release(thread) {
      releases.push(thread);
      released();
    },
    async interrupt() {},
    async dispose() {},
  };
  await host.ctx.plugin(runtimePlugin, {
    runtimes: [runtime],
    defaultRuntimeId: runtime.id,
    selection: fixtureExecutionSelection(runtime.id, runtime.capabilities),
  });
  await host.ctx.plugin(projectManagementPlugin, {
    catalogFile: path.join(directory, 'catalog.json'),
    policies: {},
    workspaces: {
      async prepare() {
        throw Error('Analysis must not prepare or change sources.');
      },
      async changes() {
        throw Error('Unused');
      },
      async commit() {
        throw Error('Unused');
      },
    } as any,
    checks: {
      async run() {
        throw Error('Analysis must not run checks.');
      },
    },
  });
  await host.ctx.plugin(projectOperationsPlugin, {
    analysisId: custom.id,
    operations: { async dispose() {} } as any,
  });
  let sequence = 0;
  const command = (method: string, params: any, id = String(++sequence)) =>
    host.ctx.commands.bus.execute({ method, params } as any, { id, fingerprint: id });
  const store = host.ctx.projects.registry.get('p');
  return { directory, root, git, host, store, command, starts, turns, releases, complete };
}

test('a real Cordis third analyzer drives research, verified material input and guarded additive apply without executing suggestions', async (t) => {
  let packet: any;
  const custom = {
    ...analyzer(),
    build: (input: any) => {
      packet = input;
      assert.ok(Object.isFrozen(input.profile));
      assert.equal('root' in input.project, false);
      assert.equal('relativePath' in input.materials[0], false);
      return {
        instructions: 'ACTUAL-THIRD-INSTRUCTIONS',
        prompt: 'ACTUAL-THIRD-PROMPT',
        schema: {
          type: 'object',
          properties: { third: { type: 'string' } },
          required: ['third'],
          additionalProperties: false,
        },
      };
    },
    parse: (text: string) => {
      assert.equal(text, 'CUSTOM-WIRE');
      return proposal();
    },
  };
  const f = await repositoryFixture(t, custom),
    material = path.join(f.directory, 'context.txt');
  await fs.writeFile(material, 'AUTHORIZED_CONTEXT');
  await f.command('context.import', { projectId: 'p', paths: [material], scope: 'project' });
  const original = f.store.snapshot().profile!;
  const result = await f.command('project.research', { projectId: 'p' }, 'research');
  await f.complete;
  const ready = f.store.snapshot().research!;
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.analysis, { id: 'third-analysis', revision: 'third-v1' });
  assert.match(packet.materials[0].text, /AUTHORIZED_CONTEXT/);
  assert.equal(f.starts[0].readOnly, true);
  assert.equal(f.starts[0].operationId, 'project.research');
  assert.match(f.starts[0].instructions, /ACTUAL-THIRD-INSTRUCTIONS/);
  assert.equal(f.turns[0].prompt, 'ACTUAL-THIRD-PROMPT');
  assert.ok(f.turns[0].schema.properties.third);
  assert.deepEqual(f.store.snapshot().profile, original);
  assert.deepEqual(await f.command('project.research', { projectId: 'p' }, 'research'), result);
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.releases, ['research-thread']);
  await assert.rejects(
    f.command(
      'project.research.apply',
      { projectId: 'p', researchId: ready.id, expectedRevision: 0 },
      'stale-form',
    ),
    { code: 'CONFLICT' },
  );
  await f.command(
    'project.research.apply',
    { projectId: 'p', researchId: ready.id, expectedRevision: 1 },
    'apply',
  );
  const applied = f.store.snapshot();
  assert.equal(applied.profile!.revision, 2);
  assert.equal(applied.profile!.context, 'Manual context');
  assert.equal(applied.profile!.components![0].command, 'never-execute');
  assert.equal(applied.profile!.checks[0].command, 'manual-command');
  assert.equal(applied.research!.appliedProfileRevision, 2);
  assert.deepEqual(applied.research!.analysis, ready.analysis);
  assert.equal(await fs.readFile(path.join(f.root, 'README.md'), 'utf8'), 'Repository fixture');
  assert.deepEqual((await f.git(['status', '--porcelain'])).stdout, '');
});

test('changed repository HEAD blocks applying an analyzer proposal while preserving its original provenance', async (t) => {
  const f = await repositoryFixture(t);
  await f.command('project.research', { projectId: 'p' }, 'research');
  await f.complete;
  const before = f.store.snapshot(),
    ready = before.research!;
  await fs.writeFile(path.join(f.root, 'README.md'), 'Changed source');
  await f.git(['add', 'README.md']);
  await f.git(['commit', '-m', 'Changed source']);
  await assert.rejects(
    f.command(
      'project.research.apply',
      { projectId: 'p', researchId: ready.id, expectedRevision: 1 },
      'apply-stale',
    ),
    { code: 'RESEARCH_STALE' },
  );
  assert.deepEqual(f.store.snapshot().profile, before.profile);
  assert.deepEqual(f.store.snapshot().research!.analysis, ready.analysis);
});

test('a malformed analyzer result fails research and releases its read-only session without applying settings', async (t) => {
  const f = await repositoryFixture(t, {
    ...analyzer(),
    parse: () => ({ ...proposal(), runtimeId: 'unauthorized' }),
  });
  const before = f.store.snapshot().profile;
  await f.command('project.research', { projectId: 'p' });
  await f.complete;
  const research = f.store.snapshot().research!;
  assert.equal(research.status, 'failed');
  assert.match(research.error!, /invalid proposal/);
  assert.deepEqual(f.store.snapshot().profile, before);
  assert.deepEqual(f.releases, ['research-thread']);
});

test('cancellation before dispatch keeps admitted analysis identity and rejects provenance rebinding', async (t) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-analysis-cancel-')),
  );
  const store = await FileProjectStore.open({
      directory: path.join(directory, 'state'),
      project: { id: 'p', name: 'Project', root: directory, managed: true },
      profile: profile(),
    }),
    projects = new ProjectStoreRegistry([store]);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  let starts = 0;
  const service = new ProjectResearchService({
    workflowRoles: createBuiltinWorkflowRoles(),
    projects,
    runtime: {
      id: 'fake',
      async start() {
        starts++;
        return { threadId: 'unexpected' };
      },
    } as any,
    head: async () => 'a'.repeat(40),
    selection: fixtureExecutionSelection(
      'fake',
      fixtureCapabilities({ structuredTurns: true, readOnlySessions: true }),
    ),
    analysis: createBuiltinProjectAnalyses().get('project-setup'),
    materials: async () => {
      enter();
      await held;
      return [];
    },
  });
  t.after(async () => {
    release();
    await service.dispose();
    await projects.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await service.start('research', 'fp', 'p');
  await entered;
  const admitted = store.snapshot().research!;
  await assert.rejects(
    store.transact('rebind', 'rebind', (doc) => {
      doc.research!.analysis.revision = 'changed';
      return {
        result: null,
        change: { type: 'project.research.changed', research: doc.research! },
      };
    }),
    { code: 'PROJECT_ANALYSIS_CHANGED' },
  );
  service.cancel('p');
  release();
  await service.jobs.get('p')!.promise;
  assert.equal(store.snapshot().research!.status, 'interrupted');
  assert.deepEqual(store.snapshot().research!.analysis, admitted.analysis);
  assert.equal(starts, 0);
});

test('simultaneous retries of one research request schedule one job and preserve its receipt', async (t) => {
  const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'buro-analysis-admit-')),
    ),
    store = await FileProjectStore.open({
      directory: path.join(directory, 'state'),
      project: { id: 'p', name: 'Project', root: directory, managed: true },
      profile: profile(),
    }),
    projects = new ProjectStoreRegistry([store]);
  let release!: () => void, entered!: () => void, completed!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    both = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    done = new Promise<void>((resolve) => {
      completed = resolve;
    });
  let heads = 0,
    starts = 0,
    turns = 0;
  const service = new ProjectResearchService({
    workflowRoles: createBuiltinWorkflowRoles(),
    projects,
    selection: fixtureExecutionSelection(
      'fake',
      fixtureCapabilities({ structuredTurns: true, readOnlySessions: true }),
    ),
    analysis: createBuiltinProjectAnalyses().get('project-setup'),
    materials: async () => [],
    head: async () => {
      if (++heads <= 2) {
        if (heads === 2) entered();
        await held;
      }
      return 'a'.repeat(40);
    },
    runtime: {
      id: 'fake',
      async start() {
        starts++;
        return { threadId: 'one' };
      },
      async turn() {
        turns++;
        return { turnId: 'one', text: JSON.stringify(proposal()) };
      },
      async release() {
        completed();
      },
    } as any,
  });
  t.after(async () => {
    release();
    await service.dispose();
    await projects.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const first = service.start('same', 'same', 'p'),
    second = service.start('same', 'same', 'p');
  await both;
  release();
  const receipts = await Promise.all([first, second]);
  await done;
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(starts, 1);
  assert.equal(turns, 1);
  assert.equal(store.snapshot().research!.status, 'ready');
});

test('material selection is admitted atomically and remains valid after later library removal', async (t) => {
  const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'buro-analysis-material-admit-')),
    ),
    store = await FileProjectStore.open({
      directory: path.join(directory, 'state'),
      project: { id: 'p', name: 'Project', root: directory, managed: true },
      profile: profile(),
    }),
    projects = new ProjectStoreRegistry([store]),
    materials = new ContextMaterials(projects);
  let headEntered!: () => void,
    releaseHead!: () => void,
    materialEntered!: () => void,
    releaseMaterials!: () => void,
    completed!: () => void;
  const enteringHead = new Promise<void>((resolve) => {
      headEntered = resolve;
    }),
    heldHead = new Promise<void>((resolve) => {
      releaseHead = resolve;
    }),
    enteringMaterials = new Promise<void>((resolve) => {
      materialEntered = resolve;
    }),
    heldMaterials = new Promise<void>((resolve) => {
      releaseMaterials = resolve;
    }),
    done = new Promise<void>((resolve) => {
      completed = resolve;
    });
  let heads = 0,
    packet: any;
  const catalog = new ProjectAnalysisCatalog();
  catalog.register({
    ...analyzer(),
    build: (input) => {
      packet = input;
      return {
        instructions: 'Read only',
        prompt: 'Analyze frozen materials',
        schema: { type: 'object' },
      };
    },
  });
  catalog.seal();
  const service = new ProjectResearchService({
    workflowRoles: createBuiltinWorkflowRoles(),
    projects,
    selection: fixtureExecutionSelection(
      'fake',
      fixtureCapabilities({ structuredTurns: true, readOnlySessions: true }),
    ),
    analysis: catalog.get('third-analysis'),
    head: async () => {
      if (++heads === 1) {
        headEntered();
        await heldHead;
      }
      return 'a'.repeat(40);
    },
    materials: async (projectId, selected, signal) => {
      materialEntered();
      await heldMaterials;
      return readAuthorizedMaterialText(projects, projectId, selected, signal);
    },
    runtime: {
      id: 'fake',
      async start() {
        return { threadId: 'one' };
      },
      async turn() {
        return { turnId: 'one', text: 'custom' };
      },
      async release() {
        completed();
      },
    } as any,
  });
  t.after(async () => {
    releaseHead();
    releaseMaterials();
    await service.dispose();
    await materials.dispose();
    await projects.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const starting = service.start('research', 'research', 'p');
  await enteringHead;
  const source = path.join(directory, 'added.txt');
  await fs.writeFile(source, 'Added during admission');
  const [saved] = await materials.import('import', 'import', {
    projectId: 'p',
    paths: [source],
    scope: 'project',
  });
  releaseHead();
  await starting;
  await enteringMaterials;
  await materials.remove('remove', 'remove', { projectId: 'p', materialId: saved.id });
  releaseMaterials();
  await done;
  assert.equal(store.snapshot().contextMaterials![0].active, false);
  assert.equal(store.snapshot().research!.status, 'ready');
  assert.equal(packet.materials[0].id, saved.id);
  assert.equal(packet.materials[0].text, 'Added during admission');
});

test('recovery interrupts a pending historical analyzer without rebinding it to the currently configured analyzer', async (t) => {
  const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'buro-analysis-recover-')),
    ),
    store = await FileProjectStore.open({
      directory: path.join(directory, 'state'),
      project: { id: 'p', name: 'Project', root: directory, managed: true },
      profile: profile(),
    }),
    projects = new ProjectStoreRegistry([store]);
  const selection = fixtureExecutionSelection(
    'fake',
    fixtureCapabilities({ structuredTurns: true, readOnlySessions: true }),
  );
  const historical = {
    id: 'research-old',
    analysis: { id: 'removed-analyzer', revision: 'old-v1' },
    resources: selection.forProject('p'),
    contextMaterials: [],
    status: 'running' as const,
    startedAt: '2026-11-22T00:00:00Z',
    sourceHead: 'a'.repeat(40),
    profileRevision: 1,
    summary: 'Pending old proposal',
    events: [],
  };
  await store.transact('seed', 'seed', (doc) => {
    const operation = serviceOperationContext(operationIds.research, doc.profile);
    const { role } = createBuiltinWorkflowRoles().ensureRole(doc, operation, historical.startedAt);
    doc.research = {
      ...historical,
      roleSnapshot: role,
      roleResource: resolveRoleResource(historical.resources, role, operation),
    };
    return { result: null, change: { type: 'project.research.changed', research: doc.research } };
  });
  let calls = 0;
  const service = new ProjectResearchService({
    workflowRoles: createBuiltinWorkflowRoles(),
    projects,
    selection,
    analysis: createBuiltinProjectAnalyses().get('project-setup'),
    head: async () => {
      calls++;
      throw Error('Recovery must not inspect sources');
    },
    materials: async () => {
      calls++;
      return [];
    },
    runtime: {
      id: 'fake',
      async start() {
        calls++;
        throw Error('Recovery must not start a model');
      },
    } as any,
  });
  t.after(async () => {
    await service.dispose();
    await projects.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await service.recover();
  assert.equal(store.snapshot().research!.status, 'interrupted');
  assert.deepEqual(store.snapshot().research!.analysis, historical.analysis);
  assert.equal(calls, 0);
});
