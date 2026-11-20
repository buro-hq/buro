const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { getSourceEvaluationCase } = require('./source-evaluation-cases.cjs');
const { runLiveProviderEvaluation, sourceCaseEvidence } = require('./live-provider-runner.cjs');
const {
  validateComparison,
  candidateFiles,
  runDirectCodex,
  summarizeProvider,
  writeComparisonReport,
  comparisonTrialReport,
  writeDirectTrialReport,
} = require('./model-comparison.cjs');

const CASE_ID = 'reviewed-source-case';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stableEntries = (object) => Object.entries(object).sort(([a], [b]) => a.localeCompare(b));
const fail = (code) => Object.assign(new Error(code), { code });
const errorCode = (error) =>
  /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code || '')
    ? error.code
    : 'PROJECT_COMPARISON_VALIDATION_FAILED';

function validateProjectComparison(options = {}) {
  const env = options.env || process.env;
  if (env.BURO_PROJECT_MODEL_COMPARISON !== '1') throw fail('PROJECT_COMPARISON_OPT_IN_REQUIRED');
  if (env.BURO_LIVE_SOURCE_TRANSFER !== '1') throw fail('LIVE_SOURCE_TRANSFER_NOT_AUTHORIZED');
  if ((options.caseId || CASE_ID) !== CASE_ID) throw fail('PROJECT_COMPARISON_CASE_NOT_AUTHORIZED');
  const config = validateComparison({ ...options, env: { ...env, BURO_MODEL_COMPARISON: '1' } });
  if (
    config.arms.some((arm) => ['deepseek-buro', 'mixed-buro'].includes(arm)) &&
    env.BURO_LIVE_DEEPSEEK !== '1'
  )
    throw fail('LIVE_OPT_IN_REQUIRED');
  if (
    config.arms.some((arm) => ['ollama-buro', 'mixed-buro'].includes(arm)) &&
    env.BURO_LIVE_OLLAMA !== '1'
  )
    throw fail('LIVE_OPT_IN_REQUIRED');
  return config;
}

function fixtureIdentity(fixture, manifest) {
  const evidence = sourceCaseEvidence(fixture);
  if (
    !evidence ||
    evidence.sourceFiles !== 9 ||
    !/^[a-f0-9]{40,64}$/.test(evidence.commit) ||
    Object.keys(evidence.controllerHashes).length < 1
  )
    throw fail('PROJECT_COMPARISON_INVALID_SOURCE_EVIDENCE');
  return {
    caseId: CASE_ID,
    sourceCommit: evidence.commit,
    sourceFiles: evidence.sourceFiles,
    sourceHash: digest(stableEntries(evidence.sourceHashes)),
    fixtureHash: digest(stableEntries(manifest)),
    taskHash: digest(fixture.goal),
    oracleHash: digest(stableEntries(evidence.controllerHashes)),
    contractHash: evidence.fixtureContractHash,
    allowedPaths: [...fixture.profile.allowedPaths],
  };
}

async function compareScope(fixture, workspace, initial) {
  const current = await candidateFiles(workspace);
  const names = [...new Set([...Object.keys(initial), ...Object.keys(current)])].sort();
  const changed = names.filter((file) => initial[file] !== current[file]);
  const allowed = fixture.profile.allowedPaths;
  const unexpected = changed.filter((file) => !allowed.includes(file));
  return {
    passed: unexpected.length === 0,
    changedFiles: changed.map((file) => (allowed.includes(file) ? file : '[unexpected-path]')),
    unexpectedCount: unexpected.length,
    sourceHash: digest(allowed.map((file) => [file, current[file] || null])),
  };
}

function oracleReceipt(result, mode) {
  if (!['public', 'holdout'].includes(mode))
    throw fail('PROJECT_COMPARISON_INVALID_ORACLE_RECEIPT');
  const checks = mode === 'public' ? 3 : 4;
  if (
    !Array.isArray(result?.rows) ||
    result.rows.length !== checks ||
    typeof result.passed !== 'boolean' ||
    !result.rows.every((row) => typeof row?.passed === 'boolean') ||
    result.passed !== result.rows.every((row) => row.passed) ||
    !/^[a-f0-9]{64}$/.test(result.sourceHash || '') ||
    result.exitCode !== (result.passed ? 0 : 1)
  )
    throw fail('PROJECT_COMPARISON_INVALID_ORACLE_RECEIPT');
  return {
    passed: result.passed,
    checks,
    passedChecks: result.rows.filter((row) => row.passed).length,
    sourceHash: result.sourceHash,
    exitCode: [0, 1].includes(result.exitCode) ? result.exitCode : null,
    durationMs:
      Number.isFinite(result.durationMs) && result.durationMs >= 0
        ? Math.round(result.durationMs)
        : null,
  };
}

/** Explicitly granted external fixtures only; none are bundled. */
async function runProjectModelComparison(options = {}) {
  const config = validateProjectComparison(options);
  const sourceCase = (options.getSourceCase || getSourceEvaluationCase)(CASE_ID);
  const liveRunner = options.runProvider || runLiveProviderEvaluation;
  const directRunner = options.runDirect || runDirectCodex;
  const report = {
    version: 1,
    syntheticOnly: false,
    caseId: CASE_ID,
    startedAt: new Date().toISOString(),
    fixture: null,
    limits: config.limits,
    comparability: {
      sameFixture: true,
      sameTask: true,
      sameOracle: true,
      sameCodingWall: true,
      oracleWallTimeMs: 30000,
      managedTokenCeilingsApplyToNative: false,
      nativeContextLimitEnforced: false,
      sameToolReadBoundary: false,
      nativeToolReadBoundary: 'native-default-host-read',
      managedToolReadBoundary: 'isolated-workspace-with-private-path-denials',
      buroRequiresWorker: true,
      nativeModel: config.models.codex || null,
      nativeReasoningEffort: config.reasoningEffort,
    },
    results: [],
  };
  for (const arm of config.arms) {
    let fixture, workspace, initial, actualPlanning;
    const started = Date.now();
    const result = {
      arm,
      planning:
        arm === 'codex-direct' ? 'not-applicable' : arm === 'codex-buro' ? 'legacy' : 'bounded',
      status: 'failed',
      accepted: false,
      canonical: {
        public: { passed: false, checks: 3, errorCode: 'PROJECT_COMPARISON_CANDIDATE_UNAVAILABLE' },
        holdout: {
          passed: false,
          checks: 4,
          errorCode: 'PROJECT_COMPARISON_CANDIDATE_UNAVAILABLE',
        },
      },
      originalSourcePreserved: null,
    };
    const trial = comparisonTrialReport(options.reportPath, arm, result.planning);
    if (trial) result.trialReport = trial.reference;
    const prepare = async (input) => {
      fixture = await sourceCase.prepare(input);
      if (
        typeof fixture.evaluateCandidate !== 'function' ||
        typeof fixture.assertOriginalUnchanged !== 'function'
      )
        throw fail('PROJECT_COMPARISON_INVALID_FIXTURE');
      initial = await candidateFiles(fixture.root);
      const identity = fixtureIdentity(fixture, initial);
      if (report.fixture && JSON.stringify(report.fixture) !== JSON.stringify(identity))
        throw fail('PROJECT_COMPARISON_FIXTURE_CHANGED');
      report.fixture ||= identity;
      return fixture;
    };
    try {
      let provider;
      if (arm === 'codex-direct') {
        const temporaryDirectory = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), 'buro-project-comparison-')),
        );
        await prepare({ temporaryDirectory, mode: 'codex', limits: config.limits });
        workspace = fixture.root;
        provider = await directRunner({ fixture, config, codex: options.codex });
        await writeDirectTrialReport(trial, fixture, config, provider);
      } else {
        provider = await liveRunner({
          mode: arm.slice(0, -5),
          env: options.env || process.env,
          credentials: options.credentials,
          models: config.models,
          endpoints: config.endpoints,
          codex: {
            ...options.codex,
            model: config.models.codex,
            reasoningEffort: config.reasoningEffort,
            networkAccess: false,
          },
          budgets: config.limits,
          contextTokensByProvider: { ollama: 16384 },
          forceWorker: true,
          planningMode: arm === 'codex-buro' ? 'legacy' : 'bounded',
          segmentPolicy: options.segmentPolicy,
          reportPath: trial?.file,
          sourceCase: { id: CASE_ID, prepare },
          async onRunFinished({ run }) {
            workspace = run?.workspace;
            if (['legacy', 'bounded'].includes(run?.planningPolicy?.mode))
              actualPlanning = run.planningPolicy.mode;
            if (/^[A-Za-z0-9._:-]{1,100}$/.test(run?.planningPolicy?.revision || ''))
              result.planningRevision = run.planningPolicy.revision;
          },
        });
      }
      Object.assign(result, summarizeProvider(provider, arm.startsWith('codex-')));
      result.actualPlanning = actualPlanning || null;
      result.model = arm.startsWith('codex-')
        ? config.models.codex
        : arm === 'mixed-buro'
          ? {
              coordinator: config.models.deepseek,
              worker: config.models.ollama,
              reviewer: config.models.deepseek,
            }
          : config.models[arm.slice(0, -5)];
    } catch (error) {
      result.errorCode = errorCode(error);
      result.accepted = false;
    } finally {
      if (fixture) {
        result.canonicalOrigin = workspace ? 'candidate-workspace' : 'fixture-baseline';
        workspace ||= fixture.root;
        try {
          result.scope = await compareScope(fixture, workspace, initial);
        } catch (error) {
          result.scope = { passed: false, errorCode: errorCode(error) };
        }
        for (const mode of ['public', 'holdout']) {
          try {
            result.canonical[mode] = oracleReceipt(
              await fixture.evaluateCandidate(workspace, mode),
              mode,
            );
          } catch (error) {
            result.canonical[mode] = { passed: false, errorCode: errorCode(error) };
          }
        }
        try {
          const after = await compareScope(fixture, workspace, initial);
          if (result.scope.sourceHash !== after.sourceHash || !after.passed)
            result.scope.passed = false;
        } catch (error) {
          result.scope = { passed: false, errorCode: errorCode(error) };
        }
        try {
          await fixture.assertOriginalUnchanged();
          result.originalSourcePreserved = true;
        } catch {
          result.originalSourcePreserved = false;
          result.accepted = false;
          result.errorCode = 'PROJECT_COMPARISON_ORIGINAL_SOURCE_CHANGED';
        }
        result.accepted =
          !result.errorCode &&
          result.originalSourcePreserved === true &&
          result.scope?.passed === true &&
          result.canonical.public?.passed === true &&
          result.canonical.holdout?.passed === true &&
          (arm === 'codex-direct' ? result.status === 'completed' : result.status === 'passed');
      }
      result.elapsedMs = Date.now() - started;
      report.results.push(result);
      if (options.reportPath) await writeComparisonReport(options.reportPath, report);
    }
  }
  report.finishedAt = new Date().toISOString();
  if (options.reportPath) await writeComparisonReport(options.reportPath, report);
  return report;
}

module.exports = {
  CASE_ID,
  validateProjectComparison,
  fixtureIdentity,
  compareScope,
  oracleReceipt,
  runProjectModelComparison,
};
