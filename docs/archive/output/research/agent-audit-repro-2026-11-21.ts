/**
 * Controlled audit reproducer, 2026-11-21.
 * Run: node --test output/research/agent-audit-repro-2026-11-21.ts
 * PASS asserts the audited vulnerability CURRENTLY EXISTS; these are not correctness tests.
 * Uses an adapted tests/recovery.test.ts fixture, fake agent/check ports and real disposable Git.
 * No model/API/network calls or user repositories. Temporary fixtures are removed after each test.
 * Baseline HEAD: a4f7e233012032c16ab3268f392b2e6cae31848f
 * SHA256 tests/recovery.test.ts d5286654c0309d58391e7f0b77d136e287fd47f8e9dd8e6c385fa9c644313a88
 * SHA256 core/execution.ts 621aa7e6c98ae1254247a52aba58641660c9c509a92e0c2d4e4c98e90bed5bce
 * SHA256 core/managed-runtime.ts 1430d52217ca9ded0f0badf08c86f0b39884656e1ab7636957015799bec1214a
 * SHA256 core/worker-assignments.ts 45afedb4d50401cccdfa22d48973677ce51da598ecf7c0432b920199c7fec7b4
 * SHA256 adapters/files/git-workspaces.ts d045921e857759f92195c5e9e24f950b60921d7b71cd10445f8f963921ff4dbb
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

test('audit: check-time out-of-scope mutation can enter accepted commit', async (t) => {
  const f = await fixture(t);
  const original = f.engine.env.checks.run;
  let calls=0;
  f.engine.env.checks.run = async (...args) => {
    const result=await original(...args);
    if (++calls === 2) await fs.writeFile(path.join(args[1], 'README.md'), 'outside permitted src scope');
    return result;
  };
  const result=await f.start();
  const committed=(await f.git(['show', result.commit+':README.md'])).stdout;
  assert.equal(result.status, 'completed');
  assert.equal(result.scopePreserved, true);
  assert.equal(result.changedFiles.some(file=>file.path==='README.md'), false);
  assert.equal(committed, 'outside permitted src scope');
  console.log('AUDIT_OBSERVED',JSON.stringify({case:'scope-after-check',status:result.status,scope:result.scopePreserved,commitContainsOutOfScopeReadme:true,reportedChangePaths:result.changedFiles.map(x=>x.path)}));
});
test('audit: repair opens replacement worker while previous worker effect is unresolved', async (t) => {
  const f = await fixture(t);
  const original=f.runtime.turn.bind(f.runtime);
  let workers=0, unknownPending=false, replacementWhileUnknown=false;
  f.runtime.turn = async (id,text) => {
    if(text.startsWith('Execute your assigned work')) {
      workers++;
      if(workers===1) { unknownPending=true; throw new DomainError('ACTION_RECONCILIATION_REQUIRED','Synthetic durable unknown tool effect'); }
      replacementWhileUnknown=unknownPending;
    }
    return original(id,text);
  };
  const first=await f.start();
  assert.equal(first.status,'failed');
  const result=await f.resume(first.id,'repair');
  assert.equal(workers,2);
  assert.equal(replacementWhileUnknown,true);
  assert.equal(result.status,'completed');
  console.log('AUDIT_OBSERVED',JSON.stringify({case:'unknown-worker-replacement',first:first.status,after:result.status,workers,replacementWhileUnknown,unknownPending}));
});
test('audit: malformed planning JSON bypasses plan correction loop', async(t)=>{
  const f=await fixture(t);
  const original=f.runtime.turn.bind(f.runtime);
  let planningCalls=0;
  f.runtime.turn=async(id,text)=> {
    if(text.startsWith('First,')) { planningCalls++; return {turnId:'bad',text:'{invalid json'}; }
    return original(id,text);
  };
  const result=await f.start();
  assert.equal(result.status,'failed');
  assert.equal(planningCalls,1);
  console.log('AUDIT_OBSERVED',JSON.stringify({case:'planning-json',status:result.status,planningCalls,planRejectedEvents:result.events.filter(e=>e.type==='plan.rejected').length}));
});
