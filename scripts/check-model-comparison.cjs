const path = require('node:path');
const { runModelComparison } = require('./lib/model-comparison.cjs');

async function main() {
  if (process.env.BURO_MODEL_COMPARISON !== '1')
    throw Object.assign(new Error('Explicit opt-in required.'), {
      code: 'COMPARISON_OPT_IN_REQUIRED',
    });
  const selected = process.argv[2];
  const arms = selected ? selected.split(',') : undefined;
  // A selected fixture is always synthetic. This does not authorize transfer of any user project.
  const env = { ...process.env, BURO_LIVE_SOURCE_TRANSFER: '1' };
  const { loadModelCredentials } = await import('../adapters/files/model-credentials.ts');
  const { boundedWorkSegmentPolicy } = await import('../core/work-segments.ts');
  const reportPath = path.resolve('artifacts/model-comparison.json');
  const report = await runModelComparison({
    env,
    arms,
    credentials: await loadModelCredentials(path.resolve('.buro/local')),
    segmentPolicy: boundedWorkSegmentPolicy,
    reportPath,
  });
  console.log(
    JSON.stringify(
      {
        reportPath,
        results: report.results.map(({ arm, planning, status, accepted, canonical }) => ({
          arm,
          planning,
          status,
          accepted,
          publicPassed: canonical?.public?.passed,
          holdoutPassed: canonical?.holdout?.passed,
        })),
      },
      null,
      2,
    ),
  );
  if (report.results.some((result) => !result.accepted)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: 'blocked',
      code: /^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'COMPARISON_FAILED',
    }),
  );
  process.exitCode = 1;
});
