const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

(async () => {
  const { createServer } = await import('vite');
  const { createHost } = await import('../plugins/host.ts');
  const { websocketPlugin } = await import('../daemon/websocket.ts');
  const { FileProjectStore } = await import('../adapters/files/project-store.ts');
  const { ProjectProfileSchema } = await import('../protocol/projects.ts');
  const { DomainError } = await import('../core/ports.ts');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-empty-ui-'));
  let host, vite, browser;
  const commands = [],
    errors = [],
    externalRequests = [];
  try {
    host = await createHost({ projects: [] });
    const profile = ProjectProfileSchema.parse({
      version: 1,
      revision: 0,
      context: '',
      scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
      checks: [],
      defaultCheckIds: [],
      setup: [],
      dependencies: 'none',
      maxWorkers: 1,
      maxRepairs: 0,
      turnTimeoutMs: 10000,
    });
    host.ctx.on('service/info', (info) =>
      info.capabilities.push('project.inspect', 'project.connect'),
    );
    host.ctx.commands.bus.register('project.inspect', (input) => {
      commands.push('project.inspect');
      assert.equal(input.root, directory);
      return {
        root: directory,
        name: 'First fixture project',
        head: 'a'.repeat(40),
        branch: 'main',
        dirty: false,
        dirtyFiles: [],
        warnings: [],
        profile,
      };
    });
    host.ctx.commands.bus.register('project.connect', async (input) => {
      commands.push('project.connect');
      assert.equal(input.root, directory);
      const project = { id: 'first', name: input.name, root: directory, managed: true };
      const store = await FileProjectStore.open({
        directory: path.join(directory, 'state'),
        project,
        profile: input.profile,
        roles: [],
        runs: [],
      });
      host.ctx.projects.registry.add(store);
      return project;
    });
    const snapshot = host.ctx.commands.bus.handlers.get('project.snapshot');
    host.ctx.commands.bus.handlers.set('project.snapshot', (...args) => {
      commands.push('project.snapshot');
      return snapshot(...args);
    });
    let port = 0;
    await host.ctx.plugin(websocketPlugin, {
      port: 0,
      onListen: (value) => {
        port = value;
      },
    });
    vite = await createServer({ server: { host: '127.0.0.1', port: 0 } });
    await vite.listen();
    const address = vite.httpServer.address();
    const base = `http://127.0.0.1:${address.port}/?daemon=${encodeURIComponent(`ws://127.0.0.1:${port}`)}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname))
        externalRequests.push(request.url());
    });
    await page.goto(base);
    await expect(
      page.getByRole('heading', { name: 'Your workspace starts with a project' }),
    ).toBeVisible();
    assert.deepEqual(
      commands,
      [],
      'An empty service must never request an invented project snapshot.',
    );
    await fs.mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/service-empty.png', fullPage: true });
    await page.getByRole('button', { name: 'Connect project', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Connect project', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Repository path', exact: true }).fill(directory);
    await expect(
      dialog.getByRole('checkbox', { name: 'Research project', exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: 'Inspect directory', exact: true }).click();
    await dialog.getByRole('button', { name: 'Connect and open', exact: true }).click();
    await expect(page.getByText('First fixture project', { exact: true }).first()).toBeVisible();
    assert.deepEqual(host.ctx.projects.registry.get('first').snapshot().goals, []);
    assert.deepEqual(host.ctx.projects.registry.get('first').snapshot().roles, []);
    assert.deepEqual(host.ctx.projects.registry.get('first').snapshot().runs, []);
    const wrong = await browser.newPage();
    await wrong.goto(base + '&project=missing');
    await expect(wrong.getByRole('alert')).toHaveText(
      'The selected project is unavailable. Choose an existing project.',
    );
    await expect(
      wrong.getByRole('heading', { name: 'Your workspace starts with a project' }),
    ).toBeVisible();
    const stale = await browser.newPage();
    await stale.addInitScript(() => localStorage.setItem('project-panel-last-project', 'removed'));
    await stale.goto(base);
    await expect(stale.getByText('First fixture project', { exact: true }).first()).toBeVisible();
    const discovery = host.ctx.commands.bus.handlers.get('service.info');
    host.ctx.commands.bus.handlers.set('service.info', () => {
      throw new DomainError('SERVICE_UNAVAILABLE', 'Fixture service discovery failed.');
    });
    const failed = await browser.newPage();
    await failed.goto(base);
    await expect(
      failed.getByText('Fixture service discovery failed.', { exact: true }),
    ).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
    await expect(failed.locator('.workspace-columns')).toHaveCount(0);
    host.ctx.commands.bus.handlers.set('service.info', discovery);
    await failed.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(failed.getByText('First fixture project', { exact: true }).first()).toBeVisible();
    const explicitReplay = await browser.newPage();
    await explicitReplay.goto(base + '&source=replay');
    await expect(explicitReplay.locator('.workspace-columns')).toHaveCount(1);
    assert.equal(commands.filter((command) => command === 'project.connect').length, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log(
      JSON.stringify({
        emptyService: true,
        connectedFirstProject: true,
        noFakeProject: true,
        explicitMissingProjectPreserved: true,
        staleStoredSelectionRecovered: true,
        failedDiscoveryWithoutImplicitReplay: true,
        explicitReplayAvailable: true,
        models: 0,
        errors: 0,
        screenshot: 'artifacts/service-empty.png',
      }),
    );
  } finally {
    await browser?.close();
    await vite?.close();
    await host?.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
