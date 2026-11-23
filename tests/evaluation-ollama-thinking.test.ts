import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { preflight, runLiveProviderEvaluation } = require('../scripts/lib/live-provider-runner.cjs');
const { validateComparison, runModelComparison } = require('../scripts/lib/model-comparison.cjs');
const { runModelRepair } = require('../scripts/lib/model-repair.cjs');
const settings = [undefined, false, true, 'low', '', 'x'.repeat(40)];
const requested = (value: unknown) =>
  value === undefined ? { mode: 'model-default' } : { mode: 'explicit', value };

test('evaluation leaves model-default thinking absent on actual Ollama wire and preserves explicit values', async () => {
  for (const ollamaThink of settings) {
    const bodies: Record<string, unknown>[] = [];
    const report = await runLiveProviderEvaluation({
      mode: 'ollama',
      env: { BURO_LIVE_OLLAMA: '1', BURO_OLLAMA_MODEL: 'fixture-model' },
      ...(ollamaThink === undefined ? {} : { ollamaThink }),
      budgets: { maxDiagnosticRequests: 1 },
      fetch: async (url: URL, init: RequestInit) => {
        const route = new URL(String(url)).pathname;
        if (route === '/api/tags')
          return new Response(JSON.stringify({ models: [{ name: 'fixture-model' }] }));
        if (route === '/api/show')
          return new Response(
            JSON.stringify({
              capabilities: ['completion', 'tools'],
              model_info: { 'fixture.context_length': 32768 },
            }),
          );
        assert.equal(route, '/api/chat');
        bodies.push(JSON.parse(String(init.body)));
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
      assert.equal(report.error?.code, 'LIVE_DIAGNOSTIC_BUDGET_EXHAUSTED');
      assert.equal(bodies.length, 1);
      assert.equal(Object.hasOwn(bodies[0], 'think'), ollamaThink !== undefined);
      if (ollamaThink !== undefined) assert.equal(bodies[0].think, ollamaThink);
      assert.deepEqual(report.requestedOllamaThinking, requested(ollamaThink));
      const saved = JSON.parse(
        await fs.readFile(path.join(report.fixtureDirectory, '.buro/local/resources.json'), 'utf8'),
      );
      const config = saved.connections.find((item: any) => item.id === 'ollama').config;
      assert.equal(Object.hasOwn(config, 'think'), ollamaThink !== undefined);
      if (ollamaThink !== undefined) assert.equal(config.think, ollamaThink);
    } finally {
      if (report.fixtureDirectory)
        await fs.rm(report.fixtureDirectory, { recursive: true, force: true });
    }
  }
});

test('invalid evaluation thinking values reject before credentials, fixtures, report claims or transport', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-thinking-preflight-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let credentialReads = 0,
    fixtures = 0,
    calls = 0;
  const env = {
    BURO_LIVE_DEEPSEEK: '1',
    BURO_LIVE_OLLAMA: '1',
    BURO_MODEL_COMPARISON: '1',
    BURO_MODEL_REPAIR: '1',
    BURO_LIVE_SOURCE_TRANSFER: '1',
  };
  for (const ollamaThink of [null, 0, 1, [], {}, 'x'.repeat(41)]) {
    const options = {
      mode: 'mixed',
      env,
      ollamaThink,
      models: { ollama: 'fixture-model', deepseek: 'fixture-cloud' },
      credentials() {
        credentialReads++;
        return 'must-not-read';
      },
      sourceCase: {
        synthetic: true,
        async prepare() {
          fixtures++;
          throw Error('must not prepare');
        },
      },
      async fetch() {
        calls++;
        throw Error('must not request');
      },
    };
    assert.equal(preflight(options).code, 'LIVE_INVALID_OLLAMA_THINK');
    const report = await runLiveProviderEvaluation(options);
    assert.equal(report.error.code, 'LIVE_INVALID_OLLAMA_THINK');
    assert.equal(report.budget.generationRequests, 0);
    assert.equal(report.fixtureDirectory, undefined);
    assert.throws(() => validateComparison({ ...options, arms: ['ollama-buro'] }), {
      code: 'LIVE_INVALID_OLLAMA_THINK',
    });
    const reportPath = path.join(directory, 'not-created.json');
    await assert.rejects(
      runModelRepair({
        env,
        ollamaThink,
        reportPath,
        runProvider() {
          calls++;
        },
      }),
      { code: 'LIVE_INVALID_OLLAMA_THINK' },
    );
    await assert.rejects(fs.stat(reportPath), { code: 'ENOENT' });
  }
  assert.equal(credentialReads, 0);
  assert.equal(fixtures, 0);
  assert.equal(calls, 0);
});

test('comparison snapshots the requested thinking choice and forwards it to each managed arm', async () => {
  for (const ollamaThink of settings.slice(0, 4)) {
    const options: any = {
      env: { BURO_MODEL_COMPARISON: '1', BURO_LIVE_DEEPSEEK: '1' },
      arms: ['ollama-buro', 'mixed-buro'],
      ...(ollamaThink === undefined ? {} : { ollamaThink }),
    };
    let calls = 0;
    options.runProvider = async (input: any) => {
      calls++;
      assert.equal(Object.hasOwn(input, 'ollamaThink'), ollamaThink !== undefined);
      assert.equal(input.ollamaThink, ollamaThink);
      options.ollamaThink = 'changed-after-validation';
      return { status: 'blocked', error: { code: 'FIXTURE_ONLY' } };
    };
    const report = await runModelComparison(options);
    assert.equal(calls, 2);
    assert.deepEqual(report.requestedOllamaThinking, requested(ollamaThink));
  }
});

test('review-repair forwards and reports the selected Ollama thinking mode without changing its task', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-thinking-repair-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [index, ollamaThink] of settings.slice(0, 4).entries()) {
    let calls = 0;
    const report = await runModelRepair({
      env: { BURO_MODEL_REPAIR: '1', BURO_LIVE_OLLAMA: '1' },
      ...(ollamaThink === undefined ? {} : { ollamaThink }),
      reportPath: path.join(directory, index + '.json'),
      runProvider: async (input: any) => {
        calls++;
        assert.equal(Object.hasOwn(input, 'ollamaThink'), ollamaThink !== undefined);
        assert.equal(input.ollamaThink, ollamaThink);
        assert.equal(input.sourceCase.synthetic, true);
        return { status: 'blocked', error: { code: 'FIXTURE_ONLY' } };
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(report.requestedOllamaThinking, requested(ollamaThink));
    assert.equal(report.caseId, 'synthetic-ready-queue-review-repair-v2');
  }
});
