/**
 * Stage 1A bounded-guarantee audit: PASS reproduces the remaining ABA limitation.
 * Run: node --test output/research/verification-aba-repro-2026-11-21.ts
 * Fake agent + real disposable Git + real child Node check. No model/API/user repository access.
 * Before/after source equality does not establish immutable check input.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DomainError } from '../../core/ports.ts';
import { ExecutionService } from '../../core/execution.ts';
import { GoalService } from '../../core/services.ts';
import { FileProjectStore } from '../../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../../adapters/files/registry.ts';
import { GitWorkspaces } from '../../adapters/files/git-workspaces.ts';
import { CodexRuntime } from '../../adapters/codex/runtime.ts';
import type { RuntimeEvent } from '../../core/ports.ts';
import { unchangedDependencyFailures } from '../../core/check-failures.ts';
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

test('audit: a transient check-time source mutation can pass while the accepted source fails the same check', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  let checkedSource = '';
  f.engine.env.checks.run = async (_projectId, workspace) => {
    if (++calls === 1) return { passed: 1, total: 1, results: [{ name: 'Baseline', passed: true }] };
    const file = path.join(workspace, 'src/code.mjs');
    const original = await fs.readFile(file, 'utf8');
    try {
      await fs.writeFile(file, 'export const value=3;');
      checkedSource = await fs.readFile(file, 'utf8');
      await exec(process.execPath, ['--input-type=module', '-e',
        'const m=await import(process.argv[1]);if(m.value!==3)process.exit(1);', file]);
      return { passed: 1, total: 1, results: [{ name: 'Value must equal three', passed: true, exitCode: 0 }] };
    } finally {
      await fs.writeFile(file, original);
    }
  };
  const result = await f.start();
  assert.equal(result.status, 'completed', result.result);
  const acceptedSource = (await f.git(['show', result.commit + ':src/code.mjs'])).stdout;
  assert.equal(checkedSource, 'export const value=3;');
  assert.equal(acceptedSource, 'export const value=2;');
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e',
    'const m=await import(process.argv[1]);if(m.value!==3)process.exit(1);',
    path.join(result.workspace, 'src/code.mjs')]));
  console.log('AUDIT_OBSERVED', JSON.stringify({
    case: 'verification-source-ABA', status: result.status, checkedSource, acceptedSource,
    identicalBeforeAfterSnapshots: true, acceptedSourceFailsCheck: true,
  }));
});
