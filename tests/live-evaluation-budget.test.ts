import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  EvaluationBudget,
  normalizedLimits,
  contextBudgets,
  preflight,
  createBudgetedFetch,
  assertMixedDelegation,
  classifyEvaluationFailure,
  evaluationRunProgress,
  sourceCaseEvidence,
  runLiveProviderEvaluation,
} = require('../scripts/lib/live-provider-runner.cjs');
const endpoints = { ollama: 'http://127.0.0.1:11434/', deepseek: 'https://api.deepseek.com/' };
const json = (value: unknown) => new Response(JSON.stringify(value));

test('a live cloud key alone never authorizes source-case transfer or preparation', async () => {
  let prepared = 0,
    http = 0,
    credentialReads = 0;
  const report = await runLiveProviderEvaluation({
    mode: 'deepseek',
    env: { BURO_LIVE_DEEPSEEK: '1', BURO_DEEPSEEK_MODEL: 'synthetic-model' },
    credentials: () => {
      credentialReads++;
      return 'synthetic-key';
    },
    sourceCase: {
      id: 'synthetic-source',
      prepare: () => {
        prepared++;
        throw Error('Must not prepare');
      },
    },
    fetch: async () => {
      http++;
      throw Error('Must not send');
    },
  });
  assert.equal(report.status, 'blocked');
  assert.equal(report.error.code, 'LIVE_SOURCE_TRANSFER_NOT_AUTHORIZED');
  assert.equal(report.budget.generationRequests, 0);
  assert.equal(prepared, 0);
  assert.equal(http, 0);
  assert.equal(credentialReads, 0);
});

test('source evaluation exports frozen hashes and bounded receipts without private evidence', () => {
  const digest = 'a'.repeat(64);
  const fixture = {
    goal: { title: 'Synthetic source case' },
    profile: { allowedPaths: ['src/value.ts'] },
    evidence: {
      source: {
        root: '/private/source-location',
        head: 'b'.repeat(40),
        hashes: { 'src/value.ts': digest, '../escape': digest, 'invalid.ts': 'private-value' },
      },
      controllerHashes: { 'checks/oracle.cjs': digest, '/private/credentials': digest },
      public: [
        {
          passed: false,
          exitCode: 1,
          durationMs: 12,
          rows: [{ output: 'private-value' }],
          sourceHash: digest,
        },
      ],
      holdout: [
        {
          passed: true,
          exitCode: 0,
          durationMs: 24,
          rows: [{}, {}, {}, {}],
          sourceHash: digest,
          rawCandidate: 'private-value',
        },
      ],
    },
  };
  const before = structuredClone(fixture);
  const result = sourceCaseEvidence(fixture);
  assert.equal(result.commit, 'b'.repeat(40));
  assert.equal(result.sourceFiles, 1);
  assert.deepEqual(result.sourceHashes, { 'src/value.ts': digest });
  assert.deepEqual(result.controllerHashes, { 'checks/oracle.cjs': digest });
  assert.deepEqual(result.public, [
    { passed: false, exitCode: 1, durationMs: 12, checks: 1, sourceHash: digest },
  ]);
  assert.equal(result.holdout[0].checks, 4);
  assert.match(result.fixtureContractHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(fixture, before);
  assert.equal(sourceCaseEvidence({}), undefined);
});

test('mixed evaluation does not increase local model memory when the cloud context budget is larger', () => {
  const limits = normalizedLimits({ contextTokens: 32768 });
  assert.deepEqual(contextBudgets(endpoints, limits), { ollama: 16384, deepseek: 32768 });
  assert.deepEqual(contextBudgets(endpoints, limits, { ollama: 8192 }), {
    ollama: 8192,
    deepseek: 32768,
  });
  assert.deepEqual(contextBudgets(endpoints, limits, { ollama: 32768 }), {
    ollama: 32768,
    deepseek: 32768,
  });
  for (const overrides of [
    { ollama: 65536 },
    { deepseek: 4096 },
    { ollama: 1.5 },
    { unknown: 8192 },
  ])
    assert.throws(() => contextBudgets(endpoints, limits, overrides), {
      code: 'LIVE_INVALID_CONTEXT_BUDGET',
    });
});
const generation = (provider: 'ollama' | 'deepseek', max = 4096) => ({
  method: 'POST',
  body: JSON.stringify(
    provider === 'ollama' ? { options: { num_predict: max } } : { max_tokens: max },
  ),
});

test('evaluation separates known context, incomplete output and unavailable resources', () => {
  const cases = [
    [
      'The conservative context estimate exceeds the configured token budget. Start a focused assignment.',
      'contextBudget',
      'budget-exhausted',
      'LIVE_CONTEXT_BUDGET_EXHAUSTED',
    ],
    [
      'The configured context exceeds this model capability.',
      'contextBudget',
      'budget-exhausted',
      'LIVE_CONTEXT_BUDGET_EXHAUSTED',
    ],
    [
      'The model response did not complete.',
      'outputIncomplete',
      'resource-blocked',
      'LIVE_OUTPUT_INCOMPLETE',
    ],
    [
      'DeepSeek generation ended without a terminal response.',
      'outputIncomplete',
      'resource-blocked',
      'LIVE_OUTPUT_INCOMPLETE',
    ],
    [
      'The configured model endpoint could not be reached.',
      'unavailable',
      'resource-blocked',
      'LIVE_PROVIDER_UNAVAILABLE',
    ],
    [
      'Model endpoint returned HTTP 429. No provider fallback was used.',
      'unavailable',
      'resource-blocked',
      'LIVE_PROVIDER_UNAVAILABLE',
    ],
  ];
  for (const [result, category, status, code] of cases) {
    const diagnosis = classifyEvaluationFailure({ status: 'failed', result });
    assert.equal(diagnosis.category, category);
    assert.equal(diagnosis.status, status);
    assert.equal(diagnosis.code, code);
    assert.equal(diagnosis.basis, 'public-status-message heuristic');
    assert.equal(Object.hasOwn(diagnosis, 'result'), false);
  }
});

test('forged public payload and known text inside a model summary cannot become resource evidence', () => {
  const privateText = 'PRIVATE_MODEL_THINKING_AND_PAYLOAD';
  const context = 'The conservative context estimate exceeds the configured token budget.';
  for (const run of [
    { status: 'failed', result: JSON.stringify({ summary: context, thinking: privateText }) },
    { status: 'failed', result: `Model summary: ${context} ${privateText}` },
    { status: 'completed', result: context + privateText },
    { status: 'interrupted', result: context + privateText },
    { status: 'failed', result: { message: context, thinking: privateText } },
    { status: 'failed', result: 'context window exceeded: ' + privateText },
  ]) {
    const diagnosis = classifyEvaluationFailure(run);
    assert.equal(diagnosis.category, 'qualityFailure');
    assert.equal(diagnosis.evidence, 'unknown');
    assert.equal(JSON.stringify(diagnosis).includes(privateText), false);
    assert.equal(JSON.stringify(diagnosis).includes(context), false);
  }
  const knownPrefix = classifyEvaluationFailure({
    status: 'failed',
    result: context + ' ' + privateText,
  });
  assert.equal(knownPrefix.category, 'contextBudget');
  assert.equal(JSON.stringify(knownPrefix).includes(privateText), false);
});

test('actual checks and review rejection remain quality failures despite quoted resource text', () => {
  const context = 'The conservative context estimate exceeds the configured token budget.';
  for (const verdict of ['approved', 'changes_requested']) {
    const diagnosis = classifyEvaluationFailure({
      status: 'failed',
      result: `Acceptance failed: 0/1 checks; boundaries respected. ${context}`,
      review: { verdict, summary: context },
    });
    assert.equal(diagnosis.status, 'quality-failed');
    assert.equal(diagnosis.code, 'LIVE_CODING_QUALITY_FAILED');
    assert.equal(
      diagnosis.evidence,
      verdict === 'changes_requested' ? 'service-review' : 'service-checks',
    );
  }
});

test('run progress retains counts and allowlisted phases without plan or event payload', () => {
  const privateText = 'PRIVATE_PLAN_OR_EVENT_TEXT';
  const summary = evaluationRunProgress({
    planSavedAt: 'saved',
    plan: [{ step: privateText }, { step: privateText }],
    events: [
      { type: 'phase.planning', text: privateText },
      { type: 'phase.implementation', text: privateText },
      { type: 'phase.' + privateText, text: privateText },
      { type: 'phase.done', text: privateText },
    ],
  });
  assert.deepEqual(summary, {
    planSaved: true,
    planStepsCount: 2,
    lastPhaseBeforeDone: 'implementation',
  });
  assert.deepEqual(evaluationRunProgress({ events: [{ type: 'phase.done' }] }), {
    planSaved: false,
    planStepsCount: 0,
  });
  assert.equal(JSON.stringify(summary).includes(privateText), false);
});

test('shared request cap reserves before HTTP across providers and stages', async () => {
  const budget = new EvaluationBudget({ maxGenerationRequests: 2 });
  let calls = 0;
  let stage = 'diagnostic';
  const fetch = createBudgetedFetch({
    endpoints,
    budget,
    stage: () => stage,
    fetch: async () => {
      calls++;
      assert.equal(budget.snapshot().generationRequests, calls);
      return json({});
    },
  });
  await (await fetch(endpoints.ollama + 'api/chat', generation('ollama'))).text();
  stage = 'coding';
  await (await fetch(endpoints.deepseek + 'chat/completions', generation('deepseek'))).text();
  await assert.rejects(fetch(endpoints.ollama + 'api/chat', generation('ollama')), {
    code: 'LIVE_REQUEST_BUDGET_EXHAUSTED',
  });
  assert.equal(calls, 2);
  assert.equal(budget.snapshot().reservedOutputTokens, 8192);
  assert.equal(budget.signal.aborted, true);
});

test('conservative reservations never refund missing or low observed usage', () => {
  const budget = new EvaluationBudget({ maxReservedOutputTokens: 8192 });
  const ticket = budget.reserve({ provider: 'deepseek', maxOutputTokens: 4096 });
  budget.observe(ticket, { inputTokens: 12, outputTokens: 1 });
  budget.reserve({ provider: 'ollama', maxOutputTokens: 4096 });
  assert.throws(() => budget.reserve({ provider: 'deepseek', maxOutputTokens: 128 }), {
    code: 'LIVE_OUTPUT_BUDGET_EXHAUSTED',
  });
  assert.equal(budget.snapshot().reservedOutputTokens, 8192);
  assert.equal(budget.snapshot().observedOutputTokens, 1);
  assert.equal(budget.snapshot().requestsWithUnknownUsage, 1);
  assert.equal(budget.snapshot().reservationRefunds, 0);
  assert.equal(budget.snapshot().cost, 'unknown');
});

test('diagnostics have their own two-call cap within the shared ledger', () => {
  const budget = new EvaluationBudget();
  for (const provider of ['ollama', 'deepseek'])
    budget.reserve({ provider, maxOutputTokens: 4096, stage: 'diagnostic' });
  assert.throws(
    () => budget.reserve({ provider: 'deepseek', maxOutputTokens: 4096, stage: 'diagnostic' }),
    { code: 'LIVE_DIAGNOSTIC_BUDGET_EXHAUSTED' },
  );
  assert.equal(budget.snapshot().generationRequests, 2);
});

test('limits cannot exceed the acceptance envelope', () => {
  for (const limits of [
    { maxGenerationRequests: 25 },
    { maxReservedOutputTokens: 65537 },
    { maxDiagnosticRequests: 3 },
    { codingWallTimeMs: 300001 },
    { diagnosticWallTimeMs: 120001 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 16384 },
    { maxGenerationRequests: 1.1 },
  ])
    assert.throws(() => normalizedLimits(limits), { code: 'LIVE_INVALID_LIMITS' });
  assert.equal(normalizedLimits().maxOutputTokens, 4096);
  assert.equal(normalizedLimits().contextTokens, 16384);
});

test('foreign routes, missing reservations and prior cancellation cannot reach HTTP', async () => {
  const budget = new EvaluationBudget();
  let calls = 0;
  const fetch = createBudgetedFetch({
    endpoints,
    budget,
    fetch: async () => {
      calls++;
      return json({});
    },
  });
  for (const url of [
    'https://evil.invalid/chat/completions',
    endpoints.deepseek + 'chat/completions?key=secret',
    endpoints.deepseek + 'other',
    'https://user:password@api.deepseek.com/chat/completions',
  ])
    await assert.rejects(fetch(url, generation('deepseek')), { code: 'LIVE_ENDPOINT_NOT_ALLOWED' });
  for (const max of [undefined, 0, -1, 1.2])
    await assert.rejects(
      fetch(endpoints.deepseek + 'chat/completions', {
        method: 'POST',
        body: JSON.stringify({ max_tokens: max }),
      }),
      { code: 'LIVE_UNBOUNDED_REQUEST' },
    );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetch(endpoints.deepseek + 'chat/completions', {
      ...generation('deepseek'),
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
  assert.equal(budget.snapshot().generationRequests, 0);
});

test('shared cancellation interrupts an in-flight fetch and blocks subsequent sessions', async () => {
  const budget = new EvaluationBudget();
  let calls = 0;
  const fetch = createBudgetedFetch({
    endpoints,
    budget,
    fetch: async (_url: URL, init: RequestInit) => {
      calls++;
      return new Promise((_resolve, reject) =>
        init.signal!.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        ),
      );
    },
  });
  const pending = fetch(endpoints.deepseek + 'chat/completions', generation('deepseek'));
  budget.stop('LIVE_CODING_TIMEOUT');
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(fetch(endpoints.ollama + 'api/chat', generation('ollama')), {
    code: 'LIVE_CODING_TIMEOUT',
  });
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().generationRequests, 1);
});

test('HTTP diagnostics retain only allowlisted telemetry, never content or arguments', async () => {
  const secret = 'SENTINEL_PRIVATE_KEY_AND_THINKING';
  const budget = new EvaluationBudget();
  const chunks = [
    {
      choices: [
        {
          delta: {
            content: secret,
            reasoning_content: secret,
            tool_calls: [{ index: 0, function: { name: 'read_', arguments: secret } }],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: secret } }] },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 9 },
    },
  ];
  const fetch = createBudgetedFetch({
    endpoints,
    budget,
    fetch: async () =>
      new Response(
        chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
      ),
  });
  await (
    await fetch(endpoints.deepseek + 'chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        max_tokens: 4096,
        messages: [{ content: secret }],
        tools: [{ function: { name: secret } }, { function: { name: 'read_file' } }],
      }),
    })
  ).text();
  const telemetry = fetch.snapshot();
  assert.equal(JSON.stringify({ telemetry, budget: budget.snapshot() }).includes(secret), false);
  assert.deepEqual(telemetry.responses[0].toolNames, ['read_file']);
  assert.deepEqual(telemetry.requests[0].toolNames, ['read_file']);
  assert.deepEqual(telemetry.responses[0].usage, { inputTokens: 30, outputTokens: 9 });
  assert.equal(telemetry.responses[0].terminal, true);
  assert.equal(budget.snapshot().requestsWithCompleteUsage, 1);
});

test('provider-reported output above reservation aborts all sessions', async () => {
  const budget = new EvaluationBudget();
  const fetch = createBudgetedFetch({
    endpoints,
    budget,
    fetch: async () => json({ done: true, prompt_eval_count: 2, eval_count: 129 }),
  });
  await (await fetch(endpoints.ollama + 'api/chat', generation('ollama', 128))).text();
  assert.equal(budget.snapshot().violation, 'LIVE_PROVIDER_OUTPUT_LIMIT_VIOLATION');
  assert.equal(budget.signal.aborted, true);
});

test('missing opt-in, key or explicit model produce typed reports without HTTP or fixture work', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'buro-budget-report-'));
  try {
    let calls = 0;
    let fixtures = 0;
    const cases = [
      { env: {}, code: 'LIVE_OPT_IN_REQUIRED' },
      { env: { BURO_LIVE_DEEPSEEK: '1' }, code: 'LIVE_DEEPSEEK_KEY_REQUIRED' },
      {
        env: { BURO_LIVE_DEEPSEEK: '1', DEEPSEEK_API_KEY: 'fake-only' },
        code: 'LIVE_MODEL_REQUIRED',
      },
    ];
    for (const [index, item] of cases.entries()) {
      const reportPath = path.join(directory, index + '.json');
      const report = await runLiveProviderEvaluation({
        mode: 'deepseek',
        env: { BURO_LIVE_SOURCE_TRANSFER: '1', ...item.env },
        reportPath,
        fetch: async () => {
          calls++;
          throw new Error('must not run');
        },
        sourceCase: {
          prepare: async () => {
            fixtures++;
            throw new Error('must not run');
          },
        },
      });
      assert.equal(report.status, 'blocked');
      assert.equal(report.error.code, item.code);
      assert.equal(report.budget.generationRequests, 0);
      assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), report);
    }
    assert.equal(calls, 0);
    assert.equal(fixtures, 0);
    assert.equal(
      preflight({
        mode: 'deepseek',
        env: { BURO_LIVE_DEEPSEEK: '1' },
        credentials: () => {
          throw new Error('private');
        },
      }).code,
      'LIVE_CREDENTIALS_UNAVAILABLE',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('actual resources probe cannot exceed shared budget through an injected transport', async () => {
  let generations = 0;
  const report = await runLiveProviderEvaluation({
    mode: 'ollama',
    env: { BURO_LIVE_OLLAMA: '1', BURO_OLLAMA_MODEL: 'fixture-model' },
    budgets: { maxDiagnosticRequests: 1 },
    fetch: async (url: URL) => {
      const route = new URL(String(url)).pathname;
      if (route === '/api/tags') return json({ models: [{ name: 'fixture-model' }] });
      if (route === '/api/show')
        return json({
          capabilities: ['completion', 'tools'],
          model_info: { 'fixture.context_length': 32768 },
        });
      assert.equal(route, '/api/chat');
      generations++;
      return json({
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
      });
    },
  });
  try {
    assert.equal(report.status, 'budget-exhausted');
    assert.equal(report.error?.code, 'LIVE_DIAGNOSTIC_BUDGET_EXHAUSTED');
    assert.equal(generations, 1);
    assert.equal(report.budget.generationRequests, 1);
    assert.equal(report.originalSourcePreserved, true);
  } finally {
    if (report.fixtureDirectory)
      await rm(report.fixtureDirectory, { recursive: true, force: true });
  }
});

test('actual coding deadline cancels execution without a live provider or source mutation', async () => {
  let generations = 0;
  const report = await runLiveProviderEvaluation({
    mode: 'ollama',
    env: { BURO_LIVE_OLLAMA: '1', BURO_OLLAMA_MODEL: 'fixture-model' },
    budgets: { codingWallTimeMs: 100 },
    fetch: async (url: URL, init: RequestInit) => {
      const route = new URL(String(url)).pathname;
      if (route === '/api/tags') return json({ models: [{ name: 'fixture-model' }] });
      if (route === '/api/show')
        return json({
          capabilities: ['completion', 'tools'],
          model_info: { 'fixture.context_length': 32768 },
        });
      assert.equal(route, '/api/chat');
      generations++;
      if (generations === 1)
        return json({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'diagnostic_echo', arguments: { value: 'buro-ready' } } },
            ],
          },
          done: true,
          done_reason: 'stop',
        });
      if (generations === 2)
        return json({
          message: { role: 'assistant', content: '{"ok":true}' },
          done: true,
          done_reason: 'stop',
        });
      return new Promise((_resolve, reject) => {
        if (init.signal!.aborted) reject(new DOMException('aborted', 'AbortError'));
        else
          init.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
      });
    },
  });
  try {
    assert.equal(report.status, 'timed-out');
    assert.equal(report.error.code, 'LIVE_CODING_TIMEOUT');
    assert.equal(report.originalSourcePreserved, true);
    assert.equal(report.budget.diagnosticRequests, 2);
    assert.ok(generations <= 3);
    assert.equal(report.budget.generationRequests, generations);
    assert.equal(report.run.acceptedCommit, false);
  } finally {
    if (report.fixtureDirectory)
      await rm(report.fixtureDirectory, { recursive: true, force: true });
  }
});

test('mixed quality requires a successful distinct Ollama worker and DeepSeek review', () => {
  const run = {
    threadId: 'coordinator-handle',
    coordinatorSession: { runtimeId: 'deepseek-live' },
    agents: [
      { threadId: 'reviewer-handle', session: { roleId: 'reviewer', runtimeId: 'deepseek-live' } },
      {
        threadId: 'worker-handle',
        status: 'completed',
        session: { roleId: 'implementer', runtimeId: 'ollama-live', result: { status: 'success' } },
      },
    ],
  };
  assert.doesNotThrow(() => assertMixedDelegation(run));
  for (const mutate of [
    (copy: any) => copy.agents.pop(),
    (copy: any) => (copy.agents[1].session.runtimeId = 'deepseek-live'),
    (copy: any) => (copy.agents[1].session.result.status = 'blocked'),
    (copy: any) => (copy.agents[1].threadId = copy.threadId),
    (copy: any) => (copy.agents[1].threadId = copy.agents[0].threadId),
    (copy: any) => (copy.agents[0].session.runtimeId = 'ollama-live'),
  ]) {
    const copy = structuredClone(run);
    mutate(copy);
    assert.throws(() => assertMixedDelegation(copy), { code: 'LIVE_MIXED_DELEGATION_MISSING' });
  }
});
