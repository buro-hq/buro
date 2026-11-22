import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { prepareComparisonFixture } = require('../scripts/lib/model-comparison.cjs');
const {
  CASE_ID,
  validateProjectComparison,
  oracleReceipt,
  runProjectModelComparison,
} = require('../scripts/lib/project-model-comparison.cjs');
const env = {
  BURO_PROJECT_MODEL_COMPARISON: '1',
  BURO_LIVE_SOURCE_TRANSFER: '1',
  BURO_LIVE_CODEX: '1',
  BURO_LIVE_DEEPSEEK: '1',
  BURO_LIVE_OLLAMA: '1',
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fix = async (root: string) => {
  const priority = path.join(root, 'src/priority.mjs'),
    queue = path.join(root, 'src/queue.mjs');
  await writeFile(priority, (await readFile(priority, 'utf8')).replace('|| 2', '?? 2'));
  await writeFile(queue, (await readFile(queue, 'utf8')).replace('.some(', '.every('));
};

function fakeSource(
  t: test.TestContext,
  options: { originalChanged?: boolean; varyingIdentity?: boolean } = {},
) {
  const roots: string[] = [],
    modes: string[] = [];
  let prepared = 0,
    preserved = 0;
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  return {
    roots,
    modes,
    get prepared() {
      return prepared;
    },
    get preserved() {
      return preserved;
    },
    getSourceCase(id: string) {
      assert.equal(id, CASE_ID);
      return {
        id,
        async prepare(input: any) {
          prepared++;
          const fixture = await prepareComparisonFixture(input);
          roots.push(fixture.root);
          fixture.evidence = {
            source: {
              head: 'a'.repeat(40),
              root: '/private/original-project',
              hashes: Object.fromEntries(
                Array.from({ length: 9 }, (_, index) => [
                  `approved/file-${index}.ts`,
                  hash('source-' + index),
                ]),
              ),
            },
            controllerHashes: {
              'checks/oracle.cjs': hash(
                options.varyingIdentity ? 'oracle-' + prepared : 'same-oracle',
              ),
            },
            public: [],
            holdout: [],
          };
          fixture.goal.body += ' A raw prompt or private source must not enter the report.';
          fixture.evaluateCandidate = async (workspace: string, mode: string) => {
            modes.push(mode);
            const priority = await readFile(path.join(workspace, 'src/priority.mjs'), 'utf8');
            const queue = await readFile(path.join(workspace, 'src/queue.mjs'), 'utf8');
            const passed = priority.includes('?? 2') && queue.includes('.every(');
            return {
              passed,
              rows: Array.from({ length: mode === 'public' ? 3 : 4 }, () => ({
                name: 'private test detail',
                passed,
                error: 'raw source or private reasoning',
              })),
              sourceHash: hash(priority + queue),
              exitCode: passed ? 0 : 1,
              durationMs: 1,
              rawPrompt: 'DO NOT RETAIN',
            };
          };
          fixture.assertOriginalUnchanged = async () => {
            preserved++;
            if (options.originalChanged) throw Error('Original differs');
          };
          return fixture;
        },
      };
    },
  };
}

test('source transfer needs an explicit project opt-in and grant before any source factory runs', async () => {
  assert.throws(() => validateProjectComparison({ env: {} }), {
    code: 'PROJECT_COMPARISON_OPT_IN_REQUIRED',
  });
  assert.throws(() => validateProjectComparison({ env: { BURO_PROJECT_MODEL_COMPARISON: '1' } }), {
    code: 'LIVE_SOURCE_TRANSFER_NOT_AUTHORIZED',
  });
  assert.throws(() => validateProjectComparison({ env, caseId: 'another-project' }), {
    code: 'PROJECT_COMPARISON_CASE_NOT_AUTHORIZED',
  });
  let reads = 0;
  await assert.rejects(
    runProjectModelComparison({
      env: { BURO_PROJECT_MODEL_COMPARISON: '1' },
      getSourceCase() {
        reads++;
        throw Error('Must not read');
      },
    }),
    { code: 'LIVE_SOURCE_TRANSFER_NOT_AUTHORIZED' },
  );
  assert.equal(reads, 0);
  assert.throws(
    () => validateProjectComparison({ env: { ...env, BURO_LIVE_DEEPSEEK: undefined } }),
    { code: 'LIVE_OPT_IN_REQUIRED' },
  );
  assert.throws(
    () => validateProjectComparison({ env, endpoints: { ollama: 'http://192.168.50.10:11434' } }),
    { code: 'COMPARISON_LOCAL_OLLAMA_ONLY' },
  );
});

test('five real-project routes use the same contract, budget, final oracle and preserved source', async (t) => {
  const source = fakeSource(t);
  const inputs: any[] = [];
  const report = await runProjectModelComparison({
    env,
    getSourceCase: source.getSourceCase,
    runDirect: async ({ fixture, config }: any) => {
      assert.equal(config.models.codex, 'gpt-6.1-sol');
      await fix(fixture.root);
      return { status: 'completed' };
    },
    runProvider: async (input: any) => {
      inputs.push(input);
      const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), 'buro-project-comparison-fake-'),
      );
      const fixture = await input.sourceCase.prepare({ temporaryDirectory });
      await fix(fixture.root);
      await input.onRunFinished({
        run: {
          workspace: fixture.root,
          workflow: { actionsRevision: 'captured-actions-v1' },
          events: [{ type: 'action.requested' }],
        },
      });
      return {
        status: 'passed',
        run: { independentReviewer: true, reviewVerdict: 'approved', acceptedCommit: true },
        nativeUsage: { inputTokens: 10, outputTokens: 5 },
        privateResponse: 'DO NOT RETAIN',
      };
    },
  });
  assert.equal(report.results.length, 5);
  assert.equal(source.prepared, 5);
  assert.equal(source.preserved, 5);
  assert.deepEqual(source.modes, Array.from({ length: 5 }, () => ['public', 'holdout']).flat());
  assert.ok(
    report.results.every((result: any) => result.accepted && result.originalSourcePreserved),
  );
  assert.equal(report.fixture.sourceFiles, 9);
  assert.equal(report.results[0].budgetCoverage.generationRequests, null);
  assert.equal(report.results[1].executionMode, 'model-selected-actions');
  assert.deepEqual(report.results[1].orchestrationPolicy, {
    strategy: 'model-selected-actions',
    actionRequests: 1,
  });
  assert.equal(Object.hasOwn(report.results[1], 'planning'), false);
  assert.equal(report.results[1].budgetCoverage.observedInputTokens, 10);
  for (const input of inputs) {
    assert.equal(input.forceWorker, true);
    assert.equal(input.budgets.codingWallTimeMs, undefined);
    assert.equal(input.budgets.maxGenerationRequests, undefined);
    assert.equal(input.budgets.maxOutputTokens, 2048);
    assert.equal(input.budgets.contextTokens, 32768);
    assert.equal(input.contextTokensByProvider.ollama, 32768);
    assert.equal(input.sourceCase.id, CASE_ID);
    assert.equal(input.codex.networkAccess, false);
    assert.equal(input.codex.model, 'gpt-6.1-sol');
  }
  assert.doesNotMatch(
    JSON.stringify(report),
    /DO NOT RETAIN|private test detail|raw source|private reasoning|raw prompt|original-project/,
  );
});

test('a stopped Buro workflow still receives public and holdout checks without accepted status', async (t) => {
  const source = fakeSource(t);
  const report = await runProjectModelComparison({
    env,
    arms: ['ollama-buro'],
    getSourceCase: source.getSourceCase,
    runProvider: async (input: any) => {
      const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), 'buro-project-comparison-stopped-'),
      );
      const fixture = await input.sourceCase.prepare({ temporaryDirectory });
      await fix(fixture.root);
      await input.onRunFinished({ run: { workspace: fixture.root } });
      return { status: 'failed', error: { code: 'LIVE_RUN_NOT_ACCEPTED' } };
    },
  });
  assert.deepEqual(source.modes, ['public', 'holdout']);
  assert.equal(report.results[0].canonical.public.passed, true);
  assert.equal(report.results[0].canonical.holdout.passed, true);
  assert.equal(report.results[0].accepted, false);
  assert.equal(report.results[0].originalSourcePreserved, true);
});

test('preparation failures still evaluate the fixture baseline when no run workspace exists', async (t) => {
  const source = fakeSource(t);
  const report = await runProjectModelComparison({
    env,
    arms: ['ollama-buro'],
    getSourceCase: source.getSourceCase,
    runProvider: async (input: any) => {
      const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), 'buro-project-comparison-early-'),
      );
      await input.sourceCase.prepare({ temporaryDirectory });
      throw Object.assign(new Error('Environment unavailable'), {
        code: 'ENVIRONMENT_UNAVAILABLE',
      });
    },
  });
  assert.deepEqual(source.modes, ['public', 'holdout']);
  assert.equal(report.results[0].canonicalOrigin, 'fixture-baseline');
  assert.equal(report.results[0].canonical.public.passed, false);
  assert.equal(report.results[0].canonical.holdout.passed, false);
  assert.equal(report.results[0].accepted, false);
  assert.equal(report.results[0].originalSourcePreserved, true);
});

test('scope failures and original-source changes cannot be accepted by a passing oracle', async (t) => {
  const source = fakeSource(t, { originalChanged: true });
  const report = await runProjectModelComparison({
    env,
    arms: ['codex-direct'],
    getSourceCase: source.getSourceCase,
    runDirect: async ({ fixture }: any) => {
      await fix(fixture.root);
      await writeFile(path.join(fixture.root, 'README.md'), 'changed protected file');
      return { status: 'completed' };
    },
  });
  assert.equal(report.results[0].canonical.public.passed, true);
  assert.equal(report.results[0].scope.passed, false);
  assert.equal(report.results[0].originalSourcePreserved, false);
  assert.equal(report.results[0].accepted, false);
  assert.equal(report.results[0].errorCode, 'PROJECT_COMPARISON_ORIGINAL_SOURCE_CHANGED');
  assert.equal(source.preserved, 1);
});

test('an oracle/controller identity change blocks the next trial before model execution', async (t) => {
  const source = fakeSource(t, { varyingIdentity: true });
  let models = 0;
  const report = await runProjectModelComparison({
    env,
    arms: ['codex-direct', 'codex-buro'],
    getSourceCase: source.getSourceCase,
    runDirect: async ({ fixture }: any) => {
      models++;
      await fix(fixture.root);
      return { status: 'completed' };
    },
    runProvider: async (input: any) => {
      const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), 'buro-project-comparison-changed-'),
      );
      await input.sourceCase.prepare({ temporaryDirectory });
      models++;
      throw Error('Identity guard must throw first');
    },
  });
  assert.equal(models, 1);
  assert.equal(source.preserved, 2);
  assert.equal(report.results[1].errorCode, 'PROJECT_COMPARISON_FIXTURE_CHANGED');
  assert.equal(report.results[1].accepted, false);
});

test('the real oracle receipt rejects inconsistent success and strips raw details', () => {
  const result = {
    passed: true,
    rows: Array.from({ length: 3 }, () => ({ passed: true, private: 'never' })),
    sourceHash: 'a'.repeat(64),
    exitCode: 0,
    durationMs: 1,
    source: 'never',
  };
  assert.equal(oracleReceipt(result, 'public').checks, 3);
  assert.doesNotMatch(JSON.stringify(oracleReceipt(result, 'public')), /never|private/);
  assert.throws(() => oracleReceipt({ ...result, passed: false }, 'public'), {
    code: 'PROJECT_COMPARISON_INVALID_ORACLE_RECEIPT',
  });
});
