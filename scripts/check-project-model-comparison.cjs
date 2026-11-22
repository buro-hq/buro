const path = require('node:path');
const {
  validateProjectComparison,
  runProjectModelComparison,
} = require('./lib/project-model-comparison.cjs');

async function main() {
  const arms = process.argv[2] ? process.argv[2].split(',') : undefined;
  // Validate explicit source-transfer authorization before reading source or credentials.
  validateProjectComparison({ arms });
  const { loadModelCredentials } = await import('../adapters/files/model-credentials.ts');
  const { contextWorkSegmentPolicy } = await import('../core/work-segments.ts');
  const reportPath = path.resolve('artifacts/project-model-comparison.json');
  const report = await runProjectModelComparison({
    arms,
    credentials: await loadModelCredentials(path.resolve('.buro/local')),
    segmentPolicy: contextWorkSegmentPolicy,
    reportPath,
  });
  console.log(
    JSON.stringify(
      {
        reportPath,
        results: report.results.map(
          ({ arm, status, accepted, canonical, originalSourcePreserved }) => ({
            arm,
            status,
            accepted,
            publicPassed: canonical.public?.passed,
            holdoutPassed: canonical.holdout?.passed,
            originalSourcePreserved,
          }),
        ),
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
      code: /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code || '')
        ? error.code
        : 'PROJECT_COMPARISON_FAILED',
    }),
  );
  process.exitCode = 1;
});
