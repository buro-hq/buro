const { parseArgs } = require('node:util');
const { runModelRepair } = require('./lib/model-repair.cjs');
const {
  EVALUATION_LIMIT_OPTIONS,
  evaluationLimitArguments,
} = require('./lib/live-provider-runner.cjs');
async function main() {
  const args = parseArgs({
    options: {
      target: { type: 'string', default: 'local' },
      'ollama-context': { type: 'string' },
      ...EVALUATION_LIMIT_OPTIONS,
    },
    allowPositionals: false,
  });
  const { contextWorkSegmentPolicy } = await import('../core/work-segments.ts');
  const report = await runModelRepair({
    target: args.values.target,
    budgets: evaluationLimitArguments(args.values),
    ...(args.values['ollama-context'] !== undefined
      ? { contextTokensByProvider: { ollama: Number(args.values['ollama-context']) } }
      : {}),
    reportPath: process.env.BURO_REPAIR_REPORT,
    segmentPolicy: contextWorkSegmentPolicy,
  });
  console.log(
    JSON.stringify(
      {
        caseId: report.caseId,
        status: report.status,
        accepted: report.accepted,
        repairCoverage: report.repairCoverage,
        error: report.provider?.error || report.error,
      },
      null,
      2,
    ),
  );
  if (!report.repairCoverage) process.exitCode = 1;
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      status: 'blocked',
      code: /^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'REPAIR_FAILED',
    }),
  );
  process.exitCode = 1;
});
