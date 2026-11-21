const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { normalizedLimits } = require('./live-provider-runner.cjs');
const {
  CASE_ID,
  IDENTITY,
  candidateFiles,
  inspectScope,
  canonicalOracle,
} = require('./model-comparison.cjs');

const VARIANTS = ['executor-checks', 'executor-review', 'team-review'];
const ROLES = ['coordinator', 'test-author', 'executor', 'reviewer'];
const codeError = (code) => Object.assign(new Error(code), { code });
const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
const safeCode = (error) =>
  /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code || '') ? error.code : 'TEAM_EXPERIMENT_FAILED';
const safeModel = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value);

function validateTeamExperimentRuntime(options = {}) {
  const env = options.env || process.env;
  if (env.BURO_TEAM_QUALITY !== '1' || env.BURO_LIVE_OLLAMA !== '1')
    throw codeError('TEAM_EXPERIMENT_OPT_IN_REQUIRED');
  if (!VARIANTS.includes(options.variant)) throw codeError('TEAM_EXPERIMENT_INVALID_VARIANT');
  if (!safeModel(options.model) || /(?:[:_-]cloud)(?:$|:)/i.test(options.model))
    throw codeError('TEAM_EXPERIMENT_INVALID_MODEL');
  let endpoint;
  try {
    endpoint = new URL(options.endpoint || 'http://127.0.0.1:11434');
  } catch {
    throw codeError('TEAM_EXPERIMENT_INVALID_ENDPOINT');
  }
  if (
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw codeError('TEAM_EXPERIMENT_LOCAL_ENDPOINT_REQUIRED');
  const limits = {
    ...normalizedLimits({ contextTokens: 16384, maxOutputTokens: 2048, ...options.limits }),
    maxToolCalls: options.limits?.maxToolCalls ?? 64,
    maxToolCallsPerTurn: options.limits?.maxToolCallsPerTurn ?? 24,
  };
  if (
    ![limits.maxToolCalls, limits.maxToolCallsPerTurn].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    limits.maxToolCalls > 64 ||
    limits.maxToolCallsPerTurn > 24
  )
    throw codeError('TEAM_EXPERIMENT_INVALID_TOOL_LIMITS');
  if (options.provider && options.provider.local !== true)
    throw codeError('TEAM_EXPERIMENT_LOCAL_PROVIDER_REQUIRED');
  const review = options.variant !== 'executor-checks';
  const reviewReserve = review
    ? { requests: 4, outputTokens: 8192, toolCalls: 8 }
    : { requests: 0, outputTokens: 0, toolCalls: 0 };
  if (
    reviewReserve.requests >= limits.maxGenerationRequests ||
    reviewReserve.outputTokens >= limits.maxReservedOutputTokens ||
    reviewReserve.toolCalls >= limits.maxToolCalls
  )
    throw codeError('TEAM_EXPERIMENT_INSUFFICIENT_BUDGET');
  return {
    endpoint: endpoint.href,
    limits,
    budgetPolicy: {
      version: 1,
      maxRequests: limits.maxGenerationRequests,
      maxReservedOutputTokens: limits.maxReservedOutputTokens,
      maxToolCalls: limits.maxToolCalls,
      reviewReserve,
    },
  };
}

async function readOwnedFile(workspace, file) {
  if (!IDENTITY.allowedPaths.includes(file)) throw codeError('TEAM_EXPERIMENT_SCOPE_CHANGED');
  const segments = file.split('/');
  let target = workspace;
  for (const [index, segment] of segments.entries()) {
    target = path.join(target, segment);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (index !== segments.length - 1 && !stat.isDirectory()))
      throw codeError('TEAM_EXPERIMENT_SCOPE_CHANGED');
  }
  const before = await fs.lstat(target);
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      (await fs.realpath(target)) !== target
    )
      throw codeError('TEAM_EXPERIMENT_UNSAFE_FILE');
    const content = await handle.readFile('utf8');
    const after = await fs.lstat(target);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size)
      throw codeError('TEAM_EXPERIMENT_STALE_FILE');
    return content;
  } finally {
    await handle.close();
  }
}

/** Experimental owner only: no delivery, commit, production acceptance or commands are exposed. */
async function runTeamExperimentTrial(options = {}) {
  const checked = validateTeamExperimentRuntime(options);
  const { fixture, variant, model } = options;
  const controller = new AbortController();
  const signal = controller.signal;
  let timedOut = false,
    runtime,
    store,
    workspace,
    ownerRunId,
    summary,
    disposePromise;
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    disposePromise = runtime?.dispose();
    void disposePromise?.catch(() => {});
  }, checked.limits.codingWallTimeMs);
  const stages = [],
    sessionsByRole = new Map(),
    released = new Set(),
    reportedModels = new Set();
  const result = {
    status: 'failed',
    experimentPassed: false,
    reviewApproved: false,
    variant,
    requestedModel: model,
    reportedModels: [],
    live: !options.provider && !options.fetch,
    stages,
    cleanupDone: false,
  };
  let original;
  try {
    signal.throwIfAborted();
    if (!fixture || fixture.caseId !== CASE_ID || fixture.identity?.caseHash !== IDENTITY.caseHash)
      throw codeError('TEAM_EXPERIMENT_INVALID_FIXTURE');
    const root = await fs.realpath(fixture.root);
    const temp = await fs.realpath(os.tmpdir());
    if (root !== fixture.root || !root.startsWith(temp + path.sep))
      throw codeError('TEAM_EXPERIMENT_TEMP_FIXTURE_REQUIRED');
    const initial = await inspectScope(root);
    if (
      !initial.passed ||
      initial.changedFiles.length ||
      initial.sourceHash !== IDENTITY.sourceHash
    )
      throw codeError('TEAM_EXPERIMENT_FIXTURE_CHANGED');
    original = await candidateFiles(root);
    const sameSet = (a, b) =>
      Array.isArray(a) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    if (
      digest(fixture.goal) !== IDENTITY.taskHash ||
      !sameSet(fixture.profile?.allowedPaths, IDENTITY.allowedPaths) ||
      !sameSet(
        fixture.profile?.protectedPaths,
        Object.keys(original).filter((file) => !IDENTITY.allowedPaths.includes(file)),
      ) ||
      JSON.stringify(fixture.profile?.defaultCheckIds) !== '[\"test\"]' ||
      fixture.profile?.checks?.length !== 1 ||
      fixture.profile.checks[0].id !== 'test' ||
      fixture.profile.checks[0].command !== 'node checks/public.cjs' ||
      fixture.profile.checks[0].timeoutMs !== 10000 ||
      fixture.profile?.dependencies !== 'none' ||
      fixture.profile?.setup?.length ||
      fixture.profile?.environment?.provider !== 'native'
    )
      throw codeError('TEAM_EXPERIMENT_FIXTURE_POLICY_CHANGED');
    const [
      { ManagedAgentRuntime },
      { FileManagedSessions },
      { FileProjectStore },
      { FileProjectRegistry },
      { ProjectRunBudgets },
      budgetsModule,
      { RepositoryTools },
      { EnvironmentExecutors },
      { GitWorkspaces },
      { RepositorySegmentEvidence },
      { boundedWorkSegmentPolicy },
      { OllamaProvider },
      { PrivateJSONFiles },
      { inScope },
      probes,
      core,
    ] = await Promise.all([
      import('../../core/managed-runtime.ts'),
      import('../../adapters/files/managed-sessions.ts'),
      import('../../adapters/files/project-store.ts'),
      import('../../adapters/files/registry.ts'),
      import('../../adapters/files/project-run-budgets.ts'),
      import('../../core/run-budget.ts'),
      import('../../adapters/tools/repository-tools.ts'),
      import('../../adapters/environments/executors.ts'),
      import('../../adapters/files/git-workspaces.ts'),
      import('../../adapters/tools/segment-evidence.ts'),
      import('../../core/work-segments.ts'),
      import('../../adapters/models/ollama.ts'),
      import('../../adapters/files/private-json.ts'),
      import('../../core/execution-ports.ts'),
      Promise.resolve().then(() => require('./team-experiment-probes.cjs')),
      import('../../core/team-experiment.ts'),
    ]);
    const profile = structuredClone({
      ...fixture.profile,
      environment: { provider: 'native' },
      managedBudget: checked.budgetPolicy,
    });
    const projectId = 'team-experiment';
    ownerRunId = 'R-experiment-' + randomUUID();
    store = await FileProjectStore.open({
      directory: path.join(root, '.buro/experiment'),
      project: { id: projectId, name: 'Isolated team experiment', root, managed: true },
      profile,
    });
    const projects = new FileProjectRegistry([store]);
    const workspaces = new GitWorkspaces(projects);
    const prepared = await workspaces.prepare(projectId, ownerRunId, 'HEAD', {
      profile,
      signal,
      managedEnvironment: true,
    });
    workspace = prepared.path;
    result.workspace = workspace;
    const now = new Date().toISOString();
    const goal = {
      id: 'G-experiment',
      projectId,
      ...fixture.goal,
      status: 'running',
      createdAt: now,
    };
    const run = {
      id: ownerRunId,
      key: goal.id,
      title: goal.title,
      summary: 'Research-only owner; never a production accepted run',
      createdAt: now,
      threadId: '',
      status: 'running',
      phase: 'implementation',
      goalId: goal.id,
      workspace,
      baseCommit: prepared.base,
      checkIds: [...profile.defaultCheckIds],
      executionPolicySnapshot: {
        ...profile,
        profile,
        checks: profile.checks.map(({ id, title }) => ({ id, title })),
      },
      agents: [],
      events: [],
      commands: [],
      plan: [],
      changedFiles: [],
      baseline: { passed: 0, total: 0, results: [] },
      acceptance: { passed: 0, total: 0, results: [] },
      specsUnchanged: true,
      scopePreserved: true,
      independentReviewer: false,
      goalText: goal.body + '\n\n' + goal.criteria,
      result: '',
      sourceHash: '',
    };
    const ledger = budgetsModule.createManagedRunBudget({
      projectId,
      ownerRunId,
      policy: checked.budgetPolicy,
      coverage: 'managed-api',
    });
    summary = budgetsModule.managedBudgetSummary(ledger);
    run.managedBudget = summary;
    await store.transact('experiment-owner', 'experiment-owner-v1', (draft) => {
      draft.goals.push(goal);
      draft.runs.push(run);
      draft.managedRunBudgets = { [ownerRunId]: ledger };
      return { result: null, change: { type: 'run.changed', run, goal } };
    });
    const executors = new EnvironmentExecutors();
    executors.protectPrivatePaths([
      path.join(root, '.buro/local'),
      path.join(root, '.buro/experiment'),
    ]);
    await executors.register(
      workspace,
      root,
      profile.environment || { provider: 'native' },
      signal,
      { privateDataIsolation: true },
    );
    const repositoryTools = new RepositoryTools(executors);
    const sessionStore = new FileManagedSessions(path.join(root, '.buro/local/team-sessions'));
    const budget = new ProjectRunBudgets(projects);
    const evidence = new RepositorySegmentEvidence(workspaces);
    const journal = new PrivateJSONFiles(path.join(root, '.buro/local/team-checks'));
    const checkEntries = [];
    let checkSerial = 0;
    const provider =
      options.provider ||
      new OllamaProvider({
        id: 'team-ollama',
        endpoint: checked.endpoint,
        think: false,
        fetch: options.fetch,
      });
    if (!options.provider) {
      const installed = await provider.listModels(signal);
      const found = installed.find((item) => item.id === model);
      if (!found) throw codeError('TEAM_EXPERIMENT_MODEL_NOT_INSTALLED');
      const info = await provider.inspect(model, signal);
      if (!info.local || info.remote) throw codeError('TEAM_EXPERIMENT_LOCAL_PROVIDER_REQUIRED');
      if (found.digest && /^[a-f0-9]{64}$/i.test(found.digest)) result.modelDigest = found.digest;
    }
    runtime = new ManagedAgentRuntime({
      id: 'team-ollama',
      model,
      provider,
      projects,
      sessions: sessionStore,
      tools: repositoryTools,
      budgets: budget,
      limits: {
        contextTokens: checked.limits.contextTokens,
        maxOutputTokens: checked.limits.maxOutputTokens,
        maxRequestsPerTurn: checked.limits.maxGenerationRequests,
        maxToolCallsPerTurn: checked.limits.maxToolCallsPerTurn,
        maxSessionRequests: checked.limits.maxGenerationRequests,
      },
      segmentPolicy: boundedWorkSegmentPolicy,
      segmentEvidence: evidence,
      idGenerator: randomUUID,
    });
    const ownerScope = {
      projectId,
      runId: ownerRunId,
      ownerRunId,
      sessionId: 'experiment-evidence',
      workspace,
      readOnly: false,
      allowedPaths: [...profile.allowedPaths],
      protectedPaths: [...profile.protectedPaths],
      materials: [],
      commands: profile.checks,
      baseCommit: prepared.base,
    };
    const capture = async (activeSignal) => {
      activeSignal.throwIfAborted();
      const before = await evidence.inspect(ownerScope, activeSignal);
      const changes = await workspaces.changes(workspace, prepared.base);
      if (
        changes.some(
          (change) => !inScope(change.path, profile.allowedPaths, profile.protectedPaths),
        )
      )
        throw codeError('TEAM_EXPERIMENT_SCOPE_CHANGED');
      const files = await Promise.all(
        profile.allowedPaths.map(async (file) => ({
          path: file,
          content: await readOwnedFile(workspace, file),
        })),
      );
      const after = await evidence.inspect(ownerScope, activeSignal);
      if (before.workspaceFingerprint !== after.workspaceFingerprint)
        throw codeError('TEAM_EXPERIMENT_STALE_EVIDENCE');
      return { fingerprint: after.workspaceFingerprint, changes, files };
    };
    const serviceCheck = async (kind, cases, activeSignal) => {
      activeSignal.throwIfAborted();
      const before = await capture(activeSignal);
      const id = 'C-' + ++checkSerial;
      await budget.reserveTools({
        projectId,
        ownerRunId,
        operationId: id,
        phase: 'work',
        count: cases?.length || 1,
      });
      const entry = { id, kind, status: 'pending', fingerprint: before.fingerprint };
      checkEntries.push(entry);
      await journal.save('checks', { version: 1, entries: checkEntries });
      try {
        const checkedResult =
          kind === 'public'
            ? await canonicalOracle(fixture, workspace, 'public', { signal: activeSignal })
            : await probes.runGeneratedProbes(fixture, workspace, cases, { signal: activeSignal });
        const after = await capture(activeSignal);
        if (before.fingerprint !== after.fingerprint || !checkedResult.scope?.passed)
          throw codeError('TEAM_EXPERIMENT_STALE_CHECK');
        const receipt = {
          fingerprint: after.fingerprint,
          passed: checkedResult.passedChecks,
          total: checkedResult.checks,
          diagnostics: checkedResult.rows
            .filter((row) => !row.passed)
            .map(
              (row) =>
                `Failed observed ${kind} case: ${String(row.name || row.id || 'case').slice(0, 120)}`,
            ),
          outcome: 'completed',
        };
        Object.assign(entry, { status: 'completed', passed: receipt.passed, total: receipt.total });
        await journal.save('checks', { version: 1, entries: checkEntries });
        return receipt;
      } catch (error) {
        entry.status = 'unknown';
        await journal.save('checks', { version: 1, entries: checkEntries }).catch(() => {});
        throw error;
      }
    };
    const ports = {
      async start(input) {
        signal.throwIfAborted();
        if (
          !ROLES.includes(input.role) ||
          input.readOnly !== (input.role !== 'executor') ||
          !Array.isArray(input.allowedPaths) ||
          (input.role === 'executor' && !input.allowedPaths.length) ||
          input.allowedPaths.some(
            (file) => !inScope(file, profile.allowedPaths, profile.protectedPaths),
          )
        )
          throw codeError('TEAM_EXPERIMENT_STAGE_SCOPE');
        if (input.role === 'executor' && [...sessionsByRole.values()].includes('executor'))
          throw codeError('TEAM_EXPERIMENT_DUPLICATE_EXECUTOR');
        const purpose = {
          coordinator: 'coordination',
          'test-author': 'research',
          executor: 'implementation',
          reviewer: 'review',
        }[input.role];
        const started = await runtime.start({
          projectId,
          runId: ownerRunId,
          ownerRunId,
          workspace,
          readOnly: input.readOnly,
          purpose,
          instructions: `Experiment role: ${input.role}.\nUse only supplied repository scope. Never edit checks, Git metadata, secrets or private runtime data.\n${input.instructions}`,
          ...(input.role === 'executor'
            ? {
                assignment: {
                  sessionId: 'executor-' + randomUUID(),
                  roleId: 'executor',
                  allowedPaths: [...input.allowedPaths],
                  protectedPaths: [...profile.protectedPaths],
                },
              }
            : {}),
        });
        sessionsByRole.set(started.threadId, input.role);
        return started.threadId;
      },
      async turn(handle, input, activeSignal) {
        activeSignal.throwIfAborted();
        const role = sessionsByRole.get(handle);
        if (!role || released.has(handle) || (role !== 'executor' && input.toolPolicy !== 'none'))
          throw codeError('TEAM_EXPERIMENT_STAGE_AUTHORITY');
        const started = performance.now();
        const stage = { role, status: 'failed', durationMs: 0 };
        stages.push(stage);
        try {
          const answer = await runtime.turn(handle, input.text, {
            schema: input.schema,
            signal: activeSignal,
            timeoutMs: Math.min(120000, checked.limits.codingWallTimeMs),
            ...(input.toolPolicy ? { toolPolicy: input.toolPolicy } : {}),
          });
          if (safeModel(answer.model)) reportedModels.add(answer.model);
          let parsed;
          try {
            parsed = JSON.parse(answer.text);
          } catch {
            throw codeError('MODEL_INVALID_RESPONSE');
          }
          stage.status = 'completed';
          return parsed;
        } finally {
          stage.durationMs = Math.round(performance.now() - started);
        }
      },
      capture,
      check: (activeSignal) => serviceCheck('public', undefined, activeSignal),
      validateGeneratedProbes: (value) => probes.validateProbes(value),
      runGeneratedProbes: (cases, activeSignal) =>
        serviceCheck('generated', probes.validateProbes({ cases }), activeSignal),
      async release(handle) {
        released.add(handle);
      },
    };
    const experiment = await core.runTeamExperiment(
      {
        variant,
        goal: structuredClone(fixture.goal),
        scope: {
          allowedPaths: [...profile.allowedPaths],
          protectedPaths: [...profile.protectedPaths],
        },
        publicCheckIds: [...profile.defaultCheckIds],
        readablePaths: Object.keys(original),
        generatedProbeSchema: probes.PROBE_SCHEMA,
        maxRepairs: 2,
        maxEvidenceBytes: 24000,
      },
      ports,
      signal,
    );
    result.experiment = experiment;
    signal.throwIfAborted();
    result.experimentPassed = experiment.experimentSuccess === true;
    result.reviewApproved = experiment.reviewApproved === true;
    result.repairs = experiment.repairs;
    result.reviewRounds = experiment.reviewRounds;
    result.checkRuns = experiment.checkRuns;
    result.generatedProbeCount = experiment.generatedProbeCount;
    result.status = result.experimentPassed ? 'experiment-passed' : 'failed';
    if (experiment.errorCode) {
      result.errorCode = experiment.errorCode;
      if (/BUDGET/.test(result.errorCode)) result.status = 'budget-exhausted';
    }
  } catch (error) {
    result.errorCode = timedOut
      ? 'TEAM_EXPERIMENT_TIMEOUT'
      : signal.aborted
        ? 'TEAM_EXPERIMENT_ABORTED'
        : safeCode(error);
    result.status = timedOut
      ? 'timed-out'
      : signal.aborted
        ? 'interrupted'
        : /BUDGET/.test(result.errorCode)
          ? 'budget-exhausted'
          : /OPT_IN|LOCAL_|INVALID_|MODEL_NOT_INSTALLED/.test(result.errorCode)
            ? 'blocked'
            : 'failed';
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', externalAbort);
    try {
      await disposePromise;
      await runtime?.dispose();
      result.cleanupDone = true;
    } catch {
      result.cleanupDone = false;
      result.experimentPassed = false;
      result.status = 'failed';
      result.errorCode = 'TEAM_EXPERIMENT_CLEANUP_FAILED';
    }
    if (store) {
      try {
        const state = store.snapshot();
        const owner = state.runs.find((run) => run.id === ownerRunId);
        if (owner?.managedBudget) summary = owner.managedBudget;
        const sessionFiles = workspace
          ? path.join(state.project.root, '.buro/local/team-sessions')
          : undefined;
        const actions = { total: 0, completed: 0, failed: 0, edits: 0 };
        if (sessionFiles)
          for (const file of await fs.readdir(sessionFiles).catch(() => [])) {
            if (!file.endsWith('.json')) continue;
            const saved = JSON.parse(await fs.readFile(path.join(sessionFiles, file), 'utf8'));
            if (safeModel(saved.reportedModel)) reportedModels.add(saved.reportedModel);
            for (const action of saved.actions || []) {
              actions.total++;
              if (action.status === 'completed') actions.completed++;
              if (action.result?.isError) actions.failed++;
              if (
                action.call?.name === 'edit_file' &&
                action.status === 'completed' &&
                !action.result?.isError
              )
                actions.edits++;
            }
          }
        result.actions = actions;
        await store.transact('experiment-finished', 'experiment-finished-v1', (draft) => {
          const run = draft.runs.find((run) => run.id === ownerRunId);
          run.status = 'needs-attention';
          run.summary =
            'Research-only experiment finished; production acceptance was not requested';
          return {
            result: null,
            change: {
              type: 'run.changed',
              run,
              goal: draft.goals.find((goal) => goal.id === run.goalId),
            },
          };
        });
      } catch (error) {
        result.experimentPassed = false;
        result.status = 'failed';
        result.errorCode ||= 'TEAM_EXPERIMENT_RECEIPT_FAILED';
      }
      try {
        await store.close();
      } catch {
        result.cleanupDone = false;
        result.experimentPassed = false;
        result.status = 'failed';
        result.errorCode = 'TEAM_EXPERIMENT_CLEANUP_FAILED';
      }
    }
    if (original) {
      try {
        result.originalFixturePreserved =
          JSON.stringify(await candidateFiles(fixture.root)) === JSON.stringify(original);
      } catch {
        result.originalFixturePreserved = false;
      }
      if (!result.originalFixturePreserved) {
        result.experimentPassed = false;
        result.status = 'failed';
        result.errorCode = 'TEAM_EXPERIMENT_ORIGINAL_CHANGED';
      }
    }
    if (summary) {
      result.budget = summary;
      result.usage = summary.observed;
    }
    result.reportedModels = [...reportedModels];
  }
  return result;
}

module.exports = { VARIANTS, validateTeamExperimentRuntime, runTeamExperimentTrial };
