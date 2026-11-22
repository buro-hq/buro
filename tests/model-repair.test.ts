import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  prepareRepairFixture,
  repairEvidence,
  runModelRepair,
  CASE_ID,
} = require('../scripts/lib/model-repair.cjs');
const { canonicalOracle, IDENTITY } = require('../scripts/lib/model-comparison.cjs');
const initialTree = 'a'.repeat(40),
  fixedTree = 'b'.repeat(40);
const check = (tree: string, passed = 1) => ({
  type: 'checks.completed',
  text: `Checks: ${passed}/1; boundaries: respected; source tree: ${tree}`,
});
const reviewStart = (threadId: string) => ({
  type: 'agent.started',
  text: 'Independent reviewer',
  threadId,
});
const review = (verdict: string) => ({
  type: 'review.completed',
  text: verdict + ': actual service review',
});
const finished = (events: unknown[], tree = fixedTree) => ({
  status: 'completed',
  commit: 'accepted',
  independentReviewer: true,
  review: { verdict: 'approved' },
  verificationEvidence: { tree },
  events,
});

test('repair fixture is separately identified, passes public checks and retains a real ordering defect', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-repair-fixture-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await prepareRepairFixture({ temporaryDirectory: root });
  assert.equal(fixture.caseId, CASE_ID);
  assert.notEqual(fixture.identity.caseHash, IDENTITY.caseHash);
  assert.notEqual(fixture.identity.fixtureHash, IDENTITY.fixtureHash);
  assert.equal(fixture.identity.oracleHash, IDENTITY.oracleHash);
  assert.deepEqual(fixture.expectedChangedPaths, ['src/queue.mjs']);
  assert.deepEqual(fixture.identity.allowedPaths, ['src/queue.mjs']);
  assert.deepEqual(fixture.profile.scope.plannedPaths, ['src/queue.mjs']);
  assert.ok(fixture.profile.scope.protectedPaths.includes('src/priority.mjs'));
  assert.deepEqual(fixture.expectedBaseline, { passed: 1, total: 1 });
  assert.match(
    fixture.goal.body,
    /before changing source files, request service checks and a fresh independent review/i,
  );
  const before = await canonicalOracle(fixture, root, 'public');
  const holdout = await canonicalOracle(fixture, root, 'holdout');
  assert.equal(before.passed, true);
  assert.equal(before.passedChecks, 3);
  assert.equal(holdout.passed, false);
  assert.equal(holdout.passedChecks, 4);
  assert.deepEqual(
    holdout.rows
      .filter((row: { passed: boolean }) => !row.passed)
      .map((row: { name: string }) => row.name),
    ['zero-below-one'],
  );
  const file = path.join(root, 'src/queue.mjs');
  await fs.writeFile(
    file,
    (await fs.readFile(file, 'utf8')).replace(
      'priorityOf(a) - priorityOf(b)',
      'priorityOf(b) - priorityOf(a)',
    ),
  );
  assert.equal((await canonicalOracle(fixture, root, 'holdout')).passed, true);
});

test('repair coverage requires service rejection of the original tree, new successful checks and fresh approval of accepted changed bytes', () => {
  const events = [
    check(initialTree),
    reviewStart('review-initial'),
    review('changes_requested'),
    check(fixedTree),
    reviewStart('review-fixed'),
    review('approved'),
  ];
  const evidence = repairEvidence(finished(events), initialTree);
  assert.equal(evidence.initialRejectionObserved, true);
  assert.equal(evidence.correctedApprovalObserved, true);
  assert.equal(evidence.repairObserved, true);
  assert.deepEqual(
    evidence.ordered.map((entry: { type: string }) => entry.type),
    ['checks', 'review', 'checks', 'review'],
  );
  for (const run of [
    finished([check(fixedTree), reviewStart('review-fixed'), review('approved')]),
    finished([
      check(initialTree),
      reviewStart('review-initial'),
      review('changes_requested'),
      reviewStart('review-fixed'),
      review('approved'),
    ]),
    finished([
      check(initialTree),
      reviewStart('review-initial'),
      review('changes_requested'),
      check(initialTree),
      reviewStart('review-fixed'),
      review('approved'),
    ]),
    finished([
      check(initialTree),
      reviewStart('review-initial'),
      review('changes_requested'),
      check(fixedTree, 0),
      reviewStart('review-fixed'),
      review('approved'),
    ]),
    finished([
      check(initialTree),
      reviewStart('review-initial'),
      review('changes_requested'),
      check(fixedTree),
      reviewStart('review-initial'),
      review('approved'),
    ]),
    finished(events, initialTree),
    { ...finished(events), independentReviewer: false },
    { ...finished(events), commit: undefined },
    { ...finished(events), status: 'needs-attention' },
  ])
    assert.equal(repairEvidence(run, initialTree).repairObserved, false);
});

test('repair evidence discards malformed checks and never serializes action arguments or reviewer text', () => {
  const evidence = repairEvidence(
    finished([
      {
        type: 'action.requested',
        text: JSON.stringify({ action: 'review', input: { private: 'not-in-report' } }),
      },
      check(initialTree),
      reviewStart('review-initial'),
      { type: 'checks.completed', text: 'invalid tree receipt' },
      review('changes_requested'),
      check(fixedTree),
      review('approved'),
    ]),
    initialTree,
  );
  assert.equal(evidence.initialRejectionObserved, false);
  assert.equal(JSON.stringify(evidence).includes('not-in-report'), false);
  assert.equal(JSON.stringify(evidence).includes('actual service review'), false);
});

test('repair invocation refuses missing opt-in and existing reports before fixture or provider effects', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-repair-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const runProvider = async () => {
    calls++;
    throw Error('must not execute');
  };
  const reportPath = path.join(root, 'report.json');
  await assert.rejects(runModelRepair({ env: {}, reportPath, runProvider }), {
    code: 'REPAIR_OPT_IN_REQUIRED',
  });
  const env = { BURO_MODEL_REPAIR: '1', BURO_LIVE_OLLAMA: '1' };
  await fs.writeFile(reportPath, 'original');
  await assert.rejects(runModelRepair({ env, reportPath, runProvider }), {
    code: 'REPAIR_REPORT_EXISTS',
  });
  assert.equal(await fs.readFile(reportPath, 'utf8'), 'original');
  assert.equal(calls, 0);
  await fs.unlink(reportPath);
  await fs.writeFile(path.join(root, 'report-provider.json'), 'provider original');
  await assert.rejects(runModelRepair({ env, reportPath, runProvider }), {
    code: 'REPAIR_REPORT_EXISTS',
  });
  await assert.rejects(fs.stat(reportPath), { code: 'ENOENT' });
  assert.equal(
    await fs.readFile(path.join(root, 'report-provider.json'), 'utf8'),
    'provider original',
  );
  assert.equal(calls, 0);
});

test('RTX repair route rejects a different endpoint or model before report creation or provider calls', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-repair-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { BURO_MODEL_REPAIR: '1', BURO_LIVE_OLLAMA: '1', BURO_RTX_MODEL_COMPARISON: '1' };
  const reportPath = path.join(root, 'report.json');
  let calls = 0;
  const runProvider = async () => {
    calls++;
  };
  await assert.rejects(
    runModelRepair({
      env,
      target: 'rtx',
      endpoint: 'http://192.168.0.228:11434',
      reportPath,
      runProvider,
    }),
    { code: 'LIVE_RTX_ENDPOINT_REQUIRED' },
  );
  await assert.rejects(
    runModelRepair({
      env,
      target: 'rtx',
      endpoint: 'http://192.168.50.10:11434',
      model: 'other:4b',
      reportPath,
      runProvider,
    }),
    { code: 'LIVE_RTX_MODEL_REQUIRED' },
  );
  assert.equal(calls, 0);
  await assert.rejects(fs.stat(reportPath), { code: 'ENOENT' });
});

test('a correct accepted candidate that skipped initial review is explicitly repair-not-covered', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-repair-controller-')),
  );
  const summaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-repair-summary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(summaryRoot, { recursive: true, force: true }));
  const reportPath = path.join(summaryRoot, 'result.json');
  const report = await runModelRepair({
    env: { BURO_MODEL_REPAIR: '1', BURO_LIVE_OLLAMA: '1' },
    reportPath,
    async runProvider(input: any) {
      assert.equal(input.forceWorker, false);
      assert.equal(input.contextTokensByProvider.ollama, 32768);
      assert.equal(input.budgets.maxGenerationRequests, undefined);
      const fixture = await input.sourceCase.prepare({ temporaryDirectory: root });
      const file = path.join(root, 'src/queue.mjs');
      await fs.writeFile(
        file,
        (await fs.readFile(file, 'utf8')).replace(
          'priorityOf(a) - priorityOf(b)',
          'priorityOf(b) - priorityOf(a)',
        ),
      );
      await input.onRunFinished({
        run: {
          ...finished([check(fixedTree), reviewStart('review-fixed'), review('approved')]),
          workspace: root,
        },
      });
      return { status: 'passed', live: false };
    },
  });
  assert.equal(report.seed.public.passed, true);
  assert.equal(report.seed.holdout.passed, false);
  assert.equal(report.accepted, true);
  assert.equal(report.repairCoverage, false);
  assert.equal(report.status, 'repair-not-covered');
  const stored = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.equal(stored.provider.live, false);
  assert.equal(stored.repairCoverage, false);
});
