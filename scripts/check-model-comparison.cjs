const path = require('node:path');
const { parseArgs } = require('node:util');
const { validateComparison, runModelComparison } = require('./lib/model-comparison.cjs');
const {
  EVALUATION_LIMIT_OPTIONS,
  evaluationLimitArguments,
} = require('./lib/live-provider-runner.cjs');

async function main() {
  if (process.env.BURO_MODEL_COMPARISON !== '1')
    throw Object.assign(new Error('Explicit opt-in required.'), {
      code: 'COMPARISON_OPT_IN_REQUIRED',
    });
  let args;
  try {
    args = parseArgs({
      options: {
        target: { type: 'string', default: 'local' },
        'ollama-context': { type: 'string' },
        ...EVALUATION_LIMIT_OPTIONS,
      },
      allowPositionals: true,
    });
    if (args.positionals.length > 1) throw Error('Invalid arguments');
  } catch {
    throw Object.assign(new Error('Invalid comparison arguments.'), {
      code: 'COMPARISON_INVALID_ARGUMENTS',
    });
  }
  // This CLI selects only the fixed synthetic fixture, never an arbitrary user project.
  const options = {
    env: { ...process.env, BURO_LIVE_SOURCE_TRANSFER: '1' },
    arms: args.positionals[0] ? args.positionals[0].split(',') : undefined,
    target: args.values.target,
    budgets: evaluationLimitArguments(args.values),
    ...(args.values['ollama-context'] !== undefined
      ? { contextTokensByProvider: { ollama: Number(args.values['ollama-context']) } }
      : {}),
    ...(args.values.target === 'rtx'
      ? { endpoints: { ollama: process.env.BURO_RTX_ENDPOINT } }
      : {}),
  };
  // Validate target and all comparison opt-ins before opening the credential store.
  validateComparison(options);
  const { loadModelCredentials } = await import('../adapters/files/model-credentials.ts');
  const { contextWorkSegmentPolicy } = await import('../core/work-segments.ts');
  const reportPath = path.resolve(
    process.env.BURO_COMPARISON_REPORT || 'artifacts/model-comparison.json',
  );
  const report = await runModelComparison({
    ...options,
    credentials: await loadModelCredentials(path.resolve('.buro/local')),
    segmentPolicy: contextWorkSegmentPolicy,
    reportPath,
  });
  console.log(
    JSON.stringify(
      {
        reportPath,
        results: report.results.map(({ arm, executionMode, status, accepted, canonical }) => ({
          arm,
          executionMode,
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
