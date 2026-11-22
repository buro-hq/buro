const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  prepareComparisonFixture,
  canonicalOracle,
  candidateFiles,
  IDENTITY,
  TASK,
} = require('./model-comparison.cjs');
const {
  runLiveProviderEvaluation,
  normalizedLimits,
  contextBudgets,
  evaluationTargetContract,
} = require('./live-provider-runner.cjs');
const exec = promisify(execFile);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const codeError = (code) => Object.assign(new Error(code), { code });
const CASE_ID = 'synthetic-ready-queue-review-repair-v2';
const SEED = Object.freeze({
  'src/priority.mjs': 'export function priorityOf(task) {\n  return task.priority ?? 2;\n}\n',
  'src/queue.mjs':
    "import { priorityOf } from './priority.mjs';\n\nexport function selectReady(tasks, completedIds = []) {\n  const done = new Set(completedIds);\n  return tasks\n    .filter(task => !done.has(task.id) && (task.dependsOn || []).every(id => done.has(id)))\n    .sort((a, b) => priorityOf(a) - priorityOf(b));\n}\n",
});
const GOAL = Object.freeze({
  title: 'Audit and repair the existing queue candidate',
  body:
    TASK.body.replace(
      'Work only on src/priority.mjs and src/queue.mjs;',
      'Edit only src/queue.mjs; src/priority.mjs is already correct and must remain unchanged;',
    ) +
    ' This is an audit of an existing candidate: before changing source files, request service checks and a fresh independent review of the current candidate. If the reviewer finds blocking issues, investigate its actual findings, correct the implementation, and obtain new checks and fresh review before submitting the result. Do not manufacture a rejection or claim approval you did not observe.',
  criteria:
    TASK.criteria.replace(
      'Only src/priority.mjs and src/queue.mjs change.',
      'Only src/queue.mjs changes; src/priority.mjs must remain unchanged.',
    ) +
    ' The initial unchanged candidate is independently reviewed before edits; actual blocking findings are resolved and a different corrected source revision is independently approved.',
});

/** A separate declared case; the original comparison fixture and its identity remain unchanged. */
async function prepareRepairFixture(input) {
  const fixture = await prepareComparisonFixture(input);
  for (const [name, value] of Object.entries(SEED))
    await fs.writeFile(path.join(fixture.root, name), value);
  await exec('git', ['add', 'src/priority.mjs', 'src/queue.mjs'], { cwd: fixture.root });
  await exec('git', ['commit', '-m', 'Seed public-passing queue candidate for independent audit'], {
    cwd: fixture.root,
  });
  const { stdout } = await exec('git', ['rev-parse', 'HEAD^{tree}'], { cwd: fixture.root });
  const initialTree = stdout.trim();
  const files = await candidateFiles(fixture.root);
  const identity = {
    caseId: CASE_ID,
    fixtureHash: hash(files),
    sourceHash: hash(Object.entries(SEED)),
    taskHash: hash(GOAL),
    oracleHash: IDENTITY.oracleHash,
    allowedPaths: ['src/queue.mjs'],
    publicChecks: IDENTITY.publicChecks,
    holdoutChecks: IDENTITY.holdoutChecks,
  };
  identity.caseHash = hash(identity);
  return Object.assign(fixture, {
    caseId: CASE_ID,
    identity,
    initialTree,
    expectedChangedPaths: ['src/queue.mjs'],
    expectedBaseline: { passed: 1, total: 1 },
    goal: { ...GOAL },
    profile: {
      ...fixture.profile,
      scope: {
        ...fixture.profile.scope,
        plannedPaths: ['src/queue.mjs'],
        protectedPaths: [...fixture.profile.scope.protectedPaths, 'src/priority.mjs'],
      },
    },
  });
}

/** Derive coverage from actual service events, never from the model's completion claims. */
function repairEvidence(run, initialTree) {
  const ordered = [];
  let checked, reviewerThread;
  for (const [index, event] of (run.events || []).entries()) {
    if (event.type === 'action.requested') {
      try {
        const proposal = JSON.parse(event.text);
        if (typeof proposal.action === 'string')
          ordered.push({ index, type: 'action', action: proposal.action });
      } catch {}
    } else if (event.type === 'checks.completed') {
      const matched =
        /^Checks: (\d+)\/(\d+); boundaries: respected; source tree: ([a-f0-9]{40,64})$/.exec(
          event.text || '',
        );
      checked = matched
        ? {
            index,
            type: 'checks',
            passed: Number(matched[1]),
            total: Number(matched[2]),
            tree: matched[3],
          }
        : undefined;
      if (checked) ordered.push(checked);
    } else if (event.type === 'agent.started' && event.text === 'Independent reviewer') {
      reviewerThread = typeof event.threadId === 'string' ? event.threadId : undefined;
    } else if (event.type === 'review.completed') {
      const verdict = /^(approved|changes_requested):/.exec(event.text || '')?.[1];
      if (verdict && checked && reviewerThread)
        ordered.push({
          index,
          type: 'review',
          verdict,
          tree: checked.tree,
          checkIndex: checked.index,
          reviewerThread,
        });
    }
  }
  const rejected = ordered.find(
    (entry) =>
      entry.type === 'review' &&
      entry.verdict === 'changes_requested' &&
      entry.tree === initialTree,
  );
  const approval =
    rejected &&
    ordered.find(
      (entry) =>
        entry.type === 'review' &&
        entry.verdict === 'approved' &&
        entry.index > rejected.index &&
        entry.checkIndex > rejected.index &&
        entry.tree !== initialTree &&
        entry.tree === run.verificationEvidence?.tree &&
        entry.reviewerThread !== rejected.reviewerThread,
    );
  const approvedCheck =
    approval &&
    ordered.find((entry) => entry.type === 'checks' && entry.index === approval.checkIndex);
  const accepted =
    run.status === 'completed' &&
    !!run.commit &&
    run.independentReviewer === true &&
    run.review?.verdict === 'approved';
  const repairObserved = !!(
    rejected &&
    approval &&
    approvedCheck.total > 0 &&
    approvedCheck.passed === approvedCheck.total &&
    accepted &&
    run.verificationEvidence?.tree === approval.tree
  );
  return {
    initialTree,
    ordered,
    initialRejectionObserved: !!rejected,
    correctedApprovalObserved: !!approval,
    acceptedTree: run.verificationEvidence?.tree || null,
    repairObserved,
  };
}

/** One opt-in local/RTX route. No implicit retries, quota increases, downloads or user project access. */
async function runModelRepair(options = {}) {
  const env = options.env || process.env;
  if (env.BURO_MODEL_REPAIR !== '1' || env.BURO_LIVE_OLLAMA !== '1')
    throw codeError('REPAIR_OPT_IN_REQUIRED');
  const target = options.target === undefined ? 'local' : options.target;
  const model =
    options.model ??
    env.BURO_OLLAMA_MODEL ??
    (target === 'rtx' ? undefined : 'qwen3:4b-instruct-2507-q4_K_M');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model))
    throw codeError('REPAIR_INVALID_MODEL');
  const endpoints = {
    ollama:
      options.endpoint || (target === 'rtx' ? env.BURO_RTX_ENDPOINT : 'http://127.0.0.1:11434'),
  };
  evaluationTargetContract({
    target,
    env,
    endpoints,
    models: { ollama: model },
    sourceCase: { synthetic: true },
    mode: 'ollama',
  });
  const limits = normalizedLimits({
    contextTokens: 32768,
    maxOutputTokens: 2048,
    ...options.budgets,
  });
  const contexts = contextBudgets(endpoints, limits, options.contextTokensByProvider);
  const reportPath = path.resolve(options.reportPath || 'artifacts/model-repair.json');
  const providerPath = path.join(
    path.dirname(reportPath),
    path.basename(reportPath, path.extname(reportPath)) + '-provider.json',
  );
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  // Both names are claimed before any fixture/provider request. Existing reports are never overwritten.
  const claims = [];
  try {
    for (const file of [reportPath, providerPath]) {
      const handle = await fs.open(file, 'wx', 0o600);
      await handle.close();
      claims.push(file);
    }
  } catch (error) {
    for (const file of claims) await fs.unlink(file);
    if (error.code === 'EEXIST') throw codeError('REPAIR_REPORT_EXISTS');
    throw error;
  }
  const report = {
    version: 1,
    caseId: CASE_ID,
    syntheticOnly: true,
    target,
    model,
    forceWorker: false,
    startedAt: new Date().toISOString(),
    limits,
    contextTokensByProvider: contexts,
    accepted: false,
    repairCoverage: false,
  };
  let fixture;
  const runner = options.runProvider || runLiveProviderEvaluation;
  const oracle = options.oracle || canonicalOracle;
  try {
    report.provider = await runner({
      mode: 'ollama',
      env,
      target,
      endpoints,
      models: { ollama: model },
      budgets: limits,
      contextTokensByProvider: contexts,
      forceWorker: false,
      segmentPolicy: options.segmentPolicy,
      reportPath: providerPath,
      sourceCase: {
        id: CASE_ID,
        synthetic: true,
        async prepare(input) {
          fixture = await prepareRepairFixture(input);
          report.fixture = fixture.identity;
          report.initialTree = fixture.initialTree;
          report.seed = {
            public: await oracle(fixture, fixture.root, 'public'),
            holdout: await oracle(fixture, fixture.root, 'holdout'),
          };
          if (report.seed.public.passed !== true || report.seed.holdout.passed !== false)
            throw codeError('REPAIR_INVALID_SEED');
          return fixture;
        },
      },
      async onRunFinished({ run }) {
        report.evidence = repairEvidence(run, fixture.initialTree);
        const workspace = run.workspace || fixture.root;
        report.canonical = {
          public: await oracle(fixture, workspace, 'public'),
          holdout: await oracle(fixture, workspace, 'holdout'),
        };
      },
    });
    report.accepted =
      report.provider.status === 'passed' &&
      report.canonical?.public.passed === true &&
      report.canonical?.holdout.passed === true;
    report.repairCoverage = report.accepted && report.evidence?.repairObserved === true;
    report.status = report.repairCoverage
      ? 'passed'
      : report.accepted
        ? 'repair-not-covered'
        : report.provider.status;
  } catch (error) {
    report.status = 'failed';
    report.error = {
      code: /^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'REPAIR_FAILED',
    };
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  return report;
}
module.exports = { CASE_ID, GOAL, SEED, prepareRepairFixture, repairEvidence, runModelRepair };
