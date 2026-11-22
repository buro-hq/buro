import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const {
  validateComparison,
  runModelComparison,
  prepareComparisonFixture,
  IDENTITY,
} = require('../scripts/lib/model-comparison.cjs');
const {
  preflight,
  evaluationTargetContract,
  createBudgetedFetch,
  runLiveProviderEvaluation,
} = require('../scripts/lib/live-provider-runner.cjs');
const RTX_EVALUATION_ENDPOINT = 'http://192.168.50.10:11434/';
const RTX_EVALUATION_MODEL = 'fixture-tools:14b-q4_K_M';
const env = {
  BURO_MODEL_COMPARISON: '1',
  BURO_RTX_MODEL_COMPARISON: '1',
  BURO_LIVE_OLLAMA: '1',
  BURO_LIVE_DEEPSEEK: '1',
  BURO_OLLAMA_MODEL: RTX_EVALUATION_MODEL,
};
const rtx = { target: 'rtx', endpoints: { ollama: RTX_EVALUATION_ENDPOINT } };
const models = { ollama: RTX_EVALUATION_MODEL };
const exec = promisify(execFile);

test('unified CLI blocks missing comparison opt-in before credentials or live calls', async () => {
  await assert.rejects(
    exec(
      process.execPath,
      ['scripts/check-model-comparison.cjs', 'ollama-buro', '--target', 'rtx'],
      {
        env: { PATH: process.env.PATH || '/usr/bin:/bin' },
        timeout: 10000,
      },
    ),
    (error: any) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.deepEqual(JSON.parse(error.stderr), {
        status: 'blocked',
        code: 'COMPARISON_OPT_IN_REQUIRED',
      });
      return true;
    },
  );
});

test('unified CLI rejects obsolete controls and unsafe targets before opening credentials', async () => {
  for (const [args, extra, code] of [
    [['ollama-buro', 'legacy'], {}, 'COMPARISON_INVALID_ARGUMENTS'],
    [['ollama-buro', 'bounded'], {}, 'COMPARISON_INVALID_ARGUMENTS'],
    [['ollama-buro', '--target'], {}, 'COMPARISON_INVALID_ARGUMENTS'],
    [['ollama-buro', '--target', 'arbitrary-lan'], {}, 'COMPARISON_INVALID_TARGET'],
    [['ollama-buro', '--ollama-context=invalid'], {}, 'LIVE_INVALID_CONTEXT_BUDGET'],
    [['ollama-buro', '--ollama-context=32769'], {}, 'LIVE_INVALID_CONTEXT_BUDGET'],
    [
      ['ollama-buro', '--target', 'rtx'],
      { BURO_RTX_ENDPOINT: RTX_EVALUATION_ENDPOINT, BURO_RTX_MODEL_COMPARISON: undefined },
      'LIVE_RTX_OPT_IN_REQUIRED',
    ],
    [['ollama-buro', '--target=rtx'], {}, 'LIVE_RTX_ENDPOINT_REQUIRED'],
    [
      ['ollama-buro', '--target=rtx'],
      { BURO_RTX_ENDPOINT: RTX_EVALUATION_ENDPOINT, BURO_OLLAMA_MODEL: undefined },
      'LIVE_RTX_MODEL_REQUIRED',
    ],
    [
      ['ollama-buro', '--target=rtx'],
      { BURO_RTX_ENDPOINT: 'http://203.0.113.10:11434' },
      'LIVE_RTX_ENDPOINT_REQUIRED',
    ],
  ] as const) {
    await assert.rejects(
      exec(process.execPath, ['scripts/check-model-comparison.cjs', ...args], {
        env: { PATH: process.env.PATH || '/usr/bin:/bin', ...env, ...extra },
        timeout: 10000,
      }),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.deepEqual(JSON.parse(error.stderr), { status: 'blocked', code });
        return true;
      },
    );
  }
});

test('RTX comparison requires explicit LAN configuration while ordinary comparison remains loopback-only', () => {
  assert.throws(
    () =>
      validateComparison({
        env,
        arms: ['ollama-buro'],
        endpoints: { ollama: rtx.endpoints.ollama },
      }),
    { code: 'COMPARISON_LOCAL_OLLAMA_ONLY' },
  );
  for (const removed of [
    'BURO_MODEL_COMPARISON',
    'BURO_RTX_MODEL_COMPARISON',
    'BURO_LIVE_OLLAMA',
  ]) {
    const missing = { ...env, [removed]: undefined };
    assert.throws(() => validateComparison({ env: missing, arms: ['ollama-buro'], ...rtx }));
  }
  assert.throws(
    () =>
      validateComparison({
        env: { ...env, BURO_LIVE_DEEPSEEK: undefined },
        arms: ['mixed-buro'],
        ...rtx,
      }),
    { code: 'COMPARISON_RTX_DEEPSEEK_OPT_IN_REQUIRED' },
  );
  for (const endpoint of [
    undefined,
    'http://203.0.113.10:11434',
    'http://100.64.0.1:11434',
    'http://169.254.1.1:11434',
    'https://192.168.50.10:11434',
    'http://user:secret@192.168.50.10:11434',
    'http://192.168.50.10:11434/?token=secret',
    'http://192.168.50.10:11434/#private',
    'http://192.168.50.10:11434/?',
    'http://192.168.50.10:11434/#',
    'http://@192.168.50.10:11434/',
    'http://192.168.50.10:11434/elsewhere',
    'http://rtx.local:11434',
    'http://127.0.0.1:11434',
  ])
    assert.throws(() =>
      validateComparison({
        env,
        arms: ['ollama-buro'],
        target: 'rtx',
        endpoints: { ollama: endpoint },
      }),
    );
  assert.throws(
    () =>
      validateComparison({
        env,
        ...rtx,
        endpoints: { ollama: 'http://elsewhere.invalid:11434' },
      }),
    { code: 'LIVE_RTX_ENDPOINT_REQUIRED' },
  );
  for (const arms of [['codex-buro'], ['deepseek-buro'], ['ollama-buro', 'ollama-buro']])
    assert.throws(() => validateComparison({ env, arms, ...rtx }), {
      code: arms.length === 2 ? 'COMPARISON_INVALID_ARMS' : 'COMPARISON_RTX_INVALID_ARMS',
    });
  for (const model of [undefined, '', 'unsafe model', 'model?token=secret'])
    assert.throws(
      () =>
        validateComparison({
          env: { ...env, BURO_OLLAMA_MODEL: undefined },
          ...rtx,
          models: { ollama: model },
        }),
      { code: 'LIVE_RTX_MODEL_REQUIRED' },
    );
  const config = validateComparison({
    env: {
      ...env,
      BURO_OLLAMA_ENDPOINT: 'http://elsewhere.invalid',
      BURO_OLLAMA_MODEL: RTX_EVALUATION_MODEL,
    },
    ...rtx,
  });
  assert.equal(config.target, 'rtx');
  const local = validateComparison({ env, arms: ['ollama-buro'] });
  assert.equal(local.target, 'local');
  assert.equal(local.endpoints.ollama, 'http://127.0.0.1:11434/');
  assert.deepEqual(config.arms, ['mixed-buro', 'ollama-buro']);
  assert.equal(config.endpoints.ollama, RTX_EVALUATION_ENDPOINT);
  assert.equal(config.models.ollama, RTX_EVALUATION_MODEL);
  assert.equal(config.limits.codingWallTimeMs, undefined);
  assert.equal(config.limits.maxGenerationRequests, undefined);
  assert.equal(config.limits.maxOutputTokens, 2048);
  assert.equal(config.limits.contextTokens, 32768);
});

test('an explicit evaluation target is a strict enum and cannot grant general LAN trust', () => {
  for (const target of [null, '', 'lan', {}, ['rtx']]) {
    assert.throws(() => validateComparison({ env, target, arms: ['ollama-buro'] }), {
      code: 'COMPARISON_INVALID_TARGET',
    });
    assert.equal(
      preflight({ mode: 'ollama', env, models, ...rtx, target }).code,
      'COMPARISON_INVALID_TARGET',
    );
  }
  assert.equal(
    preflight({ mode: 'ollama', env, models, ...rtx, target: 'local' }).code,
    'COMPARISON_LOCAL_OLLAMA_ONLY',
  );
  const local = preflight({
    mode: 'ollama',
    env,
    models,
    target: 'local',
    endpoints: { ollama: 'http://127.0.0.1:11434' },
  });
  assert.equal(local.ok, true);
  assert.equal(local.ollamaTrust, undefined);
});

test('explicit endpoint and model choices are canonicalized and frozen without a host or model default', () => {
  for (const endpoint of [
    'http://10.42.0.17:12500',
    'http://172.24.0.12:11435/',
    'http://[fd12:3456::10]:11434',
  ]) {
    const configured = {
      ...env,
      BURO_RTX_ENDPOINT: endpoint,
      BURO_OLLAMA_MODEL: 'another-tools-model:32b',
    };
    const config = validateComparison({ env: configured, target: 'rtx', arms: ['ollama-buro'] });
    assert.equal(config.endpoints.ollama, new URL(endpoint).href);
    assert.equal(config.models.ollama, 'another-tools-model:32b');
    assert.equal(Object.isFrozen(config.endpoints), true);
    assert.equal(Object.isFrozen(config.models), true);
    configured.BURO_RTX_ENDPOINT = 'http://10.42.0.99:11434';
    configured.BURO_OLLAMA_MODEL = 'replacement:latest';
    assert.equal(config.endpoints.ollama, new URL(endpoint).href);
    assert.equal(config.models.ollama, 'another-tools-model:32b');
  }
  const route = evaluationTargetContract({ env, ...rtx, models });
  assert.equal(Object.isFrozen(route), true);
  const override = validateComparison({
    env: { ...env, BURO_RTX_ENDPOINT: 'http://10.42.0.1:11434' },
    ...rtx,
    models: { ollama: 'explicit-tools:latest' },
  });
  assert.equal(override.endpoints.ollama, RTX_EVALUATION_ENDPOINT);
  assert.equal(override.models.ollama, 'explicit-tools:latest');
});

test('unsafe or absent RTX configuration rejects before credential reads', () => {
  let credentialReads = 0;
  for (const configuration of [
    { endpoints: { ollama: 'http://203.0.113.10:11434' }, models },
    { endpoints: {}, models },
    { endpoints: rtx.endpoints, models: {} },
    { endpoints: rtx.endpoints, models: { ollama: 'invalid model' } },
  ]) {
    const result = preflight({
      mode: 'mixed',
      target: 'rtx',
      env: { ...env, BURO_OLLAMA_MODEL: undefined, BURO_DEEPSEEK_MODEL: 'fixture-cloud' },
      credentials() {
        credentialReads++;
        return 'fixture-only-key';
      },
      ...configuration,
    });
    assert.equal(result.ok, false);
    assert.match(result.code, /^LIVE_RTX_(?:ENDPOINT|MODEL)_REQUIRED$/);
  }
  assert.equal(credentialReads, 0);
});

test('transport stays bound to the selected endpoint and model after configuration changes', async () => {
  const endpoints = { ollama: RTX_EVALUATION_ENDPOINT };
  const selected = { ...models };
  let calls = 0;
  const transport = createBudgetedFetch({
    endpoints,
    models: selected,
    fetch: async () => {
      calls++;
      return new Response('{}');
    },
  });
  endpoints.ollama = 'http://10.42.0.99:11434/';
  selected.ollama = 'replacement:latest';
  for (const route of ['api/chat', 'api/show']) {
    await assert.rejects(
      transport(new URL(route, RTX_EVALUATION_ENDPOINT), {
        method: 'POST',
        body: JSON.stringify({ model: selected.ollama, options: { num_predict: 128 } }),
      }),
      { code: 'LIVE_MODEL_NOT_ALLOWED' },
    );
  }
  await assert.rejects(transport(new URL('api/tags', endpoints.ollama)), {
    code: 'LIVE_ENDPOINT_NOT_ALLOWED',
  });
  assert.equal(calls, 0);
  await transport(new URL('api/show', RTX_EVALUATION_ENDPOINT), {
    method: 'POST',
    body: JSON.stringify({ model: models.ollama }),
  });
  assert.equal(calls, 1);
});

test('invalid RTX request rejects before preparing a fixture, reading credentials or invoking a transport', async () => {
  let invoked = 0;
  await assert.rejects(
    runModelComparison({
      env,
      arms: ['ollama-buro'],
      target: 'rtx',
      endpoints: { ollama: 'http://wrong.invalid' },
      credentials: () => {
        invoked++;
      },
      runProvider: async () => {
        invoked++;
        throw Error('must not run');
      },
    }),
    { code: 'LIVE_RTX_ENDPOINT_REQUIRED' },
  );
  assert.equal(invoked, 0);
  assert.equal(
    preflight({
      mode: 'ollama',
      env,
      ...rtx,
      models,
      sourceCase: { id: 'real-project', synthetic: false },
    }).code,
    'LIVE_RTX_SYNTHETIC_REQUIRED',
  );
});

test('RTX queue matrix keeps exact case identity and budgets and passes trust only through its explicit contract', async (t) => {
  const roots: string[] = [];
  t.after(() => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))));
  const received: any[] = [];
  const report = await runModelComparison({
    env,
    ...rtx,
    runProvider: async (input: any) => {
      received.push(input);
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-rtx-matrix-fake-'));
      roots.push(root);
      const fixture = await input.sourceCase.prepare({ temporaryDirectory: root });
      assert.equal(fixture.identity, IDENTITY);
      await input.onRunFinished({ run: { workspace: root } });
      return { status: 'failed' };
    },
    oracle: async (_fixture: unknown, _root: string, phase: string) => ({
      passed: false,
      checks: phase === 'public' ? 3 : 5,
    }),
  });
  assert.deepEqual(
    received.map((input) => input.mode),
    ['mixed', 'ollama'],
  );
  for (const input of received) {
    assert.equal(input.target, 'rtx');
    assert.equal(input.endpoints.ollama, RTX_EVALUATION_ENDPOINT);
    assert.equal(input.models.ollama, RTX_EVALUATION_MODEL);
    assert.equal(input.contextTokensByProvider.ollama, 32768);
    assert.equal(input.forceWorker, true);
    assert.equal(input.env.BURO_LIVE_SOURCE_TRANSFER, '1');
    assert.equal(input.budgets.maxGenerationRequests, undefined);
    assert.equal(input.budgets.maxOutputTokens, 2048);
    assert.equal(input.budgets.codingWallTimeMs, undefined);
  }
  assert.equal(report.fixture, IDENTITY);
  assert.equal(report.comparability.ollamaTarget, 'explicit-rtx-private-network');
  assert.ok(report.results.every((result: any) => result.accepted === false));
});

test('actual injected RTX probe saves only a temporary explicitly trusted connection; normal LAN stays untrusted', async () => {
  for (const explicit of [false, true]) {
    let generations = 0;
    const report = await runLiveProviderEvaluation({
      mode: 'ollama',
      env,
      models,
      endpoints: { ollama: RTX_EVALUATION_ENDPOINT },
      ...(explicit ? { target: 'rtx' } : {}),
      budgets: { maxDiagnosticRequests: 1, contextTokens: 32768, maxOutputTokens: 2048 },
      contextTokensByProvider: { ollama: 16384 },
      sourceCase: { id: IDENTITY.caseId, synthetic: true, prepare: prepareComparisonFixture },
      fetch: async (url: URL) => {
        assert.equal(new URL(String(url)).origin, new URL(RTX_EVALUATION_ENDPOINT).origin);
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/api/tags')
          return new Response(JSON.stringify({ models: [{ name: RTX_EVALUATION_MODEL }] }));
        if (pathname === '/api/show')
          return new Response(
            JSON.stringify({
              capabilities: ['completion', 'tools'],
              model_info: { 'fixture.context_length': 32768 },
            }),
          );
        assert.equal(pathname, '/api/chat');
        generations++;
        return new Response(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { function: { name: 'diagnostic_echo', arguments: { value: 'buro-ready' } } },
              ],
            },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 20,
            eval_count: 10,
          }),
        );
      },
    });
    try {
      const config = JSON.parse(
        await fs.readFile(path.join(report.fixtureDirectory, '.buro/local/resources.json'), 'utf8'),
      );
      const connection = config.connections.find((item: any) => item.id === 'ollama');
      assert.equal(connection.config.endpoint, RTX_EVALUATION_ENDPOINT);
      assert.equal(connection.config.capacity, 1);
      assert.equal(connection.config.think, false);
      assert.equal(connection.config.trust, explicit ? 'private-network' : undefined);
      assert.equal(config.runtimes[0].config.limits.contextTokens, 16384);
      assert.equal(report.live, false);
      assert.equal(report.originalSourcePreserved, true);
      if (explicit) {
        assert.equal(report.error.code, 'LIVE_DIAGNOSTIC_BUDGET_EXHAUSTED');
        assert.equal(report.runId, undefined);
        assert.equal(generations, 1);
      } else {
        assert.equal(report.error.code, 'DATA_POLICY_BLOCKED');
        assert.equal(report.runId, undefined, JSON.stringify(report.error));
        assert.equal(generations, 0);
      }
    } finally {
      if (report.fixtureDirectory)
        await fs.rm(report.fixtureDirectory, { recursive: true, force: true });
    }
  }
});
