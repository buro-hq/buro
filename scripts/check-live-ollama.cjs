const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EvaluationBudget, createBudgetedFetch } = require('./lib/live-provider-runner.cjs');
const exec = promisify(execFile);

if (process.env.BURO_LIVE_OLLAMA !== '1') {
  console.error(
    'Opt-in only: set BURO_LIVE_OLLAMA=1 to run a real Qwen3 4B diagnostic and coding goal.',
  );
  process.exitCode = 1;
} else if (process.env.BURO_LIVE_OLLAMA_DIAGNOSTIC === '1') {
  (async () => {
    const { OllamaProvider } = await import('../adapters/models/ollama.ts');
    const report = {
      startedAt: new Date().toISOString(),
      mode: 'single-generation-codec-diagnostic',
      model: 'qwen3:4b',
      status: 'running',
    };
    let observation;
    const provider = new OllamaProvider({
      id: 'ollama-local-diagnostic',
      endpoint: 'http://127.0.0.1:11434',
      think: false,
      fetch: async (url, init) => {
        assert.equal(new URL(String(url)).origin, 'http://127.0.0.1:11434');
        const response = await fetch(url, init);
        observation = response
          .clone()
          .text()
          .then((body) => {
            const chunks = body
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            report.wire = {
              status: response.status,
              doneReason: chunks.findLast((chunk) => chunk.done)?.done_reason,
              contentCharacters: chunks.reduce(
                (total, chunk) => total + (chunk.message?.content?.length || 0),
                0,
              ),
              privateThinkingCharacters: chunks.reduce(
                (total, chunk) => total + (chunk.message?.thinking?.length || 0),
                0,
              ),
              calls: chunks.flatMap((chunk, frame) =>
                (chunk.message?.tool_calls || []).map((call, position) => ({
                  frame,
                  position,
                  index: call.index,
                  functionIndex: call.function?.index,
                  name: call.function?.name,
                  argumentsType: typeof call.function?.arguments,
                  argumentKeys:
                    call.function?.arguments && typeof call.function.arguments === 'object'
                      ? Object.keys(call.function.arguments)
                      : undefined,
                  exactEcho:
                    JSON.stringify(call.function?.arguments) ===
                    JSON.stringify({ value: 'buro-ready' }),
                })),
              ),
            };
          });
        return response;
      },
    });
    try {
      const result = await provider.complete({
        requestId: 'single-codec-' + randomUUID(),
        model: report.model,
        messages: [
          {
            role: 'user',
            content:
              'Capability diagnostic. First call diagnostic_echo exactly once with value "buro-ready". After its result, return only JSON {"ok":true}. Do not answer before calling the tool.',
          },
        ],
        tools: [
          {
            name: 'diagnostic_echo',
            description: 'Read-only readiness diagnostic',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string', enum: ['buro-ready'] } },
              required: ['value'],
              additionalProperties: false,
            },
          },
        ],
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        maxOutputTokens: 1024,
        contextTokens: 32768,
        signal: AbortSignal.timeout(120000),
        onProgress() {},
      });
      report.normalized = {
        finish: result.finish,
        contentCharacters: result.message.content.length,
        calls: (result.message.toolCalls || []).map((call) => ({
          name: call.name,
          exactEcho: JSON.stringify(call.arguments) === JSON.stringify({ value: 'buro-ready' }),
        })),
        usage: result.usage,
      };
      report.status = 'observed';
    } catch (error) {
      report.status = 'failed';
      report.error = { code: error.code || 'DIAGNOSTIC_FAILED', message: error.message };
      process.exitCode = 1;
    } finally {
      await observation;
      report.finishedAt = new Date().toISOString();
      await fs.mkdir('artifacts', { recursive: true });
      await fs.writeFile(
        'artifacts/live-ollama-stage1-codec.json',
        JSON.stringify(report, null, 2),
      );
      console.log(JSON.stringify(report, null, 2));
    }
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  (async () => {
    const { createHost } = await import('../plugins/host.ts');
    const { resourcesPlugin } = await import('../plugins/resources.ts');
    const { executionPlugin } = await import('../plugins/execution.ts');
    const { PrivateJSONFiles } = await import('../adapters/files/private-json.ts');
    const { FileManagedSessions } = await import('../adapters/files/managed-sessions.ts');
    const { FileRuntimeRoutes } = await import('../adapters/files/runtime-routes.ts');
    const { EnvironmentExecutors } = await import('../adapters/environments/executors.ts');
    const { ProjectEnvironments } = await import(
      '../adapters/environments/project-environments.ts'
    );
    const { ProjectChecks } = await import('../adapters/checks/project-commands.ts');
    const { GitWorkspaces } = await import('../adapters/files/git-workspaces.ts');
    const { ResourceConfigurationSchema } = await import(
      '../adapters/files/resource-configuration.ts'
    );
    const { ProjectProfileSchema } = await import('../protocol/projects.ts');

    const model = 'qwen3:4b';
    const collectAfterProbeFailure = process.env.BURO_LIVE_COLLECT_AFTER_PROBE_FAILURE === '1';
    const budget = new EvaluationBudget();
    const startedAt = new Date().toISOString();
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-live-ollama-')));
    const directory = path.join(root, '.buro');
    const report = {
      model,
      startedAt,
      fixtureDirectory: root,
      live: true,
      status: 'running',
      stage: 'setup',
      collectAfterProbeFailure,
      diagnostic: { status: 'not-run' },
      codingStatus: 'not-run',
      http: { generations: 0, modelDetails: 0 },
      requests: [],
    };
    let host, runId;
    const observedResponses = [];
    const git = (args) => exec('git', args, { cwd: root });
    const saveReport = async () => {
      await fs.mkdir('artifacts', { recursive: true });
      await fs.writeFile(
        'artifacts/live-ollama-verification.json',
        JSON.stringify(report, null, 2),
      );
    };
    try {
      await git(['init', '-b', 'main']);
      await git(['config', 'user.name', 'Buro live fixture']);
      await git(['config', 'user.email', 'fixture@example.invalid']);
      await fs.mkdir(path.join(root, 'src'));
      await fs.mkdir(path.join(root, 'checks'));
      await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=1;\n');
      await fs.writeFile(
        path.join(root, 'checks/value.test.mjs'),
        "import assert from 'node:assert/strict';import {value} from '../src/value.mjs';assert.equal(value,2);\n",
      );
      await fs.writeFile(path.join(root, '.gitignore'), '.buro/\n');
      await git(['add', '.']);
      await git(['commit', '-m', 'Synthetic live validation fixture']);
      const originalHead = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      const profile = ProjectProfileSchema.parse({
        version: 1,
        revision: 1,
        resourceProfile: 'local',
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
      });
      await new PrivateJSONFiles(path.join(directory, 'local')).save(
        'resources',
        ResourceConfigurationSchema.parse({
          version: 1,
          defaultProfile: 'local',
          connections: [
            {
              id: 'ollama',
              provider: 'ollama',
              config: { endpoint: 'http://127.0.0.1:11434', capacity: 1, think: false },
            },
          ],
          runtimes: [
            {
              id: 'qwen-local',
              backend: 'managed',
              config: {
                connectionId: 'ollama',
                model,
                limits: {
                  contextTokens: 32768,
                  maxOutputTokens: 4096,
                },
              },
            },
          ],
          profiles: [
            {
              id: 'local',
              name: 'Qwen local live fixture',
              policy: 'local-only',
              coordinator: 'qwen-local',
              worker: 'qwen-local',
              reviewer: 'qwen-local',
            },
          ],
        }),
      );
      host = await createHost({
        projects: [
          {
            storageAddress: directory,
            project: { id: 'p', name: 'Live Ollama fixture', root, managed: true },
            profile,
          },
        ],
      });
      const executors = new EnvironmentExecutors();
      const actualFetch = createBudgetedFetch({
        endpoints: { ollama: 'http://127.0.0.1:11434' },
        budget,
        stage: () => (report.stage === 'capability-probe' ? 'diagnostic' : 'coding'),
      });
      const observedFetch = async (url, init) => {
        const endpoint = new URL(String(url));
        assert.equal(
          endpoint.origin,
          'http://127.0.0.1:11434',
          'Live validation must stay on local Ollama',
        );
        if (endpoint.pathname === '/api/show') report.http.modelDetails++;
        if (endpoint.pathname === '/api/chat') {
          report.http.generations++;
          const body = JSON.parse(String(init.body));
          report.requests.push({
            model: body.model,
            stream: body.stream,
            tools: (body.tools || []).map((tool) => tool.function.name),
            structuredFormat: !!body.format,
            thinking: body.think,
            contextTokens: body.options?.num_ctx,
            maxOutputTokens: body.options?.num_predict,
          });
        }
        const response = await actualFetch(url, init);
        if (endpoint.pathname === '/api/chat') {
          const requestIndex = report.http.generations;
          const observation = response
            .clone()
            .text()
            .then((body) => {
              const chunks = body
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line));
              const content = chunks.map((chunk) => chunk.message?.content || '').join('');
              let visibleJson,
                visibleJsonValid = false;
              try {
                visibleJson = JSON.parse(content);
                visibleJsonValid = true;
              } catch {}
              report.responses ||= [];
              report.responses.push({
                requestIndex,
                status: response.status,
                done: chunks.some((chunk) => chunk.done === true),
                doneReason: chunks.findLast((chunk) => chunk.done)?.done_reason,
                toolNames: chunks
                  .flatMap((chunk) => chunk.message?.tool_calls || [])
                  .map((call) => call.function?.name)
                  .filter(Boolean),
                visibleContentCharacters: content.length,
                visibleJsonValid,
                leadingJson: /^\s*[\[{]/.test(content),
                privateThinkingCharacters: chunks.reduce(
                  (total, chunk) =>
                    total +
                    (typeof chunk.message?.thinking === 'string'
                      ? chunk.message.thinking.length
                      : 0),
                  0,
                ),
                visibleThinkTags: /<\/?think>/.test(content),
                visibleJsonKeys:
                  visibleJson && typeof visibleJson === 'object' && !Array.isArray(visibleJson)
                    ? Object.keys(visibleJson)
                    : [],
                diagnosticOk: typeof visibleJson?.ok === 'boolean' ? visibleJson.ok : undefined,
              });
            })
            .catch(() => {});
          observedResponses.push(observation);
        }
        return response;
      };
      await host.ctx.plugin(resourcesPlugin, {
        directory,
        executors,
        fetch: observedFetch,
        codex: { executable: path.join(root, 'codex-not-installed') },
      });
      assert.deepEqual(host.ctx.agentRuntime.registry.list(), ['qwen-local']);
      let commands = 0;
      const command = (value) =>
        host.ctx.commands.bus.execute(value, {
          id: 'live-' + ++commands + '-' + randomUUID(),
          fingerprint: JSON.stringify(value),
        });
      report.stage = 'capability-probe';
      await saveReport();
      console.log('Live Ollama: bounded capability probe.');
      try {
        report.probe = await command({
          method: 'resources.probe',
          params: { runtimeId: 'qwen-local' },
        });
        report.diagnostic = { status: 'passed' };
      } catch (error) {
        report.diagnostic = {
          status: 'failed',
          error: { code: error.code || 'LIVE_PROBE_FAILED', message: error.message },
        };
        if (
          !collectAfterProbeFailure ||
          error.code !== 'MODEL_CAPABILITY_FAILED' ||
          budget.signal.aborted
        )
          throw error;
        report.collectionContinued = true;
        console.log('Live Ollama: probe failed; collecting coding evidence independently.');
        await saveReport();
      }
      const workspaces = new GitWorkspaces(host.ctx.projects.registry);
      const checks = new ProjectChecks(
        host.ctx.projects.registry,
        {
          async run() {
            throw Error('No fallback checks are allowed');
          },
        },
        executors,
      );
      const environments = new ProjectEnvironments(
        host.ctx.projects.registry,
        host.ctx.agentRuntime.adapter,
        executors,
        host.ctx.agentRuntime.selection,
      );
      const { executionPolicy } = await import('../adapters/files/project-manager.ts');
      const policy = executionPolicy(profile);
      await host.ctx.plugin(executionPlugin, {
        policies: { p: policy },
        workspaces,
        checks,
        environments,
      });
      const store = host.ctx.projects.registry.get('p');
      let phase = '';
      const unsubscribe = store.subscribe(store.snapshot().sequence, (event) => {
        if (event.change.type !== 'run.changed' || event.change.run.id !== runId) return;
        if (event.change.run.phase !== phase) {
          phase = event.change.run.phase;
          console.log('Live Ollama phase:', phase);
        }
      });
      const goal = await command({
        method: 'goal.create',
        params: {
          projectId: 'p',
          title: 'Set the exported value to two',
          body: 'Change src/value.mjs so its exported value equals 2. This is one tiny coherent edit: prefer direct coordinator implementation and an empty worker team unless delegation is useful. Preserve the protected checks and all other files.',
          criteria:
            'The protected check passes; src/value.mjs exports value=2; only src/value.mjs changes.',
        },
      });
      report.stage = 'coding-goal';
      report.codingStatus = 'running';
      runId = (await command({ method: 'run.start', params: { projectId: 'p', goalId: goal.id } }))
        .runId;
      report.runId = runId;
      await saveReport();
      await host.ctx.workflows.api.jobs.get(runId)?.promise;
      unsubscribe();
      const run = host.ctx.workflows.api.get('p', runId);
      report.run = {
        status: run.status,
        phase: run.phase,
        profile: run.resources?.profileId,
        policy: run.resources?.policy,
        result: run.result,
        baselinePassed: run.baseline.passed,
        baselineTotal: run.baseline.total,
        acceptancePassed: run.acceptance.passed,
        acceptanceTotal: run.acceptance.total,
        independentReviewer: run.independentReviewer,
        review: run.review,
        commit: run.commit,
        changedFiles: run.changedFiles.map((file) => file.path),
        sessions: [run.coordinatorSession, ...run.agents.map((agent) => agent.session)]
          .filter(Boolean)
          .map((session) => ({
            id: session.id,
            roleId: session.roleId,
            runtimeId: session.runtimeId,
            model: session.model,
            reportedModel: session.reportedModel,
          })),
      };
      report.originalSourcePreserved =
        (await git(['rev-parse', 'HEAD'])).stdout.trim() === originalHead &&
        (await fs.readFile(path.join(root, 'src/value.mjs'), 'utf8')) === 'export const value=1;\n';
      const routes = new FileRuntimeRoutes(path.join(directory, 'local/runtime-routes'));
      const sessions = new FileManagedSessions(path.join(directory, 'local/managed-sessions'));
      report.checkpoints = [];
      for (const handle of [run.threadId, ...run.agents.map((agent) => agent.threadId)]) {
        const route = await routes.load(handle);
        if (!route?.externalThreadId) continue;
        const saved = await sessions.load(route.externalThreadId);
        if (saved)
          report.checkpoints.push({
            sessionId: saved.id,
            requests: saved.requests,
            actions: saved.actions.map(({ id, status, call }) => ({ id, status, tool: call.name })),
            usage: saved.usage,
          });
      }
      assert.equal(run.status, 'completed', run.result);
      assert.ok(run.commit);
      assert.equal(run.baseline.passed, 0);
      assert.equal(run.acceptance.passed, 1);
      assert.equal(run.independentReviewer, true);
      assert.equal(run.review?.verdict, 'approved');
      assert.equal(report.originalSourcePreserved, true);
      assert.deepEqual(
        run.changedFiles.map((file) => file.path),
        ['src/value.mjs'],
      );
      assert.notEqual(
        await fs.readFile(path.join(run.workspace, 'src/value.mjs'), 'utf8'),
        'export const value=1;\n',
      );
      report.codingStatus = 'passed';
      report.status = report.diagnostic.status === 'passed' ? 'passed' : 'failed';
      if (report.status === 'failed') {
        report.error = report.diagnostic.error;
        process.exitCode = 1;
      }
      report.stage = 'complete';
      await fs.writeFile(
        'artifacts/live-ollama-change.diff',
        (
          await exec('git', ['diff', run.baseCommit, run.commit, '--', 'src/value.mjs'], {
            cwd: root,
          })
        ).stdout,
      );
      console.log(
        'Live Ollama: verified change accepted with fresh review; original source preserved.',
      );
    } catch (error) {
      report.status = 'failed';
      if (report.codingStatus === 'running') report.codingStatus = 'failed';
      report.error = { code: error.code || 'LIVE_VALIDATION_FAILED', message: error.message };
      process.exitCode = 1;
      console.error('Live Ollama failed:', report.stage, report.error.code, report.error.message);
    } finally {
      if (host) await host.dispose();
      report.finishedAt = new Date().toISOString();
      await Promise.all(observedResponses);
      report.budget = budget.snapshot();
      if (budget.violation) {
        report.status = 'failed';
        report.error = { code: budget.violation };
        process.exitCode = 1;
      }
      await saveReport();
      console.log(
        'Live Ollama outcomes:',
        'diagnostic=' + report.diagnostic.status,
        'coding=' + report.codingStatus,
        'overall=' + report.status,
      );
      console.log('Sanitized report: artifacts/live-ollama-verification.json');
    }
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
