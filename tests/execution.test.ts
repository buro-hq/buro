import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecutionService } from '../core/execution.ts';
import { resolveTeam, type ExecutionPolicy, type TeamPlan } from '../core/execution-ports.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { GoalService } from '../core/services.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { NodeChecks } from '../adapters/checks/node-checks.ts';
import { CodexRuntime } from '../adapters/codex/runtime.ts';
import type { RuntimeEvent } from '../core/ports.ts';

const policy: ExecutionPolicy = {
  allowedPaths: ['src/'],
  checks: [{ id: 'suite', title: 'Suite' }],
  defaultCheckIds: ['suite'],
  maxWorkers: 2,
  maxRepairs: 1,
  turnTimeoutMs: 1000,
};
const worker = {
  roleId: 'builder',
  action: 'create' as 'create' | 'reuse',
  title: 'Builder',
  description: 'Implements code',
  instructions: 'Implement the assigned change and check it.',
  kind: 'implementation' as const,
  paths: ['src/code.mjs'],
};
const plan: TeamPlan = {
  summary: 'Plan',
  steps: [
    { step: 'Implement', owner: 'builder' },
    { step: 'Review', owner: 'reviewer' },
  ],
  team: [worker],
};
async function fixture(
  t: any,
  options: {
    rejectReview?: number;
    outOfScope?: boolean;
    pause?: boolean;
    noWorkers?: boolean;
    direct?: boolean;
  } = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-execution-')),
    store = await FileProjectStore.open({
      directory,
      project: { id: 'p', name: 'P', root: directory },
    }),
    projects = new FileProjectRegistry([store]);
  let n = 0,
    reviews = 0;
  const turns: { id: string; text: string }[] = [],
    prepared: (string | undefined)[] = [],
    events = new Set<(e: RuntimeEvent) => void>();
  const runtime = {
    id: 'fake',
    async start(_input?: any) {
      return { threadId: 'thread-' + ++n };
    },
    async submit() {
      return { turnId: 't' };
    },
    async interrupt() {},
    async dispose() {},
    async release() {},
    subscribe(fn: (e: RuntimeEvent) => void) {
      events.add(fn);
      return () => events.delete(fn);
    },
    async turn(id: string, text: string, { signal }: any) {
      turns.push({ id, text });
      if (options.pause) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw new DOMException('Aborted', 'AbortError');
      }
      if (text.startsWith('First,'))
        return {
          turnId: 't',
          text: JSON.stringify({
            ...plan,
            ...(options.direct
              ? {
                  steps: [
                    { step: 'Implement', owner: 'coordinator' },
                    { step: 'Review', owner: 'reviewer' },
                  ],
                }
              : {}),
            team: options.direct
              ? []
              : [
                  {
                    ...worker,
                    action: store.snapshot().roles.some((r) => r.id === 'builder')
                      ? 'reuse'
                      : 'create',
                  },
                ],
          }),
        };
      if (text.startsWith('Review goal'))
        return {
          turnId: 't',
          text: JSON.stringify(
            ++reviews <= (options.rejectReview || 0)
              ? { verdict: 'changes_requested', blockingFindings: ['Fix bug'], summary: 'Bug' }
              : { verdict: 'approved', blockingFindings: [], summary: 'OK' },
          ),
        };
      const runId = store.snapshot().runs[0].id;
      if (!options.noWorkers)
        for (const kind of ['started', 'completed'])
          for (const listener of events)
            listener({
              id: 'agent-' + id + '-' + kind,
              runId,
              type: 'agent.activity',
              threadId: 'child-' + id,
              parentThreadId: id,
              completed: kind === 'completed',
              legacyAssignment: { path: '/root/builder' },
            });
      return {
        turnId: 't',
        text: JSON.stringify({
          status: 'success',
          summary: 'Done',
          artifacts: ['src/code.mjs'],
          notesForNextAgent: '',
        }),
      };
    },
  };
  const env = { projects, now: () => new Date().toISOString(), id: () => crypto.randomUUID() },
    engine = new ExecutionService({
      ...env,
      runtime,
      policies: { p: policy },
      workspaces: {
        async prepare(_p, _r, base) {
          prepared.push(base);
          return { path: directory, base: base || 'initial' };
        },
        async changes() {
          return [
            { path: options.outOfScope ? 'README.md' : 'src/code.mjs', before: '', after: 'ok' },
          ];
        },
        async checkpoint() {
          return 'a'.repeat(40);
        },
      },
      checks: {
        async run() {
          return { passed: 1, total: 1, results: [{ name: 'suite', passed: true }] };
        },
      },
    });
  t.after(async () => {
    await engine.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const goals = new GoalService(env);
  async function start(id = 'start') {
    const goal = await goals.create('goal-' + id, id, {
      projectId: 'p',
      title: 'Goal',
      body: 'Implement',
      criteria: 'Works',
    });
    const result = await engine.start(id, id, { projectId: 'p', goalId: goal.id });
    return { ...result, goal };
  }
  async function drain(runId: string) {
    await engine.jobs.get(runId)?.promise;
    return engine.get('p', runId);
  }
  return { engine, store, projects, turns, prepared, start, drain, goals, directory, runtime };
}
test('following goals reuse roles but begin independently unless a parent run is selected', async (t) => {
  const f = await fixture(t),
    first = await f.start();
  const result = await f.drain(first.runId);
  assert.equal(result.status, 'completed');
  assert.equal(result.roleOrigins?.builder, 'created');
  assert.equal(f.store.snapshot().roles.find((r) => r.id === 'builder')?.version, 1);
  assert.deepEqual(
    await f.engine.start('start', 'start', { projectId: 'p', goalId: first.goal.id }),
    { runId: first.runId },
  );
  assert.equal(f.store.snapshot().runs.length, 1);
  const second = await f.start('second'),
    next = await f.drain(second.runId);
  assert.equal(next.roleOrigins?.builder, 'reused');
  assert.equal(f.store.doc.roleVersions.filter((r) => r.id === 'builder').length, 1);
  assert.deepEqual(f.prepared, [undefined, undefined]);
  const child = await f.goals.create('child', 'child', {
    projectId: 'p',
    title: 'Child',
    body: 'Continue',
    criteria: '',
    parentRunId: first.runId,
  });
  const childRun = await f.engine.start('child-start', 'child-start', {
    projectId: 'p',
    goalId: child.id,
  });
  await f.drain(childRun.runId);
  assert.deepEqual(f.prepared, [undefined, undefined, 'a'.repeat(40)]);
  assert.ok(
    result.review?.verdict === 'approved' && result.acceptance.total === 1 && result.commit,
  );
  assert.equal(result.roleSnapshots?.find((r) => r.id === 'builder')?.version, 1);
  assert.deepEqual(result.agents.find((a) => a.name === 'builder')?.assignment?.paths, [
    'src/code.mjs',
  ]);
});
test('each run freezes its execution policy and passes project context to coordinator and reviewer', async (t) => {
  const f = await fixture(t),
    instructions: string[] = [];
  f.engine.env.policies.p = { ...policy, context: 'Original project context' };
  const original = f.runtime.start;
  f.runtime.start = async (input?: any) => {
    instructions.push(input.instructions);
    return original(input);
  };
  const first = await f.start();
  f.engine.env.policies.p = { ...policy, allowedPaths: ['elsewhere/'], context: 'Changed context' };
  const run = await f.drain(first.runId);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.executionPolicySnapshot?.allowedPaths, ['src/']);
  assert.equal(run.executionPolicySnapshot?.context, 'Original project context');
  assert.equal(instructions.length, 2);
  assert.ok(
    instructions.every(
      (text) => text.includes('Original project context') && !text.includes('Changed context'),
    ),
  );
});
test('blocking reviewer sends repair to the same coordinator session, then rechecks', async (t) => {
  const f = await fixture(t, { rejectReview: 1 }),
    first = await f.start(),
    run = await f.drain(first.runId);
  assert.equal(run.status, 'completed');
  const work = f.turns.find((t) => t.text.startsWith('Plan accepted'))!,
    repair = f.turns.find((t) => t.text.startsWith('Repair the result'))!;
  assert.equal(work.id, repair.id);
  assert.ok(run.events.some((e) => e.type === 'phase.repair'));
  assert.equal(run.agents.filter((a) => a.name === 'reviewer').length, 2);
});
test('unapproved or out-of-scope work is never accepted and does not save roles', async (t) => {
  for (const options of [{ rejectReview: 99 }, { outOfScope: true }, { noWorkers: true }]) {
    const f = await fixture(t, options),
      first = await f.start(),
      run = await f.drain(first.runId);
    assert.equal(run.status, 'failed');
    assert.equal(run.commit, undefined);
    assert.equal(
      f.store.snapshot().roles.some((r) => r.id === 'builder'),
      false,
    );
    assert.equal(f.store.snapshot().goals[0].status, 'failed');
  }
});
test('cancel is durable, blocks conflicting starts and interrupts the active phase', async (t) => {
  const f = await fixture(t, { pause: true }),
    first = await f.start();
  await assert.rejects(
    f.engine.start('other', 'other', { projectId: 'p', goalId: first.goal.id }),
    { code: 'PROJECT_BUSY' },
  );
  await assert.rejects(f.goals.delete('delete', 'delete', { projectId: 'p', id: first.goal.id }), {
    code: 'GOAL_RUNNING',
  });
  // Wait for the fake runtime to enter its cancellable phase.
  while (!f.turns.length) await new Promise((r) => setTimeout(r, 5));
  await f.engine.cancel('cancel', 'cancel', { projectId: 'p', runId: first.runId });
  const run = await f.drain(first.runId);
  assert.equal(run.status, 'interrupted');
  assert.equal(run.cancelRequested, true);
  assert.equal(run.commit, undefined);
});
test('restart marks in-flight work interrupted without replaying side effects', async (t) => {
  const f = await fixture(t, { pause: true }),
    first = await f.start();
  while (!f.turns.length) await new Promise((r) => setTimeout(r, 5));
  await f.engine.dispose();
  await f.store.transact('crash', 'crash', (doc) => {
    const run = doc.runs[0];
    run.status = 'running';
    return { result: null, change: { type: 'run.changed', run, goal: doc.goals[0] } };
  });
  const calls = f.turns.length;
  await f.engine.recover();
  assert.equal(f.engine.get('p', first.runId).status, 'interrupted');
  assert.equal(f.turns.length, calls);
});
test('team validation rejects overlapping ownership, missing reuse and escaping paths', () => {
  assert.throws(
    () =>
      resolveTeam(
        { ...plan, team: [worker, { ...worker, roleId: 'tester', paths: ['src/'] }] },
        [],
        policy,
        '',
      ),
    /overlapping/,
  );
  assert.throws(
    () => resolveTeam({ ...plan, team: [{ ...worker, action: 'reuse' }] }, [], policy, ''),
    /not in the catalog/,
  );
  assert.throws(
    () =>
      resolveTeam({ ...plan, team: [{ ...worker, paths: ['src/../README.md'] }] }, [], policy, ''),
    /allowed scope/,
  );
});
test('native JSONL completed-turn contract captures final structured answer and sandbox', async (t) => {
  const f = await fixture(t),
    runtime = new CodexRuntime({
      projects: f.projects,
      executable: process.execPath,
      args: [path.resolve('tests/fixtures/fake-codex.mjs')],
    });
  t.after(() => runtime.dispose());
  const observed: RuntimeEvent[] = [];
  runtime.subscribe((event) => observed.push(event));
  for (const readOnly of [false, true]) {
    const { threadId } = await runtime.start({ projectId: 'p', instructions: 'fixture', readOnly });
    const answer = await runtime.turn(threadId, 'test', {
      schema: { type: 'object' },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    assert.equal(JSON.parse(answer.text).sandbox, readOnly ? 'readOnly' : 'workspaceWrite');
    await runtime.release(threadId);
  }
  assert.ok(observed.some((event) => event.type === 'turn.started'));
  assert.ok(observed.some((event) => event.type === 'message.completed'));
  assert.ok(observed.some((event) => event.type === 'turn.completed'));
  assert.ok(observed.every((event) => !('method' in event) && !('params' in event)));
});

test('runtime events persist once, and failed persistence permits redelivery', async (t) => {
  const f = await fixture(t, { pause: true });
  const started = await f.start();
  while (!f.turns.length) await new Promise((resolve) => setTimeout(resolve, 5));
  const event: RuntimeEvent = {
    id: 'command-result',
    runId: started.runId,
    threadId: 'thread-1',
    type: 'command.completed',
    commandId: 'cmd',
    command: 'check',
    exitCode: 1,
    output: 'failure',
  };
  const persist = f.store.persist.bind(f.store);
  let fail = true;
  f.store.persist = async (doc) => {
    if (fail) {
      fail = false;
      throw Error('disk unavailable');
    }
    return persist(doc);
  };
  await assert.rejects(f.engine.observe(event), /disk unavailable/);
  assert.equal(f.engine.get('p', started.runId).commands.length, 0);
  await f.engine.observe(event);
  const revision = f.store.snapshot().revision;
  await f.engine.observe(event);
  const run = f.engine.get('p', started.runId);
  assert.equal(f.store.snapshot().revision, revision);
  assert.equal(run.commands.length, 1);
  assert.equal(run.commands[0].output, 'failure');
  assert.equal(run.events.filter((event) => event.type === 'command.started').length, 1);
  assert.equal(run.events.filter((event) => event.type === 'command.completed').length, 1);
});
test('Git checkpoints preserve original branch and next worktree begins at accepted commit', async (t) => {
  const f = await fixture(t),
    git = promisify(execFile),
    cwd = f.directory;
  const g = (args: string[]) => git('git', args, { cwd });
  await g(['init', '-b', 'master']);
  await g(['config', 'user.email', 'test@example.invalid']);
  await g(['config', 'user.name', 'Test']);
  await fs.mkdir(path.join(cwd, 'src'));
  await fs.writeFile(path.join(cwd, 'src/code.mjs'), 'old');
  await g(['add', 'src']);
  await g(['commit', '-m', 'initial']);
  const initial = (await g(['rev-parse', 'HEAD'])).stdout.trim(),
    adapter = new GitWorkspaces(f.projects),
    one = await adapter.prepare('p', 'run-one');
  await fs.writeFile(path.join(one.path, 'src/code.mjs'), 'new');
  assert.equal((await adapter.changes(one.path, one.base))[0].path, 'src/code.mjs');
  const commit = await adapter.checkpoint(one.path, 'run-one');
  assert.notEqual(commit, initial);
  assert.equal((await g(['rev-parse', 'HEAD'])).stdout.trim(), initial);
  assert.equal(await fs.readFile(path.join(cwd, 'src/code.mjs'), 'utf8'), 'old');
  const two = await adapter.prepare('p', 'run-two', commit);
  assert.equal(await fs.readFile(path.join(two.path, 'src/code.mjs'), 'utf8'), 'new');
  await fs.writeFile(path.join(two.path, '.git'), 'tampered');
  await assert.rejects(adapter.changes(two.path, two.base), /control data/);
});
test('CLI discovers servers under the same disabled-plugin config and verifies every MCP is off', async (t) => {
  const f = await fixture(t),
    executable = path.resolve('tests/fixtures/configured-codex.mjs');
  await fs.chmod(executable, 0o755);
  const probe = path.join(f.directory, 'discovery-cwd.txt'),
    workspace = path.join(f.directory, 'worktree');
  await fs.mkdir(workspace);
  const previous = process.env.PROJECT_CLI_PROBE_OUTPUT;
  process.env.PROJECT_CLI_PROBE_OUTPUT = probe;
  t.after(() => {
    if (previous === undefined) delete process.env.PROJECT_CLI_PROBE_OUTPUT;
    else process.env.PROJECT_CLI_PROBE_OUTPUT = previous;
  });
  const runtime = new CodexRuntime({ projects: f.projects, executable });
  t.after(() => runtime.dispose());
  const started = await runtime.start({ projectId: 'p', workspace, instructions: 'fixture' });
  assert.equal(started.threadId, 'fixture-thread');
  assert.deepEqual((await fs.readFile(probe, 'utf8')).trim().split('\n'), [
    await fs.realpath(workspace),
    await fs.realpath(workspace),
  ]);
});
test('trusted Node checks run outside the editable area and reject filesystem writes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trusted-check-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'work');
  await fs.mkdir(workspace);
  const script = path.join(directory, 'check.mjs');
  await fs.writeFile(
    script,
    `import fs from 'node:fs';fs.writeFileSync('oops','bad');console.log(JSON.stringify({results:[{name:'should not happen',passed:true}]}));`,
  );
  const adapter = new NodeChecks({ p: [{ id: 'suite', title: 'Suite', script }] });
  const result = await adapter.run('p', workspace, ['suite'], new AbortController().signal);
  assert.equal(result.passed, 0);
  await assert.rejects(fs.access(path.join(workspace, 'oops')));
});

test('hyphenated worker ids validate, while missing ids receive actionable diagnostics', () => {
  const plan = {
    summary: 'Plan',
    steps: [
      { step: 'Build', owner: 'react-developer' },
      { step: 'Review', owner: 'reviewer' },
    ],
    team: [{ ...worker, roleId: 'react-developer' }],
  };
  assert.equal(resolveTeam(plan, [], policy, '').roles[0].id, 'react-developer');
  assert.throws(
    () => resolveTeam({ ...plan, team: [{ ...worker, roleId: '' }] }, [], policy, ''),
    /roleId.*react_developer/,
  );
});

test('runtime allows ongoing child progress beyond a wall deadline but interrupts a stalled turn', async (t) => {
  const f = await fixture(t),
    runtime = new CodexRuntime({
      projects: f.projects,
      executable: process.execPath,
      args: [path.resolve('tests/fixtures/fake-codex.mjs')],
    });
  t.after(() => runtime.dispose());
  const { threadId } = await runtime.start({ projectId: 'p', instructions: 'Fixture' });
  const result = await runtime.turn(threadId, 'long-active', {
    schema: { type: 'object' },
    signal: new AbortController().signal,
    timeoutMs: 300,
  });
  assert.equal(result.text, 'done');
  await assert.rejects(
    runtime.turn(threadId, 'idle', {
      schema: { type: 'object' },
      signal: new AbortController().signal,
      timeoutMs: 80,
    }),
    /No coordinator or agent progress/,
  );
});

test('run freezes selected context and passes staged paths to planning, workers and independent review', async (t) => {
  const f = await fixture(t),
    { ContextMaterials } = await import('../adapters/files/context-materials.ts'),
    library = new ContextMaterials(f.projects);
  t.after(() => library.dispose());
  const [material] = await library.import('context', 'context', {
    projectId: 'p',
    scope: 'project',
    upload: {
      name: 'requirements.md',
      base64: Buffer.from('Requirements for this goal').toString('base64'),
    },
  });
  const instructions: string[] = [];
  const original = f.runtime.start;
  f.runtime.start = async (input?: any) => {
    instructions.push(input.instructions);
    return original(input);
  };
  const preparedMaterials: any[] = [];
  const prepare = f.engine.env.workspaces.prepare;
  f.engine.env.workspaces.prepare = async (...args) => {
    preparedMaterials.push(args[3]?.materials);
    return prepare(...args);
  };
  const first = await f.start();
  await library.remove('remove-context', 'remove-context', {
    projectId: 'p',
    materialId: material.id,
  });
  const run = await f.drain(first.runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.contextMaterials?.[0].id, material.id);
  assert.equal(run.contextMaterials?.[0].active, true);
  assert.equal(preparedMaterials[0][0].id, material.id);
  assert.equal(instructions.length, 2);
  assert.ok(
    instructions.every(
      (text) =>
        text.includes('requirements.md') &&
        text.includes('/.buro/context/') &&
        !text.includes('/local/context/'),
    ),
  );
  assert.ok(
    f.turns.find((turn) => turn.text.startsWith('Plan accepted'))?.text.includes('user material'),
  );
});

test('a coherent task can finish directly while still requiring independent checks and a fresh reviewer', async (t) => {
  const f = await fixture(t, { direct: true, noWorkers: true });
  const started = await f.start();
  const result = await f.drain(started.runId);
  assert.equal(result.status, 'completed', result.result);
  assert.equal(result.independentReviewer, true);
  assert.equal(result.agents.filter((agent) => agent.name !== 'reviewer').length, 0);
  assert.equal(result.acceptance.passed, 1);
});

test('environment failure preserves the workspace and stops before planning or source repair', async (t) => {
  const f = await fixture(t);
  f.engine.env.policies.p = {
    ...policy,
    profile: {
      version: 1,
      revision: 1,
      context: '',
      allowedPaths: ['src/'],
      protectedPaths: [],
      setup: [],
      dependencies: 'none',
      checks: [{ id: 'suite', title: 'Suite', command: 'make test', timeoutMs: 1000 }],
      defaultCheckIds: ['suite'],
      maxWorkers: 2,
      maxRepairs: 1,
      turnTimeoutMs: 10000,
    },
  };
  let releases = 0;
  f.engine.env.environments = {
    async prepare() {
      return {
        name: 'Project environment',
        passed: false,
        error: 'Required toolchain is unavailable',
      };
    },
    async release() {
      releases++;
    },
  };
  const started = await f.start(),
    result = await f.drain(started.runId);
  assert.equal(result.status, 'needs-attention');
  assert.equal(result.workspace, f.directory);
  assert.equal(f.turns.length, 0);
  assert.equal(releases, 1);
  assert.match(result.result, /toolchain/);
});
