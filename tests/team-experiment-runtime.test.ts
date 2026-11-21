import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { ModelProvider } from '../core/model-ports.ts';

const require = createRequire(import.meta.url);
const {
  prepareComparisonFixture,
  canonicalOracle,
} = require('../scripts/lib/model-comparison.cjs');
const {
  validateTeamExperimentRuntime,
  runTeamExperimentTrial,
} = require('../scripts/lib/team-experiment-runtime.cjs');
const env = { BURO_TEAM_QUALITY: '1', BURO_LIVE_OLLAMA: '1' };
const model = 'fixture-model';
const fixedQueue = `import { priorityOf } from './priority.mjs';\n\nexport function selectReady(tasks, completedIds = []) {\n  const done = new Set(completedIds);\n  return tasks\n    .filter(task => !done.has(task.id) && (task.dependsOn || []).every(id => done.has(id)))\n    .sort((a, b) => priorityOf(b) - priorityOf(a));\n}\n`;
const buggyQueue = fixedQueue.replace('!done.has(task.id) && ', '');
const sourceQueue = fixedQueue.replace('.every(', '.some(');
const json = (value: unknown) => ({
  model,
  message: { role: 'assistant' as const, content: JSON.stringify(value) },
  finish: 'stop' as const,
  usage: { inputTokens: 100, outputTokens: 25 },
});
const tool = (id: string, file: string, oldText: string, newText: string) => ({
  model,
  message: {
    role: 'assistant' as const,
    content: '',
    toolCalls: [{ id, name: 'edit_file', arguments: { path: file, oldText, newText } }],
  },
  finish: 'tools' as const,
  usage: { inputTokens: 100, outputTokens: 25 },
});
async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-team-adapter-test-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return prepareComparisonFixture({ temporaryDirectory: directory });
}

function providerWithRepair(repair: boolean) {
  let executorCalls = 0,
    reviewCalls = 0;
  const roles: string[] = [],
    authorities: { role: string; tools: number }[] = [];
  const provider: ModelProvider = {
    id: 'fixture-provider',
    revision: '1',
    local: true,
    async complete(input) {
      assert.equal(input.model, model);
      const role = input.messages[0].content.split('Experiment role: ')[1].split('.')[0];
      roles.push(role);
      authorities.push({ role, tools: input.tools.length });
      if (role === 'coordinator')
        return json({
          objective: 'Correct ready selection and priority handling.',
          inputs: ['src/priority.mjs', 'src/queue.mjs'],
          expectedResult: 'Preserve APIs and immutable inputs with correct queue behavior.',
          criteria: [
            'Use every dependency',
            'Exclude completed tasks',
            'Preserve zero priority and stable order',
          ],
        });
      if (role === 'test-author')
        return json({
          cases: [
            { kind: 'priority', task: { priority: 0 } },
            { kind: 'ready', tasks: [{ id: 'done' }], done: ['done'] },
          ],
        });
      if (role === 'reviewer') {
        assert.deepEqual(input.tools, []);
        reviewCalls++;
        return json(
          repair && reviewCalls === 1
            ? {
                verdict: 'changes_requested',
                findings: [
                  {
                    path: 'src/queue.mjs',
                    issue: 'Completed tasks are still returned.',
                    expected: 'Exclude tasks whose IDs are in completedIds.',
                  },
                ],
                summary: 'One concrete defect remains.',
              }
            : {
                verdict: 'approved',
                findings: [],
                summary: 'The changed code matches the full task and observed checks.',
              },
        );
      }
      assert.equal(role, 'executor');
      if ((input.schema as any)?.properties?.status?.enum?.includes('continue'))
        return json({
          status: 'continue',
          nextTask:
            'Apply the scoped reviewer correction to the existing queue source; do not redo completed edits.',
        });
      executorCalls++;
      if (executorCalls === 1)
        return tool(
          'fix-priority',
          'src/priority.mjs',
          'return task.priority || 2;',
          'return task.priority ?? 2;',
        );
      if (executorCalls === 2)
        return tool('fix-queue', 'src/queue.mjs', sourceQueue, repair ? buggyQueue : fixedQueue);
      if (repair && executorCalls === 4) {
        assert.match(input.messages.at(-1)!.content, /Completed tasks/);
        return tool('repair-queue', 'src/queue.mjs', buggyQueue, fixedQueue);
      }
      return json({
        status: 'success',
        summary: 'Implemented the scoped task.',
        artifacts: ['src/priority.mjs', 'src/queue.mjs'],
        notesForNextAgent: '',
      });
    },
  };
  return { provider, roles, authorities };
}

test('team runtime rejects missing opt-in, remote endpoints and cloud models before touching a fixture', async () => {
  assert.throws(
    () => validateTeamExperimentRuntime({ variant: 'executor-checks', model, env: {} }),
    { code: 'TEAM_EXPERIMENT_OPT_IN_REQUIRED' },
  );
  assert.throws(
    () =>
      validateTeamExperimentRuntime({
        variant: 'executor-checks',
        model,
        env,
        endpoint: 'http://192.168.50.10:11434',
      }),
    { code: 'TEAM_EXPERIMENT_LOCAL_ENDPOINT_REQUIRED' },
  );
  assert.throws(
    () => validateTeamExperimentRuntime({ variant: 'executor-checks', model: 'qwen:cloud', env }),
    { code: 'TEAM_EXPERIMENT_INVALID_MODEL' },
  );
  const baseline = validateTeamExperimentRuntime({ variant: 'executor-checks', model, env });
  const review = validateTeamExperimentRuntime({ variant: 'executor-review', model, env });
  assert.equal(baseline.budgetPolicy.maxRequests, review.budgetPolicy.maxRequests);
  assert.equal(review.budgetPolicy.maxToolCalls, 64);
  assert.deepEqual(review.budgetPolicy.reviewReserve, {
    requests: 4,
    outputTokens: 8192,
    toolCalls: 8,
  });
  assert.deepEqual(baseline.budgetPolicy.reviewReserve, {
    requests: 0,
    outputTokens: 0,
    toolCalls: 0,
  });
});

test('actual managed executor edits an isolated worktree with durable budget but never a production acceptance', async (t) => {
  const f = await fixture(t);
  const fake = providerWithRepair(false);
  const result = await runTeamExperimentTrial({
    fixture: f,
    variant: 'executor-checks',
    model,
    env,
    provider: fake.provider,
  });
  assert.equal(result.experimentPassed, true, result.errorCode);
  assert.equal(result.cleanupDone, true);
  assert.equal(result.originalFixturePreserved, true);
  assert.equal(result.reviewApproved, false);
  assert.equal(result.budget.used.requests, 3);
  assert.equal(result.actions.edits, 2);
  assert.equal((await canonicalOracle(f, result.workspace, 'holdout')).passed, true);
  const doc = JSON.parse(
    await fs.readFile(path.join(f.root, '.buro/experiment/control-state.json'), 'utf8'),
  );
  assert.equal(doc.runs[0].status, 'needs-attention');
  assert.equal(doc.runs[0].commit, undefined);
  assert.equal(doc.runs[0].independentReviewer, false);
  assert.ok(Object.keys(doc.managedRunBudgets).length === 1);
  assert.equal(await fs.readFile(path.join(f.root, 'src/queue.mjs'), 'utf8'), sourceQueue);
});

test('Ollama separate-turn work, final envelope and tools-free review share the actual runtime ledger', async (t) => {
  const f = await fixture(t);
  let executorRequests = 0,
    reviewerRequests = 0;
  const provider: ModelProvider = {
    id: 'fixture-ollama-separate',
    revision: '1',
    local: true,
    structuredToolMode: 'separate-turn',
    async complete(input) {
      const role = input.messages[0].content.split('Experiment role: ')[1].split('.')[0];
      if (role === 'reviewer') {
        reviewerRequests++;
        assert.deepEqual(input.tools, []);
        assert.ok(input.schema);
        return json({
          verdict: 'approved',
          findings: [],
          summary: 'The complete patch meets the criteria.',
        });
      }
      assert.equal(role, 'executor');
      executorRequests++;
      if (executorRequests === 1) {
        assert.equal(input.schema, undefined);
        assert.ok(input.tools.some((tool) => tool.name === 'edit_file'));
        const first = tool(
          'separate-priority',
          'src/priority.mjs',
          'task.priority || 2',
          'task.priority ?? 2',
        );
        const second = tool('separate-queue', 'src/queue.mjs', sourceQueue, fixedQueue);
        return {
          ...first,
          message: {
            ...first.message,
            toolCalls: [...first.message.toolCalls, ...second.message.toolCalls],
          },
        };
      }
      if (executorRequests === 2) {
        assert.equal(input.schema, undefined);
        return {
          ...json({}),
          message: { role: 'assistant', content: 'The scoped implementation is complete.' },
        };
      }
      assert.equal(executorRequests, 3);
      assert.deepEqual(input.tools, []);
      assert.ok(input.schema);
      return json({
        status: 'success',
        summary: 'Implemented the queue fix.',
        artifacts: ['src/priority.mjs', 'src/queue.mjs'],
        notesForNextAgent: '',
      });
    },
  };
  const result = await runTeamExperimentTrial({
    fixture: f,
    variant: 'executor-review',
    model,
    env,
    provider,
  });
  assert.equal(result.experimentPassed, true, result.errorCode);
  assert.equal(result.reviewApproved, true);
  assert.equal(executorRequests, 3);
  assert.equal(reviewerRequests, 1);
  assert.equal(result.budget.used.requests, 4);
  assert.equal(result.budget.reviewUsed.requests, 1);
  assert.equal(result.cleanupDone, true);
});

test('fresh reviewer findings cause a real same-session edit and fresh re-review under the same ledger', async (t) => {
  const f = await fixture(t);
  const fake = providerWithRepair(true);
  const result = await runTeamExperimentTrial({
    fixture: f,
    variant: 'executor-review',
    model,
    env,
    provider: fake.provider,
  });
  assert.equal(result.experimentPassed, true, result.errorCode);
  assert.equal(result.repairs, 1);
  assert.equal(result.reviewApproved, true);
  assert.equal(result.cleanupDone, true);
  assert.equal(result.actions.edits, 3);
  assert.equal(result.budget.reviewUsed.requests, 2);
  assert.equal(
    result.budget.workUsed.requests,
    fake.roles.filter((role) => role === 'executor').length,
  );
  assert.equal((await canonicalOracle(f, result.workspace, 'holdout')).passed, true);
  const directory = path.join(f.root, '.buro/local/team-sessions');
  const saved = await Promise.all(
    (await fs.readdir(directory)).map(async (name) =>
      JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')),
    ),
  );
  assert.equal(saved.filter((s) => s.purpose === 'implementation').length, 1);
  assert.equal(saved.filter((s) => s.purpose === 'review').length, 2);
  assert.ok(
    saved
      .filter((s) => s.purpose === 'review')
      .every(
        (s) =>
          s.scope.readOnly && s.actions.length === 0 && s.turnAuthorities[0].toolPolicy === 'none',
      ),
  );
  const executor = saved.find((s) => s.purpose === 'implementation');
  assert.equal(executor.turnAuthorities.length, 2);
  assert.equal(executor.actions.length, 3);
});

test('test author proposes data before edits and generated cases are checked by the trusted parent', async (t) => {
  const f = await fixture(t);
  const fake = providerWithRepair(false);
  const result = await runTeamExperimentTrial({
    fixture: f,
    variant: 'team-review',
    model,
    env,
    provider: fake.provider,
  });
  assert.equal(result.experimentPassed, true, result.errorCode);
  assert.equal(result.experiment.generatedProbeCount, 2);
  assert.equal(result.generatedProbeCount, 2);
  assert.equal(result.reviewRounds, 1);
  assert.equal(result.checkRuns, result.experiment.checkRuns);
  assert.ok(result.checkRuns >= 2);
  assert.equal(result.reviewApproved, true);
  assert.deepEqual(fake.roles.slice(0, 2), ['coordinator', 'test-author']);
  assert.ok(fake.authorities.filter((x) => x.role !== 'executor').every((x) => x.tools === 0));
  assert.equal(result.budget.used.requests, 6);
  assert.equal(result.originalFixturePreserved, true);
});

test('cloud-backed local Ollama aliases are rejected during metadata inspection without a generation', async (t) => {
  const f = await fixture(t);
  let generations = 0;
  const result = await runTeamExperimentTrial({
    fixture: f,
    variant: 'executor-checks',
    model,
    env,
    fetch: async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/api/tags')
        return new Response(JSON.stringify({ models: [{ name: model }] }));
      if (url.pathname === '/api/show')
        return new Response(
          JSON.stringify({ remote_host: 'https://remote.invalid', capabilities: ['tools'] }),
        );
      generations++;
      throw Error('No generation is authorized');
    },
  });
  assert.equal(result.experimentPassed, false);
  assert.equal(result.errorCode, 'TEAM_EXPERIMENT_LOCAL_PROVIDER_REQUIRED');
  assert.equal(result.cleanupDone, true);
  assert.equal(result.budget.used.requests, 0);
  assert.equal(generations, 0);
});
