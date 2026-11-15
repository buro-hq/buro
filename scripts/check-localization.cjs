const { chromium } = require('@playwright/test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { execFile } = require('node:child_process'),
  { promisify } = require('node:util'),
  exec = promisify(execFile);
(async () => {
  const { createHost } = await import('../plugins/host.ts'),
    { projectManagementPlugin } = await import('../plugins/project-management.ts'),
    { GitWorkspaces } = await import('../adapters/files/git-workspaces.ts'),
    { websocketPlugin } = await import('../daemon/websocket.ts');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-docs-'))),
    repo = path.join(root, 'example');
  await fs.mkdir(repo);
  const git = (args) => exec('git', args, { cwd: repo });
  await git(['init', '-b', 'master']);
  await git(['config', 'user.name', 'Example']);
  await git(['config', 'user.email', 'example@invalid.test']);
  await fs.writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'Example project', scripts: { test: 'node --test' } }),
  );
  await fs.writeFile(path.join(repo, 'README.md'), 'Example project');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  let host, browser;
  const errors = [],
    passed = [];
  try {
    host = await createHost({ projects: [] });
    await host.ctx.plugin(projectManagementPlugin, {
      catalogFile: path.join(root, 'catalog.json'),
      policies: {},
      workspaces: new GitWorkspaces(host.ctx.projects.registry),
      checks: {
        async run() {
          return { passed: 1, total: 1, results: [{ name: 'Tests', passed: true }] };
        },
      },
    });
    const bus = host.ctx.commands.bus;
    let n = 0;
    const command = (method, params) =>
      bus.execute({ method, params }, { id: 'docs-' + ++n, fingerprint: 'docs-' + n });
    const info = await command('project.inspect', { root: repo });
    const project = await command('project.connect', {
      root: repo,
      name: 'Example project',
      profile: {
        ...info.profile,
        dependencies: 'none',
        components: [
          {
            id: 'web',
            name: 'Frontend',
            kind: 'web',
            path: './',
            command: 'npm run dev',
            port: 3000,
            readyPath: '/',
            instructions: 'Open the preview and verify search.',
            evidence: 'package.json',
          },
        ],
      },
    });
    const { sampleRun } = await import('../tests/fixtures/sample-run.ts');
    const run = sampleRun();
    run.id = 'R-example';
    run.key = 'GOAL-001';
    run.title = 'Improve CLI feedback';
    run.summary = 'Readable status and a stable JSON mode.';
    run.goalText = 'Improve CLI feedback and preserve the JSON output contract.';
    run.result = 'Implementation verified with tests and independent review.';
    run.goalId = 'G-example';
    const store = host.ctx.projects.registry.get(project.id);
    await store.transact('docs-run', 'docs-run', (doc) => {
      doc.runs.push(run);
      const goal = {
        id: 'G-example',
        projectId: project.id,
        title: run.title,
        body: run.goalText,
        criteria: 'Tests pass and JSON remains stable.',
        status: 'completed',
        runId: run.id,
        createdAt: run.createdAt,
      };
      doc.goals.push(goal);
      return { result: null, change: { type: 'run.changed', run, goal } };
    });
    await command('context.import', {
      projectId: project.id,
      scope: 'project',
      upload: {
        name: 'requirements.md',
        base64: Buffer.from('Preserve backwards compatibility and keyboard navigation.').toString(
          'base64',
        ),
      },
    });
    let port;
    await host.ctx.plugin(websocketPlugin, { port: 0, onListen: (p) => (port = p) });
    const url =
      'http://127.0.0.1:4317/?project=' +
      project.id +
      '&daemon=' +
      encodeURIComponent('ws://127.0.0.1:' + port);
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }),
      page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.getByRole('heading', { name: 'Example project', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await page.getByRole('button', { name: 'Full result', exact: true }).click();
    await fs.mkdir('artifacts/localization', { recursive: true });
    await page.screenshot({ path: 'artifacts/localization/office.png', animations: 'disabled' });
    passed.push('English is the default; office uses synthetic run data');
    const sidebar = (label) =>
      page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
    await sidebar('Project settings');
    await page.getByRole('region', { name: 'Project materials', exact: true }).waitFor();
    await page.screenshot({
      path: 'artifacts/localization/project-settings.png',
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'New goal', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'What should we achieve?', exact: true })
      .fill('Add search to the activity log');
    await page
      .getByRole('textbox', { name: 'Context and expected result', exact: true })
      .fill('Find events by agent, command or message. Keep keyboard navigation working.');
    await page
      .getByRole('textbox', { name: 'How will we know it is done?', exact: true })
      .fill('Search filters the log and preserves the selected project.');
    await page
      .getByRole('region', { name: 'Goal materials', exact: true })
      .getByText('Project materials will also be available: 1.')
      .waitFor();
    await page.screenshot({
      path: 'artifacts/localization/goal-materials.png',
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Open user settings', exact: true }).click();
    await page.getByRole('textbox', { name: 'Interface language', exact: true }).waitFor();
    await page.screenshot({
      path: 'artifacts/localization/user-settings.png',
      animations: 'disabled',
    });
    await page.getByRole('textbox', { name: 'Interface language', exact: true }).click();
    await page.getByRole('option', { name: 'Russian', exact: true }).click();
    const ru = JSON.parse(await fs.readFile('src/i18n/locales/ru.json', 'utf8'));
    await page.getByRole('heading', { name: ru['User settings'], exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
    await sidebar(ru.Goals);
    await page.getByRole('heading', { name: 'Improve CLI feedback', exact: true }).waitFor();
    passed.push('RU switches immediately; user goal titles stay unchanged');
    await page.reload();
    await page.getByRole('button', { name: ru['Open user settings'], exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
    await page.getByRole('button', { name: ru['Open user settings'], exact: true }).click();
    await page
      .getByRole('button', { name: ru['Theme {p0}'].replace('{p0}', ru.Iris), exact: true })
      .waitFor();
    passed.push('language persists after reload; module-level theme labels update');
    const second = await context.newPage();
    await second.goto(url);
    await second.getByRole('button', { name: ru['Open user settings'], exact: true }).click();
    await second.getByRole('textbox', { name: ru['Interface language'], exact: true }).click();
    await second.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('heading', { name: 'User settings', exact: true }).waitFor();
    passed.push('language changes synchronize across tabs');
    await second.close();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      );
    }
    passed.push('language and theme settings fit desktop/mobile');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed, errors }, null, 2));
    await fs.writeFile(
      'artifacts/localization-verification.json',
      JSON.stringify({ passed, errors }, null, 2),
    );
  } finally {
    await browser?.close();
    await host?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
