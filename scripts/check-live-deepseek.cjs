const path = require('node:path');
const { runLiveProviderEvaluation } = require('./lib/live-provider-runner.cjs');

(async () => {
  const { loadModelCredentials } = await import('../adapters/files/model-credentials.ts');
  const directory = path.join(
    path.resolve(process.env.PROJECT_DATA_DIR || path.join(__dirname, '..', '.buro')),
    'local',
  );
  const credentials = await loadModelCredentials(directory);
  const mode = process.env.BURO_LIVE_MODE || 'deepseek';
  const report = await runLiveProviderEvaluation({
    mode,
    models: { deepseek: process.env.BURO_DEEPSEEK_MODEL, ollama: process.env.BURO_OLLAMA_MODEL },
    endpoints: {
      deepseek: process.env.BURO_DEEPSEEK_ENDPOINT || 'https://api.deepseek.com',
      ollama: process.env.BURO_OLLAMA_ENDPOINT || 'http://127.0.0.1:11434',
    },
    credentials,
    budgets: process.env.BURO_LIVE_CONTEXT_TOKENS
      ? { contextTokens: Number(process.env.BURO_LIVE_CONTEXT_TOKENS) }
      : undefined,
    reportPath: process.env.BURO_LIVE_REPORT || `artifacts/live-${mode}-verification.json`,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
})().catch((error) => {
  console.error(
    JSON.stringify({
      status: 'failed',
      error: {
        code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'LIVE_RUNNER_FAILED',
      },
    }),
  );
  process.exitCode = 1;
});
