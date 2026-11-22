const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const {
  runLiveProviderEvaluation,
  prepareSyntheticFixture,
} = require('./lib/live-provider-runner.cjs');

// Synthetic data only. This script never selects a user's source case or a remote Ollama host.
async function main() {
  const mode = process.argv[2] || 'mixed';
  if (process.env.BURO_LIVE_SEGMENTS !== '1' || !['deepseek', 'mixed', 'ollama'].includes(mode))
    throw Object.assign(
      new Error('Opt-in required: BURO_LIVE_SEGMENTS=1, mode deepseek|mixed|ollama.'),
      {
        code: 'LIVE_OPT_IN_REQUIRED',
      },
    );
  const { contextWorkSegmentPolicy } = await import('../core/work-segments.ts');
  const { loadModelCredentials } = await import('../adapters/files/model-credentials.ts');
  const limits = {
    ...contextWorkSegmentPolicy.limits,
    revision: 'managed-work-segments-live-two-rounds-v1',
    maxToolRounds: 2,
  };
  const segmentPolicy = {
    ...contextWorkSegmentPolicy,
    revision: limits.revision,
    limits,
    // This explicit stress fixture forces rotations; production uses context pressure only.
    decide(input) {
      return input.toolRounds >= limits.maxToolRounds
        ? 'close'
        : contextWorkSegmentPolicy.decide(input);
    },
  };
  const sourceCase = {
    id: 'synthetic-work-segments',
    async prepare({ temporaryDirectory }) {
      const fixture = await prepareSyntheticFixture(temporaryDirectory, 'mixed');
      fixture.caseId = 'synthetic-work-segments';
      fixture.goal.body +=
        ' The worker must begin by reading src/value.mjs in a separate first tool round, without editing in that round. ' +
        'After reading, make the requested edit, inspect it and finish. Put this sequence into the worker assignment. ' +
        'Follow Buro step-closing instructions when they appear; a completed read is not a completed assignment.';
      const verify = fixture.verifyAccepted;
      fixture.verifyAccepted = async (run) => {
        await verify(run);
        return {
          passed: true,
          checks: 1,
          sourceHash: createHash('sha256')
            .update(await fs.readFile(path.join(run.workspace, 'src/value.mjs')))
            .digest('hex'),
        };
      };
      return fixture;
    },
  };
  const reportPath = `artifacts/live-segments-${mode}.json`;
  const credentials =
    mode === 'ollama' ? () => undefined : await loadModelCredentials(path.resolve('.buro/local'));
  const report = await runLiveProviderEvaluation({
    mode,
    env: { BURO_LIVE_DEEPSEEK: '1', BURO_LIVE_OLLAMA: '1', BURO_LIVE_SOURCE_TRANSFER: '1' },
    credentials,
    endpoints: { deepseek: 'https://api.deepseek.com', ollama: 'http://127.0.0.1:11434' },
    models: { deepseek: 'deepseek-flash', ollama: 'qwen3:4b-instruct-2507-q4_K_M' },
    budgets: { contextTokens: 32768, maxOutputTokens: 2048 },
    sourceCase,
    segmentPolicy,
    forceWorker: true,
    reportPath,
  });
  const archives = (report.checkpoints || []).reduce(
    (total, checkpoint) => total + (checkpoint.workSegments?.archiveCount || 0),
    0,
  );
  report.segmentValidation = {
    rotated: archives > 0,
    archiveCount: archives,
    syntheticOnly: true,
    localOllamaOnly: true,
    result: report.status === 'passed' && archives > 0 ? 'passed' : 'not-accepted',
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        mode,
        status: report.status,
        segmentValidation: report.segmentValidation,
        error: report.error,
        budget: report.budget,
        reportPath,
      },
      null,
      2,
    ),
  );
  if (report.segmentValidation.result !== 'passed') process.exitCode = 1;
}
main().catch((error) => {
  console.error(
    JSON.stringify({ status: 'failed', code: error.code || 'LIVE_SEGMENT_CHECK_FAILED' }),
  );
  process.exitCode = 1;
});
