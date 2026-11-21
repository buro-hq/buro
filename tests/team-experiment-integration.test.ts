import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import type { ModelProvider } from '../core/model-ports.ts';

const require = createRequire(import.meta.url);
const {
  prepareComparisonFixture,
  canonicalOracle,
} = require('../scripts/lib/model-comparison.cjs');
const { runTeamExperimentTrial } = require('../scripts/lib/team-experiment-runtime.cjs');
const env = { BURO_TEAM_QUALITY: '1', BURO_LIVE_OLLAMA: '1' };
const model = 'integration-model';
const sourceQueue = `import { priorityOf } from './priority.mjs';

export function selectReady(tasks, completedIds = []) {
  const done = new Set(completedIds);
  return tasks
    .filter(task => !done.has(task.id) && (task.dependsOn || []).some(id => done.has(id)))
    .sort((a, b) => priorityOf(b) - priorityOf(a));
}
`;
const fixedQueue = sourceQueue.replace('.some(', '.every(');
const checkPassingDefect = fixedQueue.replace('!done.has(task.id) && ', '');
const completed = {
  status: 'success',
  summary: 'Finished the scoped change.',
  artifacts: ['src/priority.mjs', 'src/queue.mjs'],
  notesForNextAgent: '',
};
const reply = (value: unknown) => ({
  model,
  finish: 'stop' as const,
  message: { role: 'assistant' as const, content: JSON.stringify(value) },
  usage: { inputTokens: 100, outputTokens: 30 },
});
const edit = (id: string, file: string, oldText: string, newText: string) => ({
  model,
  finish: 'tools' as const,
  message: {
    role: 'assistant' as const,
    content: '',
    toolCalls: [{ id, name: 'edit_file', arguments: { path: file, oldText, newText } }],
  },
  usage: { inputTokens: 100, outputTokens: 30 },
});

async function fixture(t: any) {
  const temporaryDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-team-integration-')),
  );
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  return prepareComparisonFixture({ temporaryDirectory });
}
async function saved(f: any) {
  const directory = path.join(f.root, '.buro/local/team-sessions');
  const sessions = await Promise.all(
    (await fs.readdir(directory))
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'))),
  );
  const document = JSON.parse(
    await fs.readFile(path.join(f.root, '.buro/experiment/control-state.json'), 'utf8'),
  );
  return { sessions, document };
}
async function ownedWorkspace(f: any) {
  const directory = path.join(f.root, '.buro/worktrees');
  const names = await fs.readdir(directory);
  assert.equal(names.length, 1);
  return path.join(directory, names[0]);
}

function stagedProvider(
  options: { fixAfterReview?: boolean; onReview?: () => Promise<void> } = {},
) {
  let executorTurns = 0,
    reviews = 0;
  const provider: ModelProvider = {
    id: 'integration-provider',
    revision: '1',
    local: true,
    async complete(input) {
      assert.equal(input.model, model);
      assert.equal(input.contextTokens, 32768);
      const role = input.messages[0].content.split('Experiment role: ')[1].split('.')[0];
      if (role === 'reviewer') {
        assert.deepEqual(input.tools, []);
        reviews++;
        await options.onReview?.();
        return reply(
          options.fixAfterReview !== false && reviews === 2
            ? {
                verdict: 'approved',
                findings: [],
                summary: 'The full observed code now excludes completed tasks.',
              }
            : {
                verdict: 'changes_requested',
                findings: [
                  {
                    path: 'src/queue.mjs',
                    issue: 'Completed tasks are returned even though public checks pass.',
                    expected: 'Exclude task IDs present in completedIds.',
                  },
                ],
                summary: 'The completed-task criterion remains unfulfilled.',
              },
        );
      }
      assert.equal(role, 'executor');
      const schema: any = input.schema;
      if (schema?.properties?.nextTask) return reply({ status: 'complete', nextTask: '' });
      const latest = input.messages.at(-1)!;
      if (
        latest.role !== 'user' ||
        !/^(Implement the frozen task|Repair the original frozen task)/.test(latest.content)
      )
        return reply(completed);
      executorTurns++;
      if (executorTurns === 1)
        return edit(
          'initial-priority',
          'src/priority.mjs',
          'return task.priority || 2;',
          'return task.priority ?? 2;',
        );
      if (executorTurns === 2) {
        assert.match(latest.content, /public-checks/);
        return edit('check-repair', 'src/queue.mjs', sourceQueue, checkPassingDefect);
      }
      assert.equal(executorTurns, 3, 'The shared two-repair budget must not renew for review');
      assert.match(latest.content, /independent-review/);
      return options.fixAfterReview === false
        ? reply(completed)
        : edit('review-repair', 'src/queue.mjs', checkPassingDefect, fixedQueue);
    },
  };
  return { provider, counts: () => ({ executorTurns, reviews }) };
}

test('public and independent-review failures share one repair allowance and one real executor journal', async (t) => {
  const f = await fixture(t);
  const fake = stagedProvider();
  const result = await runTeamExperimentTrial({
    fixture: f,
    variant: 'executor-review',
    env,
    model,
    provider: fake.provider,
    limits: { contextTokens: 32768 },
  });
  assert.equal(result.experimentPassed, true, result.errorCode);
  assert.equal(result.repairs, 2);
  assert.equal(result.experiment.checkRuns, 4);
  assert.deepEqual(fake.counts(), { executorTurns: 3, reviews: 2 });
  assert.equal(result.actions.edits, 3);
  assert.equal(result.budget.reviewUsed.requests, 2);
  assert.ok(result.budget.used.requests >= 8 && result.budget.used.requests <= 24);
  assert.equal(result.cleanupDone, true);
  assert.equal(result.originalFixturePreserved, true);
  assert.equal((await canonicalOracle(f, result.workspace, 'holdout')).passed, true);
  const { sessions, document } = await saved(f);
  const executor = sessions.filter((s) => s.purpose === 'implementation');
  const reviewers = sessions.filter((s) => s.purpose === 'review');
  assert.equal(executor.length, 1);
  assert.equal(executor[0].turnAuthorities.length, 3);
  assert.equal(executor[0].actions.length, 3);
  assert.equal(reviewers.length, 2);
  assert.notEqual(reviewers[0].id, reviewers[1].id);
  assert.ok(
    reviewers.every(
      (s) =>
        s.scope.readOnly &&
        s.actions.length === 0 &&
        s.turnAuthorities.every((a) => a.toolPolicy === 'none'),
    ),
  );
  assert.equal(document.runs[0].status, 'needs-attention');
  assert.equal(document.runs[0].commit, undefined);
  assert.equal(document.runs[0].independentReviewer, false);
});

test('review rejection cannot grant extra repairs after a prior check repair exhausted the shared bound', async (t) => {
  const f = await fixture(t);
  const fake = stagedProvider({ fixAfterReview: false });
  const result = await runTeamExperimentTrial({
    fixture: f,
    variant: 'executor-review',
    env,
    model,
    provider: fake.provider,
    limits: { contextTokens: 32768 },
  });
  assert.equal(result.experimentPassed, false);
  assert.equal(result.errorCode, 'TEAM_EXPERIMENT_REPAIR_LIMIT');
  assert.equal(result.repairs, 2);
  assert.deepEqual(fake.counts(), { executorTurns: 3, reviews: 2 });
  assert.equal(result.actions.edits, 2);
  assert.equal(result.reviewApproved, false);
  assert.equal((await canonicalOracle(f, result.workspace, 'public')).passed, true);
  assert.equal((await canonicalOracle(f, result.workspace, 'holdout')).passed, false);
  assert.equal(result.cleanupDone, true);
});

test('a source race during a read-only reviewer invalidates approval without replay or repair', async (t) => {
  const f = await fixture(t);
  let raced = false;
  const fake = stagedProvider({
    onReview: async () => {
      assert.equal(raced, false);
      raced = true;
      await fs.appendFile(
        path.join(await ownedWorkspace(f), 'src/queue.mjs'),
        '\n// external source race\n',
      );
    },
  });
  const result = await runTeamExperimentTrial({
    fixture: f,
    variant: 'executor-review',
    env,
    model,
    provider: fake.provider,
    limits: { contextTokens: 32768 },
  });
  assert.equal(result.experimentPassed, false);
  assert.equal(result.errorCode, 'TEAM_EXPERIMENT_STALE_EVIDENCE');
  assert.equal(result.repairs, 1);
  assert.deepEqual(fake.counts(), { executorTurns: 2, reviews: 1 });
  assert.equal(result.cleanupDone, true);
  assert.equal(result.originalFixturePreserved, true);
});

test('test-author tool requests fail before execution or implementation despite a valid-looking edit', async (t) => {
  const f = await fixture(t);
  const frozen = await fs.readFile(path.join(f.root, 'checks/public.cjs'), 'utf8');
  const roles: string[] = [];
  const provider: ModelProvider = {
    id: 'integration-provider',
    revision: '1',
    local: true,
    async complete(input) {
      const role = input.messages[0].content.split('Experiment role: ')[1].split('.')[0];
      roles.push(role);
      assert.deepEqual(input.tools, []);
      if (role === 'coordinator')
        return reply({
          objective: 'Fix the two source modules.',
          inputs: ['src/priority.mjs', 'src/queue.mjs'],
          expectedResult: 'Queue APIs preserve all specified behavior.',
          criteria: ['Public checks pass without modifying their source.'],
        });
      assert.equal(role, 'test-author');
      return edit('forged-authority', 'checks/public.cjs', frozen, 'console.log("pass");\n');
    },
  };
  const result = await runTeamExperimentTrial({
    fixture: f,
    variant: 'team-review',
    env,
    model,
    provider,
  });
  assert.equal(result.experimentPassed, false);
  assert.equal(result.errorCode, 'TOOL_POLICY_VIOLATION');
  assert.deepEqual(roles, ['coordinator', 'test-author']);
  assert.equal(result.actions.total, 0);
  assert.equal(result.budget.used.toolCalls, 1, 'Only the service baseline check was charged');
  assert.equal(await fs.readFile(path.join(result.workspace, 'checks/public.cjs'), 'utf8'), frozen);
  assert.equal(result.cleanupDone, true);
});

test('cancelling an in-flight generation keeps its unknown outcome charged and never retries it', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let calls = 0,
    abortObserved = false;
  const provider: ModelProvider = {
    id: 'integration-provider',
    revision: '1',
    local: true,
    complete(input) {
      calls++;
      assert.equal(calls, 1);
      queueMicrotask(() => controller.abort());
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          'abort',
          () => {
            abortObserved = true;
            reject(new DOMException('Interrupted', 'AbortError'));
          },
          { once: true },
        );
      });
    },
  };
  const result = await runTeamExperimentTrial({
    fixture: f,
    variant: 'executor-review',
    env,
    model,
    provider,
    signal: controller.signal,
  });
  assert.equal(result.experimentPassed, false);
  assert.equal(result.errorCode, 'TEAM_EXPERIMENT_ABORTED');
  assert.equal(result.cleanupDone, true);
  assert.equal(abortObserved, true);
  assert.equal(calls, 1);
  assert.equal(result.budget.used.requests, 1);
  assert.equal(result.budget.observed.unknownUsageRequests, 1);
  assert.equal(result.actions.total, 0);
  const { sessions, document } = await saved(f);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].generation.outcome, 'unknown');
  assert.equal(document.runs[0].commit, undefined);
  await assert.rejects(fs.access(path.join(f.root, '.buro/experiment/writer.lock')), {
    code: 'ENOENT',
  });
});
