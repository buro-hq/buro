import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { GoalService, RoleService, canAccept } from '../core/services.ts';
import { evaluateAcceptance, type PhaseReceipt } from '../core/workflow.ts';
import { createHost, goalsPlugin } from '../plugins/host.ts';
import { codexPlugin } from '../plugins/codex.ts';

async function fixture(t: any, extra: Record<string, unknown> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-core-'));
  const options = {
    directory,
    project: { id: 'sample', name: 'Sample', root: directory },
    ...extra,
  };
  const store = await FileProjectStore.open(options);
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const registry = new ProjectStoreRegistry([store]);
  const env = {
    projects: registry,
    now: () => new Date().toISOString(),
    id: () => crypto.randomUUID(),
  };
  return { store, options, goals: new GoalService(env), roles: new RoleService(env) };
}
const goal = { projectId: 'sample', title: 'Goal', body: 'Verify atomic writes', criteria: '' };
const role = {
  projectId: 'sample',
  id: 'browser_debugger',
  title: 'UI verifier',
  description: 'Verifies user scenarios',
  instructions: 'Reproduce the issue and return evidence.',
  kind: 'testing' as const,
  expectedVersion: 0,
};

test('concurrent writes are serialized; state, receipts and events survive reopening', async (t) => {
  const f = await fixture(t);
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      f.goals.create('r-' + i, 'fp-' + i, { ...goal, title: 'Goal ' + i }),
    ),
  );
  const before = f.store.snapshot();
  assert.equal(before.goals.length, 15);
  assert.equal(before.sequence, 15);
  assert.equal(before.revision, 15);
  await f.store.close();
  const restored = await FileProjectStore.open(f.options);
  t.after(() => restored.close());
  assert.deepEqual(restored.snapshot(), before);
  const replay: number[] = [];
  restored.subscribe(10, (e) => replay.push(e.seq));
  assert.deepEqual(replay, [11, 12, 13, 14, 15]);
});
test('retrying a committed request is idempotent, conflicting reuse is rejected', async (t) => {
  const f = await fixture(t);
  let events = 0;
  f.store.subscribe(0, () => events++);
  const first = await f.goals.create('retry', 'same', goal);
  const second = await f.goals.create('retry', 'same', goal);
  assert.deepEqual(second, first);
  assert.equal(events, 1);
  assert.equal(f.store.snapshot().goals.length, 1);
  await assert.rejects(f.goals.create('retry', 'different', goal), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await f.store.close();
  const restored = await FileProjectStore.open(f.options);
  t.after(() => restored.close());
  const service = new GoalService({
    projects: new ProjectStoreRegistry([restored]),
    now: () => '',
    id: () => '',
  });
  assert.deepEqual(await service.create('retry', 'same', goal), first);
  assert.equal(restored.snapshot().sequence, 1);
});
test('failed file replacement publishes nothing and leaves persisted state unchanged', async (t) => {
  let fail = false;
  const f = await fixture(t, {
    replace: async (a: string, b: string) => {
      if (fail) throw Error('Injected rename failure');
      await fs.rename(a, b);
    },
  });
  let events = 0;
  f.store.subscribe(0, () => events++);
  const before = await fs.readFile(path.join(f.options.directory, 'control-state.json'), 'utf8');
  fail = true;
  await assert.rejects(f.goals.create('failed', 'fp', goal), /rename failure/);
  assert.equal(f.store.snapshot().goals.length, 0);
  assert.equal(events, 0);
  assert.equal(
    await fs.readFile(path.join(f.options.directory, 'control-state.json'), 'utf8'),
    before,
  );
  fail = false;
  await f.goals.create('failed', 'fp', goal);
  assert.equal(events, 1);
  assert.equal(f.store.snapshot().goals.length, 1);
});
test('role versions use optimistic concurrency and persist complete history', async (t) => {
  const f = await fixture(t);
  const first = await f.roles.save('role-1', 'f1', role);
  assert.equal(first.version, 1);
  const second = await f.roles.save('role-2', 'f2', {
    ...role,
    title: 'New title',
    expectedVersion: 1,
  });
  assert.equal(second.version, 2);
  await assert.rejects(f.roles.save('stale', 'f3', { ...role, expectedVersion: 1 }), {
    code: 'CONFLICT',
  });
  const stored = JSON.parse(
    await fs.readFile(path.join(f.options.directory, 'control-state.json'), 'utf8'),
  );
  assert.deepEqual(
    stored.roleVersions.filter((r: any) => r.id === role.id).map((r: any) => r.version),
    [1, 2],
  );
  const snapshot = f.store.snapshot();
  snapshot.roles[0].title = 'Mutation';
  assert.notEqual(f.store.snapshot().roles[0].title, 'Mutation');
});
test('one writer per project; a failing observer cannot invalidate a commit', async (t) => {
  const f = await fixture(t);
  await assert.rejects(FileProjectStore.open(f.options), { code: 'PROJECT_LOCKED' });
  f.store.subscribe(0, () => {
    throw Error('broken observer');
  });
  await f.goals.create('observer', 'fp', goal);
  assert.equal(f.store.snapshot().sequence, 1);
});
test('plugin disposal withdraws handlers and leaves independent services working', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-plugins-'));
  const host = await createHost({
    projects: [
      { storageAddress: directory, project: { id: 'sample', name: 'Sample', root: directory } },
    ],
  });
  t.after(async () => {
    await host.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const runtime = host.ctx.registry.get(goalsPlugin)!;
  await [...runtime.fibers][0].dispose();
  assert.throws(
    () =>
      host.ctx.commands.bus.execute(
        { method: 'goal.create', params: goal },
        { id: '1', fingerprint: 'fp' },
      ),
    { code: 'UNAVAILABLE' },
  );
  assert.equal(
    (
      (await host.ctx.commands.bus.execute(
        { method: 'project.list', params: {} },
        { id: '2', fingerprint: 'fp' },
      )) as any[]
    ).length,
    1,
  );
  await host.ctx.plugin(goalsPlugin);
  await host.ctx.commands.bus.execute(
    { method: 'goal.create', params: goal },
    { id: '3', fingerprint: 'fp' },
  );
  assert.equal(host.ctx.projects.registry.get('sample').snapshot().goals.length, 1);
});
test('completion and reviewer participation are insufficient for acceptance', () => {
  const base = { testsPassed: true, scopePreserved: true, specsUnchanged: true };
  assert.equal(canAccept(base), false);
  assert.equal(
    canAccept({ ...base, review: { verdict: 'changes_requested', blockingFindings: 1 } }),
    false,
  );
  assert.equal(canAccept({ ...base, review: { verdict: 'approved', blockingFindings: 1 } }), false);
  assert.equal(canAccept({ ...base, review: { verdict: 'approved', blockingFindings: 0 } }), true);
  const phase: PhaseReceipt = {
    id: 'build',
    kind: 'agent',
    status: 'completed',
    envelope: { status: 'success', summary: 'Done', artifacts: [] },
    gates: [{ id: 'tests', checks: [{ item: 'suite', passed: false, evidence: 'exit 1' }] }],
  };
  const result = evaluateAcceptance({
    phases: [phase],
    review: { verdict: 'approved', blockingFindings: [] },
    scopePreserved: true,
    specsUnchanged: true,
  });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.some((r) => r.includes('exit 1')));
  phase.gates[0].checks[0].passed = true;
  assert.equal(
    evaluateAcceptance({
      phases: [phase],
      review: { verdict: 'approved', blockingFindings: [] },
      scopePreserved: true,
      specsUnchanged: true,
    }).accepted,
    true,
  );
});
test('Codex runtime is a replaceable plugin; same session supports follow-up turns', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-runtime-'));
  const host = await createHost({
    projects: [
      { storageAddress: directory, project: { id: 'sample', name: 'Sample', root: directory } },
    ],
  });
  t.after(async () => {
    await host.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await host.ctx.plugin(codexPlugin, {
    id: 'codex',
    executable: process.execPath,
    args: [path.resolve('tests/fixtures/fake-codex.mjs')],
  });
  const { threadId } = await host.ctx.agentRuntime.adapter.start({
    projectId: 'sample',
    instructions: 'Only fixture work.',
  });
  const first = await host.ctx.agentRuntime.adapter.submit(threadId, 'Initial task');
  const second = await host.ctx.agentRuntime.adapter.submit(threadId, 'Fix the failed gate');
  assert.equal(threadId, 'fixture-thread');
  assert.notEqual(first.turnId, second.turnId);
  await host.ctx.agentRuntime.adapter.interrupt(threadId, second.turnId);
  await host.ctx.agentRuntime.adapter.dispose();
  await assert.rejects(
    host.ctx.agentRuntime.adapter.start({ projectId: 'sample', instructions: 'x' }),
    { code: 'RUNTIME_CLOSED' },
  );
});

test('stale-lock recovery has one winner under concurrent process startup', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-lock-race-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve) => child.once('exit', resolve));
  await fs.writeFile(
    path.join(directory, 'writer.lock'),
    JSON.stringify({ pid: child.pid, nonce: 'old' }),
  );
  const acquire = () =>
    new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, [
        path.resolve('tests/fixtures/acquire-store.mjs'),
        directory,
      ]);
      let out = '';
      p.stdout.on('data', (b) => (out += b));
      p.once('error', reject);
      p.once('exit', () => resolve(out.trim()));
    });
  const results = await Promise.all([acquire(), acquire()]);
  assert.equal(results.filter((r) => r === 'acquired').length, 1);
  assert.ok(results.includes('PROJECT_LOCKED'));
});
