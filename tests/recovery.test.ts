import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { CodexRuntime } from '../adapters/codex/runtime.ts';
import type { RuntimeEvent } from '../core/ports.ts';
import { unchangedDependencyFailures } from '../core/check-failures.ts';
const exec = promisify(execFile);
async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'recover-run-'))),
    git = (args: string[]) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'master']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/code.mjs'), 'export const value=1;');
  await fs.writeFile(path.join(root, '.gitignore'), '.buro/\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  const store = await FileProjectStore.open({
      directory: path.join(root, '.buro'),
      project: { id: 'p', name: 'P', root },
    }),
    projects = new FileProjectRegistry([store]),
    workspaces = new GitWorkspaces(projects),
    listeners = new Set<(event: RuntimeEvent) => void>(),
    threads = new Map<string, any>(),
    turns: { id: string; text: string }[] = [],
    resumed: string[] = [];
  let count = 0;
  const options = { rejectReview: false, environmentFailure: false, invalidPlan: false };
  const runtime = {
    id: 'fixture',
    async start(input: any) {
      const threadId = 't-' + ++count;
      threads.set(threadId, input);
      return { threadId };
    },
    async resume(input: any) {
      resumed.push(input.threadId);
      threads.set(input.threadId, input);
      return { threadId: input.threadId };
    },
    async submit() {
      return { turnId: 't' };
    },
    async interrupt() {},
    async release() {},
    async dispose() {},
    subscribe(fn: (event: RuntimeEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async turn(id: string, text: string) {
      turns.push({ id, text });
      const input = threads.get(id);
      if (text.startsWith('First,'))
        return {
          turnId: 'p',
          text: JSON.stringify({
            summary: 'Plan',
            steps: [
              { step: 'Implement', owner: 'builder' },
              { step: 'Review', owner: 'reviewer' },
            ],
            team: [
              {
                roleId: options.invalidPlan ? '' : 'builder',
                action: 'create',
                title: 'Builder',
                description: 'Implements modules',
                instructions: 'Implement assigned modules.',
                kind: 'implementation',
                paths: ['src/code.mjs'],
              },
            ],
          }),
        };
      if (input.readOnly)
        return {
          turnId: 'r',
          text: JSON.stringify(
            options.rejectReview
              ? { verdict: 'changes_requested', blockingFindings: ['Fix'], summary: 'Fix' }
              : { verdict: 'approved', blockingFindings: [], summary: 'OK' },
          ),
        };
      await fs.writeFile(path.join(input.workspace, 'src/code.mjs'), 'export const value=2;');
      return {
        turnId: 'work',
        text: JSON.stringify({
          status: 'success',
          summary: 'Done',
          artifacts: ['src/code.mjs'],
          notesForNextAgent: '',
        }),
      };
    },
  };
  const checks = {
    async run() {
      const results = [
        { name: 'Tests', command: 'test', passed: true },
        ...(options.environmentFailure
          ? [
              {
                name: 'Types',
                command: 'typecheck',
                passed: false,
                exitCode: 2,
                output:
                  'node_modules/pkg/index.d.ts(1,1): error TS2307: Cannot find module dependency.',
              },
            ]
          : []),
      ];
      return { passed: results.filter((c) => c.passed).length, total: results.length, results };
    },
  };
  const env = { projects, now: () => new Date().toISOString(), id: () => crypto.randomUUID() },
    goals = new GoalService(env),
    engine = new ExecutionService({
      ...env,
      runtime,
      workspaces,
      checks,
      policies: {
        p: {
          allowedPaths: ['src/'],
          checks: [{ id: 'suite', title: 'Suite' }],
          defaultCheckIds: ['suite'],
          maxWorkers: 1,
          maxRepairs: 1,
          turnTimeoutMs: 1000,
        },
      },
    });
  t.after(async () => {
    await engine.dispose();
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const goal = await goals.create('goal', 'goal', {
    projectId: 'p',
    title: 'Goal',
    body: 'Implement',
    criteria: 'Works',
  });
  async function start() {
    const result = await engine.start('start', 'start', { projectId: 'p', goalId: goal.id });
    await engine.jobs.get(result.runId)?.promise;
    return engine.get('p', result.runId);
  }
  async function resume(runId: string, mode: 'repair' | 'recheck' = 'recheck') {
    const result = await engine.resume('resume', 'resume', {
      projectId: 'p',
      runId,
      mode,
      instructions: 'Continue the existing change',
      useCurrentProfile: false,
    });
    await engine.jobs.get(result.runId)?.promise;
    return engine.get('p', result.runId);
  }
  return {
    root,
    git,
    store,
    projects,
    workspaces,
    engine,
    goals,
    goal,
    runtime,
    turns,
    resumed,
    options,
    start,
    resume,
  };
}
test('recheck retains run/worktree/history, reruns gates, and accepts without replanning or rewriting files', async (t) => {
  const f = await fixture(t);
  f.options.rejectReview = true;
  const before = await f.start();
  assert.equal(before.status, 'failed');
  const body = await fs.readFile(path.join(before.workspace!, 'src/code.mjs'), 'utf8'),
    turns = f.turns.length;
  f.options.rejectReview = false;
  const after = await f.resume(before.id);
  assert.equal(after.id, before.id);
  assert.equal(after.workspace, before.workspace);
  assert.equal(after.status, 'completed');
  assert.ok(after.commit);
  assert.equal(after.attempts?.length, 1);
  assert.equal(after.events.filter((e) => e.type === 'plan.saved').length, 1);
  assert.equal(await fs.readFile(path.join(after.workspace!, 'src/code.mjs'), 'utf8'), body);
  assert.equal(f.resumed.length, 0);
  assert.equal(f.turns.length, turns + 1);
  assert.equal(
    await fs.readFile(path.join(f.root, 'src/code.mjs'), 'utf8'),
    'export const value=1;',
  );
  assert.equal(f.store.snapshot().roles.filter((r) => r.id === 'builder').length, 1);
  assert.deepEqual(
    await f.engine.resume('resume', 'resume', {
      projectId: 'p',
      runId: before.id,
      mode: 'recheck',
      instructions: 'Continue the existing change',
      useCurrentProfile: false,
    }),
    { runId: before.id },
  );
});
test('editing a stopped goal is versioned; repair resumes the original coordinator with revised requirements', async (t) => {
  const f = await fixture(t);
  f.options.rejectReview = true;
  const before = await f.start();
  const edited = await f.goals.update('edit', 'edit', {
    projectId: 'p',
    id: f.goal.id,
    expectedRevision: 1,
    title: 'Updated goal',
    body: 'Revised behavior',
    criteria: 'Updated criteria',
  });
  assert.equal(edited.revision, 2);
  await assert.rejects(
    f.goals.update('stale', 'stale', {
      projectId: 'p',
      id: f.goal.id,
      expectedRevision: 1,
      title: 'Old',
      body: 'Old',
      criteria: '',
    }),
    { code: 'CONFLICT' },
  );
  f.options.rejectReview = false;
  const after = await f.resume(before.id, 'repair');
  assert.equal(after.status, 'completed');
  assert.deepEqual(f.resumed, [before.threadId]);
  assert.equal(after.threadId, before.threadId);
  assert.equal(after.title, 'Updated goal');
  assert.ok(
    f.turns.some((turn) => turn.id === before.threadId && turn.text.includes('Revised behavior')),
  );
  assert.equal(after.attempts?.[0].goalText, before.goalText);
});
test('unchanged dependency declaration failures stop at needs-attention without repeated reviewer/repair model calls', async (t) => {
  const f = await fixture(t);
  f.options.environmentFailure = true;
  const before = await f.start();
  assert.equal(before.status, 'needs-attention', before.result);
  assert.equal(before.issue?.code, 'BASELINE_CHECKS_FAILED');
  assert.equal(f.turns.length, 3);
  assert.equal(
    before.events.some((e) => e.type === 'phase.repair'),
    false,
  );
  const after = await f.resume(before.id);
  assert.equal(after.status, 'needs-attention');
  assert.equal(f.turns.length, 3);
  assert.equal(after.attempts?.length, 1);
});
test('workspace restoration validates project identity/base and reconstructs its diff after adapter restart', async (t) => {
  const f = await fixture(t);
  f.options.rejectReview = true;
  const before = await f.start(),
    restored = new GitWorkspaces(f.projects);
  await restored.restore('p', before.id, before.workspace!, before.baseCommit!);
  assert.equal(
    (await restored.changes(before.workspace!, before.baseCommit!))[0].path,
    'src/code.mjs',
  );
  await assert.rejects(restored.restore('p', 'another-id', before.workspace!, before.baseCommit!), {
    code: 'INVALID_WORKSPACE',
  });
  await assert.rejects(restored.restore('p', before.id, before.workspace!, '0'.repeat(40)), {
    code: 'WORKSPACE_CHANGED',
  });
});
test('environment classification never hides new or application-source type errors', () => {
  const baseline = [
    {
      name: 'Types',
      passed: false,
      command: 'tsc',
      output: 'node_modules/a.d.ts(1,1): error TS2307: Missing type.',
    },
  ];
  assert.deepEqual(unchangedDependencyFailures(baseline, baseline), ['Types']);
  assert.deepEqual(
    unchangedDependencyFailures(baseline, [
      { ...baseline[0], output: baseline[0].output + '\napp/a.ts(2,1): error TS2322: Regression.' },
    ]),
    [],
  );
  assert.deepEqual(
    unchangedDependencyFailures(baseline, [
      { ...baseline[0], output: 'node_modules/a.d.ts(2,1): error TS2307: Different failure.' },
    ]),
    [],
  );
});
test('native adapter restores the saved thread id through thread/resume', async (t) => {
  const f = await fixture(t),
    runtime = new CodexRuntime({
      projects: f.projects,
      executable: process.execPath,
      args: [path.resolve('tests/fixtures/fake-codex.mjs')],
    });
  t.after(() => runtime.dispose());
  const original = await runtime.start({ projectId: 'p', instructions: 'Fixture' });
  await runtime.release(original.threadId);
  const restored = await runtime.resume({
    projectId: 'p',
    runId: 'r',
    threadId: original.threadId,
    workspace: f.root,
    instructions: 'Continue',
  });
  assert.equal(restored.threadId, original.threadId);
  const result = await runtime.turn(restored.threadId, 'Continue', {
    schema: { type: 'object' },
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  assert.ok(result.text.includes('workspaceWrite'));
});

test('failed planning resumes the same workspace and coordinator, then saves a valid team', async (t) => {
  const f = await fixture(t);
  f.options.invalidPlan = true;
  const before = await f.start();
  assert.equal(before.status, 'failed');
  assert.equal(before.plan.length, 0);
  assert.ok(before.result.includes('roleId'));
  assert.equal(before.events.filter((e) => e.type === 'plan.rejected').length, 2);
  await assert.rejects(
    f.engine.resume('invalid-recheck', 'invalid-recheck', {
      projectId: 'p',
      runId: before.id,
      mode: 'recheck',
      instructions: '',
      useCurrentProfile: false,
    }),
    { code: 'REPLAN_REQUIRED' },
  );
  assert.equal(f.engine.get('p', before.id).status, 'failed');
  f.options.invalidPlan = false;
  const after = await f.resume(before.id, 'repair');
  assert.equal(after.status, 'completed', after.result);
  assert.equal(after.id, before.id);
  assert.equal(after.workspace, before.workspace);
  assert.equal(after.threadId, before.threadId);
  assert.deepEqual(f.resumed, [before.threadId]);
  assert.equal(after.events.filter((e) => e.type === 'plan.saved').length, 1);
});

test('repair picks up new goal attachments and retains the previous attempt material snapshot', async (t) => {
  const f = await fixture(t),
    { ContextMaterials } = await import('../adapters/files/context-materials.ts'),
    library = new ContextMaterials(f.projects);
  t.after(() => library.dispose());
  const [shared] = await library.import('shared', 'shared', {
    projectId: 'p',
    scope: 'project',
    upload: { name: 'shared.md', base64: Buffer.from('Shared requirements').toString('base64') },
  });
  f.options.rejectReview = true;
  const before = await f.start();
  assert.equal(before.contextMaterials?.[0].id, shared.id);
  const [attachment] = await library.import('correction', 'correction', {
    projectId: 'p',
    scope: 'goal',
    upload: { name: 'correction.md', base64: Buffer.from('New correction').toString('base64') },
  });
  await f.goals.update('edit-materials', 'edit-materials', {
    projectId: 'p',
    id: f.goal.id,
    expectedRevision: 1,
    title: 'Revised',
    body: 'Use correction',
    criteria: '',
    materialIds: [attachment.id],
  });
  f.options.rejectReview = false;
  const continued = await f.resume(before.id, 'repair');
  assert.equal(continued.status, 'completed');
  assert.deepEqual(
    continued.contextMaterials?.map((m) => m.id),
    [shared.id, attachment.id],
  );
  assert.deepEqual(
    continued.attempts?.[0].contextMaterials?.map((m) => m.id),
    [shared.id],
  );
  assert.equal(
    await fs.readFile(
      path.join(continued.workspace!, '.buro/context', path.basename(attachment.relativePath)),
      'utf8',
    ),
    'New correction',
  );
});
