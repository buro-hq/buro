import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  VARIANTS,
  validateTeamQualityComparison,
  expectedBudgetPolicy,
  trialOrder,
  runTeamQualityComparison,
} = require('../scripts/lib/team-quality-comparison.cjs');
const {
  IDENTITY,
  prepareComparisonFixture,
  canonicalOracle,
  confinedOutput,
  inspectScope,
} = require('../scripts/lib/model-comparison.cjs');
const env = { BURO_TEAM_QUALITY: '1', BURO_LIVE_OLLAMA: '1' };

async function fix(root: string) {
  const priority = path.join(root, 'src/priority.mjs'),
    queue = path.join(root, 'src/queue.mjs');
  await fs.writeFile(priority, (await fs.readFile(priority, 'utf8')).replace('|| 2', '?? 2'));
  await fs.writeFile(queue, (await fs.readFile(queue, 'utf8')).replace('.some(', '.every('));
}

function budget(limits: any, variant: string) {
  const review = variant === 'executor-checks' ? 0 : 2;
  const counters = (requests: number, toolCalls: number) => ({
    requests,
    reservedOutputTokens: requests * 100,
    toolCalls,
  });
  return {
    version: 1,
    coverage: 'managed-api',
    policy: expectedBudgetPolicy(limits, variant),
    status: 'open',
    used: counters(5, 3),
    workUsed: counters(5 - review, 3 - (review ? 1 : 0)),
    reviewUsed: counters(review, review ? 1 : 0),
    observed: {
      inputTokens: 200,
      outputTokens: 50,
      completeUsageRequests: 5,
      unknownUsageRequests: 0,
    },
  };
}

function outcome(input: any) {
  return {
    status: 'experiment-passed',
    experimentPassed: true,
    reviewApproved: true,
    cleanupDone: true,
    workspace: input.fixture.root,
    budget: budget(input.limits, input.variant),
    reportedModels: [input.model],
    modelDigest: 'a'.repeat(64),
    repairs: 1,
    reviewRounds: input.variant === 'executor-checks' ? 0 : 1,
    checkRuns: 2,
    generatedProbeCount: input.variant === 'team-review' ? 2 : 0,
    stages: [
      {
        role: 'executor',
        durationMs: 12.5,
        status: 'completed',
        privateText: 'private secret prompt',
      },
    ],
    actions: { total: 3, completed: 3, failed: 0, edits: 1, arguments: 'private secret prompt' },
    privateText: 'private secret prompt',
  };
}

// The test fixture code is fixed and trusted; inspect confinement, then execute that synthetic
// module without nested OS sandboxing so this suite remains runnable inside an outer sandbox.
const syntheticExecution = async (launch: any, input: any, options: any) => {
  const index = launch.args.indexOf(process.execPath);
  assert.ok(index >= 0);
  assert.ok(['/usr/bin/sandbox-exec', 'bwrap'].includes(launch.executable));
  if (launch.executable === '/usr/bin/sandbox-exec') {
    assert.match(launch.args[1], /\(deny network\*\)/);
    assert.match(launch.args[1], /\(deny file-write\*\)/);
  }
  return confinedOutput(
    {
      executable: process.execPath,
      args: launch.args.slice(index + 1),
      cwd: launch.cwd,
      env: launch.env,
    },
    input,
    options,
  );
};

async function fixtures(t: test.TestContext) {
  const roots: string[] = [];
  t.after(() => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))));
  return async (input: any) => {
    roots.push(input.temporaryDirectory);
    return prepareComparisonFixture(input);
  };
}

test('team matrix preflight requires both opt-ins and refuses source, cloud, remote endpoints and raised caps before I/O', async () => {
  for (const options of [
    { env: {} },
    { env: { BURO_TEAM_QUALITY: '1' } },
    { env, variants: [] },
    { env, variants: ['executor-checks', 'executor-checks'] },
    { env, variants: ['arbitrary'] },
    { env, repetitions: 0 },
    { env, repetitions: 4 },
    { env, repetitions: 1.5 },
    { env, endpoint: 'http://192.168.50.10:11434' },
    { env, endpoint: 'http://token@127.0.0.1:11434' },
    { env, endpoint: 'https://api.deepseek.com' },
    { env, endpoint: 'http://127.0.0.1:11434/private' },
    { env, model: 'qwen3:cloud' },
    { env, sourceCase: { id: 'user-project' } },
    { env, limits: { maxGenerationRequests: 25 } },
    { env, limits: { maxToolCalls: 65 } },
    { env, limits: { maxToolCallsPerTurn: 25 } },
    { env, limits: { maxOutputTokens: 4096 } },
    { env, limits: { contextTokens: 65536 } },
    { env, limits: { silentlyIgnored: 1 } },
  ]) {
    let touched = false;
    await assert.rejects(
      runTeamQualityComparison({
        ...options,
        prepareFixture: () => {
          touched = true;
        },
        runTrial: () => {
          touched = true;
        },
      }),
    );
    assert.equal(touched, false);
  }
  const config = validateTeamQualityComparison({ env });
  assert.deepEqual(config.variants, VARIANTS);
  assert.equal(config.model, 'qwen3:4b-instruct-2507-q4_K_M');
  assert.equal(config.limits.contextTokens, 16384);
  assert.equal(config.limits.maxToolCalls, 64);
});

test('three modes share model/task/oracles/global caps and retain only sanitized research outcomes after cleanup', async (t) => {
  const prepareFixture = await fixtures(t);
  let running = false,
    cleaned = false;
  const inputs: any[] = [];
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-team-report-'));
  t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }));
  const report = await runTeamQualityComparison({
    env,
    prepareFixture,
    reportPath: path.join(outputDirectory, 'result.json'),
    async runTrial(input: any) {
      assert.equal(running, false);
      running = true;
      cleaned = false;
      inputs.push(input);
      await fix(input.fixture.root);
      running = false;
      cleaned = true;
      return outcome(input);
    },
    async oracle(fixture: any, workspace: string, phase: string) {
      assert.equal(running, false);
      assert.equal(cleaned, true);
      return canonicalOracle(fixture, workspace, phase, { execute: syntheticExecution });
    },
  });
  assert.equal(report.results.length, 3);
  assert.equal(report.productionAcceptanceEnabled, false);
  assert.equal(report.researchOnly, true);
  assert.equal(report.comparability.sameWeightsVerified, true);
  assert.deepEqual(
    inputs.map((input) => input.variant),
    VARIANTS,
  );
  for (const input of inputs) {
    assert.equal(input.model, report.model);
    assert.equal(input.fixture.identity, IDENTITY);
    assert.deepEqual(input.limits, inputs[0].limits);
    assert.equal(input.endpoint, 'http://127.0.0.1:11434/');
  }
  assert.equal(new Set(inputs.map((input) => input.fixture.root)).size, 3);
  assert.ok(
    report.results.every(
      (result: any) =>
        result.commonCodePassed && result.experimentPassed && !result.productionAccepted,
    ),
  );
  assert.equal(report.results[0].reviewApproved, false);
  assert.equal(report.results[0].reviewRequired, false);
  assert.equal(report.results[1].reviewRequired, true);
  assert.equal(report.results[0].budget.policy.reviewReserve.requests, 0);
  assert.equal(report.results[1].budget.policy.reviewReserve.requests, 4);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('private secret prompt'), false);
  assert.equal(serialized.includes('arguments'), false);
  assert.equal(serialized.includes('privateText'), false);
  assert.ok(
    report.results.every((result: any) => !JSON.stringify(result).includes('candidateWorkspace')),
  );
  const inner = JSON.parse(
    await fs.readFile(path.join(outputDirectory, report.results[0].trialReport), 'utf8'),
  );
  assert.equal(inner.fixtureDirectory, inputs[0].fixture.root);
  assert.equal(inner.productionAccepted, false);
  assert.equal(JSON.stringify(inner).includes('private secret prompt'), false);
});

test('failed or review-rejected workflows still receive the final common oracle without becoming successful', async (t) => {
  for (const reason of ['budget', 'review', 'policy', 'model']) {
    const prepareFixture = await fixtures(t);
    let checks = 0;
    const report = await runTeamQualityComparison({
      env,
      prepareFixture,
      variants: ['executor-review'],
      async runTrial(input: any) {
        await fix(input.fixture.root);
        const result = outcome(input);
        if (reason === 'budget') {
          result.status = 'budget-exhausted';
          result.experimentPassed = false;
        }
        if (reason === 'review') result.reviewApproved = false;
        if (reason === 'policy') result.budget.policy.maxRequests--;
        if (reason === 'model') result.reportedModels = ['unexpected-other-model'];
        return result;
      },
      async oracle(fixture: any, workspace: string, phase: string) {
        checks++;
        return canonicalOracle(fixture, workspace, phase, { execute: syntheticExecution });
      },
    });
    assert.equal(checks, 2);
    assert.equal(report.results[0].commonCodePassed, true);
    assert.equal(report.results[0].experimentPassed, false, reason);
    assert.equal(report.results[0].productionAccepted, false);
  }
});

test('cleanup uncertainty and foreign candidate roots cannot trigger an oracle on active or unrelated files', async (t) => {
  const foreign = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-team-foreign-'));
  t.after(() => fs.rm(foreign, { recursive: true, force: true }));
  for (const reason of ['cleanup', 'foreign', 'throw']) {
    let checks = 0;
    const report = await runTeamQualityComparison({
      env,
      prepareFixture: await fixtures(t),
      variants: ['executor-checks'],
      async runTrial(input: any) {
        if (reason === 'throw')
          throw Object.assign(new Error('private secret prompt'), {
            code: 'UNEXPECTED_RUNTIME_ERROR',
          });
        const result = outcome(input);
        if (reason === 'cleanup') result.cleanupDone = false;
        if (reason === 'foreign') result.workspace = foreign;
        return result;
      },
      async oracle() {
        checks++;
        throw Error('Must not execute');
      },
    });
    assert.equal(checks, 0);
    assert.equal(report.results[0].experimentPassed, false);
    assert.equal(JSON.stringify(report).includes('private secret prompt'), false);
  }
});

test('repetitions rotate sequential order while preserving fixture identity and allowances', async (t) => {
  const order: string[] = [];
  const report = await runTeamQualityComparison({
    env,
    repetitions: 3,
    prepareFixture: await fixtures(t),
    async runTrial(input: any) {
      order.push(input.variant);
      return { ...outcome(input), status: 'failed', experimentPassed: false };
    },
    async oracle(_fixture: any, workspace: string, phase: string) {
      return {
        passed: false,
        checks: phase === 'public' ? 3 : 5,
        passedChecks: 0,
        scope: await inspectScope(workspace),
      };
    },
  });
  assert.deepEqual(order, [
    ...trialOrder(VARIANTS, 0),
    ...trialOrder(VARIANTS, 1),
    ...trialOrder(VARIANTS, 2),
  ]);
  assert.deepEqual(
    report.summary.map((summary: any) => summary.trials),
    [3, 3, 3],
  );
  assert.equal(report.results.length, 9);
});

test('an expired coding wall awaits runtime cleanup before final checks, while prior cancellation starts nothing', async (t) => {
  let cleaned = false,
    checks = 0;
  const report = await runTeamQualityComparison({
    env,
    variants: ['executor-checks'],
    prepareFixture: await fixtures(t),
    limits: { codingWallTimeMs: 20 },
    async runTrial(input: any) {
      await new Promise<void>((resolve) =>
        input.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      cleaned = true;
      return { ...outcome(input), status: 'timed-out', experimentPassed: false };
    },
    async oracle(_fixture: any, workspace: string, phase: string) {
      assert.equal(cleaned, true);
      checks++;
      return {
        passed: false,
        checks: phase === 'public' ? 3 : 5,
        passedChecks: 0,
        scope: await inspectScope(workspace),
      };
    },
  });
  assert.equal(checks, 2);
  assert.equal(report.results[0].status, 'timed-out');
  assert.equal(report.results[0].experimentPassed, false);
  const controller = new AbortController();
  controller.abort();
  const aborted = await runTeamQualityComparison({
    env,
    signal: controller.signal,
    prepareFixture: () => {
      throw Error('No fixture');
    },
  });
  assert.equal(aborted.results.length, 0);
  assert.equal(aborted.interrupted, true);
});

test('changed or inconsistent final receipts cannot establish code correctness', async (t) => {
  const report = await runTeamQualityComparison({
    env,
    variants: ['executor-checks'],
    prepareFixture: await fixtures(t),
    async runTrial(input: any) {
      await fix(input.fixture.root);
      return outcome(input);
    },
    async oracle(_fixture: any, workspace: string, phase: string) {
      const scope = await inspectScope(workspace);
      return {
        passed: true,
        checks: phase === 'public' ? 3 : 5,
        passedChecks: phase === 'public' ? 3 : 5,
        scope: { ...scope, sourceHash: (phase === 'public' ? 'a' : 'b').repeat(64) },
      };
    },
  });
  assert.equal(report.results[0].commonCodePassed, false);
  assert.equal(report.results[0].finalEvidenceStable, false);
  assert.equal(report.results[0].experimentPassed, false);
});

test('a late success after the coding deadline remains timed out even when final code passes', async (t) => {
  let checks = 0;
  const report = await runTeamQualityComparison({
    env,
    variants: ['executor-checks'],
    prepareFixture: await fixtures(t),
    limits: { codingWallTimeMs: 20 },
    async runTrial(input: any) {
      await fix(input.fixture.root);
      if (!input.signal.aborted)
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      return outcome(input);
    },
    async oracle(_fixture: any, workspace: string, phase: string) {
      checks++;
      return {
        passed: true,
        checks: phase === 'public' ? 3 : 5,
        passedChecks: phase === 'public' ? 3 : 5,
        scope: await inspectScope(workspace),
      };
    },
  });
  assert.equal(checks, 2);
  assert.equal(report.results[0].commonCodePassed, true);
  assert.equal(report.results[0].status, 'timed-out');
  assert.equal(report.results[0].errorCode, 'TEAM_COMPARISON_WALL_EXHAUSTED');
  assert.equal(report.results[0].experimentPassed, false);
});
