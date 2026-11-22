import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ContextLoaderCatalog, type ContextLoader } from '../core/context-loaders.ts';
import { createBuiltinContextLoaders } from '../adapters/context/loaders/builtins.ts';
import { documentContextLoader } from '../adapters/context/loaders/documents.ts';
import { stageContextMaterials } from '../adapters/files/context-materials.ts';
import { readAuthorizedMaterialText } from '../adapters/files/context-material-text.ts';
import { materialInstructions } from '../protocol/context.ts';
import { createHost } from '../plugins/host.ts';
import { goalMaterials } from '../core/context.ts';
import { sampleRun } from './fixtures/sample-run.ts';
import type { ContextMaterial } from '../protocol/context.ts';

const signal = () => new AbortController().signal;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const meta = (id: string) => ({ id, fingerprint: id });
const loader = (id = 'synthetic'): ContextLoader => ({
  id,
  revision: 'v1',
  matches: () => true,
  load: async () => ({ mimeType: 'text/plain', representation: 'text', text: 'Loaded' }),
});

test('sealed loader selection is unambiguous and captures callbacks and detached bytes', async () => {
  const catalog = new ContextLoaderCatalog();
  const registration = loader();
  registration.matches = (input) => {
    input.bytes[0] = 0;
    return true;
  };
  registration.load = async (input) => {
    assert.deepEqual([...input.bytes], [42]);
    input.bytes[0] = 7;
    return { mimeType: 'text/plain', representation: 'text', text: 'Original callback' };
  };
  catalog.register(registration);
  assert.throws(() => catalog.select({ name: 'x', bytes: new Uint8Array([42]) }), {
    code: 'CONTEXT_LOADERS_UNSEALED',
  });
  assert.throws(() => catalog.register(loader()), { code: 'CONTEXT_LOADER_EXISTS' });
  catalog.seal();
  registration.load = async () => {
    throw Error('Late callback replacement');
  };
  const bytes = new Uint8Array([42]);
  const selected = catalog.select({ name: 'x', bytes });
  bytes[0] = 99;
  assert.equal((await selected.load(signal())).text, 'Original callback');
  assert.throws(() => catalog.register(loader('late')), { code: 'CONTEXT_LOADERS_SEALED' });
  const ambiguous = new ContextLoaderCatalog();
  ambiguous.register(loader('one'));
  ambiguous.register(loader('two'));
  ambiguous.seal();
  assert.throws(() => ambiguous.select({ name: 'x', bytes: new Uint8Array() }), {
    code: 'CONTEXT_LOADER_AMBIGUOUS',
  });
  const fallback = createBuiltinContextLoaders();
  assert.equal(
    (
      await fallback.load(
        { name: 'source.newlanguage', bytes: new TextEncoder().encode('Valid text') },
        signal(),
      )
    ).loader.id,
    'text',
  );
  assert.throws(() => fallback.select({ name: 'unknown.bin', bytes: new Uint8Array([0, 255]) }), {
    code: 'UNSUPPORTED_CONTEXT',
  });
});

test('invalid, binary-as-text and oversized loader outputs fail before persistence', async () => {
  for (const result of [
    { mimeType: 'text/plain', representation: 'text', text: 'x', file: '/arbitrary/path' },
    { mimeType: 'text/plain', representation: 'text', text: 'binary\0data' },
    { mimeType: 'text/plain', representation: 'reference', text: 'Invented transcription' },
    { mimeType: 'text/plain', representation: 'text', text: 'x'.repeat(8 * 1024 * 1024 + 1) },
  ]) {
    const catalog = new ContextLoaderCatalog();
    catalog.register({ ...loader(), load: async () => result as any });
    catalog.seal();
    await assert.rejects(catalog.load({ name: 'x', bytes: new Uint8Array() }, signal()), {
      code: 'INVALID_CONTEXT_LOADER',
    });
  }
});

test('document extraction receives authorized copied bytes and missing tools preserve reference-only originals', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const catalog = new ContextLoaderCatalog();
  catalog.register(
    documentContextLoader(async (input, format) => {
      assert.deepEqual([...input], [1, 2, 3]);
      assert.equal(format, 'pdf');
      input[0] = 9;
      return ' PDF requirement ';
    }),
  );
  catalog.seal();
  assert.equal(
    (await catalog.load({ name: 'input.pdf', bytes }, signal())).text,
    'PDF requirement',
  );
  assert.deepEqual([...bytes], [1, 2, 3]);
  const unavailable = new ContextLoaderCatalog();
  unavailable.register(
    documentContextLoader(async () => {
      throw Error('Extractor unavailable');
    }),
  );
  unavailable.seal();
  const result = await unavailable.load({ name: 'input.docx', bytes }, signal());
  assert.equal(result.representation, 'reference');
  assert.equal(result.text, undefined);
  assert.match(result.note!, /extraction is unavailable/);
});

test('third loader runs through real Cordis imports while receipts, provenance and frozen run bytes survive upgrades', async (t) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'context-contributions-')),
  );
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  const hosts: Awaited<ReturnType<typeof createHost>>[] = [];
  t.after(async () => {
    await Promise.all(hosts.map((host) => host.dispose()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  let calls = 0;
  const open = async (revision: string) => {
    const host = await createHost({
      projects: [
        { storageAddress: path.join(root, '.buro'), project: { id: 'p', name: 'Synthetic', root } },
      ],
      configure(ctx) {
        ctx.projectContributions.contextLoaders.register({
          id: 'requirements',
          revision,
          matches: ({ name }) => name.endsWith('.requirements'),
          async load(input) {
            assert.deepEqual(Object.keys(input).sort(), ['bytes', 'name']);
            assert.deepEqual([...input.bytes], [0, 255, 42]);
            calls++;
            return {
              mimeType: 'application/x-requirements',
              representation: 'text',
              text: 'Requirement ' + revision,
            };
          },
        });
      },
    });
    hosts.push(host);
    return host;
  };
  const firstHost = await open('v1');
  const input = {
    projectId: 'p',
    scope: 'project' as const,
    upload: { name: 'selected.requirements', base64: Buffer.from([0, 255, 42]).toString('base64') },
  };
  const imported = (await firstHost.ctx.commands.bus.execute(
    { method: 'context.import', params: input },
    meta('import-one'),
  )) as ContextMaterial[];
  assert.equal(imported[0].hash, hash(new Uint8Array([0, 255, 42])));
  assert.equal(imported[0].textHash, hash('Requirement v1'));
  assert.deepEqual(imported[0].loader, { id: 'requirements', revision: 'v1' });
  const goal = await firstHost.ctx.goals.api.create('goal', 'goal', {
    projectId: 'p',
    title: 'Use context',
    body: 'Synthetic',
    criteria: '',
  });
  const store = firstHost.ctx.projects.registry.get('p');
  const frozen = await store.transact('freeze', 'freeze', (doc) => {
    const run = {
      ...sampleRun(),
      id: 'run',
      goalId: goal.id,
      contextMaterials: goalMaterials(doc, goal),
    };
    doc.runs.push(run);
    return { result: run.contextMaterials, change: { type: 'run.changed', run, goal } };
  });
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace);
  await stageContextMaterials(root, workspace, frozen);
  assert.equal(calls, 1);
  await firstHost.dispose();
  const secondHost = await open('v2');
  const replay = await secondHost.ctx.commands.bus.execute(
    { method: 'context.import', params: input },
    meta('import-one'),
  );
  assert.deepEqual(replay, imported);
  assert.equal(calls, 1, 'receipt replay never runs a new extractor');
  const newer = (await secondHost.ctx.commands.bus.execute(
    { method: 'context.import', params: input },
    meta('import-two'),
  )) as ContextMaterial[];
  assert.notEqual(newer[0].id, imported[0].id);
  assert.equal(newer[0].textHash, hash('Requirement v2'));
  const oldRun = secondHost.ctx.projects.registry
    .get('p')
    .snapshot()
    .runs.find((run) => run.id === 'run')!;
  await stageContextMaterials(root, workspace, oldRun.contextMaterials!);
  assert.equal(
    await fs.readFile(
      path.join(workspace, '.buro/context', path.basename(imported[0].textPath!)),
      'utf8',
    ),
    'Requirement v1',
  );
  assert.equal(calls, 2, 'staging the frozen run never invokes an upgraded loader');
  assert.equal(
    (await readAuthorizedMaterialText(secondHost.ctx.projects.registry, 'p', imported, signal()))[0]
      .text,
    'Requirement v1',
  );
  assert.throws(() => secondHost.ctx.projectContributions.contextLoaders.register(loader('late')), {
    code: 'CONTEXT_LOADERS_SEALED',
  });
});

test('private imports are rejected before loaders and image originals never become claimed model content', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'context-private-')));
  let matches = 0;
  const host = await createHost({
    projects: [
      {
        storageAddress: path.join(directory, '.buro'),
        project: { id: 'p', name: 'Synthetic', root: directory },
      },
    ],
    configure(ctx) {
      ctx.projectContributions.contextLoaders.register({
        ...loader('observe'),
        matches: () => {
          matches++;
          return false;
        },
      });
    },
  });
  t.after(async () => {
    await host.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    host.ctx.commands.bus.execute(
      {
        method: 'context.import',
        params: {
          projectId: 'p',
          scope: 'goal',
          upload: { name: '.env', base64: Buffer.from('synthetic-private').toString('base64') },
        },
      },
      meta('private'),
    ),
    { code: 'UNSUPPORTED_CONTEXT' },
  );
  assert.equal(matches, 0);
  const image = (await host.ctx.commands.bus.execute(
    {
      method: 'context.import',
      params: {
        projectId: 'p',
        scope: 'goal',
        upload: { name: 'screen.png', base64: Buffer.from([137, 80, 78, 71]).toString('base64') },
      },
    },
    meta('image'),
  )) as ContextMaterial[];
  const resolved = await readAuthorizedMaterialText(
    host.ctx.projects.registry,
    'p',
    image,
    signal(),
  );
  assert.equal(resolved[0].representation, 'reference');
  assert.equal(resolved[0].text, undefined);
  const instructions = materialInstructions(image, directory);
  assert.match(instructions, /reference only/);
  assert.doesNotMatch(instructions, /Use available tools to inspect images/);
  const alias = { ...image[0], relativePath: 'local/context/' + '0'.repeat(64) + '.png' };
  await assert.rejects(
    readAuthorizedMaterialText(host.ctx.projects.registry, 'p', [alias], signal()),
    { code: 'CONTEXT_NOT_FOUND' },
  );
  const original = path.join(directory, '.buro', image[0].relativePath);
  await fs.writeFile(original, 'Changed saved image');
  await assert.rejects(
    readAuthorizedMaterialText(host.ctx.projects.registry, 'p', image, signal()),
    { code: 'CONTEXT_CORRUPT' },
  );
  const external = path.join(directory, 'other.png');
  await fs.writeFile(external, 'different');
  await fs.rm(original);
  await fs.symlink(external, original);
  await assert.rejects(
    readAuthorizedMaterialText(host.ctx.projects.registry, 'p', image, signal()),
    { code: 'CONTEXT_CORRUPT' },
  );
});
