const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const DEFAULT_LIVE_LIMITS = Object.freeze({
  maxGenerationRequests: 24,
  maxReservedOutputTokens: 65536,
  maxDiagnosticRequests: 2,
  diagnosticWallTimeMs: 120000,
  codingWallTimeMs: 300000,
  contextTokens: 16384,
  maxOutputTokens: 4096,
});
const knownTools = new Set([
  'diagnostic_echo',
  'read_file',
  'list_files',
  'search_text',
  'edit_file',
  'run_command',
  'read_diff',
]);
const RTX_EVALUATION_ENDPOINT = 'http://192.168.50.10:11434/';
const RTX_EVALUATION_MODEL = 'qwen3.5:9b-q4_K_M';
const finiteCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

class LiveEvaluationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Evaluation-only route selection; private-network trust requires an exact synthetic target. */
function evaluationTargetContract(options = {}) {
  const target = options.target === undefined ? 'local' : options.target;
  if (!['local', 'rtx'].includes(target))
    throw new LiveEvaluationError('COMPARISON_INVALID_TARGET');
  const endpoint = options.endpoints?.ollama;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new LiveEvaluationError(
      target === 'rtx' ? 'LIVE_RTX_ENDPOINT_REQUIRED' : 'COMPARISON_LOCAL_OLLAMA_ONLY',
    );
  }
  if (target === 'local') {
    if (
      parsed.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    )
      throw new LiveEvaluationError('COMPARISON_LOCAL_OLLAMA_ONLY');
    return { target, endpoint: parsed.href };
  }
  const env = options.env || process.env;
  if (env.BURO_RTX_MODEL_COMPARISON !== '1' || env.BURO_LIVE_OLLAMA !== '1')
    throw new LiveEvaluationError('LIVE_RTX_OPT_IN_REQUIRED');
  if (
    parsed.href !== RTX_EVALUATION_ENDPOINT ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new LiveEvaluationError('LIVE_RTX_ENDPOINT_REQUIRED');
  if (options.mode !== undefined && !['ollama', 'mixed'].includes(options.mode))
    throw new LiveEvaluationError('LIVE_RTX_INVALID_MODE');
  if (options.sourceCase && options.sourceCase.synthetic !== true)
    throw new LiveEvaluationError('LIVE_RTX_SYNTHETIC_REQUIRED');
  const model = options.models?.ollama || env.BURO_OLLAMA_MODEL || RTX_EVALUATION_MODEL;
  if (model !== RTX_EVALUATION_MODEL) throw new LiveEvaluationError('LIVE_RTX_MODEL_REQUIRED');
  return { target, endpoint: parsed.href, model, trust: 'private-network' };
}

function normalizedLimits(input = {}) {
  const limits = { ...DEFAULT_LIVE_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new LiveEvaluationError('LIVE_INVALID_LIMITS');
  for (const name of [
    'maxGenerationRequests',
    'maxReservedOutputTokens',
    'maxDiagnosticRequests',
    'diagnosticWallTimeMs',
    'codingWallTimeMs',
  ])
    if (limits[name] > DEFAULT_LIVE_LIMITS[name])
      throw new LiveEvaluationError('LIVE_INVALID_LIMITS');
  if (
    limits.contextTokens < 1024 ||
    limits.contextTokens > 262144 ||
    limits.maxOutputTokens < 128 ||
    limits.maxOutputTokens > 32768 ||
    limits.maxOutputTokens >= limits.contextTokens
  )
    throw new LiveEvaluationError('LIVE_INVALID_LIMITS');
  return Object.freeze(limits);
}

/** One reservation ledger covers every probe, agent, repair and review HTTP generation. */
class EvaluationBudget {
  constructor(limits = {}) {
    this.limits = normalizedLimits(limits);
    this.controller = new AbortController();
    this.tickets = [];
    this.violation = undefined;
  }
  get signal() {
    return this.controller.signal;
  }
  stop(code) {
    this.violation ||= code;
    this.controller.abort();
  }
  reserve({ provider, maxOutputTokens, stage = 'coding', signal }) {
    signal?.throwIfAborted();
    if (this.signal.aborted) throw new LiveEvaluationError(this.violation || 'LIVE_INTERRUPTED');
    if (!['ollama', 'deepseek'].includes(provider) || !['diagnostic', 'coding'].includes(stage))
      throw new LiveEvaluationError('LIVE_UNEXPECTED_GENERATION');
    const amount = finiteCount(maxOutputTokens);
    if (!amount) throw new LiveEvaluationError('LIVE_UNBOUNDED_REQUEST');
    if (amount > this.limits.maxOutputTokens)
      throw new LiveEvaluationError('LIVE_REQUEST_OUTPUT_LIMIT_EXCEEDED');
    const reject = (code) => {
      this.stop(code);
      throw new LiveEvaluationError(code);
    };
    if (this.tickets.length >= this.limits.maxGenerationRequests)
      reject('LIVE_REQUEST_BUDGET_EXHAUSTED');
    if (
      stage === 'diagnostic' &&
      this.tickets.filter((ticket) => ticket.stage === 'diagnostic').length >=
        this.limits.maxDiagnosticRequests
    )
      reject('LIVE_DIAGNOSTIC_BUDGET_EXHAUSTED');
    if (
      this.tickets.reduce((sum, ticket) => sum + ticket.reservedOutputTokens, 0) + amount >
      this.limits.maxReservedOutputTokens
    )
      reject('LIVE_OUTPUT_BUDGET_EXHAUSTED');
    const ticket = {
      index: this.tickets.length + 1,
      provider,
      stage,
      reservedOutputTokens: amount,
    };
    this.tickets.push(ticket);
    return ticket.index;
  }
  observe(index, usage = {}) {
    const ticket = this.tickets[index - 1];
    if (!ticket) throw new LiveEvaluationError('LIVE_UNKNOWN_RESERVATION');
    const inputTokens = finiteCount(usage.inputTokens),
      outputTokens = finiteCount(usage.outputTokens);
    if (inputTokens !== undefined) ticket.inputTokens = inputTokens;
    if (outputTokens !== undefined) {
      ticket.outputTokens = outputTokens;
      if (outputTokens > ticket.reservedOutputTokens)
        this.stop('LIVE_PROVIDER_OUTPUT_LIMIT_VIOLATION');
    }
  }
  snapshot() {
    const complete = this.tickets.filter(
      (ticket) => ticket.inputTokens !== undefined && ticket.outputTokens !== undefined,
    );
    return {
      limits: this.limits,
      generationRequests: this.tickets.length,
      diagnosticRequests: this.tickets.filter((ticket) => ticket.stage === 'diagnostic').length,
      reservedOutputTokens: this.tickets.reduce(
        (sum, ticket) => sum + ticket.reservedOutputTokens,
        0,
      ),
      observedInputTokens: this.tickets.reduce((sum, ticket) => sum + (ticket.inputTokens || 0), 0),
      observedOutputTokens: this.tickets.reduce(
        (sum, ticket) => sum + (ticket.outputTokens || 0),
        0,
      ),
      requestsWithCompleteUsage: complete.length,
      requestsWithUnknownUsage: this.tickets.length - complete.length,
      reservationRefunds: 0,
      cost: 'unknown',
      ...(this.violation ? { violation: this.violation } : {}),
    };
  }
}

function safeEndpoint(value) {
  const url = new URL(value.endsWith('/') ? value : value + '/');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new LiveEvaluationError('LIVE_INVALID_ENDPOINT');
  return url;
}

/** Native thread IDs must never be interpreted as private managed checkpoint IDs. */
async function loadManagedCheckpoints(handles, routes, sessions) {
  const saved = [];
  for (const handle of handles) {
    const route = await routes.load(handle);
    if (route?.resource?.backendId !== 'managed' || !route.externalThreadId) continue;
    const session = await sessions.load(route.externalThreadId);
    if (session) saved.push(session);
  }
  return saved;
}

function contextBudgets(endpoints, limits, overrides = {}) {
  if (Object.keys(overrides).some((name) => !['ollama', 'deepseek'].includes(name)))
    throw new LiveEvaluationError('LIVE_INVALID_CONTEXT_BUDGET');
  const contexts = {};
  for (const provider of Object.keys(endpoints)) {
    const tokens =
      overrides[provider] ??
      (provider === 'ollama'
        ? Math.min(limits.contextTokens, DEFAULT_LIVE_LIMITS.contextTokens)
        : limits.contextTokens);
    if (
      !Number.isSafeInteger(tokens) ||
      tokens < 1024 ||
      tokens > limits.contextTokens ||
      tokens <= limits.maxOutputTokens
    )
      throw new LiveEvaluationError('LIVE_INVALID_CONTEXT_BUDGET');
    contexts[provider] = tokens;
  }
  return contexts;
}

function preflight(options = {}) {
  const env = options.env || process.env,
    mode = options.mode;
  if (!['ollama', 'deepseek', 'mixed', 'codex'].includes(mode))
    return { ok: false, code: 'LIVE_INVALID_MODE' };
  const usesDeepSeek = ['deepseek', 'mixed'].includes(mode),
    usesOllama = ['ollama', 'mixed'].includes(mode),
    usesCodex = mode === 'codex';
  if (
    (usesCodex
      ? env.BURO_LIVE_CODEX
      : usesDeepSeek
        ? env.BURO_LIVE_DEEPSEEK
        : env.BURO_LIVE_OLLAMA) !== '1'
  )
    return { ok: false, code: 'LIVE_OPT_IN_REQUIRED' };
  if ((usesDeepSeek || usesCodex) && options.sourceCase && env.BURO_LIVE_SOURCE_TRANSFER !== '1')
    return { ok: false, code: 'LIVE_SOURCE_TRANSFER_NOT_AUTHORIZED' };
  if (
    usesCodex &&
    (!options.codex?.model ||
      !['low', 'medium', 'high', 'xhigh'].includes(options.codex?.reasoningEffort))
  )
    return { ok: false, code: 'LIVE_CODEX_PIN_REQUIRED' };
  const models = {
    ...(usesCodex ? { codex: options.codex.model } : {}),
    ollama: options.models?.ollama || env.BURO_OLLAMA_MODEL,
    deepseek: options.models?.deepseek || env.BURO_DEEPSEEK_MODEL,
  };
  try {
    if (usesDeepSeek && !(options.credentials?.('DEEPSEEK_API_KEY') || env.DEEPSEEK_API_KEY))
      return { ok: false, code: 'LIVE_DEEPSEEK_KEY_REQUIRED' };
  } catch {
    return { ok: false, code: 'LIVE_CREDENTIALS_UNAVAILABLE' };
  }
  if ((usesDeepSeek && !models.deepseek) || (usesOllama && !models.ollama))
    return { ok: false, code: 'LIVE_MODEL_REQUIRED' };
  for (const model of [
    usesOllama && models.ollama,
    usesDeepSeek && models.deepseek,
    usesCodex && models.codex,
  ].filter(Boolean))
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model))
      return { ok: false, code: 'LIVE_INVALID_MODEL' };
  try {
    const target = options.target === undefined ? undefined : evaluationTargetContract(options);
    const endpoints = {
      ...(usesOllama
        ? {
            ollama: safeEndpoint(
              target?.endpoint ||
                options.endpoints?.ollama ||
                env.BURO_OLLAMA_ENDPOINT ||
                'http://127.0.0.1:11434',
            ).href,
          }
        : {}),
      ...(usesDeepSeek
        ? {
            deepseek: safeEndpoint(
              options.endpoints?.deepseek ||
                env.BURO_DEEPSEEK_ENDPOINT ||
                'https://api.deepseek.com',
            ).href,
          }
        : {}),
    };
    const limits = normalizedLimits(options.budgets);
    return {
      ok: true,
      mode,
      models,
      endpoints,
      limits,
      ...(target?.trust ? { ollamaTrust: target.trust } : {}),
      contexts: contextBudgets(endpoints, limits, options.contextTokensByProvider),
    };
  } catch (error) {
    return { ok: false, code: error.code || 'LIVE_INVALID_CONFIGURATION' };
  }
}

/** Reports allowlisted telemetry only; model text, arguments and thinking are never retained. */
function observedResponse(response, provider, ticket, budget, observations) {
  if (!response.body) return response;
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  const entry = {
    requestIndex: ticket,
    provider,
    status: response.status,
    terminal: false,
    toolNames: [],
  };
  observations.push(entry);
  let buffer = '',
    bytes = 0;
  const names = new Map();
  const record = (line) => {
    if (!line.trim()) return;
    if (provider === 'deepseek') {
      if (!line.startsWith('data:')) return;
      line = line.slice(5).trim();
      if (line === '[DONE]') {
        entry.terminal = true;
        return;
      }
    }
    let chunk;
    try {
      chunk = object(JSON.parse(line));
    } catch {
      return;
    }
    const reason =
      provider === 'ollama' ? chunk.done_reason : object((chunk.choices || [])[0]).finish_reason;
    if (typeof reason === 'string')
      entry.finish = [
        'stop',
        'length',
        'tool_calls',
        'content_filter',
        'insufficient_system_resource',
        'aborted',
        'load',
        'unload',
      ].includes(reason)
        ? reason
        : 'unknown';
    if (provider === 'ollama' && chunk.done === true) entry.terminal = true;
    const usage =
      provider === 'ollama'
        ? {
            inputTokens: finiteCount(chunk.prompt_eval_count),
            outputTokens: finiteCount(chunk.eval_count),
          }
        : {
            inputTokens: finiteCount(object(chunk.usage).prompt_tokens),
            outputTokens: finiteCount(object(chunk.usage).completion_tokens),
          };
    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
      entry.usage = {
        ...entry.usage,
        ...Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)),
      };
      budget.observe(ticket, entry.usage);
    }
    const calls =
      provider === 'ollama'
        ? object(chunk.message).tool_calls
        : object(object((chunk.choices || [])[0]).delta).tool_calls;
    if (Array.isArray(calls))
      for (const [position, raw] of calls.entries()) {
        const call = object(raw),
          fn = object(call.function),
          index = finiteCount(call.index) ?? finiteCount(fn.index) ?? position;
        if (typeof fn.name !== 'string') continue;
        const previous = names.get(index) || '',
          combined = previous === fn.name ? previous : previous + fn.name;
        if (combined.length <= 64) names.set(index, combined);
      }
    entry.toolNames = [...new Set([...names.values()].filter((name) => knownTools.has(name)))];
  };
  const flush = (final = false) => {
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      record(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
    }
    if (final && buffer) {
      record(buffer.replace(/\r$/, ''));
      buffer = '';
    }
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          buffer += decoder.decode();
          flush(true);
          controller.close();
          reader.releaseLock();
          return;
        }
        bytes += chunk.value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw new LiveEvaluationError('LIVE_RESPONSE_LIMIT');
        buffer += decoder.decode(chunk.value, { stream: true });
        flush();
        controller.enqueue(chunk.value);
      } catch (error) {
        await reader.cancel().catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      reader.releaseLock();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function createBudgetedFetch({
  endpoints,
  budget = new EvaluationBudget(),
  fetch: actualFetch = globalThis.fetch,
  stage = () => 'coding',
}) {
  const routes = new Map();
  for (const [provider, endpoint] of Object.entries(endpoints)) {
    const base = safeEndpoint(endpoint);
    for (const route of provider === 'ollama'
      ? ['api/chat', 'api/show', 'api/tags']
      : ['chat/completions', 'models'])
      routes.set(new URL(route, base).href, {
        provider,
        generation: route === 'api/chat' || route === 'chat/completions',
      });
  }
  const requests = [],
    responses = [],
    metadata = { ollama: 0, deepseek: 0 };
  const wrapped = async (url, init = {}) => {
    init.signal?.throwIfAborted();
    if (budget.signal.aborted)
      throw new LiveEvaluationError(budget.violation || 'LIVE_INTERRUPTED');
    const target = new URL(typeof url === 'string' || url instanceof URL ? String(url) : url.url);
    const route = routes.get(target.href);
    if (!route) throw new LiveEvaluationError('LIVE_ENDPOINT_NOT_ALLOWED');
    let ticket;
    if (route.generation) {
      if ((init.method || 'GET').toUpperCase() !== 'POST')
        throw new LiveEvaluationError('LIVE_INVALID_GENERATION_METHOD');
      let body;
      try {
        body = object(JSON.parse(String(init.body)));
      } catch {
        throw new LiveEvaluationError('LIVE_INVALID_GENERATION_BODY');
      }
      const maxOutputTokens =
        route.provider === 'ollama' ? object(body.options).num_predict : body.max_tokens;
      ticket = budget.reserve({
        provider: route.provider,
        maxOutputTokens,
        stage: stage(),
        signal: init.signal,
      });
      requests.push({
        requestIndex: ticket,
        provider: route.provider,
        maxOutputTokens,
        toolNames: [
          ...new Set(
            (Array.isArray(body.tools) ? body.tools : [])
              .map((tool) => object(object(tool).function).name)
              .filter((name) => knownTools.has(name)),
          ),
        ],
      });
    } else metadata[route.provider]++;
    const signal = init.signal ? AbortSignal.any([init.signal, budget.signal]) : budget.signal;
    const response = await actualFetch(target, { ...init, signal, redirect: 'error' });
    return ticket
      ? observedResponse(response, route.provider, ticket, budget, responses)
      : response;
  };
  wrapped.snapshot = () => ({
    requests: structuredClone(requests),
    responses: structuredClone(responses),
    metadata: { ...metadata },
  });
  return wrapped;
}

const safeError = (error) => ({
  code:
    typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
      ? error.code
      : 'LIVE_VALIDATION_FAILED',
});
/** Public evidence contains frozen hashes and bounded outcomes, never candidate text or paths to secrets. */
function sourceCaseEvidence(fixture) {
  const evidence = fixture?.evidence;
  if (!evidence?.source) return undefined;
  const hashes = (input) =>
    Object.fromEntries(
      Object.entries(object(input))
        .filter(
          ([name, value]) =>
            name.length <= 512 &&
            name
              .split('/')
              .every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part)) &&
            /^[a-f0-9]{64}$/.test(value),
        )
        .slice(0, 128),
    );
  const sourceHashes = hashes(evidence.source.hashes);
  const receipts = (mode) =>
    (Array.isArray(evidence[mode]) ? evidence[mode] : []).slice(0, 64).map((record) => ({
      passed: record.passed === true,
      exitCode: [0, 1].includes(record.exitCode) ? record.exitCode : null,
      durationMs: finiteCount(record.durationMs),
      checks: Array.isArray(record.rows) ? record.rows.length : 0,
      sourceHash: /^[a-f0-9]{64}$/.test(record.sourceHash || '') ? record.sourceHash : 'unknown',
    }));
  return {
    commit: /^[a-f0-9]{40,64}$/.test(evidence.source.head || '') ? evidence.source.head : 'unknown',
    sourceFiles: Object.keys(sourceHashes).length,
    sourceHashes,
    controllerHashes: hashes(evidence.controllerHashes),
    fixtureContractHash: createHash('sha256')
      .update(JSON.stringify([fixture.goal, fixture.profile]))
      .digest('hex'),
    public: receipts('public'),
    holdout: receipts('holdout'),
  };
}
async function writeReport(reportPath, report) {
  if (!reportPath) return;
  await fs.mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
}
async function git(root, args) {
  return exec(
    'git',
    [
      '--no-optional-locks',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd: root,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    },
  );
}
async function sourceState(root) {
  const names = (await git(root, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean).sort();
  const files = [];
  for (const name of names) {
    const filename = path.join(root, name);
    const stat = await fs.lstat(filename);
    files.push([
      name,
      createHash('sha256')
        .update(stat.isSymbolicLink() ? await fs.readlink(filename) : await fs.readFile(filename))
        .digest('hex'),
    ]);
  }
  return {
    head: (await git(root, ['rev-parse', 'HEAD'])).stdout.trim(),
    status: (await git(root, ['status', '--porcelain=v1', '-z'])).stdout,
    files,
  };
}

async function prepareSyntheticFixture(temporaryDirectory, mode) {
  const root = temporaryDirectory;
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Buro live fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'checks'));
  await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=1;\n');
  await fs.writeFile(
    path.join(root, 'checks/value.test.mjs'),
    "import assert from 'node:assert/strict';import {value} from '../src/value.mjs';assert.equal(value,2);\n",
  );
  await fs.writeFile(path.join(root, '.gitignore'), '.buro/\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'Synthetic provider acceptance fixture']);
  return {
    root,
    caseId: 'synthetic-value',
    expectedChangedPaths: ['src/value.mjs'],
    expectedBaseline: { passed: 0, total: 1 },
    goal: {
      title: 'Set the exported value to two',
      body:
        'Change src/value.mjs so its exported value equals 2. Preserve the protected checks and all other files. ' +
        (mode === 'mixed'
          ? 'Delegate implementation to one real worker. The coordinator must plan and integrate; Buro starts the worker and independent reviewer. An empty worker team does not satisfy this goal.'
          : 'This is one tiny coherent edit; use a direct coordinator implementation or delegate only when useful.'),
      criteria:
        'The protected check passes; src/value.mjs exports value=2; only src/value.mjs changes.' +
        (mode === 'mixed' ? ' A real worker implements the change in a distinct session.' : ''),
    },
    profile: {
      version: 1,
      revision: 1,
      resourceProfile: 'evaluation',
      context:
        'A tiny synthetic JavaScript module. The trusted check is outside the editable source area.',
      scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
      checks: [
        {
          id: 'test',
          title: 'Protected value check',
          command: 'node --test checks/value.test.mjs',
          timeoutMs: 10000,
        },
      ],
      defaultCheckIds: ['test'],
      setup: [],
      dependencies: 'none',
      maxWorkers: 1,
      maxRepairs: 1,
      turnTimeoutMs: 120000,
      baseBranch: 'main',
      environment: {
        provider: 'native',
        recipe: {
          summary: 'No dependencies',
          inputs: ['src/value.mjs'],
          variables: {},
          setup: [],
          ready: [{ id: 'node', title: 'Node', command: 'node --version', timeoutMs: 10000 }],
        },
      },
    },
    async verifyAccepted(run) {
      assert.match(
        await fs.readFile(path.join(run.workspace, 'src/value.mjs'), 'utf8'),
        /^\s*export\s+const\s+value\s*=\s*2\s*;?\s*$/,
      );
    },
  };
}

function assertMixedDelegation(run) {
  const reviewer = run.agents.find((agent) => agent.session?.roleId === 'reviewer');
  const worker = run.agents.find(
    (agent) =>
      agent.session &&
      !['coordinator', 'reviewer'].includes(agent.session.roleId) &&
      agent.session.runtimeId === 'ollama-live' &&
      agent.session.result?.status === 'success' &&
      agent.status === 'completed' &&
      agent.threadId &&
      agent.threadId !== run.threadId &&
      agent.threadId !== reviewer?.threadId,
  );
  if (
    !worker ||
    run.coordinatorSession?.runtimeId !== 'deepseek-live' ||
    reviewer?.session?.runtimeId !== 'deepseek-live' ||
    !reviewer.threadId ||
    reviewer.threadId === run.threadId
  )
    throw new LiveEvaluationError('LIVE_MIXED_DELEGATION_MISSING');
}

/** Typed service issues take precedence; legacy public text remains a bounded diagnostic heuristic. */
function classifyEvaluationFailure(run) {
  const terminalFailure = ['failed', 'needs-attention'].includes(run.status);
  if (
    terminalFailure &&
    run.issue?.code === 'MANAGED_BUDGET_BLOCKED' &&
    [
      'RUN_BUDGET_EXHAUSTED',
      'RUN_BUDGET_USAGE_EXCEEDED',
      'INVALID_RUN_BUDGET',
      'RUN_BUDGET_OWNER_UNKNOWN',
      'BUDGET_RECEIPT_CONFLICT',
    ].includes(run.issue.budgetCode)
  )
    return {
      category: 'runBudget',
      status:
        run.issue.budgetCode === 'RUN_BUDGET_EXHAUSTED' ? 'budget-exhausted' : 'resource-blocked',
      code:
        run.issue.budgetCode === 'RUN_BUDGET_EXHAUSTED'
          ? 'LIVE_RUN_BUDGET_EXHAUSTED'
          : 'LIVE_RUN_BUDGET_BLOCKED',
      evidence: 'service-budget-issue',
      basis: 'typed-service-issue',
    };
  const message = typeof run.result === 'string' ? run.result : '';
  const classified = (category, status, code, evidence = 'known-service-message') => ({
    category,
    status,
    code,
    evidence,
    basis: 'public-status-message heuristic',
  });
  if (terminalFailure) {
    if (message === 'The saved work segment limit is exhausted.')
      return classified('workSegmentLimit', 'resource-blocked', 'LIVE_WORK_SEGMENT_LIMIT');
    if (message === 'The saved worker check feedback limit is exhausted.')
      return classified(
        'stepCheckFeedbackLimit',
        'resource-blocked',
        'LIVE_STEP_CHECK_FEEDBACK_LIMIT',
      );
    if (
      message === 'A registered worker check is unavailable. No automatic repair was started.' ||
      message === 'The saved worker scope, checks or prepared environment is unavailable.' ||
      message === 'The workspace changed while its worker checks were running.'
    )
      return classified('stepCheckUnavailable', 'resource-blocked', 'LIVE_STEP_CHECK_UNAVAILABLE');
    if (
      message ===
        'A saved model generation has an unknown outcome. It cannot be automatically repeated.' ||
      message ===
        'A saved tool action has an unknown outcome. It cannot be automatically repeated.' ||
      message ===
        'A saved service check has an unknown outcome. It cannot be automatically repeated.'
    )
      return classified('unknownOutcome', 'resource-blocked', 'LIVE_RECONCILIATION_REQUIRED');
    if (/^Acceptance failed: [0-9]+\/[0-9]+ checks;/.test(message))
      return classified(
        'qualityFailure',
        'quality-failed',
        'LIVE_CODING_QUALITY_FAILED',
        run.review?.verdict === 'changes_requested' ? 'service-review' : 'service-checks',
      );
    if (
      /^The conservative context estimate exceeds the configured token budget\./.test(message) ||
      message === 'The configured context exceeds this model capability.'
    )
      return classified('contextBudget', 'budget-exhausted', 'LIVE_CONTEXT_BUDGET_EXHAUSTED');
    if (
      message === 'The model response did not complete.' ||
      /^(?:Ollama|DeepSeek) generation ended without a terminal response\.$/.test(message) ||
      message === 'An incomplete streamed tool call was returned.'
    )
      return classified('outputIncomplete', 'resource-blocked', 'LIVE_OUTPUT_INCOMPLETE');
    if (
      message === 'The configured model endpoint could not be reached.' ||
      /^Model endpoint returned HTTP (?:401|402|403|404|429|5[0-9]{2})\. No provider fallback was used\.$/.test(
        message,
      ) ||
      message ===
        'The saved runtime configuration is unavailable. Restore it or start a new attempt.' ||
      /^Runtime unavailable: (?:ollama-live|deepseek-live)$/.test(message)
    )
      return classified('unavailable', 'resource-blocked', 'LIVE_PROVIDER_UNAVAILABLE');
  }
  return classified('qualityFailure', 'quality-failed', 'LIVE_CODING_QUALITY_FAILED', 'unknown');
}

function evaluationRunProgress(run) {
  const phases = new Set([
    'queued',
    'preparing',
    'planning',
    'implementation',
    'checking',
    'repair',
    'review',
  ]);
  const last = (run.events || [])
    .map((event) => event.type)
    .filter(
      (type) => typeof type === 'string' && type.startsWith('phase.') && phases.has(type.slice(6)),
    )
    .at(-1);
  return {
    planSaved: typeof run.planSavedAt === 'string' && !!run.planSavedAt,
    planStepsCount: Array.isArray(run.plan) ? run.plan.length : 0,
    ...(last ? { lastPhaseBeforeDone: last.slice(6) } : {}),
  };
}

/** Run one configured route once. Importing this module never starts models or network requests. */
async function runLiveProviderEvaluation(options = {}) {
  const checked = preflight(options);
  const report = {
    version: 1,
    startedAt: new Date().toISOString(),
    mode: options.mode,
    live: !options.fetch,
    status: 'blocked',
    stage: 'preflight',
    caseId: options.sourceCase?.id || 'synthetic-value',
    forceWorker: !!options.forceWorker,
    ...(options.segmentPolicy
      ? { segmentPolicy: { revision: options.segmentPolicy.revision } }
      : {}),
  };
  let budget;
  try {
    budget = new EvaluationBudget(checked.ok ? checked.limits : options.budgets);
  } catch (error) {
    report.error = safeError(error);
    report.finishedAt = new Date().toISOString();
    await writeReport(options.reportPath, report);
    return report;
  }
  if (!checked.ok) {
    report.error = { code: checked.code };
    report.budget = budget.snapshot();
    report.http = { requests: [], responses: [], metadata: { ollama: 0, deepseek: 0 } };
    report.finishedAt = new Date().toISOString();
    await writeReport(options.reportPath, report);
    return report;
  }
  const limits = checked.limits;
  report.models = Object.fromEntries(
    Object.entries(checked.models).filter(([name]) => checked.endpoints[name] || name === 'codex'),
  );
  report.contextTokensByProvider = checked.contexts;
  const observedFetch = createBudgetedFetch({
    endpoints: checked.endpoints,
    budget,
    fetch: options.fetch || globalThis.fetch,
    stage: () =>
      report.stage === 'capability-probe'
        ? 'diagnostic'
        : report.stage === 'coding-goal'
          ? 'coding'
          : 'forbidden',
  });
  const nativeUsage = new Map();
  const recordNativeUsage = ({ method, params }) => {
    if (method !== 'thread/tokenUsage/updated') return;
    const total = object(object(params).tokenUsage).total;
    const threadId = object(params).threadId;
    if (
      typeof threadId === 'string' &&
      Number.isSafeInteger(total?.inputTokens) &&
      total.inputTokens >= 0 &&
      Number.isSafeInteger(total?.outputTokens) &&
      total.outputTokens >= 0
    )
      nativeUsage.set(threadId, {
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
      });
  };
  let host, runId, codingTimer, diagnosticTimer, fixture, original, unsubscribe;
  const temporaryDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-provider-evaluation-')),
  );
  report.fixtureDirectory = temporaryDirectory;
  try {
    report.status = 'running';
    report.stage = 'setup';
    await writeReport(options.reportPath, report);
    fixture = options.sourceCase?.prepare
      ? await options.sourceCase.prepare({ temporaryDirectory, mode: checked.mode, limits })
      : await prepareSyntheticFixture(
          temporaryDirectory,
          options.forceWorker ? 'mixed' : checked.mode,
        );
    const realRoot = await fs.realpath(fixture.root);
    if (realRoot !== temporaryDirectory && !realRoot.startsWith(temporaryDirectory + path.sep))
      throw new LiveEvaluationError('LIVE_FIXTURE_OUTSIDE_TEMPORARY_DIRECTORY');
    if (!fixture.profile?.checks?.length || typeof fixture.verifyAccepted !== 'function')
      throw new LiveEvaluationError('LIVE_INVALID_FIXTURE');
    report.caseId = fixture.caseId || report.caseId;
    if (fixture.evidence?.source) report.sourceCase = sourceCaseEvidence(fixture);
    const root = realRoot,
      directory = path.join(root, '.buro');
    original = await sourceState(root);
    const { createHost } = await import('../../plugins/host.ts');
    const { resourcesPlugin } = await import('../../plugins/resources.ts');
    const { executionPlugin } = await import('../../plugins/execution.ts');
    const { PrivateJSONFiles } = await import('../../adapters/files/private-json.ts');
    const { FileManagedSessions } = await import('../../adapters/files/managed-sessions.ts');
    const { FileRuntimeRoutes } = await import('../../adapters/files/runtime-routes.ts');
    const { EnvironmentExecutors } = await import('../../adapters/environments/executors.ts');
    const { ProjectEnvironments } = await import(
      '../../adapters/environments/project-environments.ts'
    );
    const { ProjectChecks } = await import('../../adapters/checks/project-commands.ts');
    const { GitWorkspaces } = await import('../../adapters/files/git-workspaces.ts');
    const { ResourceConfigurationSchema } = await import(
      '../../adapters/files/resource-configuration.ts'
    );
    const { ProjectProfileSchema } = await import('../../protocol/projects.ts');
    const usesOllama = ['ollama', 'mixed'].includes(checked.mode),
      usesDeepSeek = ['deepseek', 'mixed'].includes(checked.mode),
      usesCodex = checked.mode === 'codex';
    const runtimeLimits = {
      contextTokens: limits.contextTokens,
      maxOutputTokens: limits.maxOutputTokens,
      maxRequestsPerTurn: limits.maxGenerationRequests,
      maxToolCallsPerTurn: 24,
      maxSessionRequests: limits.maxGenerationRequests,
    };
    const configuration = ResourceConfigurationSchema.parse({
      version: 1,
      defaultProfile: 'evaluation',
      connections: [
        ...(usesOllama
          ? [
              {
                id: 'ollama',
                provider: 'ollama',
                config: {
                  endpoint: checked.endpoints.ollama,
                  capacity: 1,
                  think: false,
                  ...(checked.ollamaTrust ? { trust: checked.ollamaTrust } : {}),
                },
              },
            ]
          : []),
        ...(usesDeepSeek
          ? [
              {
                id: 'deepseek',
                provider: 'deepseek',
                config: {
                  endpoint: checked.endpoints.deepseek,
                  apiKeyEnv: 'DEEPSEEK_API_KEY',
                  capacity: 1,
                  thinking: 'disabled',
                },
              },
            ]
          : []),
      ],
      runtimes: [
        ...(usesCodex ? [{ id: 'codex', backend: 'codex', config: {} }] : []),
        ...(usesOllama
          ? [
              {
                id: 'ollama-live',
                backend: 'managed',
                config: {
                  connectionId: 'ollama',
                  model: checked.models.ollama,
                  limits: { ...runtimeLimits, contextTokens: checked.contexts.ollama },
                },
              },
            ]
          : []),
        ...(usesDeepSeek
          ? [
              {
                id: 'deepseek-live',
                backend: 'managed',
                config: {
                  connectionId: 'deepseek',
                  model: checked.models.deepseek,
                  limits: { ...runtimeLimits, contextTokens: checked.contexts.deepseek },
                },
              },
            ]
          : []),
      ],
      profiles: [
        {
          id: 'evaluation',
          name: 'Bounded provider evaluation',
          policy: usesDeepSeek || usesCodex ? 'hybrid' : 'local-only',
          coordinator: usesCodex ? 'codex' : usesDeepSeek ? 'deepseek-live' : 'ollama-live',
          worker: usesCodex ? 'codex' : usesOllama ? 'ollama-live' : 'deepseek-live',
          reviewer: usesCodex ? 'codex' : usesDeepSeek ? 'deepseek-live' : 'ollama-live',
        },
      ],
    });
    const profile = ProjectProfileSchema.parse({
      ...fixture.profile,
      resourceProfile: 'evaluation',
    });
    await new PrivateJSONFiles(path.join(directory, 'local')).save('resources', configuration);
    host = await createHost({
      projects: [
        {
          storageAddress: directory,
          project: { id: 'p', name: 'Provider evaluation fixture', root, managed: true },
          profile,
        },
      ],
    });
    const executors = new EnvironmentExecutors();
    const workspaces = new GitWorkspaces(host.ctx.projects.registry);
    const checks = fixture.createChecks
      ? await fixture.createChecks({ projects: host.ctx.projects.registry, executors })
      : new ProjectChecks(
          host.ctx.projects.registry,
          {
            async run() {
              throw new LiveEvaluationError('LIVE_FALLBACK_CHECKS_FORBIDDEN');
            },
          },
          executors,
        );
    if (typeof checks?.run !== 'function') throw new LiveEvaluationError('LIVE_INVALID_CHECK_PORT');
    await host.ctx.plugin(resourcesPlugin, {
      directory,
      executors,
      workspaces,
      checks,
      segmentPolicy: options.segmentPolicy,
      fetch: observedFetch,
      credentials: options.credentials,
      codex: usesCodex
        ? { ...options.codex, networkAccess: false, onEvent: recordNativeUsage }
        : { executable: path.join(root, 'codex-not-installed') },
    });
    assert.deepEqual(
      host.ctx.agentRuntime.registry.list().sort(),
      configuration.runtimes.map((runtime) => runtime.id).sort(),
    );
    const command = (value) =>
      host.ctx.commands.bus.execute(value, {
        id: 'live-' + randomUUID(),
        fingerprint: JSON.stringify(value),
      });
    for (const provider of usesOllama && usesDeepSeek
      ? ['ollama', 'deepseek']
      : usesCodex
        ? []
        : [usesOllama ? 'ollama' : 'deepseek']) {
      const installed = await command({
        method: 'resources.models',
        params: { connectionId: provider },
      });
      if (!installed.some((model) => model.id === checked.models[provider]))
        throw new LiveEvaluationError('LIVE_MODEL_NOT_AVAILABLE');
    }
    if (!usesCodex) {
      report.stage = 'capability-probe';
      diagnosticTimer = setTimeout(
        () => budget.stop('LIVE_DIAGNOSTIC_TIMEOUT'),
        limits.diagnosticWallTimeMs,
      );
      await writeReport(options.reportPath, report);
      const probeRuntime = usesOllama ? 'ollama-live' : 'deepseek-live';
      const probe = await command({
        method: 'resources.probe',
        params: { runtimeId: probeRuntime },
      });
      report.diagnostic = {
        status: probe.status,
        runtimeId: probeRuntime,
        tools: probe.tools,
        structured: probe.structured,
      };
      clearTimeout(diagnosticTimer);
    } else report.diagnostic = { status: 'not-applicable', runtimeId: 'codex' };
    const environments = new ProjectEnvironments(
      host.ctx.projects.registry,
      host.ctx.agentRuntime.adapter,
      executors,
      host.ctx.agentRuntime.selection,
    );
    const { executionPolicy } = await import('../../adapters/files/project-manager.ts');
    const policy = executionPolicy(profile);
    await host.ctx.plugin(executionPlugin, {
      policies: { p: policy },
      workspaces,
      checks,
      environments,
    });
    const goal = await command({
      method: 'goal.create',
      params: {
        projectId: 'p',
        ...fixture.goal,
        ...(options.forceWorker
          ? {
              body:
                fixture.goal.body +
                '\nDelegate the implementation to one real worker. The coordinator plans and integrates; Buro starts the worker and fresh reviewer. An empty team does not satisfy this evaluation. The worker must make the actual change in its own session.',
              criteria:
                fixture.goal.criteria +
                ' A distinct worker session implements the change successfully.',
            }
          : {}),
      },
    });
    report.stage = 'coding-goal';
    codingTimer = setTimeout(() => {
      budget.stop('LIVE_CODING_TIMEOUT');
      if (runId)
        void command({ method: 'run.cancel', params: { projectId: 'p', runId } }).catch(() => {});
    }, limits.codingWallTimeMs);
    runId = (await command({ method: 'run.start', params: { projectId: 'p', goalId: goal.id } }))
      .runId;
    report.runId = runId;
    await writeReport(options.reportPath, report);
    const store = host.ctx.projects.registry.get('p');
    unsubscribe = store.subscribe(store.snapshot().sequence, (event) => {
      if (event.change.type === 'run.changed' && event.change.run.id === runId)
        report.currentPhase = event.change.run.phase;
    });
    await host.ctx.workflows.api.jobs.get(runId)?.promise;
    clearTimeout(codingTimer);
    const run = host.ctx.workflows.api.get('p', runId);
    await options.onRunFinished?.({ run, fixture });
    report.run = {
      ...evaluationRunProgress(run),
      ...(run.planningPolicy ? { planningPolicy: { ...run.planningPolicy } } : {}),
      ...(run.managedBudget ? { managedBudget: structuredClone(run.managedBudget) } : {}),
      status: run.status,
      phase: run.phase,
      profile: run.resources?.profileId,
      policy: run.resources?.policy,
      baselinePassed: run.baseline.passed,
      baselineTotal: run.baseline.total,
      acceptancePassed: run.acceptance.passed,
      acceptanceTotal: run.acceptance.total,
      independentReviewer: run.independentReviewer,
      reviewVerdict: run.review?.verdict,
      blockingFindingsCount: run.review?.blockingFindings?.length,
      acceptedCommit: !!run.commit,
      changedFiles: run.changedFiles.map((file) =>
        fixture.expectedChangedPaths.includes(file.path) ? file.path : '[unexpected-path]',
      ),
      sessions: [run.coordinatorSession, ...run.agents.map((agent) => agent.session)]
        .filter(Boolean)
        .map((session) => ({
          role: ['coordinator', 'reviewer'].includes(session.roleId) ? session.roleId : 'worker',
          runtimeId: ['codex', 'ollama-live', 'deepseek-live'].includes(session.runtimeId)
            ? session.runtimeId
            : 'unknown',
          requestedModelMatchesConfigured: Object.values(checked.models).includes(session.model),
          reportedModelMatchesConfigured: session.reportedModel === session.model,
        })),
    };
    report.originalSourcePreserved =
      JSON.stringify(await sourceState(root)) === JSON.stringify(original);
    const routes = new FileRuntimeRoutes(path.join(directory, 'local/runtime-routes'));
    const sessions = new FileManagedSessions(path.join(directory, 'local/managed-sessions'));
    report.checkpoints = [];
    for (const saved of await loadManagedCheckpoints(
      [run.threadId, ...run.agents.map((agent) => agent.threadId)],
      routes,
      sessions,
    )) {
      if (saved)
        report.checkpoints.push({
          requests: saved.requests,
          actions: saved.actions.map(({ status, call }) => ({
            status,
            tool: knownTools.has(call.name) ? call.name : 'unknown',
          })),
          usage: saved.usage,
          ...(saved.workSegments
            ? {
                workSegments: {
                  archiveCount: saved.workSegments.archives.length,
                  activeIndex: saved.workSegments.active.index,
                  policyRevision: saved.workSegments.limits.revision,
                },
              }
            : {}),
          ...(saved.workerStepChecks
            ? {
                workerStepChecks: {
                  revision: saved.workerStepChecks.revision,
                  feedbackSteps: saved.workerStepChecks.feedbackSteps,
                  entries: saved.workerStepChecks.entries.map((entry) => ({
                    status: entry.status,
                    ...(entry.result
                      ? {
                          outcome: entry.result.outcome,
                          passed: entry.result.passed,
                          total: entry.result.total,
                        }
                      : {}),
                  })),
                },
              }
            : {}),
        });
    }
    if (budget.violation) throw new LiveEvaluationError(budget.violation);
    if (
      run.status !== 'completed' ||
      !run.commit ||
      !run.independentReviewer ||
      run.review?.verdict !== 'approved' ||
      !run.acceptance.total ||
      run.acceptance.passed !== run.acceptance.total
    ) {
      report.failureClassification = classifyEvaluationFailure(run);
      throw new LiveEvaluationError(report.failureClassification.code);
    }
    if (!report.originalSourcePreserved)
      throw new LiveEvaluationError('LIVE_ORIGINAL_FIXTURE_MODIFIED');
    if (fixture.expectedBaseline) {
      assert.equal(run.baseline.passed, fixture.expectedBaseline.passed);
      assert.equal(run.baseline.total, fixture.expectedBaseline.total);
    }
    assert.deepEqual(
      run.changedFiles.map((file) => file.path).sort(),
      [...fixture.expectedChangedPaths].sort(),
    );
    let verification;
    try {
      verification = await fixture.verifyAccepted(run);
      if (
        options.sourceCase &&
        (!verification ||
          verification.passed !== true ||
          !Number.isSafeInteger(verification.checks) ||
          verification.checks < 1)
      )
        throw new LiveEvaluationError('LIVE_HOLDOUT_FAILED');
    } catch {
      throw new LiveEvaluationError('LIVE_HOLDOUT_FAILED');
    }
    if (verification?.passed === true)
      report.holdout = {
        passed: true,
        checks: verification.checks,
        sourceHash: /^[a-f0-9]{64}$/.test(verification.sourceHash || '')
          ? verification.sourceHash
          : 'unknown',
      };
    if (checked.mode === 'mixed') assertMixedDelegation(run);
    if (
      options.forceWorker &&
      !run.agents.some(
        (agent) =>
          agent.session &&
          !['coordinator', 'reviewer'].includes(agent.session.roleId) &&
          agent.session.result?.status === 'success' &&
          agent.status === 'completed' &&
          agent.threadId &&
          agent.threadId !== run.threadId &&
          !run.agents.some(
            (reviewer) =>
              reviewer.session?.roleId === 'reviewer' && reviewer.threadId === agent.threadId,
          ),
      )
    )
      throw new LiveEvaluationError('LIVE_WORKER_DELEGATION_MISSING');
    report.status = 'passed';
    report.stage = 'complete';
  } catch (error) {
    const code = budget.violation || safeError(error).code;
    report.error = { code };
    report.status =
      report.failureClassification?.code === code
        ? report.failureClassification.status
        : /TIMEOUT/.test(code)
          ? 'timed-out'
          : /BUDGET|LIMIT_VIOLATION/.test(code)
            ? 'budget-exhausted'
            : /QUALITY_FAILED|DELEGATION_MISSING|HOLDOUT_FAILED/.test(code)
              ? 'quality-failed'
              : code === 'LIVE_MODEL_NOT_AVAILABLE'
                ? 'blocked'
                : 'failed';
  } finally {
    clearTimeout(codingTimer);
    clearTimeout(diagnosticTimer);
    unsubscribe?.();
    try {
      await host?.dispose();
    } catch {
      report.cleanupFailed = true;
      report.status = 'failed';
      report.error ||= { code: 'LIVE_CLEANUP_FAILED' };
    }
    if (fixture && original) {
      try {
        report.originalSourcePreserved =
          JSON.stringify(await sourceState(fixture.root)) === JSON.stringify(original);
      } catch {
        report.originalSourcePreserved = false;
      }
      if (!report.originalSourcePreserved) {
        report.status = 'failed';
        report.error = { code: 'LIVE_ORIGINAL_FIXTURE_MODIFIED' };
      }
    }
    if (fixture?.assertOriginalUnchanged) {
      try {
        await fixture.assertOriginalUnchanged();
        report.userRepositoryPreserved = true;
      } catch {
        report.userRepositoryPreserved = false;
        report.status = 'failed';
        report.error = { code: 'LIVE_ORIGINAL_REPOSITORY_CHANGED' };
      }
    }
    if (fixture?.evidence?.source) report.sourceCase = sourceCaseEvidence(fixture);
    if (checked.mode === 'codex') {
      report.nativeAccounting = {
        coverage: 'reported-usage-only',
        generationRequests: null,
        reservedOutputTokens: null,
        hardTokenCeilings: false,
      };
      if (nativeUsage.size)
        report.nativeUsage = [...nativeUsage.values()].reduce(
          (sum, usage) => ({
            inputTokens: sum.inputTokens + usage.inputTokens,
            outputTokens: sum.outputTokens + usage.outputTokens,
          }),
          { inputTokens: 0, outputTokens: 0 },
        );
    }
    report.http = observedFetch.snapshot();
    report.budget = budget.snapshot();
    report.finishedAt = new Date().toISOString();
    await writeReport(options.reportPath, report);
  }
  return report;
}

module.exports = {
  RTX_EVALUATION_ENDPOINT,
  RTX_EVALUATION_MODEL,
  evaluationTargetContract,
  DEFAULT_LIVE_LIMITS,
  LiveEvaluationError,
  EvaluationBudget,
  normalizedLimits,
  contextBudgets,
  preflight,
  loadManagedCheckpoints,
  createBudgetedFetch,
  assertMixedDelegation,
  classifyEvaluationFailure,
  evaluationRunProgress,
  sourceCaseEvidence,
  prepareSyntheticFixture,
  runLiveProviderEvaluation,
};
