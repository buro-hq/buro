const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { promisify } = require('node:util'),
  { execFile } = require('node:child_process');
const exec = promisify(execFile);
(async () => {
  const { Service } = await import('cordis');
  const { createHost } = await import('../plugins/host.ts');
  const { projectManagementPlugin } = await import('../plugins/project-management.ts');
  const { projectOperationsPlugin } = await import('../plugins/project-operations.ts');
  const { websocketPlugin } = await import('../daemon/websocket.ts');
  const { NativeProjectOperations } = await import('../adapters/processes/project-operations.ts');
  const { GitWorkspaces } = await import('../adapters/files/git-workspaces.ts');
  const { ProjectChecks } = await import('../adapters/checks/project-commands.ts');
  const { GoalService } = await import('../core/services.ts');
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-setup-ui-'))),
    root = path.join(dir, 'repo');
  await fs.mkdir(root);
  const git = (args) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'Setup fixture', scripts: { test: 'node -e "console.log(123)"' } }),
  );
  await fs.writeFile(
    path.join(root, 'server.mjs'),
    "import http from 'node:http';http.createServer((req,res)=>{res.end('preview ready '+process.pid);}).listen(Number(process.env.PORT),'127.0.0.1');\n",
  );
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  const initial = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const host = await createHost({
    projects: [
      {
        directory: path.join(dir, 'control'),
        project: { id: 'control', name: 'Setup control', root: dir },
      },
    ],
  });
  let browser;
  const errors = [],
    passed = [];
  let deployCalls = 0;
  try {
    let count = 0;
    const runtime = {
      id: 'fixture',
      async start(input) {
        return { threadId: 'thread-' + ++count };
      },
      async turn(id, text) {
        if (text.startsWith('Inspect the project')) {
          await new Promise((r) => setTimeout(r, 500));
          return {
            turnId: 'turn',
            text: JSON.stringify({
              summary: 'HTTP API discovered',
              context: 'Fixture API context',
              components: [
                {
                  id: 'api',
                  name: 'Fixture API',
                  kind: 'api',
                  path: './',
                  command: 'node server.mjs',
                  port: 3000,
                  readyPath: '/',
                  instructions: 'Open the API or send an HTTP request',
                  evidence: 'server.mjs',
                },
              ],
              checks: [{ id: 'test', title: 'Tests', command: 'npm run test', timeoutMs: 30000 }],
              questions: [],
            }),
          };
        }
        return {
          turnId: 'turn',
          text: JSON.stringify({
            ready: true,
            summary: 'Result and checks prepared',
            blockers: [],
          }),
        };
      },
      async release() {},
      async submit() {
        return { turnId: 'turn' };
      },
      async interrupt() {},
      async dispose() {},
    };
    class Runtime extends Service {
      constructor(ctx) {
        super(ctx, 'agentRuntime');
        this.adapter = runtime;
      }
    }
    await host.ctx.plugin(Runtime);
    const policies = {},
      workspaces = new GitWorkspaces(host.ctx.projects.registry),
      checks = new ProjectChecks(host.ctx.projects.registry, {
        async run() {
          throw Error('Unexpected fallback');
        },
      });
    await host.ctx.plugin(projectManagementPlugin, {
      catalogFile: path.join(dir, 'catalog.json'),
      policies,
      workspaces,
      checks,
    });
    const native = new NativeProjectOperations();
    await host.ctx.plugin(projectOperationsPlugin, {
      operations: {
        preview: native.preview.bind(native),
        stopPreview: native.stopPreview.bind(native),
        previewStatus: native.previewStatus.bind(native),
        dispose: native.dispose.bind(native),
        async pullRequest() {
          return { url: 'https://example.invalid/pr/1', branch: 'goal/fixture' };
        },
        async deploy() {
          deployCalls++;
          return { url: 'https://example.invalid/production', output: 'Fixture deployment' };
        },
      },
    });
    let port;
    await host.ctx.plugin(websocketPlugin, { port: 0, onListen: (p) => (port = p) });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1512, height: 1080 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(
      (process.env.BURO_UI_BASE_URL || 'http://127.0.0.1:4317') +
        '/?project=control&daemon=' +
        encodeURIComponent('ws://127.0.0.1:' + port),
    );
    await page.getByRole('heading', { name: 'Setup control', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Connect project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Repository path' }).fill(root);
    await page.getByRole('button', { name: 'Research directory', exact: true }).click();
    await page.getByRole('heading', { name: 'Project research', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save and open', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Component name', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: 'Component name', exact: true }).inputValue(),
      'Fixture API',
    );
    passed.push('folder → agent research → editable generated configuration');
    await fs.access(path.join(root, '.buro/local'));
    assert.match(await fs.readFile(path.join(root, '.buro/.gitignore'), 'utf8'), /local\//);
    await page.getByRole('button', { name: 'Save and open', exact: true }).click();
    await page.getByRole('heading', { name: 'Setup fixture', exact: true }).waitFor();
    const project = host.ctx.projects.registry.list().find((p) => p.root === root);
    const store = host.ctx.projects.registry.get(project.id);
    assert.equal(store.snapshot().profile.components[0].kind, 'api');
    assert.ok(store.snapshot().roles.some((r) => r.id === 'production_delivery'));
    assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), initial);
    passed.push('profile and operational roles saved; original branch preserved');
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'Project settings', exact: true })
      .click();
    await page.getByRole('button', { name: 'Research again', exact: true }).click();
    await page.getByLabel('Agent is researching the project', { exact: true }).waitFor();
    await page
      .getByLabel('Agent is researching the project', { exact: true })
      .waitFor({ state: 'hidden' });
    await page
      .getByRole('textbox', { name: 'Project context', exact: true })
      .fill('Manual settings after research');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByText('Settings saved', { exact: true }).waitFor();
    assert.equal(store.snapshot().profile.context, 'Manual settings after research');
    assert.equal(
      store.snapshot().research.reviewedProfileRevision,
      store.snapshot().profile.revision,
    );
    assert.equal(store.snapshot().research.appliedProfileRevision, undefined);
    const strict = page.getByRole('checkbox', {
      name: 'Forbid changes outside planned paths',
      exact: true,
    });
    const planned = page.getByRole('textbox', { name: 'Planned paths', exact: true });
    assert.equal(await strict.isChecked(), false);
    await planned.fill('server.mjs');
    await strict.check();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect.poll(() => store.snapshot().profile.scope.mode).toBe('strict');
    assert.deepEqual(store.snapshot().profile.scope.plannedPaths, ['server.mjs']);
    await strict.uncheck();
    await planned.fill('');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect.poll(() => store.snapshot().profile.scope.mode).toBe('advisory');
    assert.deepEqual(store.snapshot().profile.scope.plannedPaths, []);
    passed.push('strict scope persists and advisory discovery accepts an empty plan');
    await page.locator('.sidebar').getByRole('button', { name: 'Office', exact: true }).click();
    assert.equal(
      await page
        .getByText('Project research is ready. Review the suggestions and complete the settings.', {
          exact: true,
        })
        .count(),
      0,
    );
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'Project settings', exact: true })
      .click();
    await page.getByRole('button', { name: 'Edit before saving', exact: true }).click();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByText('Settings saved', { exact: true }).waitFor();
    assert.equal(
      store.snapshot().research.appliedProfileRevision,
      store.snapshot().profile.revision,
    );
    passed.push(
      'manual settings save dismisses research notice; proposals can be accepted after a later profile revision',
    );
    const configured = store.snapshot().profile;
    await host.ctx.projectManagement.api.configure('clear-local', 'clear-local', {
      projectId: project.id,
      expectedRevision: configured.revision,
      profile: { ...configured, components: [] },
    });
    const workspace = await workspaces.prepare(project.id, 'R-result', 'main', {
      profile: store.snapshot().profile,
    });
    const goal = await new GoalService({
      projects: host.ctx.projects.registry,
      id: () => crypto.randomUUID(),
      now: () => new Date().toISOString(),
    }).create('fixture-goal', 'fixture-goal', {
      projectId: project.id,
      title: 'Ready implementation',
      body: 'Show API',
      criteria: 'HTTP available',
      outcome: { kind: 'local' },
    });
    const at = new Date().toISOString();
    const run = {
      id: 'R-result',
      key: goal.id,
      goalId: goal.id,
      title: goal.title,
      summary: 'Done',
      createdAt: at,
      completedAt: at,
      threadId: 'fixture',
      status: 'completed',
      phase: 'done',
      commit: workspace.base,
      workspace: workspace.path,
      baseBranch: 'main',
      outcome: { kind: 'local' },
      agents: [],
      events: [{ at, type: 'goal.completed', text: 'API ready' }],
      commands: [],
      plan: [],
      changedFiles: [],
      baseline: { passed: 1, total: 1, results: [] },
      acceptance: { passed: 1, total: 1, results: [{ name: 'Tests', passed: true }] },
      specsUnchanged: true,
      scopePreserved: true,
      independentReviewer: true,
      review: { verdict: 'approved', blockingFindings: [], summary: 'Synthetic review fixture' },
      goalText: 'Show API',
      result: 'API ready',
      sourceHash: '',
    };
    await store.transact('seed-run', 'seed-run', (doc) => {
      doc.runs.unshift(run);
      const g = doc.goals.find((g) => g.id === goal.id);
      g.status = 'completed';
      g.runId = run.id;
      return { result: null, change: { type: 'run.changed', run, goal: g } };
    });
    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    await page.getByRole('tab', { name: 'Result', exact: true }).click();
    await page.getByRole('heading', { name: 'Implementation ready', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Configure and launch locally', exact: true }).click();
    await page.getByRole('link', { name: 'Open Fixture API', exact: true }).waitFor();
    const url = await page
      .getByRole('link', { name: 'Open Fixture API', exact: true })
      .getAttribute('href');
    assert.equal((await fetch(url)).status, 200);
    assert.equal(store.snapshot().profile.context, 'Manual settings after research');
    assert.equal(store.snapshot().profile.components[0].id, 'api');
    passed.push(
      'ready result applies discovered launch configuration and starts preview in one action without overwriting manual context',
    );
    const originalProcess = await (await fetch(url)).text();
    await page.getByRole('button', { name: 'Restart locally', exact: true }).click();
    await page.getByRole('link', { name: 'Open Fixture API', exact: true }).waitFor();
    const restartedUrl = await page
      .getByRole('link', { name: 'Open Fixture API', exact: true })
      .getAttribute('href');
    const restartedProcess = await (await fetch(restartedUrl)).text();
    assert.notEqual(restartedProcess, originalProcess);
    passed.push('local restart replaces the real HTTP process');
    await page.screenshot({ path: 'artifacts/setup-local-result.png', fullPage: true });
    await page.getByRole('button', { name: 'Stop local preview', exact: true }).click();
    await page.getByText('Local preview: Stopped', { exact: true }).waitFor();
    passed.push('accepted API starts in worktree, exposes HTTP URL and stops from UI');
    const initialProfile = store.snapshot().profile;
    await host.ctx.projectManagement.api.configure('enable-deploy', 'enable-deploy', {
      projectId: project.id,
      expectedRevision: initialProfile.revision,
      profile: {
        ...initialProfile,
        delivery: {
          remote: 'origin',
          pullRequests: true,
          environments: [
            {
              id: 'production',
              name: 'Production fixture',
              enabled: true,
              command: 'configured fixture command',
              url: 'https://example.invalid/health',
              requireConfirmation: true,
              roleId: 'production_delivery',
            },
          ],
        },
      },
    });
    await store.transact('set-outcome', 'set-outcome', (doc) => {
      const r = doc.runs[0];
      r.outcome = { kind: 'deploy', environmentId: 'production' };
      return {
        result: null,
        change: { type: 'run.changed', run: r, goal: doc.goals.find((g) => g.id === r.goalId) },
      };
    });
    await page.getByRole('button', { name: 'Prepare delivery', exact: true }).click();
    await page
      .getByRole('button', { name: 'Confirm delivery of this commit', exact: true })
      .waitFor();
    assert.equal(deployCalls, 0);
    await page.screenshot({ path: 'artifacts/setup-delivery-confirmation.png', fullPage: true });
    await page
      .getByRole('button', { name: 'Confirm delivery of this commit', exact: true })
      .click();
    await page.getByRole('link', { name: 'Open delivery result', exact: true }).waitFor();
    assert.equal(deployCalls, 1);
    assert.equal(store.snapshot().runs[0].status, 'completed');
    passed.push(
      'production preparation waits for concrete-commit confirmation; acceptance stays completed',
    );
    await page.getByRole('button', { name: 'Repeat delivery', exact: true }).click();
    await page
      .getByRole('button', { name: 'Confirm delivery of this commit', exact: true })
      .waitFor();
    assert.equal(deployCalls, 1);
    assert.equal(store.snapshot().runs[0].deliveryHistory.length, 1);
    await page
      .getByRole('button', { name: 'Confirm delivery of this commit', exact: true })
      .click();
    await page.getByRole('button', { name: 'Repeat delivery', exact: true }).waitFor();
    assert.equal(deployCalls, 2);
    assert.equal(store.snapshot().runs[0].commit, workspace.base);
    assert.equal(store.snapshot().runs[0].status, 'completed');
    passed.push(
      'redeploy repeats only delivery, preserves history and requests confirmation again',
    );
    await page.getByRole('button', { name: 'New goal', exact: true }).click();
    assert.equal(
      await page
        .getByRole('textbox', { name: 'Work with the completed result', exact: true })
        .inputValue(),
      'Draft PR — default',
    );
    await page
      .getByRole('textbox', { name: 'What should we achieve?', exact: true })
      .fill('Child goal');
    await page
      .getByRole('textbox', { name: 'Context and expected result', exact: true })
      .fill('Continue implementation');
    await page.getByRole('textbox', { name: 'Goal starting point', exact: true }).click();
    await page.getByRole('option').filter({ hasText: 'Ready implementation' }).click();
    await page.getByRole('button', { name: 'Save goal', exact: true }).click();
    await page.locator('.draft-card').filter({ hasText: 'Child goal' }).waitFor();
    assert.equal(
      store.snapshot().goals.find((g) => g.title === 'Child goal').parentRunId,
      'R-result',
    );
    assert.equal(
      store.snapshot().goals.find((g) => g.title === 'Child goal').outcome.kind,
      'pull-request',
    );
    passed.push('new goal defaults to PR and can select a parent run');
    await page.getByRole('button', { name: 'New goal', exact: true }).click();
    assert.equal(
      await page.getByRole('textbox', { name: 'Goal starting point', exact: true }).inputValue(),
      'Base branch: main',
    );
    await page.locator('.mantine-Modal-close').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed, errors }, null, 2));
  } finally {
    await browser?.close();
    await host.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
