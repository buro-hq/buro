const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { normalizedLimits } = require('./live-provider-runner.cjs');
const { IDENTITY, prepareComparisonFixture, canonicalOracle } = require('./model-comparison.cjs');

const VARIANTS = Object.freeze(['executor-checks', 'executor-review', 'team-review']);
const ROLES = new Set(['coordinator', 'test-author', 'executor', 'reviewer', 'checks', 'repair']);
const STATUSES = new Set([
  'experiment-passed',
  'passed',
  'completed',
  'failed',
  'blocked',
  'budget-exhausted',
  'timed-out',
  'interrupted',
]);
const fail = (code) => Object.assign(new Error(code), { code });
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const errorCode = (error) =>
  /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code || '') ? error.code : 'TEAM_COMPARISON_FAILED';

/** Preflight is pure: no fixture, model discovery, network or credential access. */
function validateTeamQualityComparison(options = {}) {
  const env = options.env || process.env;
  if (env.BURO_TEAM_QUALITY !== '1' || env.BURO_LIVE_OLLAMA !== '1')
    throw fail('TEAM_COMPARISON_OPT_IN_REQUIRED');
  if (
    ['sourceCase', 'sourceRoot', 'goal', 'profile', 'fixture', 'cases'].some((key) =>
      Object.hasOwn(options, key),
    )
  )
    throw fail('TEAM_COMPARISON_SYNTHETIC_ONLY');
  const variants = options.variants || VARIANTS;
  if (
    !Array.isArray(variants) ||
    !variants.length ||
    new Set(variants).size !== variants.length ||
    variants.some((value) => !VARIANTS.includes(value))
  )
    throw fail('TEAM_COMPARISON_INVALID_VARIANTS');
  const repetitions = options.repetitions ?? 1;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 3)
    throw fail('TEAM_COMPARISON_INVALID_REPETITIONS');
  const model = options.model || env.BURO_TEAM_MODEL || 'qwen3:4b-instruct-2507-q4_K_M';
  if (
    typeof model !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model) ||
    /(?:^|[-_:/])cloud(?:$|[-_:/])/i.test(model)
  )
    throw fail('TEAM_COMPARISON_INVALID_MODEL');
  let endpoint;
  try {
    endpoint = new URL(options.endpoint || 'http://127.0.0.1:11434');
  } catch {
    throw fail('TEAM_COMPARISON_LOCAL_OLLAMA_ONLY');
  }
  if (
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw fail('TEAM_COMPARISON_LOCAL_OLLAMA_ONLY');
  const supplied = options.limits || {};
  const allowed = [
    'maxGenerationRequests',
    'maxReservedOutputTokens',
    'maxDiagnosticRequests',
    'diagnosticWallTimeMs',
    'codingWallTimeMs',
    'contextTokens',
    'maxOutputTokens',
    'maxToolCalls',
    'maxToolCallsPerTurn',
  ];
  if (Object.keys(supplied).some((key) => !allowed.includes(key)))
    throw fail('TEAM_COMPARISON_INVALID_LIMITS');
  const limits = normalizedLimits({
    contextTokens: 16384,
    maxOutputTokens: 2048,
    maxToolCalls: 64,
    maxToolCallsPerTurn: 24,
    ...supplied,
  });
  if (
    limits.contextTokens > 32768 ||
    limits.maxOutputTokens > 2048 ||
    limits.maxToolCalls > 64 ||
    limits.maxToolCallsPerTurn > 24 ||
    limits.maxGenerationRequests <= 4 ||
    limits.maxReservedOutputTokens <= 8192 ||
    limits.maxToolCalls <= 8
  )
    throw fail('TEAM_COMPARISON_INVALID_LIMITS');
  return { variants: [...variants], repetitions, model, endpoint: endpoint.href, limits };
}

function expectedBudgetPolicy(limits, variant) {
  return {
    version: 1,
    maxRequests: limits.maxGenerationRequests,
    maxReservedOutputTokens: limits.maxReservedOutputTokens,
    maxToolCalls: limits.maxToolCalls,
    reviewReserve:
      variant === 'executor-checks'
        ? { requests: 0, outputTokens: 0, toolCalls: 0 }
        : { requests: 4, outputTokens: 8192, toolCalls: 8 },
  };
}

function trialOrder(variants, repetition) {
  const shift = repetition % variants.length;
  return [...variants.slice(shift), ...variants.slice(0, shift)];
}

function trialReportPath(reportPath, variant, repetition) {
  if (!reportPath) return undefined;
  const outer = path.resolve(reportPath);
  const file = path.join(
    path.dirname(outer),
    path.basename(outer, path.extname(outer)) + '-trials',
    `${repetition + 1}-${variant}.json`,
  );
  return { file, reference: path.relative(path.dirname(outer), file) };
}

async function writeTeamReport(file, report) {
  const resolved = path.resolve(file);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const temporary = resolved + '.tmp-' + randomUUID();
  try {
    await fs.writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, resolved);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function canonicalReceipt(value, phase) {
  const checks = phase === 'public' ? IDENTITY.publicChecks : IDENTITY.holdoutChecks;
  if (
    !value ||
    value.checks !== checks ||
    count(value.passedChecks) === null ||
    value.passedChecks > checks ||
    typeof value.passed !== 'boolean' ||
    value.passed !== (value.passedChecks === checks && value.scope?.passed === true) ||
    !/^[a-f0-9]{64}$/.test(value.scope?.sourceHash || '')
  )
    return { passed: false, checks, errorCode: 'TEAM_COMPARISON_INVALID_ORACLE_RECEIPT' };
  return {
    passed: value.passed,
    checks,
    passedChecks: value.passedChecks,
    sourceHash: value.scope.sourceHash,
    scopePreserved: value.scope.passed === true,
  };
}

async function sanitizeTrial(trial, config, variant) {
  const { ManagedRunBudgetSummarySchema } = await import('../../protocol/run-budget.ts');
  const parsed = ManagedRunBudgetSummarySchema.safeParse(trial?.budget);
  const policy = expectedBudgetPolicy(config.limits, variant);
  const samePolicy =
    parsed.success && JSON.stringify(parsed.data.policy) === JSON.stringify(policy);
  const stages = (Array.isArray(trial?.stages) ? trial.stages : []).slice(0, 128).map((stage) => ({
    role: ROLES.has(stage.role) ? stage.role : 'unknown',
    durationMs:
      typeof stage.durationMs === 'number' &&
      Number.isFinite(stage.durationMs) &&
      stage.durationMs >= 0
        ? Math.round(stage.durationMs)
        : null,
    status: STATUSES.has(stage.status) ? stage.status : 'unknown',
  }));
  const actions = {};
  for (const key of ['total', 'completed', 'failed', 'edits'])
    if (count(trial?.actions?.[key]) !== null) actions[key] = trial.actions[key];
  const reported = Array.isArray(trial?.reportedModels) ? trial.reportedModels : [];
  return {
    status: STATUSES.has(trial?.status) ? trial.status : 'failed',
    ...(trial?.errorCode ? { errorCode: errorCode({ code: trial.errorCode }) } : {}),
    cleanupDone: trial?.cleanupDone === true,
    experimentSuccess: trial?.experimentPassed === true || trial?.experimentSuccess === true,
    reviewApproved: variant !== 'executor-checks' && trial?.reviewApproved === true,
    repairs: count(trial?.repairs),
    reviewRounds: count(trial?.reviewRounds),
    generatedProbeCount: count(trial?.generatedProbeCount),
    checkRuns: count(trial?.checkRuns),
    model: config.model,
    reportedModelCount: reported.length,
    reportedModelMatchesRequested: reported.length
      ? reported.every((model) => model === config.model)
      : null,
    modelDigest: /^[a-f0-9]{64}$/.test(trial?.modelDigest || '') ? trial.modelDigest : null,
    budget: parsed.success ? parsed.data : null,
    budgetMatchesConfiguration: samePolicy,
    stages,
    actions,
  };
}

/** Same model and global allowance; different orchestration. No production run is accepted here. */
async function runTeamQualityComparison(options = {}) {
  const config = validateTeamQualityComparison(options);
  const runTrial =
    options.runTrial ||
    ((input) => require('./team-experiment-runtime.cjs').runTeamExperimentTrial(input));
  const oracle = options.oracle || canonicalOracle;
  const prepare = options.prepareFixture || prepareComparisonFixture;
  const env = options.env || process.env;
  const report = {
    version: 1,
    researchOnly: true,
    productionAcceptanceEnabled: false,
    syntheticOnly: true,
    fixture: IDENTITY,
    startedAt: new Date().toISOString(),
    model: config.model,
    endpoint: config.endpoint,
    limits: config.limits,
    repetitions: config.repetitions,
    comparability: {
      sameRequestedModel: true,
      sameFixture: true,
      sameTask: true,
      sameOracle: true,
      sameContext: true,
      sameGlobalCaps: true,
      sequentialInference: true,
      noInferenceDiagnostics: true,
      reviewReserves: {
        baseline: { requests: 0, outputTokens: 0, toolCalls: 0 },
        reviewed: { requests: 4, outputTokens: 8192, toolCalls: 8 },
      },
      order: 'rotate selected variant order by repetition',
      limitations: [
        'one synthetic case',
        'correlated errors across sessions of the same model',
        'small sample; no reliability ranking',
        'baseline omits independent model review and is not production Buro acceptance',
      ],
    },
    results: [],
  };
  if (options.reportPath) await writeTeamReport(options.reportPath, report);
  for (let repetition = 0; repetition < config.repetitions; repetition++) {
    for (const variant of trialOrder(config.variants, repetition)) {
      if (options.signal?.aborted) break;
      const started = Date.now();
      const controller = new AbortController();
      const abort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      const trialPath = trialReportPath(options.reportPath, variant, repetition);
      const result = {
        variant,
        repetition: repetition + 1,
        sequence: report.results.length + 1,
        productionAccepted: false,
        commonCodePassed: false,
        experimentPassed: false,
        reviewRequired: variant !== 'executor-checks',
        canonical: {},
      };
      let fixture, trial, workspace, timer;
      try {
        controller.signal.throwIfAborted();
        const directory = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), 'buro-team-quality-')),
        );
        fixture = await prepare({ temporaryDirectory: directory });
        if (JSON.stringify(fixture.identity) !== JSON.stringify(IDENTITY))
          throw fail('TEAM_COMPARISON_FIXTURE_CHANGED');
        const root = await fs.realpath(fixture.root);
        if (root !== directory && !root.startsWith(directory + path.sep))
          throw fail('TEAM_COMPARISON_FIXTURE_OUTSIDE_TEMP');
        timer = setTimeout(
          () => controller.abort(fail('TEAM_COMPARISON_WALL_EXHAUSTED')),
          config.limits.codingWallTimeMs,
        );
        trial = await runTrial({
          fixture,
          variant,
          model: config.model,
          limits: { ...config.limits },
          endpoint: config.endpoint,
          env,
          signal: controller.signal,
          ...(options.provider ? { provider: options.provider } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        Object.assign(result, await sanitizeTrial(trial, config, variant));
        if (controller.signal.aborted) {
          result.status = options.signal?.aborted ? 'interrupted' : 'timed-out';
          result.errorCode = options.signal?.aborted
            ? 'TEAM_COMPARISON_ABORTED'
            : 'TEAM_COMPARISON_WALL_EXHAUSTED';
          result.experimentSuccess = false;
        }
        if (!result.cleanupDone) throw fail('TEAM_COMPARISON_CLEANUP_UNCONFIRMED');
        const candidate = await fs.realpath(trial.workspace || fixture.root);
        if (
          candidate !== root &&
          !candidate.startsWith(path.join(root, '.buro/worktrees') + path.sep)
        )
          throw fail('TEAM_COMPARISON_WORKSPACE_OUTSIDE_FIXTURE');
        workspace = candidate;
        result.canonicalOrigin =
          workspace === root ? 'fixture-baseline-or-direct' : 'candidate-worktree';
        if (!result.budgetMatchesConfiguration)
          result.errorCode = 'TEAM_COMPARISON_BUDGET_MISMATCH';
        if (result.reportedModelMatchesRequested === false)
          result.errorCode = 'TEAM_COMPARISON_MODEL_MISMATCH';
      } catch (error) {
        result.status = controller.signal.aborted ? 'timed-out' : 'failed';
        result.errorCode = errorCode(error);
      } finally {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          result.status = options.signal?.aborted ? 'interrupted' : 'timed-out';
          result.errorCode = options.signal?.aborted
            ? 'TEAM_COMPARISON_ABORTED'
            : 'TEAM_COMPARISON_WALL_EXHAUSTED';
          result.experimentSuccess = false;
        }
        options.signal?.removeEventListener('abort', abort);
        // Unknown cleanup is not evidence that a candidate stopped mutating; do not race its oracle.
        if (fixture && trial?.cleanupDone === true && workspace) {
          for (const phase of ['public', 'holdout']) {
            try {
              result.canonical[phase] = canonicalReceipt(
                await oracle(fixture, workspace, phase),
                phase,
              );
            } catch {
              result.canonical[phase] = {
                passed: false,
                errorCode: 'TEAM_COMPARISON_FINAL_ORACLE_FAILED',
              };
            }
          }
          result.finalEvidenceStable =
            !!result.canonical.public?.sourceHash &&
            result.canonical.public.sourceHash === result.canonical.holdout?.sourceHash;
          result.commonCodePassed =
            result.canonical.public?.passed === true &&
            result.canonical.holdout?.passed === true &&
            result.finalEvidenceStable;
          result.experimentPassed =
            !result.errorCode &&
            result.commonCodePassed &&
            result.experimentSuccess === true &&
            result.budgetMatchesConfiguration === true &&
            ['experiment-passed', 'passed', 'completed'].includes(result.status) &&
            (!result.reviewRequired || result.reviewApproved === true);
        } else result.canonicalUnavailable = 'runtime cleanup or candidate workspace unconfirmed';
        result.elapsedMs = Date.now() - started;
        if (trialPath) {
          result.trialReport = trialPath.reference;
          await writeTeamReport(trialPath.file, {
            version: 1,
            researchOnly: true,
            fixture: IDENTITY,
            fixtureDirectory: fixture?.root || null,
            candidateWorkspace: workspace || null,
            ...result,
          });
        }
        report.results.push(result);
        if (options.reportPath) await writeTeamReport(options.reportPath, report);
      }
    }
    if (options.signal?.aborted) break;
  }
  report.finishedAt = new Date().toISOString();
  report.interrupted = options.signal?.aborted === true;
  const digests = report.results.map((result) => result.modelDigest);
  report.comparability.sameWeightsVerified =
    digests.length > 0 && digests.every(Boolean) && new Set(digests).size === 1;
  report.summary = config.variants.map((variant) => {
    const results = report.results.filter((result) => result.variant === variant);
    return {
      variant,
      trials: results.length,
      codePassed: results.filter((result) => result.commonCodePassed).length,
      experimentPassed: results.filter((result) => result.experimentPassed).length,
      reviewApproved: results.filter((result) => result.reviewApproved).length,
    };
  });
  if (options.reportPath) await writeTeamReport(options.reportPath, report);
  return report;
}

module.exports = {
  VARIANTS,
  validateTeamQualityComparison,
  expectedBudgetPolicy,
  trialOrder,
  trialReportPath,
  canonicalReceipt,
  sanitizeTrial,
  runTeamQualityComparison,
};
