import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { RuntimeRouter, type RuntimeRoute } from '../core/runtime-router.ts';
import { ResourceSelection } from '../core/resource-selection.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { ProjectRunBudgets } from '../adapters/files/project-run-budgets.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { executionPolicy } from '../adapters/files/project-manager.ts';
import { ProjectChecks } from '../adapters/checks/project-commands.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import type { RuntimeResource } from '../protocol/resources.ts';

const exec = promisify(execFile);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const checker =
  "const fs=require('node:fs');if(!fs.readFileSync('src/value.mjs','utf8').includes('value=2'))process.exit(1);";

for (const mode of ['advisory', 'strict'] as const)
  test(`${mode} scope reaches real checks, fresh review and the exact accepted commit`, async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-scope-flow-')));
    const git = (args: string[], cwd = root) => exec('git', args, { cwd });
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Synthetic scope test']);
    await git(['config', 'user.email', 'scope@example.invalid']);
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, 'checks'));
    await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=1;\n');
    await fs.writeFile(path.join(root, 'README.md'), 'Before\n');
    await fs.writeFile(path.join(root, 'checks/check.cjs'), checker);
    await fs.writeFile(path.join(root, '.gitignore'), '.buro/\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'Synthetic baseline']);
    const sourceHead = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const profile: ProjectProfile = {
      version: 1,
      revision: 1,
      context: '',
      scope: { mode, plannedPaths: ['src/value.mjs'], protectedPaths: ['checks/'] },
      checks: [
        {
          id: 'test',
          title: 'Actual value',
          command: quote(process.execPath) + ' checks/check.cjs',
          timeoutMs: 5000,
        },
      ],
      defaultCheckIds: ['test'],
      setup: [],
      dependencies: 'none',
      maxWorkers: 1,
      maxRepairs: 0,
      turnTimeoutMs: 10000,
      environment: { provider: 'native' },
    };
    const store = await FileProjectStore.open({
      directory: path.join(root, '.buro'),
      project: { id: 'p', name: 'Synthetic', root },
      profile,
    });
    const projects = new FileProjectRegistry([store]);
    const executors = new EnvironmentExecutors();
    const sessions = new FileManagedSessions(path.join(root, '.buro/local/scope-sessions'));
    let reviewerReads = 0;
    const reply = (value: unknown) => ({
      model: 'fixture',
      finish: 'stop' as const,
      message: { role: 'assistant' as const, content: JSON.stringify(value) },
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const provider: ModelProvider = {
      id: 'fake',
      revision: 'fixture-v1',
      local: true,
      async complete(input) {
        const properties = (input.schema as any)?.properties || {};
        if (properties.team)
          return reply({
            summary: 'One focused change',
            steps: [
              { step: 'Implement', owner: 'coordinator' },
              { step: 'Review', owner: 'reviewer' },
            ],
            team: [],
          });
        if (properties.verdict) {
          assert.ok(!input.tools.some((tool) => ['edit_file', 'run_command'].includes(tool.name)));
          const observed = input.messages.find((message) => message.toolCallId === 'review-input');
          if (!observed)
            return {
              ...reply(null),
              finish: 'tools',
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [
                  { id: 'review-input', name: 'read_file', arguments: { path: 'src/value.mjs' } },
                ],
              },
            };
          assert.match(JSON.parse(observed.content).text, /value=2/);
          reviewerReads++;
          return reply({
            verdict: 'approved',
            blockingFindings: [],
            summary: 'Read the verified source',
          });
        }
        if (!input.messages.some((message) => message.toolCallId === 'edit-value'))
          return {
            ...reply(null),
            finish: 'tools',
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'edit-value',
                  name: 'edit_file',
                  arguments: { path: 'src/value.mjs', oldText: 'value=1', newText: 'value=2' },
                },
                {
                  id: 'edit-adjacent',
                  name: 'edit_file',
                  arguments: { path: 'README.md', oldText: 'Before', newText: 'After' },
                },
                {
                  id: 'edit-protected',
                  name: 'edit_file',
                  arguments: {
                    path: 'checks/check.cjs',
                    oldText: checker,
                    newText: 'process.exit(0)',
                  },
                },
              ],
            },
          };
        return reply({
          status: 'success',
          summary: 'Updated value',
          artifacts: ['src/value.mjs'],
          notesForNextAgent: '',
        });
      },
    };
    const managed = new ManagedAgentRuntime({
      id: 'local',
      model: 'fixture',
      provider,
      projects,
      sessions,
      tools: new RepositoryTools(executors),
      budgets: new ProjectRunBudgets(projects),
      idGenerator: randomUUID,
      limits: {
        contextTokens: 32768,
        maxOutputTokens: 1024,
        maxRequestsPerTurn: 10,
        maxToolCallsPerTurn: 10,
        maxSessionRequests: 32,
      },
    });
    const resource: RuntimeResource = {
      id: managed.id,
      client: 'managed',
      model: 'fixture',
      providerId: provider.id,
      local: true,
      configurationRevision: 'synthetic',
      capabilities: managed.capabilities,
    };
    const selection = new ResourceSelection({
      projects,
      runtimes: [resource],
      defaultProfile: () => 'local',
      profiles: [
        {
          id: 'local',
          name: 'Synthetic',
          policy: 'local-only',
          coordinator: 'local',
          worker: 'local',
          reviewer: 'local',
        },
      ],
    });
    const catalog = new RuntimeCatalog();
    catalog.register(managed);
    const routes = new Map<string, RuntimeRoute>();
    const runtime = new RuntimeRouter({
      projects,
      registry: catalog,
      resources: [resource],
      selection,
      id: randomUUID,
      routes: {
        async load(id) {
          return structuredClone(routes.get(id));
        },
        async save(route) {
          routes.set(route.id, structuredClone(route));
        },
      },
    });
    const workspaces = new GitWorkspaces(projects);
    const checks = new ProjectChecks(
      projects,
      {
        async run() {
          throw Error('Unexpected host fallback');
        },
      },
      executors,
    );
    const env = { projects, now: () => new Date().toISOString(), id: randomUUID };
    const engine = new ExecutionService({
      ...env,
      runtime,
      selection,
      workspaces,
      checks,
      policies: { p: executionPolicy(profile) },
    });
    t.after(async () => {
      await engine.dispose();
      await runtime.dispose();
      await catalog.dispose();
      await store.close();
      await fs.rm(root, { recursive: true, force: true });
    });
    const goal = await new GoalService(env).create('goal', 'goal', {
      projectId: 'p',
      title: 'Update value',
      body: 'Set value to 2; update the readme if useful.',
      criteria: 'The actual value check and independent review pass.',
    });
    const started = await engine.start('start', 'start', { projectId: 'p', goalId: goal.id });
    await engine.jobs.get(started.runId)?.promise;
    const run = engine.get('p', started.runId);
    assert.equal(run.status, 'completed', run.result);
    assert.equal(run.acceptance.passed, run.acceptance.total);
    assert.equal(reviewerReads, 1);
    assert.equal(run.scopePreserved, true);
    assert.equal(run.specsUnchanged, true);
    assert.deepEqual(
      run.scopeObservation?.additionalPaths,
      mode === 'advisory' ? ['README.md'] : [],
    );
    assert.equal(run.scopeObservation?.tree, run.verificationEvidence?.tree);
    assert.equal(
      run.scopeObservation?.tree,
      (await git(['rev-parse', run.commit + '^{tree}'], run.workspace)).stdout.trim(),
    );
    assert.equal(
      await fs.readFile(path.join(run.workspace!, 'README.md'), 'utf8'),
      mode === 'advisory' ? 'After\n' : 'Before\n',
    );
    assert.equal(await fs.readFile(path.join(run.workspace!, 'checks/check.cjs'), 'utf8'), checker);
    assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), sourceHead);
    assert.equal(
      await fs.readFile(path.join(root, 'src/value.mjs'), 'utf8'),
      'export const value=1;\n',
    );
    const checkpoints = await Promise.all(
      (await fs.readdir(path.join(root, '.buro/local/scope-sessions'))).map((file) =>
        sessions.load(file.replace(/\.json$/, '')),
      ),
    );
    const writer = checkpoints.find((session) => session?.purpose === 'coordination')!;
    assert.equal(
      writer.actions.find((action) => action.call.id === 'edit-protected')?.result?.isError,
      true,
    );
    assert.equal(
      writer.actions.find((action) => action.call.id === 'edit-adjacent')?.result?.isError,
      mode === 'strict' ? true : undefined,
    );
  });
