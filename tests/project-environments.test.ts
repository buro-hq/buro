import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnvironmentExecutors, type Launch } from '../adapters/environments/executors.ts';
import { ProjectEnvironments } from '../adapters/environments/project-environments.ts';
import type { AgentRuntime, ProjectRegistry } from '../core/ports.ts';
import type { Check, ProjectProfile } from '../protocol/domain.ts';
import {
  environmentRecipeOutputSchema,
  parseEnvironmentRecipeOutput,
  EnvironmentRecipeSchema,
  type EnvironmentRecipe,
} from '../protocol/environment.ts';
// Logic fixtures intentionally use a plain executor; confinement is tested separately below.
class FixtureExecutors extends EnvironmentExecutors {
  launch(workspace: string, argv: string[]): Launch {
    return {
      executable: argv[0],
      args: argv.slice(1),
      cwd: workspace,
      env: { ...process.env, ...this.get(workspace)!.variables },
    };
  }
}
async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-environment-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'work');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'toolchain.txt'), 'v1');
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: '',
    scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: [] },
    setup: [],
    dependencies: 'none',
    checks: [],
    defaultCheckIds: [],
    maxWorkers: 2,
    turnTimeoutMs: 1000,
  };
  const command = (id: string, script: string) => ({
    id,
    title: id,
    command: script,
    timeoutMs: 1000,
  });
  const recipe: EnvironmentRecipe = {
    summary: 'Prepare a non-Node project',
    inputs: ['toolchain.txt'],
    variables: { PATH: '${HOME}/project-bin:${PATH}', TOOLCHAIN_ROOT: '${WORKSPACE}/tools' },
    setup: [
      command('install', 'echo setup >> installs; mkdir -p tools; cp toolchain.txt tools/version'),
    ],
    ready: [command('ready', 'test -f tools/version && cmp toolchain.txt tools/version')],
  };
  const recipes = [recipe],
    prompts: string[] = [],
    reports: Check[] = [];
  const runtime = {
    id: 'fixture',
    async start() {
      return { threadId: 'environment' };
    },
    async release() {},
    async turn(_id: string, prompt: string, options: { schema: unknown }) {
      assertStrictSchema(options.schema);
      prompts.push(prompt);
      return {
        turnId: 'turn',
        text: JSON.stringify({
          ...recipes[Math.min(prompts.length - 1, recipes.length - 1)],
          variables: Object.entries(
            recipes[Math.min(prompts.length - 1, recipes.length - 1)].variables || {},
          ).map(([name, value]) => ({ name, value })),
        }),
      };
    },
  } as unknown as AgentRuntime;
  const projects = {
    get: () => ({ snapshot: () => ({ project: { root }, runs: [] }) }),
  } as unknown as ProjectRegistry;
  const executors = new FixtureExecutors();
  const manager = new ProjectEnvironments(projects, runtime, executors);
  const input = {
    projectId: 'p',
    runId: 'r',
    workspace,
    base: 'base',
    profile,
    signal: new AbortController().signal,
    report: async (check: Check) => {
      reports.push(check);
    },
  };
  return {
    root,
    workspace,
    profile,
    recipe,
    recipes,
    manager,
    input,
    prompts,
    reports,
    executors,
    projects,
  };
}
test('generic preparation needs no package.json, reuses discovery and setup, but always probes readiness', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.manager.prepare(f.input)).passed, true);
  const firstPath = f.executors.get(f.workspace)!.variables.PATH;
  assert.equal((await f.manager.prepare(f.input)).passed, true);
  assert.equal(f.prompts.length, 1);
  assert.equal(await fs.readFile(path.join(f.workspace, 'installs'), 'utf8'), 'setup\n');
  assert.equal(f.reports.filter((c) => c.name.includes('ready')).length, 2);
  assert.equal(f.executors.get(f.workspace)!.variables.PATH, firstPath);
  await f.manager.release(f.workspace);
  const restored = new ProjectEnvironments(
    f.projects,
    {
      start: () => {
        throw Error('Discovery should be cached');
      },
    } as any,
    f.executors,
  );
  assert.equal((await restored.prepare(f.input)).passed, true);
});
test('missing runtime artifact and changed setup inputs both force real preparation despite a cached fingerprint', async (t) => {
  const f = await fixture(t);
  await f.manager.prepare(f.input);
  await fs.unlink(path.join(f.workspace, 'tools/version'));
  assert.equal((await f.manager.prepare(f.input)).passed, true);
  await fs.writeFile(path.join(f.workspace, 'toolchain.txt'), 'v2');
  assert.equal((await f.manager.prepare(f.input)).passed, true);
  assert.equal(
    await fs.readFile(path.join(f.workspace, 'installs'), 'utf8'),
    'setup\nsetup\nsetup\n',
  );
  assert.equal(f.prompts.length, 1);
});
test('failed environment commands return logs to recipe repair and identical failures stop early', async (t) => {
  const f = await fixture(t);
  f.recipes[0] = {
    ...f.recipe,
    setup: [{ ...f.recipe.setup[0], command: 'echo missing-tool >&2; exit 3' }],
  };
  f.recipes.push(f.recipe);
  assert.equal((await f.manager.prepare(f.input)).passed, true);
  assert.match(f.prompts[1], /missing-tool/);
  const second = await fixture(t);
  second.recipes[0] = {
    ...second.recipe,
    setup: [{ ...second.recipe.setup[0], command: 'echo same-failure >&2; exit 4' }],
  };
  const result = await second.manager.prepare(second.input);
  assert.equal(result.passed, false);
  assert.equal(second.prompts.length, 2);
  assert.match(result.output!, /same-failure/);
});
test('readiness configuration and dependency inputs cannot traverse source symlinks', async (t) => {
  const f = await fixture(t);
  await fs.symlink(path.join(f.root, 'outside'), path.join(f.workspace, 'redirect'));
  await fs.writeFile(path.join(f.root, 'outside'), 'outside');
  f.profile.environment = { provider: 'native', recipe: { ...f.recipe, inputs: ['redirect'] } };
  await assert.rejects(f.manager.prepare(f.input), /symlink/);
});
test('native command launch confines writes and shares the exact private tool environment with agent shells', async (t) => {
  const f = await fixture(t),
    executors = new EnvironmentExecutors();
  await executors.register(f.workspace, f.root, { provider: 'native' }, f.input.signal);
  const spec = executors.launch(f.workspace, ['/bin/sh', '-c', 'echo ready']);
  assert.equal(spec.cwd, f.workspace);
  assert.equal(spec.env.HOME, executors.get(f.workspace)!.variables.HOME);
  assert.equal(spec.executable, process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'bwrap');
  assert.ok(
    spec.args.includes(f.workspace) || spec.args.some((value) => value.includes(f.workspace)),
  );
});

test('cancellation interrupts setup and cannot publish a successful environment state', async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  f.profile.environment = {
    provider: 'native',
    recipe: { ...f.recipe, setup: [{ ...f.recipe.setup[0], command: 'sleep 10' }] },
  };
  const pending = f.manager.prepare({ ...f.input, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(
      pending,
      (error) => error instanceof DOMException && error.name === 'AbortError',
    );
  } finally {
    clearTimeout(timer);
  }
  await assert.rejects(fs.access(path.join(f.workspace, '.buro/environment/state.json')));
});

test('Docker provider retains its environment, forwards only explicit agent credentials, and stops on cancellation', async (t) => {
  const f = await fixture(t),
    calls: string[][] = [];
  const execute = async (_file: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'inspect') throw Object.assign(Error('not found'), { code: 1 });
    return { stdout: '', stderr: '' };
  };
  const executors = new EnvironmentExecutors(execute as any, path.join(f.root, 'fixture-auth'));
  await executors.register(
    f.workspace,
    f.root,
    { provider: 'docker', image: 'example/agent:1' },
    f.input.signal,
  );
  const created = calls.find((args) => args[0] === 'run')!;
  assert.ok(created.some((value) => value.includes(`src=${f.root}`) && value.includes('readonly')));
  const spec = executors.launch(f.workspace, ['/bin/sh', '-c', 'sleep 10']);
  assert.equal(spec.executable, 'docker');
  assert.ok(spec.args.includes(f.workspace));
  assert.ok(spec.terminate);
  await spec.terminate!();
  assert.equal(calls.at(-1)![0], 'stop');
  await executors.release(f.workspace);
  assert.equal(executors.get(f.workspace), undefined);
});

test(
  'real native provider permits workspace writes and denies writes to the source checkout',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = await fixture(t),
      executors = new EnvironmentExecutors();
    const { runProjectCommand } = await import('../adapters/checks/project-commands.ts');
    await executors.register(f.workspace, f.root, { provider: 'native' }, f.input.signal);
    const command = {
      id: 'probe',
      title: 'Confinement',
      timeoutMs: 1000,
      command: 'echo inside > allowed; echo outside > ../forbidden',
    };
    const result = await runProjectCommand(
      command,
      f.workspace,
      f.root,
      f.input.signal,
      {},
      executors.launch(f.workspace, ['/bin/sh', '-c', command.command]),
    );
    assert.notEqual(result.exitCode, 0);
    assert.equal(await fs.readFile(path.join(f.workspace, 'allowed'), 'utf8'), 'inside\n');
    await assert.rejects(fs.access(path.join(f.root, 'forbidden')));
  },
);

function assertStrictSchema(schema: unknown) {
  if (!schema || typeof schema !== 'object') return;
  const node = schema as Record<string, any>;
  if (node.type === 'object') {
    assert.equal(node.additionalProperties, false, 'Model output objects must be closed');
    assert.deepEqual(
      [...(node.required || [])].sort(),
      Object.keys(node.properties || {}).sort(),
      'Every model output property must be required',
    );
    assert.equal(
      node.patternProperties,
      undefined,
      'Model output must not contain arbitrary dictionary keys',
    );
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(assertStrictSchema);
    else if (value && typeof value === 'object') assertStrictSchema(value);
  }
}

test('the exact environment schema sent to Codex meets strict structured-output object rules', () => {
  assertStrictSchema(environmentRecipeOutputSchema);
  const schema = environmentRecipeOutputSchema as any;
  assert.ok(schema.required.includes('variables'));
  assert.equal(schema.properties.variables.type, 'array');
});

test('model variables normalize to compatible saved recipes and reject reserved or duplicate names', () => {
  const base = {
    summary: 'Ready',
    inputs: ['Makefile'],
    setup: [],
    ready: [{ id: 'ready', title: 'Ready', command: 'make --version', timeoutMs: 1000 }],
  };
  assert.deepEqual(parseEnvironmentRecipeOutput({ ...base, variables: [] }).variables, {});
  assert.deepEqual(
    parseEnvironmentRecipeOutput({ ...base, variables: [{ name: 'LANG', value: 'C' }] }).variables,
    { LANG: 'C' },
  );
  assert.equal(
    EnvironmentRecipeSchema.safeParse(base).success,
    true,
    'Existing stored recipes may omit variables',
  );
  assert.equal(
    EnvironmentRecipeSchema.safeParse({ ...base, variables: { LANG: 'C' } }).success,
    true,
  );
  assert.throws(
    () =>
      parseEnvironmentRecipeOutput({ ...base, variables: [{ name: 'HOME', value: '/outside' }] }),
    /Reserved/,
  );
  assert.throws(
    () =>
      parseEnvironmentRecipeOutput({
        ...base,
        variables: [
          { name: 'LANG', value: 'C' },
          { name: 'LANG', value: 'en' },
        ],
      }),
    /unique/,
  );
  assert.throws(() => parseEnvironmentRecipeOutput(base));
});

test('a provider output-schema rejection stops after one attempt without running setup', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const runtime = {
    async start() {
      return { threadId: 'schema' };
    },
    async release() {},
    async turn() {
      calls++;
      throw Error('{"code":"invalid_json_schema","message":"Invalid schema for response_format"}');
    },
  } as any;
  const manager = new ProjectEnvironments(f.projects, runtime, f.executors);
  const result = await manager.prepare(f.input);
  assert.equal(result.passed, false);
  assert.equal(calls, 1);
  assert.equal(f.reports.length, 0);
  await assert.rejects(fs.access(path.join(f.workspace, 'installs')));
});
