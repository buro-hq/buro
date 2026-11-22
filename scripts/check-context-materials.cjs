const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const { execFile } = require('node:child_process'),
  { promisify } = require('node:util'),
  exec = promisify(execFile);
(async () => {
  const { createHost } = await import('../plugins/host.ts'),
    { websocketPlugin } = await import('../daemon/websocket.ts'),
    { projectManagementPlugin } = await import('../plugins/project-management.ts'),
    { GitWorkspaces } = await import('../adapters/files/git-workspaces.ts');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'context-ui-'))),
    root = path.join(directory, 'repository'),
    external = path.join(directory, 'external');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(external);
  await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=1;\n');
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'Context fixture', scripts: { test: 'node --test' } }),
  );
  await fs.writeFile(path.join(external, 'requirements.md'), 'User materials stay external.');
  const git = (args) => exec('git', args, { cwd: root });
  await git(['init', '-b', 'master']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  let host, browser;
  const errors = [],
    passed = [];
  try {
    host = await createHost({
      projects: [
        {
          storageAddress: path.join(directory, 'control'),
          project: { id: 'codex-panel', name: 'Control', root: directory },
        },
      ],
    });
    await host.ctx.plugin(projectManagementPlugin, {
      catalogFile: path.join(directory, 'catalog.json'),
      policies: {},
      workspaces: new GitWorkspaces(host.ctx.projects.registry),
      checks: {
        async run() {
          return { passed: 1, total: 1, results: [{ name: 'test', passed: true }] };
        },
      },
    });
    let port;
    await host.ctx.plugin(websocketPlugin, { port: 0, onListen: (p) => (port = p) });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(
      (process.env.BURO_UI_BASE_URL || 'http://127.0.0.1:4317') +
        '/?daemon=' +
        encodeURIComponent('ws://127.0.0.1:' + port),
    );
    await page.getByRole('heading', { name: 'Control', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Connect project', exact: true }).click();
    await page.getByRole('button', { name: 'Choose: Repository path', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose: Repository path', exact: true });
    await picker.getByRole('textbox', { name: 'Directory address' }).fill(directory);
    await picker.getByRole('button', { name: 'Open', exact: true }).click();
    await picker.getByRole('button', { name: 'repository', exact: true }).click();
    await picker.getByRole('button', { name: 'Select', exact: true }).click();
    assert.equal(
      await page.getByRole('textbox', { name: 'Repository path', exact: true }).inputValue(),
      root,
    );
    passed.push('repository folder selected through the local browser');
    await page.getByRole('button', { name: 'Inspect directory', exact: true }).click();
    await page.getByRole('button', { name: 'Connect and open', exact: true }).click();
    await page.getByRole('heading', { name: 'Context fixture', exact: true }).waitFor();
    const project = host.ctx.projects.registry.list().find((p) => p.root === root);
    assert.ok(project);
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'Project settings', exact: true })
      .click();
    await page.getByRole('button', { name: 'Add component', exact: true }).click();
    await page.getByRole('button', { name: 'Choose: Working directory', exact: true }).click();
    const working = page.getByRole('dialog', { name: 'Choose: Working directory', exact: true });
    await working.getByRole('button', { name: 'src', exact: true }).click();
    await working.getByRole('button', { name: 'Select', exact: true }).click();
    assert.equal(
      await page.getByRole('textbox', { name: 'Working directory', exact: true }).inputValue(),
      'src/',
    );
    passed.push('component working folder is stored relative to the repository');
    const allowed = page
      .locator('.profile-paths')
      .filter({ has: page.getByRole('textbox', { name: 'Planned paths', exact: true }) });
    await allowed.getByRole('button', { name: 'Choose files and directories' }).first().click();
    const paths = page.getByRole('dialog', { name: 'Planned paths', exact: true });
    await paths.getByRole('checkbox', { name: 'Select src', exact: true }).check();
    await paths.getByRole('button', { name: 'Select', exact: true }).click();
    assert.ok(
      (
        await page.getByRole('textbox', { name: 'Planned paths', exact: true }).inputValue()
      ).includes('src/'),
    );
    passed.push('scope paths can be selected as files and folders');
    const shared = page.getByRole('region', { name: 'Project materials', exact: true });
    await shared.getByRole('button', { name: 'Choose on computer', exact: true }).click();
    const materials = page.getByRole('dialog', { name: 'Add context materials' });
    await materials.getByRole('textbox', { name: 'Directory address' }).fill(external);
    await materials.getByRole('button', { name: 'Open', exact: true }).click();
    await materials.getByRole('checkbox', { name: 'Select requirements.md', exact: true }).check();
    await materials.getByRole('button', { name: 'Select', exact: true }).click();
    await shared.getByText('requirements.md', { exact: true }).waitFor();
    assert.equal(
      host.ctx.projects.registry.get(project.id).snapshot().contextMaterials[0].scope,
      'project',
    );
    passed.push('external file is imported into shared project context');
    await page.locator('.sidebar').getByRole('button', { name: 'Goals', exact: true }).click();
    await page.getByRole('button', { name: 'New goal', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'What should we achieve?' })
      .fill('Goal with materials');
    await page
      .getByRole('textbox', { name: 'Context and expected result' })
      .fill('Use my documents.');
    const specific = page.getByRole('region', { name: 'Goal materials', exact: true });
    await specific.getByText('Project materials will also be available: 1.').waitFor();
    const fileChooser = page.waitForEvent('filechooser');
    await specific.getByRole('button', { name: 'Upload files', exact: true }).click();
    await (
      await fileChooser
    ).setFiles([
      {
        name: 'acceptance.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('Acceptance criteria'),
      },
      { name: 'design.txt', mimeType: 'text/plain', buffer: Buffer.from('Design notes') },
    ]);
    await specific.getByText('acceptance.md', { exact: true }).waitFor();
    await specific.getByText('design.txt', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save goal', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const saved = host.ctx.projects.registry.get(project.id).snapshot().goals[0];
    assert.equal(saved.materialIds.length, 2);
    passed.push('multiple native uploads attach to one goal without losing earlier files');
    await page.reload();
    await page.getByRole('heading', { name: 'Context fixture', exact: true }).waitFor();
    await page.locator('.sidebar').getByRole('button', { name: 'Goals', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page
      .getByRole('region', { name: 'Goal materials' })
      .getByText('acceptance.md', { exact: true })
      .waitFor();
    await page
      .getByRole('region', { name: 'Goal materials' })
      .getByRole('button', { name: 'Remove material acceptance.md' })
      .click();
    await page.getByRole('button', { name: 'Save goal', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(
      host.ctx.projects.registry.get(project.id).snapshot().goals[0].materialIds.length,
      1,
    );
    passed.push('attachments persist after reload and can be removed from the goal');
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'Project settings', exact: true })
      .click();
    await page
      .getByRole('region', { name: 'Project materials' })
      .getByRole('button', { name: 'Remove material requirements.md' })
      .click();
    await page
      .getByRole('region', { name: 'Project materials' })
      .getByText('requirements.md', { exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(
      host.ctx.projects.registry
        .get(project.id)
        .snapshot()
        .contextMaterials.find((m) => m.scope === 'project').active,
      false,
    );
    assert.equal(
      await fs.readFile(path.join(external, 'requirements.md'), 'utf8'),
      'User materials stay external.',
    );
    passed.push('removing a project attachment preserves the user source');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      );
    }
    passed.push('material controls fit mobile and desktop');
    assert.deepEqual(errors, []);
    await fs.mkdir('artifacts', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: 'artifacts/context-materials.png', fullPage: true });
    await fs.writeFile(
      'artifacts/context-ui-verification.json',
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
