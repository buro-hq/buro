import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { FileRuntimeRoutes } from '../adapters/files/runtime-routes.ts';
import { ContextMaterials } from '../adapters/files/context-materials.ts';
import { readAuthorizedMaterialText } from '../adapters/files/context-material-text.ts';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { RuntimeRouter } from '../core/runtime-router.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { ProjectResearchService } from '../core/project-research.ts';
import { ProjectAnalysisCatalog, type ProjectAnalysisInput } from '../core/project-analysis.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import type { RuntimeResource, ResourceSnapshot } from '../protocol/resources.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: any) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-research-boundary-')),
  );
  const state = path.join(root, 'state');
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
  const store = await FileProjectStore.open({
    directory: state,
    project: { id: 'p', name: 'Fixture', root, managed: true },
    profile,
  });
  const projects = new ProjectStoreRegistry([store]),
    imports = new ContextMaterials(projects),
    registry = new RuntimeCatalog(),
    sessionsDirectory = path.join(root, 'sessions'),
    sessions = new FileManagedSessions(sessionsDirectory),
    routes = new FileRuntimeRoutes(path.join(root, 'routes')),
    tools = new RepositoryTools(new EnvironmentExecutors());
  let sequence = 0;
  const requests: { runtime: string; input: any }[] = [];
  const resources: RuntimeResource[] = [];
  for (const id of ['first', 'second']) {
    const runtime = new ManagedAgentRuntime({
      id,
      model: id + '-model',
      sessions,
      projects,
      tools,
      loopRunner: new PiAgentLoopRunner(),
      idGenerator: () => String(++sequence),
      limits: {
        contextTokens: 32768,
        maxOutputTokens: 512,
        maxRequestsPerTurn: 4,
        maxToolCallsPerTurn: 4,
        maxSessionRequests: 8,
      },
      provider: {
        id: id + '-provider',
        revision: 'v1',
        local: true,
        async complete(input) {
          requests.push({
            runtime: id,
            input: structuredClone({ messages: input.messages, tools: input.tools }),
          });
          return {
            model: id + '-model',
            finish: 'stop',
            message: { role: 'assistant', content: '{"ok":true}' },
          };
        },
      },
    });
    registry.register(runtime);
    resources.push({
      id,
      backendId: 'managed',
      model: id + '-model',
      providerId: id + '-provider',
      local: true,
      configurationRevision: id + '-v1',
      capabilities: runtime.capabilities,
    });
  }
  let active = resources[0];
  const selection = {
    forProject: (): ResourceSnapshot => ({
      profileId: active.id,
      policy: 'local-only',
      coordinator: active,
      worker: active,
      reviewer: active,
      workerPool: resources,
    }),
  };
  const router = new RuntimeRouter({
    projects,
    registry,
    resources,
    routes,
    selection,
    id: () => 'route-' + ++sequence,
  });
  const catalog = new ProjectAnalysisCatalog();
  let packet: ProjectAnalysisInput | undefined;
  catalog.register({
    id: 'research-probe',
    revision: 'v1',
    purpose: 'project-setup',
    build(input) {
      packet = input;
      return {
        instructions: 'Analyze only supplied material text.',
        prompt: JSON.stringify(input),
        schema: { type: 'object' },
      };
    },
    parse: () => ({
      summary: 'Proposal only',
      context: 'Suggested context',
      components: [],
      checks: [],
      questions: [],
    }),
  });
  catalog.seal();
  const headEntered = deferred(),
    heldHead = deferred(),
    readerEntered = deferred(),
    heldReader = deferred();
  let heads = 0;
  const service = new ProjectResearchService({
    projects,
    runtime: router,
    selection,
    analysis: catalog.get('research-probe'),
    async head() {
      if (++heads === 1) {
        headEntered.resolve();
        await heldHead.promise;
      }
      return 'a'.repeat(40);
    },
    async materials(projectId, selected, signal) {
      readerEntered.resolve();
      await heldReader.promise;
      return readAuthorizedMaterialText(projects, projectId, selected, signal);
    },
  });
  const upload = async (id: string, name: string, content: string) =>
    (
      await imports.import(id, id, {
        projectId: 'p',
        scope: 'project',
        upload: { name, base64: Buffer.from(content).toString('base64') },
      })
    )[0];
  const text = await upload('initial-text', 'brief.txt', 'Frozen original text');
  const image = await upload(
    'initial-image',
    'diagram.png',
    'IMAGE_BYTES_MUST_NOT_BECOME_MODEL_CONTENT',
  );
  t.after(async () => {
    heldHead.resolve();
    heldReader.resolve();
    await service.dispose();
    await router.dispose();
    await registry.dispose();
    await imports.dispose();
    await projects.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    state,
    store,
    projects,
    imports,
    router,
    routes,
    requests,
    text,
    image,
    resources,
    upload,
    service,
    headEntered,
    heldHead,
    readerEntered,
    heldReader,
    packet: () => packet,
    selectSecond: () => {
      active = resources[1];
    },
    reopenSession: (id: string) => new FileManagedSessions(sessionsDirectory).load(id),
  };
}

test('research uses its admitted model and material grants across machine changes, later imports and private session reopen', async (t) => {
  const f = await fixture(t);
  const starting = f.service.start('research', 'research', 'p');
  await f.headEntered.promise;
  f.selectSecond();
  const duringAdmission = await f.upload(
    'during-admission',
    'during.txt',
    'Included atomically at admission',
  );
  f.heldHead.resolve();
  await starting;
  await f.readerEntered.promise;
  const job = f.service.jobs.get('p')!.promise;
  const admitted = structuredClone(f.store.snapshot().research!);
  assert.equal(admitted.resources.coordinator.id, 'first');
  assert.deepEqual(
    admitted.contextMaterials.map((m) => m.id),
    [f.text.id, f.image.id, duringAdmission.id],
  );
  await f.imports.remove('remove', 'remove', { projectId: 'p', materialId: f.text.id });
  const later = await f.upload('later', 'later.txt', 'Never authorized for this research');
  f.heldReader.resolve();
  await job;
  const saved = f.store.snapshot().research!;
  assert.equal(saved.status, 'ready', saved.error);
  assert.deepEqual(
    f.requests.map((r) => r.runtime),
    ['first'],
  );
  assert.equal(f.packet()!.materials.find((m) => m.id === f.text.id)!.text, 'Frozen original text');
  const reference = f.packet()!.materials.find((m) => m.id === f.image.id)!;
  assert.equal(reference.representation, 'reference');
  assert.equal(reference.text, undefined);
  assert.equal(
    f.packet()!.materials.some((m) => m.id === later.id),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(f.packet()),
    /IMAGE_BYTES_MUST|relativePath|textPath|workspace/,
  );
  assert.doesNotMatch(
    JSON.stringify(f.requests),
    /IMAGE_BYTES_MUST|Never authorized for this research/,
  );
  const route = (await f.routes.load(saved.threadId!))!;
  assert.equal(route.resource.id, 'first');
  const privateSession = (await f.reopenSession(route.externalThreadId!))!;
  const grant = admitted.contextMaterials
    .flatMap((m) => [m.relativePath, ...(m.textPath ? [m.textPath] : [])])
    .map((p) => '.buro/' + p);
  assert.deepEqual(privateSession.scope.materials, grant);
  assert.equal(privateSession.scope.readOnly, true);
  assert.equal(privateSession.requests, 1);
  await f.store.transact('replace-finished-research', 'replace-finished-research', (doc) => {
    doc.research = { ...doc.research!, id: 'new-analysis', contextMaterials: [later] };
    return { result: null, change: { type: 'project.research.changed', research: doc.research } };
  });
  await f.router.resume({
    projectId: 'p',
    runId: admitted.id,
    threadId: saved.threadId!,
    workspace: f.root,
    instructions: 'Continue the original analysis',
  });
  assert.deepEqual((await f.reopenSession(route.externalThreadId!))!.scope.materials, grant);
  assert.deepEqual(
    f.requests.map((r) => r.runtime),
    ['first'],
  );
});

test('captured research resources and material provenance cannot be rewritten with a successful receipt', async (t) => {
  const f = await fixture(t);
  const starting = f.service.start('research', 'research', 'p');
  await f.headEntered.promise;
  f.heldHead.resolve();
  await starting;
  await f.readerEntered.promise;
  const before = f.store.snapshot(),
    bytes = await fs.readFile(path.join(f.state, 'control-state.json'), 'utf8');
  for (const [id, mutate] of [
    [
      'replace-resource',
      (r: any) => {
        r.resources.coordinator = f.resources[1];
      },
    ],
    [
      'erase-materials',
      (r: any) => {
        r.contextMaterials = [];
      },
    ],
    [
      'retarget-material',
      (r: any) => {
        r.contextMaterials[0].hash = 'b'.repeat(64);
      },
    ],
  ] as const) {
    await assert.rejects(
      f.store.transact(id, id, (doc) => {
        mutate(doc.research);
        return {
          result: null,
          change: { type: 'project.research.changed', research: doc.research! },
        };
      }),
      { code: 'PROJECT_ANALYSIS_CHANGED' },
    );
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(await fs.readFile(path.join(f.state, 'control-state.json'), 'utf8'), bytes);
    assert.equal(f.store.receipt(id, id), undefined);
  }
});

test('corrupt saved material bytes fail research before analysis build or any model dispatch', async (t) => {
  const f = await fixture(t);
  const starting = f.service.start('research', 'research', 'p');
  await f.headEntered.promise;
  f.heldHead.resolve();
  await starting;
  await f.readerEntered.promise;
  const job = f.service.jobs.get('p')!.promise;
  await fs.writeFile(path.join(f.root, '.buro', f.text.relativePath), 'Tampered content');
  f.heldReader.resolve();
  await job;
  assert.equal(f.store.snapshot().research!.status, 'failed');
  assert.match(f.store.snapshot().research!.error!, /saved material changed/i);
  assert.equal(f.packet(), undefined);
  assert.deepEqual(f.requests, []);
  assert.equal(f.store.snapshot().research!.threadId, undefined);
  assert.equal(f.store.snapshot().profile!.context, '');
});
