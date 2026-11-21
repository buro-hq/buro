const path = require('node:path');
const {
  runTeamQualityComparison,
  validateTeamQualityComparison,
} = require('./lib/team-quality-comparison.cjs');

async function main() {
  if (process.argv.length > 4)
    throw Object.assign(new Error('Invalid arguments'), {
      code: 'TEAM_COMPARISON_INVALID_ARGUMENTS',
    });
  const options = {
    variants: process.argv[2] ? process.argv[2].split(',') : undefined,
    repetitions:
      process.argv[3] === undefined
        ? 1
        : /^\d$/.test(process.argv[3])
          ? Number(process.argv[3])
          : NaN,
    reportPath: path.resolve(
      process.env.BURO_TEAM_REPORT || 'artifacts/team-quality-comparison.json',
    ),
  };
  validateTeamQualityComparison(options);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const report = await runTeamQualityComparison({ ...options, signal: controller.signal });
    console.log(
      JSON.stringify(
        {
          reportPath: options.reportPath,
          researchOnly: true,
          summary: report.summary,
          interrupted: report.interrupted,
        },
        null,
        2,
      ),
    );
    if (report.interrupted || report.results.some((result) => !result.experimentPassed))
      process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      status: 'blocked',
      code: /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code || '') ? error.code : 'TEAM_COMPARISON_FAILED',
    }),
  );
  process.exitCode = 1;
});
