const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { execFile } = require('node:child_process'),
  { promisify } = require('node:util');
const exec = promisify(execFile);
async function expectRoleSources(page) {
  const cards = page.locator('.project-team-grid .team-role');
  await cards
    .filter({ hasText: 'JS developer' })
    .getByText('Created by coordinator', { exact: true })
    .waitFor();
  assert.equal(await cards.count(), 3);
  assert.equal(await cards.getByText('From workflow', { exact: true }).count(), 2);
}
(async () => {
  const { Service } = await import('cordis');
  const { createHost } = await import('../plugins/host.ts');
  const { projectManagementPlugin } = await import('../plugins/project-management.ts');
  const { executionPlugin } = await import('../plugins/execution.ts');
  const { websocketPlugin } = await import('../daemon/websocket.ts');
  const { GitWorkspaces } = await import('../adapters/files/git-workspaces.ts');
  const { ProjectChecks } = await import('../adapters/checks/project-commands.ts');
  const { EnvironmentExecutors } = await import('../adapters/environments/executors.ts');
  const { ProjectEnvironments } = await import('../adapters/environments/project-environments.ts');
  const { fixtureExecutionSelection, fixtureExecutionCapabilities } = await import(
    '../tests/fixtures/execution-resources.ts'
  );
  const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'project-onboarding-ui-')),
    ),
    root = path.join(directory, 'repository'),
    data = path.join(directory, 'daemon');
  await fs.mkdir(root);
  await fs.mkdir(data);
  const git = (args) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'master']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=1;\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\ndist/\n');
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'Fixture repository',
      scripts: { test: 'node --test' },
      dependencies: { 'fixture-dependency': '1.0.0' },
    }),
  );
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  const initial = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await fs.mkdir(path.join(root, 'node_modules/fixture-dependency'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'node_modules/fixture-dependency/index.js'),
    'module.exports=7;',
  );
  await fs.writeFile(
    path.join(root, 'node_modules/fixture-dependency/package.json'),
    JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', main: 'index.js' }),
  );
  const passed = [],
    errors = [];
  let host, browser;
  try {
    await fs.mkdir('artifacts', { recursive: true });
    host = await createHost({
      projects: [
        {
          storageAddress: path.join(data, 'control'),
          project: { id: 'codex-panel', name: 'Control project', root: data },
        },
      ],
    });
    const policies = {},
      executors = new EnvironmentExecutors(),
      workspaces = new GitWorkspaces(host.ctx.projects.registry),
      checks = new ProjectChecks(
        host.ctx.projects.registry,
        {
          async run() {
            throw Error('Unexpected fallback');
          },
        },
        executors,
      ),
      listeners = new Set(),
      threads = new Map();
    let counter = 0,
      rejectReview = true;
    const resumed = [];
    // Deterministic runtime: this checks UI/core/Git/command integration without model calls.
    const runtime = {
      id: 'fixture',
      async start(input) {
        const threadId = 'thread-' + ++counter;
        threads.set(threadId, input);
        return { threadId };
      },
      async resume(input) {
        resumed.push(input.threadId);
        threads.set(input.threadId, input);
        return { threadId: input.threadId };
      },
      async submit() {
        return { turnId: 'fixture' };
      },
      async interrupt() {},
      async release() {},
      async dispose() {},
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async turn(threadId, text) {
        const input = threads.get(threadId);
        if (input.purpose === 'environment')
          return {
            turnId: 'environment',
            text: JSON.stringify({
              summary: 'Use the isolated fixture dependency and existing setup.',
              inputs: ['package.json'],
              variables: [],
              setup: [
                {
                  id: 'fixture-setup',
                  title: 'Prepare private fixture dependency',
                  command:
                    'mkdir -p node_modules/fixture-dependency && cp "$PROJECT_ROOT/node_modules/fixture-dependency/index.js" node_modules/fixture-dependency/index.js && cp "$PROJECT_ROOT/node_modules/fixture-dependency/package.json" node_modules/fixture-dependency/package.json',
                  timeoutMs: 10000,
                },
              ],
              ready: [
                {
                  id: 'fixture-ready',
                  title: 'Fixture dependency',
                  command:
                    'test -f node_modules/fixture-dependency/package.json && node -e "require(\'fixture-dependency\')"',
                  timeoutMs: 10000,
                },
              ],
            }),
          };
        if (text.startsWith('First,'))
          return {
            turnId: 'plan',
            text: JSON.stringify({
              summary: 'Implement and verify',
              steps: [
                { step: 'Implement assigned module', owner: 'js_developer' },
                { step: 'Review', owner: 'reviewer' },
              ],
              team: [
                {
                  roleId: 'js_developer',
                  action: 'create',
                  title: 'JS developer',
                  description: 'Implements JS modules',
                  instructions: 'Implement and verify assigned behavior.',
                  kind: 'implementation',
                  paths: ['src/value.mjs'],
                },
              ],
            }),
          };
        if (input.readOnly)
          return {
            turnId: 'review',
            text: JSON.stringify(
              rejectReview
                ? {
                    verdict: 'changes_requested',
                    blockingFindings: ['Fixture asks for a follow-up'],
                    summary: 'Repair requested',
                  }
                : {
                    verdict: 'approved',
                    blockingFindings: [],
                    summary: 'Matches fixture requirements',
                  },
            ),
          };
        await fs.writeFile(path.join(input.workspace, 'src/value.mjs'), 'export const value=2;\n');
        return {
          turnId: 'work',
          text: JSON.stringify({
            status: 'success',
            summary: 'Updated value to two',
            artifacts: ['src/value.mjs'],
            notesForNextAgent: '',
          }),
        };
      },
    };
    class FixtureRuntime extends Service {
      constructor(ctx) {
        super(ctx, 'agentRuntime');
        this.adapter = runtime;
        this.selection = fixtureExecutionSelection(
          'fixture',
          fixtureExecutionCapabilities({ resumeSessions: true }),
        );
      }
    }
    await host.ctx.plugin(FixtureRuntime);
    const environments = new ProjectEnvironments(
      host.ctx.projects.registry,
      runtime,
      executors,
      host.ctx.agentRuntime.selection,
    );
    await host.ctx.plugin(projectManagementPlugin, {
      catalogFile: path.join(data, 'linked-projects.json'),
      policies,
      workspaces,
      checks,
      environments,
    });
    await host.ctx.plugin(executionPlugin, { policies, workspaces, checks, environments });
    let port;
    await host.ctx.plugin(websocketPlugin, { port: 0, onListen: (p) => (port = p) });
    const endpoint = 'ws://127.0.0.1:' + port,
      url =
        (process.env.BURO_UI_BASE_URL || 'http://127.0.0.1:4317') +
        '/?daemon=' +
        encodeURIComponent(endpoint);
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1512, height: 1080 } }),
      page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.getByRole('heading', { name: 'Control project', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Connect project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Repository path' }).fill(root);
    await page.getByRole('button', { name: 'Inspect directory', exact: true }).click();
    await page.getByRole('textbox', { name: 'Project name', exact: true }).waitFor();
    await assert.rejects(fs.access(path.join(root, '.buro')));
    passed.push('repository inspection makes no changes');
    await page
      .getByRole('textbox', { name: 'Project name', exact: true })
      .fill('Connected fixture');
    await page
      .getByRole('textbox', { name: 'Project context', exact: true })
      .fill('User-owned project context. Only change assigned files.');
    await page
      .getByRole('textbox', { name: 'Check command', exact: true })
      .fill(
        "node --input-type=module -e \"import assert from 'node:assert/strict'; import {value} from './src/value.mjs'; import dep from 'fixture-dependency'; assert.equal(dep,7); assert.equal(value,2); console.log('verified dependency and source')\"",
      );
    await page
      .getByRole('textbox', { name: 'Environment setup', exact: true })
      .fill('mkdir -p dist && echo prepared > dist/ready');
    await page.getByRole('button', { name: 'Connect and open', exact: true }).click();
    await page.getByRole('heading', { name: 'Connected fixture', exact: true }).waitFor();
    const project = host.ctx.projects.registry.list().find((p) => p.root === root);
    assert.ok(project?.managed);
    assert.equal(new URL(page.url()).searchParams.get('project'), project.id);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, '.buro/project.json'), 'utf8')).profile.context,
      'User-owned project context. Only change assigned files.',
    );
    passed.push('UI connects and opens a repository without daemon restart');
    assert.deepEqual(host.ctx.projects.registry.get(project.id).snapshot().roles, []);
    await page.locator('.sidebar').getByRole('button', { name: 'Team', exact: true }).click();
    await page.getByText('Your team will appear here', { exact: true }).waitFor();
    assert.equal(await page.locator('.project-team-grid .team-role').count(), 0);
    passed.push('new project opens an honest empty team without predefined assignments');
    await page.locator('.sidebar').getByRole('button', { name: 'Goals', exact: true }).click();
    const other = await context.newPage();
    other.on('pageerror', (e) => errors.push(e.message));
    await other.goto(url + '&project=codex-panel');
    await other.getByRole('heading', { name: 'Control project', exact: true }).waitFor();
    await page.getByRole('button', { name: 'New goal', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'What should we achieve?', exact: true })
      .fill('Update fixture value');
    await page
      .getByRole('textbox', { name: 'Context and expected result' })
      .fill('Set the module value to two and preserve existing behavior.');
    const environmentOption = page.getByRole('checkbox', {
      name: 'Allow environment repair',
      exact: true,
    });
    assert.equal(await environmentOption.isChecked(), false);
    await environmentOption.check();
    await page.getByRole('button', { name: 'Save goal', exact: true }).click();
    await page.locator('.draft-card').filter({ hasText: 'Update fixture value' }).waitFor();
    assert.equal(
      host.ctx.projects.registry.get(project.id).snapshot().goals[0].repairEnvironment,
      true,
    );
    await page.getByRole('button', { name: 'Start goal', exact: true }).click();
    await page
      .locator('.phase-badge')
      .filter({ hasText: 'Failed' })
      .waitFor()
      .catch(async (error) => {
        console.error(
          JSON.stringify(
            host.ctx.projects.registry
              .get(project.id)
              .snapshot()
              .runs.map(({ status, phase, result, events }) => ({ status, phase, result, events })),
            null,
            2,
          ),
        );
        await page.screenshot({ path: 'artifacts/first-goal-failure.png', fullPage: true });
        throw error;
      });
    const stopped = host.ctx.projects.registry.get(project.id).snapshot().runs[0];
    assert.equal(stopped.status, 'failed');
    assert.ok(stopped.workspace);
    const createdRoles = host.ctx.projects.registry.get(project.id).snapshot().roles;
    assert.deepEqual(
      createdRoles.map((role) => role.id).sort(),
      ['coordinator', 'js_developer', 'reviewer'],
      JSON.stringify({ result: stopped.result, acceptance: stopped.acceptance }),
    );
    assert.equal(
      createdRoles.find((role) => role.id === 'coordinator').provenance.origin,
      'workflow',
    );
    assert.equal(createdRoles.find((role) => role.id === 'reviewer').provenance.origin, 'workflow');
    assert.equal(
      createdRoles.find((role) => role.id === 'js_developer').provenance.origin,
      'coordinator',
    );
    assert.ok(stopped.review.blockingFindings.length > 0);
    await page.locator('.sidebar').getByRole('button', { name: 'Team', exact: true }).click();
    await expectRoleSources(page);
    await page.locator('.sidebar').getByRole('button', { name: 'Runs', exact: true }).click();
    passed.push(
      'first goal creates workflow coordinator/reviewer and a live coordinator-authored specialist without reload; fresh review still blocks acceptance',
    );
    await page.reload();
    await page.locator('.phase-badge').filter({ hasText: 'Failed' }).waitFor();
    await page.getByRole('button', { name: 'Edit goal', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'What should we achieve?' })
      .fill('Revised fixture goal');
    await page
      .getByRole('textbox', { name: 'Context and expected result' })
      .fill('Set value to two, continue the saved change.');
    await page.getByRole('button', { name: 'Save goal', exact: true }).click();
    await page.locator('.mantine-Modal-content').waitFor({ state: 'hidden' });
    assert.equal(host.ctx.projects.registry.get(project.id).snapshot().goals[0].revision, 2);
    passed.push('stopped goal is editable after reload with a versioned update');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Clarification (optional)', exact: true })
      .fill('Resolve the review finding and keep the saved implementation.');
    rejectReview = false;
    await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('.phase-badge').filter({ hasText: 'Accepted' }).waitFor();
    const continued = host.ctx.projects.registry.get(project.id).snapshot().runs[0];
    assert.equal(continued.id, stopped.id);
    assert.equal(continued.workspace, stopped.workspace);
    assert.equal(continued.threadId, stopped.threadId);
    assert.equal(continued.attempts.length, 1);
    assert.equal(continued.title, 'Revised fixture goal');
    assert.deepEqual(resumed, [stopped.threadId]);
    passed.push(
      'UI resumes the original session and worktree and retains the failed attempt before fresh acceptance',
    );
    const state = host.ctx.projects.registry.get(project.id).snapshot(),
      run = state.runs[0];
    assert.equal(run.status, 'completed');
    assert.equal(run.repairEnvironment, true);
    assert.equal(
      (await fs.lstat(path.join(run.workspace, 'node_modules'))).isSymbolicLink(),
      false,
    );
    passed.push('per-goal environment checkbox persists and runs with private dependencies');
    assert.equal(run.baseline.passed, 0);
    assert.equal(run.acceptance.passed, 1);
    assert.equal(
      run.executionPolicySnapshot.context,
      'User-owned project context. Only change assigned files.',
    );
    assert.equal(run.roleOrigins.js_developer, 'created');
    assert.equal(run.independentReviewer, true);
    assert.equal(run.review.verdict, 'approved');
    assert.deepEqual(
      host.ctx.projects.registry
        .get(project.id)
        .snapshot()
        .roles.map((role) => [role.id, role.version]),
      createdRoles.map((role) => [role.id, role.version]),
    );
    await page.locator('.sidebar').getByRole('button', { name: 'Team', exact: true }).click();
    await expectRoleSources(page);
    await page.screenshot({ path: 'artifacts/first-goal-team.png', fullPage: true });
    passed.push('continued goal reuses existing role versions and team shows each actual creator');
    assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), initial);
    assert.match(await fs.readFile(path.join(root, 'src/value.mjs'), 'utf8'), /value=1/);
    assert.equal(host.ctx.projects.registry.get('codex-panel').snapshot().goals.length, 0);
    passed.push('new goal uses frozen profile, dependencies, checks and an isolated worktree');
    passed.push('projects keep independent goals and roles');
    const go = (label) =>
      page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
    await go('Runs');
    await page.getByRole('tab', { name: 'Checks', exact: true }).click();
    await page.locator('.check-command-output').waitFor();
    assert.ok(
      (await page.locator('.check-command-output').innerText()).includes('Tests') ||
        (await page.locator('.check-command-output').innerText()).includes('Tests'),
    );
    await page.getByRole('tab', { name: 'Changes', exact: true }).click();
    assert.ok((await page.locator('.diff-code').innerText()).includes('value=2'));
    await page.getByRole('tab', { name: 'Result', exact: true }).click();
    await page.getByRole('button', { name: 'Apply to branch master', exact: true }).click();
    await page.getByText('Applied to branch master', { exact: true }).waitFor();
    assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), run.commit);
    assert.match(await fs.readFile(path.join(root, 'src/value.mjs'), 'utf8'), /value=2/);
    passed.push('reviewed accepted result applies to the intended branch');
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'Project settings', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Project context', exact: true })
      .fill('Updated context');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Settings saved' }).waitFor();
    assert.equal(host.ctx.projects.registry.get(project.id).snapshot().profile.revision, 2);
    passed.push('profile revisions update through the UI');
    await page.getByRole('button', { name: 'Check environment', exact: true }).click();
    await page.getByRole('heading', { name: 'Checks: 1/1', exact: true }).waitFor();
    await page.screenshot({ path: 'artifacts/project-profile.png', fullPage: true });
    passed.push('environment verification uses a separate worktree without starting a model');
    for (const width of [1512, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 1080 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      );
    }
    passed.push('project settings fit desktop and mobile');
    await page.setViewportSize({ width: 1512, height: 1080 });
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    assert.equal(await page.locator('.connected-project').count(), 2);
    await page.locator('.connected-project').filter({ hasText: 'Control project' }).click();
    await page.getByRole('heading', { name: 'Control project', exact: true }).waitFor();
    passed.push('project picker switches back to an independent project');
    const cli = JSON.parse(
      (
        await exec(process.execPath, ['cli/main.ts', 'status'], {
          cwd: process.cwd(),
          env: { ...process.env, PROJECT_DAEMON_URL: endpoint, PROJECT_ID: project.id },
        })
      ).stdout,
    );
    assert.ok(cli.projects.some((item) => item.id === project.id));
    const cliGoals = JSON.parse(
      (
        await exec(process.execPath, ['cli/main.ts', 'goals'], {
          cwd: process.cwd(),
          env: { ...process.env, PROJECT_DAEMON_URL: endpoint, PROJECT_ID: project.id },
        })
      ).stdout,
    );
    assert.equal(cliGoals.length, 1);
    assert.equal(cliGoals[0].projectId, project.id);
    passed.push('CLI reads the same connected repository');
    assert.deepEqual(errors, []);
    await browser.close();
    browser = undefined;
    await host.dispose();
    host = undefined;
    const fresh = await createHost({ projects: [] });
    try {
      const restoredWorkspaces = new GitWorkspaces(fresh.ctx.projects.registry),
        restoredChecks = new ProjectChecks(fresh.ctx.projects.registry, checks);
      await fresh.ctx.plugin(projectManagementPlugin, {
        catalogFile: path.join(data, 'linked-projects.json'),
        policies: {},
        workspaces: restoredWorkspaces,
        checks: restoredChecks,
      });
      assert.equal(fresh.ctx.projects.registry.get(project.id).snapshot().profile.revision, 2);
      assert.equal(
        fresh.ctx.projects.registry.get(project.id).snapshot().runs[0].appliedBranch,
        'master',
      );
    } finally {
      await fresh.dispose();
    }
    passed.push('connected project and applied result survive daemon restart');
    await fs.writeFile(
      'artifacts/projects-ui-verification.json',
      JSON.stringify({ passed, errors }, null, 2),
    );
    console.log(JSON.stringify({ passed, errors }, null, 2));
  } finally {
    await browser?.close();
    await host?.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
