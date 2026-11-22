import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  ARMS,
  IDENTITY,
  validateComparison,
  prepareComparisonFixture,
  inspectScope,
  canonicalOracle,
  confinedOutput,
  summarizeProvider,
  comparisonTrialReport,
  runModelComparison,
} = require('../scripts/lib/model-comparison.cjs');
const env = { BURO_MODEL_COMPARISON: '1', BURO_LIVE_CODEX: '1' };
const fix = async (root: string) => {
  const priority = path.join(root, 'src/priority.mjs');
  const queue = path.join(root, 'src/queue.mjs');
  await writeFile(priority, (await readFile(priority, 'utf8')).replace('|| 2', '?? 2'));
  await writeFile(queue, (await readFile(queue, 'utf8')).replace('.some(', '.every('));
};
const fixtureIn = async (t: test.TestContext) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'buro-comparison-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return prepareComparisonFixture({ temporaryDirectory: directory });
};

// Tests execute only our fixed synthetic module. Production must use the enclosing OS sandbox;
// inspect that launch here, then bypass it solely to keep the default suite sandbox-independent.
const syntheticExecution = async (launch: any, input: any, options: any) => {
  const nodeAt = launch.args.indexOf(process.execPath);
  assert.ok(nodeAt >= 0);
  assert.ok(['/usr/bin/sandbox-exec', 'bwrap'].includes(launch.executable));
  if (launch.executable === '/usr/bin/sandbox-exec') {
    assert.match(launch.args[1], /\(deny network\*\)/);
    assert.match(launch.args[1], /\(deny file-write\*\)/);
  }
  return confinedOutput(
    {
      executable: process.execPath,
      args: launch.args.slice(nodeAt + 1),
      cwd: launch.cwd,
      env: launch.env,
    },
    input,
    options,
  );
};

test('comparison needs explicit opt-in, pins native settings and forbids remote Ollama', () => {
  assert.throws(() => validateComparison({ env: {} }), { code: 'COMPARISON_OPT_IN_REQUIRED' });
  assert.throws(() => validateComparison({ env: { BURO_MODEL_COMPARISON: '1' } }), {
    code: 'COMPARISON_NATIVE_OPT_IN_REQUIRED',
  });
  assert.throws(() => validateComparison({ env, arms: ['unknown'] }), {
    code: 'COMPARISON_INVALID_ARMS',
  });
  assert.throws(
    () => validateComparison({ env, endpoints: { ollama: 'http://192.168.50.10:11434' } }),
    { code: 'COMPARISON_LOCAL_OLLAMA_ONLY' },
  );
  assert.throws(
    () => validateComparison({ env, endpoints: { ollama: 'http://secret@localhost:11434' } }),
    { code: 'COMPARISON_LOCAL_OLLAMA_ONLY' },
  );
  assert.throws(
    () => validateComparison({ env, endpoints: { deepseek: 'https://elsewhere.invalid' } }),
    { code: 'COMPARISON_DEEPSEEK_ENDPOINT_REQUIRED' },
  );
  assert.throws(() => validateComparison({ env, budgets: { codingWallTimeMs: 300001 } }), {
    code: 'LIVE_INVALID_LIMITS',
  });
  const config = validateComparison({ env });
  assert.deepEqual(config.arms, ARMS);
  assert.equal(config.models.codex, 'gpt-6.1-sol');
  assert.equal(config.reasoningEffort, 'high');
  assert.equal(config.limits.codingWallTimeMs, 300000);
});

test('fresh comparison fixtures have identical frozen task, content and oracle identities', async (t) => {
  const a = await fixtureIn(t),
    b = await fixtureIn(t);
  assert.notEqual(a.root, b.root);
  assert.deepEqual(a.identity, b.identity);
  assert.equal(a.identity, IDENTITY);
  assert.deepEqual(a.goal, b.goal);
  assert.deepEqual(a.profile, b.profile);
  assert.deepEqual(await inspectScope(a.root), await inspectScope(b.root));
  assert.equal((await inspectScope(a.root)).passed, true);
  assert.deepEqual((await inspectScope(a.root)).changedFiles, []);
});

test('comparison validates and records explicit provider context without changing other pilot limits', async () => {
  for (const contextTokensByProvider of [
    { ollama: NaN },
    { ollama: 32769 },
    { ollama: 2048 },
    { ollama: 16384.5 },
    { unknown: 16384 },
  ]) {
    assert.throws(
      () => validateComparison({ env, arms: ['ollama-buro'], contextTokensByProvider }),
      { code: 'LIVE_INVALID_CONTEXT_BUDGET' },
    );
  }
  assert.equal(validateComparison({ env }).contexts.ollama, 16384);
  let dispatched = false;
  const report = await runModelComparison({
    env,
    arms: ['ollama-buro'],
    contextTokensByProvider: { ollama: 32768 },
    runProvider: async (input: any) => {
      dispatched = true;
      assert.equal(input.contextTokensByProvider.ollama, 32768);
      assert.equal(input.budgets.maxGenerationRequests, 24);
      assert.equal(input.budgets.maxOutputTokens, 2048);
      assert.equal(input.budgets.codingWallTimeMs, 300000);
      return { status: 'blocked' };
    },
  });
  assert.equal(dispatched, true);
  assert.equal(report.contextTokensByProvider.ollama, 32768);
  assert.equal(report.results[0].accepted, false);
});

test('parent oracle rejects baseline and validates the two-file fix and immutable inputs', async (t) => {
  const fixture = await fixtureIn(t);
  const before = await canonicalOracle(fixture, fixture.root, 'public', {
    execute: syntheticExecution,
  });
  assert.equal(before.passed, false);
  assert.equal(before.passedChecks, 0);
  await fix(fixture.root);
  const publicResult = await canonicalOracle(fixture, fixture.root, 'public', {
    execute: syntheticExecution,
  });
  const holdout = await canonicalOracle(fixture, fixture.root, 'holdout', {
    execute: syntheticExecution,
  });
  assert.equal(publicResult.passed, true);
  assert.equal(holdout.passed, true);
  assert.equal(publicResult.checks, IDENTITY.publicChecks);
  assert.equal(holdout.checks, IDENTITY.holdoutChecks);
  assert.deepEqual(publicResult.scope.changedFiles, ['src/priority.mjs', 'src/queue.mjs']);
  // A tempting implementation passes examples but mutates the task array while sorting.
  await writeFile(
    path.join(fixture.root, 'src/queue.mjs'),
    "import { priorityOf } from './priority.mjs';export function selectReady(tasks, completedIds=[]) { const done=new Set(completedIds); tasks.sort((a,b)=>priorityOf(b)-priorityOf(a)); return tasks.filter(t=>!done.has(t.id)&&(t.dependsOn||[]).every(id=>done.has(id))); }\n",
  );
  assert.equal(
    (await canonicalOracle(fixture, fixture.root, 'holdout', { execute: syntheticExecution }))
      .passed,
    false,
  );
});

test('public-check spoofing and unexpected empty files cannot pass the scope boundary', async (t) => {
  const fixture = await fixtureIn(t);
  await fix(fixture.root);
  await writeFile(path.join(fixture.root, 'checks/public.cjs'), "console.log('passed')\n");
  const result = await canonicalOracle(fixture, fixture.root, 'public', {
    execute: () => {
      throw Error('Must reject protected edits before execution');
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.scope.unexpectedCount, 1);
  assert.deepEqual(result.scope.changedFiles, [
    '[unexpected-path]',
    'src/priority.mjs',
    'src/queue.mjs',
  ]);
  const other = await fixtureIn(t);
  await writeFile(path.join(other.root, 'unexpected-empty'), '');
  assert.equal((await inspectScope(other.root)).passed, false);
  await symlink('/etc/passwd', path.join(other.root, 'src/link'));
  await assert.rejects(inspectScope(other.root), { code: 'COMPARISON_UNSAFE_CANDIDATE' });
});

test('oracle ignores printed success and mismatched RPC envelopes', async (t) => {
  const fixture = await fixtureIn(t);
  await fix(fixture.root);
  const forged = await canonicalOracle(fixture, fixture.root, 'holdout', {
    execute: async () => JSON.stringify({ nonce: 'other-session', passed: true, outputs: [] }),
  });
  assert.equal(forged.passed, false);
  assert.equal(forged.passedChecks, 0);
});

test('candidate JSON and array monkeypatches cannot hide input mutation from the oracle', async (t) => {
  const fixture = await fixtureIn(t);
  await fix(fixture.root);
  await writeFile(
    path.join(fixture.root, 'src/priority.mjs'),
    "JSON.stringify=()=> 'constant'; Array.prototype.map=()=>[]; export function priorityOf(task) { const value=task.priority ?? 2; task.mutated=true; return value; }\n",
  );
  const result = await canonicalOracle(fixture, fixture.root, 'public', {
    execute: syntheticExecution,
  });
  assert.equal(result.passed, false);
  assert.equal(result.rows.find((row: any) => row.name === 'explicit-zero').passed, false);
});

test('candidate toJSON hooks cannot hide mutation of recursively frozen inputs', async (t) => {
  const fixture = await fixtureIn(t);
  await fix(fixture.root);
  await writeFile(
    path.join(fixture.root, 'src/priority.mjs'),
    "Object.prototype.toJSON=function(){if ('task' in this) return {task:{priority:this.task.priorityBefore ?? 0}};return this;}; export function priorityOf(task) {const value=task.priority ?? 2;task.priorityBefore=value;task.priority=99;return value;}\n",
  );
  const result = await canonicalOracle(fixture, fixture.root, 'public', {
    execute: syntheticExecution,
  });
  assert.equal(result.passed, false);
  assert.equal(result.passedChecks, 0);
});

test('native usage is unknown rather than zero, and Buro review remains a separate result', () => {
  const native = summarizeProvider(
    { status: 'completed', budget: { generationRequests: 0, reservedOutputTokens: 0 } },
    true,
  );
  assert.equal(native.budgetCoverage.requestsEnforced, false);
  assert.equal(native.budgetCoverage.tokensEnforced, false);
  assert.equal(native.budgetCoverage.generationRequests, null);
  assert.equal(native.budgetCoverage.reservedOutputTokens, null);
  assert.equal(native.orchestration, null);
  const observed = summarizeProvider(
    { status: 'completed', nativeUsage: { inputTokens: 123, outputTokens: 45 } },
    true,
  );
  assert.equal(observed.budgetCoverage.observedInputTokens, 123);
  assert.equal(observed.budgetCoverage.observedOutputTokens, 45);
  assert.equal(observed.budgetCoverage.requestsEnforced, false);
  const managed = summarizeProvider(
    {
      status: 'passed',
      budget: { generationRequests: 7 },
      run: { independentReviewer: true, reviewVerdict: 'approved', acceptedCommit: true },
    },
    false,
  );
  assert.equal(managed.budgetCoverage.generationRequests, 7);
  assert.equal(managed.orchestration.reviewApproved, true);
});

test('inner trial reports live beside the outer report with relative public references', () => {
  const trial = comparisonTrialReport(
    '/tmp/artifacts/model-comparison.json',
    'codex-buro',
    'legacy',
  );
  assert.equal(trial.file, '/tmp/artifacts/model-comparison-trials/codex-buro-legacy.json');
  assert.equal(trial.reference, 'model-comparison-trials/codex-buro-legacy.json');
  assert.equal(comparisonTrialReport(undefined, 'codex-direct', 'not-applicable'), undefined);
});

test('the complete matrix keeps task/oracle/wall constant without overriding model-selected actions', async (t) => {
  const roots: string[] = [];
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  const providerInputs: any[] = [];
  const oracleCalls: string[] = [];
  let directModel: any;
  const report = await runModelComparison({
    env,
    runDirect: async ({ fixture, config }: any) => {
      roots.push(fixture.root);
      directModel = { model: config.models.codex, reasoningEffort: config.reasoningEffort };
      await fix(fixture.root);
      return { status: 'completed', privateText: 'never retain this prompt or credential' };
    },
    runProvider: async (input: any) => {
      providerInputs.push(input);
      const directory = await mkdtemp(path.join(os.tmpdir(), 'buro-comparison-fake-'));
      const fixture = await input.sourceCase.prepare({ temporaryDirectory: directory });
      roots.push(fixture.root);
      await fix(fixture.root);
      await input.onRunFinished({ run: { workspace: fixture.root }, fixture });
      return {
        status: 'passed',
        run: { independentReviewer: true, reviewVerdict: 'approved', acceptedCommit: true },
        budget: { generationRequests: 7, reservedOutputTokens: 14336 },
        privateText: 'never retain this prompt or credential',
      };
    },
    oracle: async (fixture: any, workspace: string, phase: string) => {
      oracleCalls.push(phase);
      return canonicalOracle(fixture, workspace, phase, { execute: syntheticExecution });
    },
  });
  assert.equal(report.results.length, 5);
  assert.ok(report.results.every((result: any) => result.accepted));
  assert.equal(providerInputs.length, 4);
  assert.equal(oracleCalls.length, 10);
  assert.equal(new Set(roots).size, 5);
  assert.deepEqual(directModel, { model: 'gpt-6.1-sol', reasoningEffort: 'high' });
  for (const input of providerInputs) {
    assert.equal(input.forceWorker, true);
    assert.equal(input.budgets.codingWallTimeMs, 300000);
    assert.equal(input.sourceCase.id, IDENTITY.caseId);
    assert.equal(input.sourceCase.synthetic, true);
    assert.equal(input.codex.networkAccess, false);
    assert.equal(input.codex.model, directModel.model);
    assert.equal(input.codex.reasoningEffort, directModel.reasoningEffort);
    assert.equal(input.env.BURO_LIVE_SOURCE_TRANSFER, '1');
  }
  for (const mode of ['deepseek', 'ollama', 'mixed']) {
    assert.deepEqual(
      providerInputs.filter((input) => input.mode === mode).map((input) => input.planningMode),
      [undefined],
    );
  }
  assert.deepEqual(
    report.results
      .filter((result: any) => result.arm === 'codex-buro')
      .map((result: any) => result.executionMode),
    ['model-selected-actions'],
  );
  assert.doesNotMatch(JSON.stringify(report), /never retain|privateText|fixtureDirectory/);
});

test('failed Buro workflows still get the same final oracle and cannot be accepted by a correct diff alone', async (t) => {
  const roots: string[] = [];
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  const report = await runModelComparison({
    env,
    arms: ['deepseek-buro'],
    runProvider: async (input: any) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'buro-comparison-failed-'));
      const fixture = await input.sourceCase.prepare({ temporaryDirectory: directory });
      roots.push(fixture.root);
      await fix(fixture.root);
      await input.onRunFinished({ run: { workspace: fixture.root }, fixture });
      return {
        status: 'failed',
        run: { independentReviewer: false, acceptedCommit: false },
        error: { code: 'LIVE_RUN_NOT_ACCEPTED' },
      };
    },
    oracle: (fixture: any, workspace: string, phase: string) =>
      canonicalOracle(fixture, workspace, phase, { execute: syntheticExecution }),
  });
  assert.equal(report.results[0].canonical.public.passed, true);
  assert.equal(report.results[0].canonical.holdout.passed, true);
  assert.equal(report.results[0].accepted, false);
  assert.equal(report.results[0].orchestration.independentReviewer, false);
});

test('synthetic preparing failures receive the final baseline oracle without a workspace', async (t) => {
  const roots: string[] = [];
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  const report = await runModelComparison({
    env,
    arms: ['ollama-buro'],
    runProvider: async (input: any) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'buro-comparison-early-'));
      const fixture = await input.sourceCase.prepare({ temporaryDirectory: directory });
      roots.push(fixture.root);
      return { status: 'failed', error: { code: 'ENVIRONMENT_UNAVAILABLE' } };
    },
    oracle: (fixture: any, workspace: string, phase: string) =>
      canonicalOracle(fixture, workspace, phase, { execute: syntheticExecution }),
  });
  assert.equal(report.results[0].canonicalOrigin, 'fixture-baseline');
  assert.equal(report.results[0].canonical.public.passed, false);
  assert.equal(report.results[0].canonical.holdout.passed, false);
  assert.equal(report.results[0].accepted, false);
});

test('oracle hard wall kills and awaits a process that ignores graceful termination', async () => {
  const started = Date.now();
  await assert.rejects(
    confinedOutput(
      {
        executable: process.execPath,
        args: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        cwd: os.tmpdir(),
        env: { PATH: process.env.PATH },
      },
      {},
      { timeoutMs: 100 },
    ),
    { code: 'COMPARISON_ORACLE_TIMEOUT' },
  );
  assert.ok(Date.now() - started < 2500);
});
