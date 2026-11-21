const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { normalizedLimits, runLiveProviderEvaluation } = require('./live-provider-runner.cjs');
const exec = promisify(execFile);
const { SAFE_JSON_SOURCE } = require('./oracle-serialization.cjs');

const ARMS = Object.freeze([
  'codex-direct',
  'codex-buro',
  'deepseek-buro',
  'ollama-buro',
  'mixed-buro',
]);
const CASE_ID = 'synthetic-ready-queue-v1';
const TASK = Object.freeze({
  title: 'Correct ready-task selection and preserve priority zero',
  body: 'Fix the small dependency-free task queue. selectReady(tasks, completedIds) must return unfinished tasks only when every dependency is completed; tasks without dependencies are ready. Sort ready tasks by descending priority and preserve input order for equal priorities. priorityOf(task) must preserve explicit priority 0 and use priority 2 only when priority is null or missing. Preserve the exported APIs and do not mutate either input. Work only on src/priority.mjs and src/queue.mjs; no dependencies, networking, process spawning, or changes to the protected checks. The public examples are in checks/public.cjs. Inspect the implementation, make the correction, and finish so independent checks can verify it.',
  criteria:
    'The public examples and independent additional cases pass. Only src/priority.mjs and src/queue.mjs change. Both exported APIs and input values are preserved.',
});
const FILES = Object.freeze({
  '.gitignore': '.buro/\n',
  'README.md':
    '# Ready task queue\n\nDependency-free JavaScript. Run public examples with `node checks/public.cjs`.\n\nA task has id, optional dependsOn (an array of IDs), and optional priority (an integer). Higher priority runs first. Missing or null priority means 2; zero is valid. selectReady must preserve input arrays and task objects.\n',
  'src/priority.mjs': 'export function priorityOf(task) {\n  return task.priority || 2;\n}\n',
  'src/queue.mjs':
    "import { priorityOf } from './priority.mjs';\n\nexport function selectReady(tasks, completedIds = []) {\n  const done = new Set(completedIds);\n  return tasks\n    .filter(task => !done.has(task.id) && (task.dependsOn || []).some(id => done.has(id)))\n    .sort((a, b) => priorityOf(b) - priorityOf(a));\n}\n",
  'checks/public.cjs':
    "const assert = require('node:assert/strict');\n(async () => {\n  const { priorityOf } = await import('../src/priority.mjs');\n  const { selectReady } = await import('../src/queue.mjs');\n  assert.equal(priorityOf({ priority: 0 }), 0);\n  assert.deepEqual(selectReady([{ id: 'independent', priority: 1 }]).map(t => t.id), ['independent']);\n  assert.deepEqual(selectReady([{ id: 'blocked', dependsOn: ['a', 'b'] }], ['a']).map(t => t.id), []);\n  console.log('Public queue examples passed');\n})().catch(() => { console.error('Public queue examples failed'); process.exitCode = 1; });\n",
});
const ALLOWED = Object.freeze(['src/priority.mjs', 'src/queue.mjs']);
const PUBLIC_CASES = Object.freeze([
  { name: 'explicit-zero', task: { priority: 0 }, expected: 0 },
  {
    name: 'independent-task',
    tasks: [{ id: 'independent', priority: 1 }],
    done: [],
    expected: ['independent'],
  },
  {
    name: 'all-dependencies-required',
    tasks: [{ id: 'blocked', dependsOn: ['a', 'b'] }],
    done: ['a'],
    expected: [],
  },
]);
const HOLDOUT_CASES = Object.freeze([
  { name: 'missing-priority', task: {}, expected: 2 },
  { name: 'null-priority', task: { priority: null }, expected: 2 },
  {
    name: 'zero-below-one',
    tasks: [{ id: 'zero', priority: 0 }, { id: 'one', priority: 1 }, { id: 'default' }],
    done: [],
    expected: ['default', 'one', 'zero'],
  },
  {
    name: 'completed-and-ready',
    tasks: [
      { id: 'done', priority: 5 },
      { id: 'ready', dependsOn: ['a', 'b'], priority: 1 },
      { id: 'blocked', dependsOn: ['c'], priority: 4 },
    ],
    done: ['done', 'a', 'b'],
    expected: ['ready'],
  },
  {
    name: 'stable-equal-priorities',
    tasks: [
      { id: 'first', dependsOn: [], priority: 2 },
      { id: 'second', priority: 2 },
      { id: 'third', dependsOn: ['a'], priority: 2 },
    ],
    done: ['a'],
    expected: ['first', 'second', 'third'],
  },
]);
const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
const IDENTITY = Object.freeze({
  caseId: CASE_ID,
  caseHash: hash({ files: FILES, task: TASK, public: PUBLIC_CASES, holdout: HOLDOUT_CASES }),
  fixtureHash: hash(FILES),
  sourceHash: hash(ALLOWED.map((file) => [file, hash(FILES[file])])),
  taskHash: hash(TASK),
  oracleHash: hash({ public: PUBLIC_CASES, holdout: HOLDOUT_CASES }),
  allowedPaths: ALLOWED,
  publicChecks: PUBLIC_CASES.length,
  holdoutChecks: HOLDOUT_CASES.length,
});
const codeError = (code) => Object.assign(new Error(code), { code });
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

// The parent owns expectations. Candidate code returns values in a read-only, network-denied
// child; it never gets to assert the outcome of a comparison or access the parent's process.
const ORACLE_CHILD = `
import { readFileSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
${SAFE_JSON_SOURCE}
const parse = JSON.parse.bind(JSON);
const map = Function.call.bind(Array.prototype.map);
const isArray = Array.isArray;
const freeze = Object.freeze;
const values = Object.values;
const request = parse(readFileSync(0, 'utf8'));
const freezeInput = value => {
  if (value && typeof value === 'object') {
    map(values(value), freezeInput);
    freeze(value);
  }
};
freezeInput(request.inputs);
const emit = writeSync.bind(null, 1);
const root = process.argv[1];
const { priorityOf } = await import(pathToFileURL(path.join(root, 'src/priority.mjs')));
const { selectReady } = await import(pathToFileURL(path.join(root, 'src/queue.mjs')));
const outputs = map(request.inputs, input => {
  const before = stringify(input);
  let value;
  if ('task' in input) value = priorityOf(input.task);
  else {
    const selected = selectReady(input.tasks, input.done);
    if (!isArray(selected)) throw Error('Task selection must return an array');
    value = map(selected, task => task.id);
  }
  return { value, unchanged: stringify(input) === before };
});
emit(stringify({ nonce: request.nonce, outputs }));
`;

/** Spawn only an already-confined specification, and always reap its process group. */
async function confinedOutput(launch, input, { signal, timeoutMs = 10000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      failed,
      escalation;
    const killGroup = (kind) => {
      try {
        if (child.pid) process.kill(-child.pid, kind);
      } catch {}
    };
    const stop = (code) => {
      failed ||= codeError(code);
      killGroup('SIGTERM');
      escalation ||= setTimeout(() => killGroup('SIGKILL'), 500);
    };
    const timer = setTimeout(() => stop('COMPARISON_ORACLE_TIMEOUT'), timeoutMs);
    const abort = () => stop('COMPARISON_ABORTED');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk) => {
      if (failed) return;
      output += String(chunk);
      if (Buffer.byteLength(output) > 65536) stop('COMPARISON_ORACLE_OUTPUT_LIMIT');
    });
    let stderrBytes = 0;
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65536) stop('COMPARISON_ORACLE_OUTPUT_LIMIT');
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') stop('COMPARISON_ORACLE_INPUT_FAILED');
    });
    child.once('error', () => {
      failed ||= codeError('COMPARISON_ORACLE_PROCESS_FAILED');
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      killGroup('SIGKILL');
      if (failed) reject(failed);
      else if (exitCode !== 0) reject(codeError('COMPARISON_ORACLE_PROCESS_FAILED'));
      else resolve(output);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function candidateFiles(workspace) {
  const files = {};
  let entries = 0;
  const visit = async (directory, relative = '') => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!relative && ['.git', '.buro'].includes(entry.name)) continue;
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (
        ++entries > 100 ||
        name.split('/').length > 16 ||
        name.length > 500 ||
        entry.isSymbolicLink()
      )
        throw codeError('COMPARISON_UNSAFE_CANDIDATE');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, name);
      else {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > 1024 * 1024)
          throw codeError('COMPARISON_UNSAFE_CANDIDATE');
        const handle = await fs.open(
          file,
          require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW,
        );
        try {
          files[name] = hash(await handle.readFile());
        } finally {
          await handle.close();
        }
      }
    }
  };
  assert.equal(await fs.realpath(workspace), workspace);
  await visit(workspace);
  return files;
}

async function inspectScope(workspace) {
  const actual = await candidateFiles(workspace);
  const changed = [...new Set([...Object.keys(FILES), ...Object.keys(actual)])]
    .filter((file) => !Object.hasOwn(FILES, file) || actual[file] !== hash(FILES[file]))
    .sort();
  const unexpected = changed.filter((file) => !ALLOWED.includes(file));
  return {
    passed: unexpected.length === 0,
    changedFiles: changed.map((file) => (ALLOWED.includes(file) ? file : '[unexpected-path]')),
    unexpectedCount: unexpected.length,
    sourceHash: hash(ALLOWED.map((file) => [file, actual[file] || null])),
  };
}

async function canonicalOracle(fixture, workspace, phase, options = {}) {
  const cases = phase === 'public' ? PUBLIC_CASES : phase === 'holdout' ? HOLDOUT_CASES : null;
  if (!cases) throw codeError('COMPARISON_INVALID_ORACLE_PHASE');
  const before = await inspectScope(workspace);
  if (!before.passed)
    return { passed: false, checks: cases.length, passedChecks: 0, scope: before };
  const { EnvironmentExecutors } = await import('../../adapters/environments/executors.ts');
  const executors = new EnvironmentExecutors();
  await executors.register(
    workspace,
    fixture.root,
    { provider: 'native' },
    options.signal || new AbortController().signal,
    { privateDataIsolation: true },
  );
  const launch = executors.launch(
    workspace,
    [process.execPath, '--input-type=module', '-e', ORACLE_CHILD, workspace],
    { readOnly: true, privateDataIsolation: true, allowNetwork: false },
  );
  const nonce = randomUUID();
  const inputs = cases.map(({ expected, name, ...input }) => input);
  let rows;
  try {
    const output = await (options.execute || confinedOutput)(launch, { nonce, inputs }, options);
    const reply = JSON.parse(output);
    assert.equal(reply.nonce, nonce);
    assert.equal(reply.outputs.length, cases.length);
    rows = cases.map((entry, index) => ({
      name: entry.name,
      passed:
        reply.outputs[index]?.unchanged === true &&
        JSON.stringify(reply.outputs[index]?.value) === JSON.stringify(entry.expected),
    }));
  } catch (error) {
    options.signal?.throwIfAborted();
    rows = cases.map((entry) => ({ name: entry.name, passed: false }));
  }
  const after = await inspectScope(workspace);
  const passedChecks = rows.filter((row) => row.passed).length;
  return {
    passed: passedChecks === cases.length && after.passed && before.sourceHash === after.sourceHash,
    checks: cases.length,
    passedChecks,
    rows,
    scope: after,
  };
}

/** Every invocation creates identical bytes in a fresh repository. No user source is read. */
async function prepareComparisonFixture({ temporaryDirectory }) {
  const root = await fs.realpath(temporaryDirectory);
  for (const [file, contents] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), contents);
  }
  const git = (args) => exec('git', args, { cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Buro comparison fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['add', '.']);
  await git(['commit', '-m', 'Synthetic queue comparison fixture']);
  const fixture = {
    root,
    caseId: CASE_ID,
    identity: IDENTITY,
    expectedChangedPaths: [...ALLOWED],
    expectedBaseline: { passed: 0, total: 1 },
    goal: { ...TASK },
    profile: {
      version: 1,
      revision: 1,
      resourceProfile: 'evaluation',
      context:
        'A small dependency-free JavaScript task queue with two source modules. The service owns independent checks.',
      scope: {
        mode: 'advisory',
        plannedPaths: [...ALLOWED],
        protectedPaths: Object.keys(FILES).filter((file) => !ALLOWED.includes(file)),
      },
      checks: [
        {
          id: 'test',
          title: 'Independent public queue examples',
          command: 'node checks/public.cjs',
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
          inputs: [...ALLOWED],
          variables: {},
          setup: [],
          ready: [{ id: 'node', title: 'Node', command: 'node --version', timeoutMs: 10000 }],
        },
      },
    },
    async createChecks() {
      return {
        async run(projectId, workspace, ids, signal, profile) {
          assert.deepEqual(ids, ['test']);
          assert.equal(
            profile.checks.find((check) => check.id === 'test')?.command,
            'node checks/public.cjs',
          );
          const started = Date.now();
          const result = await canonicalOracle(fixture, workspace, 'public', { signal });
          return {
            passed: result.passed ? 1 : 0,
            total: 1,
            results: [
              {
                name: 'Independent public queue examples',
                command: 'node checks/public.cjs',
                passed: result.passed,
                exitCode: result.passed ? 0 : 1,
                durationMs: Date.now() - started,
                output: JSON.stringify(result.rows || []),
              },
            ],
          };
        },
      };
    },
    async verifyAccepted(run) {
      fixture.finalWorkspace = run.workspace;
      const result = await canonicalOracle(fixture, run.workspace, 'holdout');
      assert.equal(result.passed, true);
      return { passed: true, checks: result.checks, sourceHash: result.scope.sourceHash };
    },
  };
  return fixture;
}

function validateComparison(options = {}) {
  const env = options.env || process.env;
  if (env.BURO_MODEL_COMPARISON !== '1') throw codeError('COMPARISON_OPT_IN_REQUIRED');
  const arms = options.arms || ARMS;
  if (
    !Array.isArray(arms) ||
    !arms.length ||
    new Set(arms).size !== arms.length ||
    arms.some((arm) => !ARMS.includes(arm))
  )
    throw codeError('COMPARISON_INVALID_ARMS');
  const native = arms.some((arm) => arm.startsWith('codex-'));
  if (native && env.BURO_LIVE_CODEX !== '1') throw codeError('COMPARISON_NATIVE_OPT_IN_REQUIRED');
  const models = {
    codex: options.models?.codex || env.BURO_CODEX_MODEL || 'gpt-6.1-sol',
    deepseek: options.models?.deepseek || env.BURO_DEEPSEEK_MODEL || 'deepseek-flash',
    ollama: options.models?.ollama || env.BURO_OLLAMA_MODEL || 'qwen3:4b-instruct-2507-q4_K_M',
  };
  const required = [
    native && 'codex',
    arms.some((arm) => ['deepseek-buro', 'mixed-buro'].includes(arm)) && 'deepseek',
    arms.some((arm) => ['ollama-buro', 'mixed-buro'].includes(arm)) && 'ollama',
  ].filter(Boolean);
  if (
    required.some(
      (provider) =>
        typeof models[provider] !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(models[provider]),
    )
  )
    throw codeError('COMPARISON_INVALID_MODEL');
  if (options.codex?.args) throw codeError('COMPARISON_NATIVE_ARGS_FORBIDDEN');
  const reasoningEffort = options.reasoningEffort || env.BURO_CODEX_REASONING || 'high';
  if (!['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort))
    throw codeError('COMPARISON_INVALID_REASONING');
  const endpoints = {
    deepseek: 'https://api.deepseek.com',
    ollama: 'http://127.0.0.1:11434',
    ...options.endpoints,
  };
  const local = new URL(endpoints.ollama);
  if (
    local.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) ||
    local.username ||
    local.password ||
    local.search ||
    local.hash ||
    local.pathname !== '/'
  )
    throw codeError('COMPARISON_LOCAL_OLLAMA_ONLY');
  if (new URL(endpoints.deepseek).href !== 'https://api.deepseek.com/')
    throw codeError('COMPARISON_DEEPSEEK_ENDPOINT_REQUIRED');
  const limits = normalizedLimits({
    contextTokens: 32768,
    maxOutputTokens: 2048,
    ...options.budgets,
  });
  return { arms: [...arms], models, reasoningEffort, endpoints, limits };
}

/** Direct native execution: one adapter turn, no goal service, planning, Buro workers or reviewer. */
async function runDirectCodex({ fixture, config, codex = {} }) {
  const { CodexRuntime } = await import('../../adapters/codex/runtime.ts');
  const { EnvironmentExecutors } = await import('../../adapters/environments/executors.ts');
  const controller = new AbortController();
  const executors = new EnvironmentExecutors();
  await executors.register(
    fixture.root,
    fixture.root,
    fixture.profile.environment,
    controller.signal,
  );
  const usageByThread = new Map();
  const nativeUsage = () =>
    usageByThread.size
      ? {
          inputTokens: [...usageByThread.values()].reduce(
            (sum, value) => sum + value.inputTokens,
            0,
          ),
          outputTokens: [...usageByThread.values()].reduce(
            (sum, value) => sum + value.outputTokens,
            0,
          ),
        }
      : undefined;
  const runtime = new CodexRuntime({
    projects: { get: () => ({ snapshot: () => ({ project: { root: fixture.root } }) }) },
    executors,
    ...codex,
    model: config.models.codex,
    reasoningEffort: config.reasoningEffort,
    networkAccess: false,
    onEvent(event) {
      const { method, params } = event;
      if (method !== 'thread/tokenUsage/updated' || typeof params?.threadId !== 'string') return;
      const usage = params.tokenUsage?.total;
      if (count(usage?.inputTokens) !== null && count(usage?.outputTokens) !== null)
        usageByThread.set(params.threadId, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
    },
  });
  let timedOut = false,
    cleanup = Promise.resolve();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    cleanup = runtime.dispose();
    void cleanup.catch(() => {});
  }, config.limits.codingWallTimeMs);
  const started = Date.now();
  try {
    const { threadId } = await runtime.start({
      projectId: 'comparison',
      workspace: fixture.root,
      instructions:
        'Implement the user task in this isolated evaluation repository. Native subagents, MCP, apps, hooks, web search and network project tools are disabled. Finish after implementation; independent checks decide acceptance.' +
        `\nProject context: ${fixture.profile.context || ''}\nEditable paths: ${fixture.profile.scope.plannedPaths.join(', ')}\nProtected paths: ${fixture.profile.scope.protectedPaths.join(', ')}`,
    });
    const goal = fixture.goal;
    await runtime.turn(threadId, `${goal.title}\n\n${goal.body}\n\nAcceptance: ${goal.criteria}`, {
      schema: {
        type: 'object',
        properties: { completed: { type: 'boolean' } },
        required: ['completed'],
        additionalProperties: false,
      },
      signal: controller.signal,
      timeoutMs: config.limits.codingWallTimeMs,
    });
    return {
      status: timedOut ? 'timeout' : 'completed',
      codingDurationMs: Date.now() - started,
      nativeUsage: nativeUsage(),
    };
  } catch {
    return {
      status: timedOut ? 'timeout' : 'failed',
      codingDurationMs: Date.now() - started,
      nativeUsage: nativeUsage(),
      error: { code: timedOut ? 'COMPARISON_CODING_TIMEOUT' : 'COMPARISON_NATIVE_FAILED' },
    };
  } finally {
    clearTimeout(timer);
    await cleanup;
    await runtime.dispose();
  }
}

function summarizeProvider(report, native) {
  const budget = report?.budget || {};
  return {
    status: [
      'blocked',
      'running',
      'passed',
      'failed',
      'completed',
      'timeout',
      'budget-exhausted',
      'resource-blocked',
    ].includes(report?.status)
      ? report.status
      : 'failed',
    ...(typeof report?.error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(report.error.code)
      ? { errorCode: report.error.code }
      : {}),
    orchestration: report?.run
      ? {
          planSaved: report.run.planSaved === true,
          baselinePassed: count(report.run.baselinePassed),
          baselineTotal: count(report.run.baselineTotal),
          acceptancePassed: count(report.run.acceptancePassed),
          acceptanceTotal: count(report.run.acceptanceTotal),
          independentReviewer: report.run.independentReviewer === true,
          reviewApproved: report.run.reviewVerdict === 'approved',
          acceptedCommit: report.run.acceptedCommit === true,
        }
      : null,
    budgetCoverage: native
      ? {
          kind: 'native-observed-only',
          requestsEnforced: false,
          tokensEnforced: false,
          generationRequests: null,
          reservedOutputTokens: null,
          observedInputTokens: count(report?.nativeUsage?.inputTokens),
          observedOutputTokens: count(report?.nativeUsage?.outputTokens),
        }
      : {
          kind: 'managed-enforced',
          requestsEnforced: true,
          tokensEnforced: true,
          generationRequests: count(budget.generationRequests),
          diagnosticRequests: count(budget.diagnosticRequests),
          codingGenerationRequests:
            count(budget.generationRequests) !== null && count(budget.diagnosticRequests) !== null
              ? budget.generationRequests - budget.diagnosticRequests
              : null,
          reservedOutputTokens: count(budget.reservedOutputTokens),
          observedInputTokens: count(budget.observedInputTokens),
          observedOutputTokens: count(budget.observedOutputTokens),
          requestsWithCompleteUsage: count(budget.requestsWithCompleteUsage),
          requestsWithUnknownUsage: count(budget.requestsWithUnknownUsage),
        },
  };
}

function comparisonTrialReport(reportPath, arm, planning) {
  if (!reportPath) return undefined;
  const outer = path.resolve(reportPath);
  const directory = path.join(
    path.dirname(outer),
    path.basename(outer, path.extname(outer)) + '-trials',
  );
  const file = path.join(directory, `${arm}-${planning}.json`);
  return { file, reference: path.relative(path.dirname(outer), file) };
}

async function writeDirectTrialReport(trial, fixture, config, provider) {
  if (!trial) return;
  await writeComparisonReport(trial.file, {
    version: 1,
    mode: 'codex-direct',
    caseId: fixture.caseId,
    fixtureDirectory: fixture.root,
    models: { codex: config.models.codex },
    ...summarizeProvider(provider, true),
    codingDurationMs: count(provider.codingDurationMs),
  });
}

/** Runs arms sequentially to avoid contention. Optional controls change only planning policy. */
async function runModelComparison(options = {}) {
  const config = validateComparison(options);
  const controls = options.planningControls || [
    { id: 'legacy', mode: 'legacy' },
    { id: 'bounded', mode: 'bounded' },
  ];
  if (
    !controls.length ||
    controls.some(
      (control) =>
        !/^[a-z][a-z0-9-]{0,39}$/.test(control.id) || !['legacy', 'bounded'].includes(control.mode),
    ) ||
    new Set(controls.map((control) => control.id)).size !== controls.length
  )
    throw codeError('COMPARISON_INVALID_CONTROLS');
  const report = {
    version: 1,
    syntheticOnly: true,
    fixture: IDENTITY,
    startedAt: new Date().toISOString(),
    limits: config.limits,
    comparability: {
      sameFixture: true,
      sameTask: true,
      sameOracle: true,
      sameCodingWall: true,
      oracleWallTimeMs: 10000,
      managedTokenCeilingsApplyToNative: false,
      nativeContextLimitEnforced: false,
      sameToolReadBoundary: false,
      nativeToolReadBoundary: 'native-default-host-read',
      managedToolReadBoundary: 'isolated-workspace-with-private-path-denials',
      buroRequiresWorker: true,
      nativeModel: config.models.codex || null,
      nativeReasoningEffort: config.reasoningEffort,
    },
    results: [],
  };
  const liveRunner = options.runProvider || runLiveProviderEvaluation;
  const directRunner = options.runDirect || runDirectCodex;
  const oracle = options.oracle || canonicalOracle;
  for (const arm of config.arms) {
    for (const control of arm === 'codex-direct'
      ? [{ id: 'not-applicable' }]
      : arm === 'codex-buro'
        ? [{ id: 'legacy', mode: 'legacy' }]
        : controls) {
      let fixture, workspace, actualPlanning;
      const trial = comparisonTrialReport(options.reportPath, arm, control.id);
      const started = Date.now();
      let provider;
      try {
        if (arm === 'codex-direct') {
          const directory = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'buro-comparison-direct-')),
          );
          fixture = await prepareComparisonFixture({ temporaryDirectory: directory });
          workspace = fixture.root;
          provider = await directRunner({ fixture, config, codex: options.codex });
          await writeDirectTrialReport(trial, fixture, config, provider);
        } else {
          const mode = arm.slice(0, -5);
          provider = await liveRunner({
            mode,
            env: { ...(options.env || process.env), BURO_LIVE_SOURCE_TRANSFER: '1' },
            credentials: options.credentials,
            endpoints: config.endpoints,
            models: config.models,
            codex: {
              ...options.codex,
              model: config.models.codex,
              reasoningEffort: config.reasoningEffort,
              networkAccess: false,
            },
            budgets: config.limits,
            contextTokensByProvider: { ollama: 16384 },
            forceWorker: true,
            planningMode: control.mode,
            segmentPolicy: options.segmentPolicy,
            reportPath: trial?.file,
            sourceCase: {
              id: CASE_ID,
              synthetic: true,
              async prepare(input) {
                fixture = await prepareComparisonFixture(input);
                return fixture;
              },
            },
            async onRunFinished(input) {
              workspace = input.run?.workspace;
              const policy = input.run?.planningPolicy;
              if (['bounded', 'legacy'].includes(policy?.mode))
                actualPlanning = {
                  mode: policy.mode,
                  revision: /^[a-zA-Z0-9._:-]{1,100}$/.test(policy.revision || '')
                    ? policy.revision
                    : 'unknown',
                };
            },
          });
          workspace ||= fixture?.finalWorkspace;
        }
        const canonicalOrigin = workspace
          ? 'candidate-workspace'
          : fixture
            ? 'fixture-baseline'
            : 'unavailable';
        workspace ||= fixture?.root;
        const final =
          fixture && workspace
            ? {
                public: await oracle(fixture, workspace, 'public'),
                holdout: await oracle(fixture, workspace, 'holdout'),
              }
            : null;
        const summary = summarizeProvider(provider, arm.startsWith('codex-'));
        report.results.push({
          arm,
          planning: control.id,
          ...(trial ? { trialReport: trial.reference } : {}),
          planningCoverage:
            arm === 'codex-direct'
              ? 'not-applicable'
              : arm === 'codex-buro'
                ? 'native-legacy'
                : `managed-${control.mode}`,
          actualPlanning: actualPlanning || null,
          model: arm.startsWith('codex-')
            ? config.models.codex
            : arm === 'mixed-buro'
              ? {
                  coordinator: config.models.deepseek,
                  worker: config.models.ollama,
                  reviewer: config.models.deepseek,
                }
              : config.models[arm.slice(0, -5)],
          ...summary,
          elapsedMs: Date.now() - started,
          canonical: final,
          canonicalOrigin,
          accepted:
            final?.public.passed === true &&
            final?.holdout.passed === true &&
            (arm === 'codex-direct'
              ? provider.status === 'completed'
              : provider.status === 'passed'),
        });
      } catch (error) {
        const canonical = {};
        if (fixture) {
          workspace ||= fixture.root;
          for (const phase of ['public', 'holdout']) {
            try {
              canonical[phase] = await oracle(fixture, workspace, phase);
            } catch {
              canonical[phase] = { passed: false, errorCode: 'COMPARISON_ORACLE_FAILED' };
            }
          }
        }
        report.results.push({
          arm,
          planning: control.id,
          status: 'failed',
          accepted: false,
          canonical: fixture ? canonical : null,
          errorCode: /^[A-Z0-9_]{1,100}$/.test(error.code || '')
            ? error.code
            : 'COMPARISON_ARM_FAILED',
          elapsedMs: Date.now() - started,
        });
      }
      if (options.reportPath) await writeComparisonReport(options.reportPath, report);
    }
  }
  report.finishedAt = new Date().toISOString();
  if (options.reportPath) await writeComparisonReport(options.reportPath, report);
  return report;
}

async function writeComparisonReport(file, report) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

module.exports = {
  ARMS,
  CASE_ID,
  IDENTITY,
  TASK,
  validateComparison,
  prepareComparisonFixture,
  candidateFiles,
  inspectScope,
  canonicalOracle,
  confinedOutput,
  runDirectCodex,
  summarizeProvider,
  comparisonTrialReport,
  writeDirectTrialReport,
  writeComparisonReport,
  runModelComparison,
};
