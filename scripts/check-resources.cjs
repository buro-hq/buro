const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('@playwright/test');
(async () => {
  const { createServer } = await import('vite');
  const { createHost } = await import('../plugins/host.ts');
  const { DomainError } = await import('../core/ports.ts');
  const { resourcesPlugin } = await import('../plugins/resources.ts');
  const { projectManagementPlugin } = await import('../plugins/project-management.ts');
  const { GitWorkspaces } = await import('../adapters/files/git-workspaces.ts');
  const { websocketPlugin } = await import('../daemon/websocket.ts');
  const { PrivateJSONFiles } = await import('../adapters/files/private-json.ts');
  const { EnvironmentExecutors } = await import('../adapters/environments/executors.ts');
  const { ProjectProfileSchema } = await import('../protocol/projects.ts');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-resources-ui-')));
  const privateFiles = new PrivateJSONFiles(path.join(root, 'local'));
  let host, vite, browser;
  let modelsRequested = 0,
    generations = 0,
    port = 0;
  let failNextCatalog = false;
  const errors = [];
  try {
    await privateFiles.save('resources', {
      version: 1,
      defaultProfile: 'codex',
      connections: [
        { id: 'ollama', kind: 'ollama', endpoint: 'http://127.0.0.1:11434' },
        { id: 'deepseek', kind: 'deepseek', apiKeyEnv: 'BURO_UI_FAKE_MISSING_KEY' },
      ],
      runtimes: [
        { id: 'codex', client: 'codex' },
        { id: 'local-coder', client: 'managed', connectionId: 'ollama', model: 'fixture-coder' },
      ],
      profiles: [
        {
          id: 'codex',
          name: 'Codex',
          policy: 'hybrid',
          coordinator: 'codex',
          worker: 'codex',
          reviewer: 'codex',
        },
        {
          id: 'local',
          name: 'Local team',
          policy: 'local-only',
          coordinator: 'local-coder',
          worker: 'local-coder',
          reviewer: 'local-coder',
        },
      ],
    });
    const profile = ProjectProfileSchema.parse({
      version: 1,
      revision: 1,
      context: '',
      allowedPaths: ['src/'],
      protectedPaths: [],
      checks: [],
      defaultCheckIds: [],
      setup: [],
      dependencies: 'none',
      maxWorkers: 1,
      maxRepairs: 0,
      turnTimeoutMs: 10000,
    });
    host = await createHost({
      projects: [
        {
          directory: path.join(root, 'project'),
          project: { id: 'codex-panel', name: 'Resource settings fixture', root, managed: true },
          profile,
        },
      ],
    });
    await fs.mkdir(path.join(root, '.buro'), { recursive: true });
    await host.ctx.plugin(projectManagementPlugin, {
      catalogFile: path.join(root, 'linked-projects.json'),
      policies: {},
      workspaces: new GitWorkspaces(host.ctx.projects.registry),
      checks: {
        async run() {
          throw Error('UI settings must not launch verification');
        },
      },
    });
    await host.ctx.plugin(resourcesPlugin, {
      directory: root,
      executors: new EnvironmentExecutors(),
      fetch: async (url, init) => {
        const route = new URL(String(url)).pathname;
        if (route === '/api/tags') {
          modelsRequested++;
          return Response.json({ models: [{ name: 'fixture-coder' }, { name: 'fixture-helper' }] });
        }
        if (route === '/api/show')
          return Response.json({
            capabilities: ['completion', 'tools'],
            model_info: { 'fixture.context_length': 32768 },
          });
        assert.equal(route, '/api/chat');
        generations++;
        const body = JSON.parse(String(init.body));
        const afterTool = body.messages.some((message) => message.role === 'tool');
        return new Response(
          JSON.stringify({
            model: 'fixture-coder',
            message: {
              role: 'assistant',
              content: afterTool ? '{"ok":true}' : '',
              thinking: 'PRIVATE_UI_REASONING',
              ...(afterTool
                ? {}
                : {
                    tool_calls: [
                      { function: { name: 'diagnostic_echo', arguments: { value: 'buro-ready' } } },
                    ],
                  }),
            },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 30,
            eval_count: 15,
          }) + '\n',
        );
      },
    });
    const catalogHandler = host.ctx.commands.bus.handlers.get('resources.list');
    host.ctx.commands.bus.handlers.set('resources.list', (...args) => {
      if (failNextCatalog) {
        throw new DomainError('FIXTURE_CATALOG_UNAVAILABLE', 'Fixture catalog unavailable');
      }
      return catalogHandler(...args);
    });
    await host.ctx.plugin(websocketPlugin, {
      port: 0,
      onListen: (value) => {
        port = value;
      },
    });
    vite = await createServer({
      configFile: path.resolve('vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    await vite.listen();
    const base = vite.resolvedUrls.local[0];
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1080 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base + '?daemon=' + encodeURIComponent('ws://127.0.0.1:' + port));
    await page.getByRole('button', { name: 'User settings', exact: true }).click();
    await page.getByRole('heading', { name: 'Execution resources', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Default execution profile', exact: true }).click();
    await page.getByRole('option', { name: 'Local team', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Default execution profile', exact: true })
      .evaluate((element) => element.blur());
    await page.getByText('Local only', { exact: true }).waitFor();
    assert.equal((await privateFiles.load('resources')).defaultProfile, 'local');
    assert.equal(generations, 0, 'Changing the default never starts model inference');
    await page.getByRole('button', { name: 'Models and connections', exact: true }).click();
    const ollama = page
      .locator('.mantine-Paper-root')
      .filter({ has: page.getByText('Ollama', { exact: true }) });
    await ollama.getByRole('button', { name: 'Available models', exact: true }).click();
    await page.getByText('fixture-coder · fixture-helper', { exact: true }).waitFor();
    assert.equal(modelsRequested, 1);
    await page.getByRole('button', { name: 'Check model', exact: true }).click();
    await page.getByText('ollama · Connection checked', { exact: true }).waitFor();
    assert.equal(generations, 2);
    await page.getByText('Key required', { exact: true }).waitFor();
    assert.equal((await page.locator('body').innerText()).includes('PRIVATE_UI_REASONING'), false);
    await fs.mkdir('artifacts', { recursive: true });
    const checkedSchemes = [];
    for (const scheme of ['Light', 'Dark']) {
      await page.getByRole('button', { name: scheme, exact: true }).click();
      await page.waitForFunction(
        (value) => document.documentElement.getAttribute('data-mantine-color-scheme') === value,
        scheme.toLowerCase(),
      );
      assert.equal(
        await page
          .getByRole('textbox', { name: 'Default execution profile', exact: true })
          .isVisible(),
        true,
      );
      assert.equal(
        await page.getByRole('button', { name: 'Check model', exact: true }).isVisible(),
        true,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        true,
        'Resource settings must not overflow horizontally',
      );
      checkedSchemes.push(scheme.toLowerCase());
      await page.locator('.workspace-scroll').evaluate((element) => element.scrollTo(0, 0));
      await page
        .locator('.mantine-Accordion-panel')
        .evaluateAll((elements) =>
          Promise.all(
            elements.flatMap((element) =>
              element
                .getAnimations({ subtree: true })
                .map((animation) => animation.finished.catch(() => {})),
            ),
          ),
        );
      await page
        .waitForFunction(() => {
          const header = [...document.querySelectorAll('.mantine-Paper-root')].find((element) =>
            element.textContent.includes('Ollama'),
          );
          if (!header) return false;
          const panel = header.closest('.mantine-Accordion-panel');
          if (!panel) return false;
          const note = [...panel.querySelectorAll('p')].find((element) =>
            element.textContent.includes('Model checks run a small diagnostic.'),
          );
          if (!note) return false;
          return (
            header.getBoundingClientRect().top >= panel.getBoundingClientRect().top &&
            header.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom &&
            note.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom
          );
        })
        .catch(async (error) => {
          console.error(
            'Accordion geometry',
            await page.locator('.mantine-Accordion-panel').evaluate((panel) => ({
              panel: panel.getBoundingClientRect().toJSON(),
              style: panel.getAttribute('style'),
              text: [...panel.querySelectorAll('p')].map((element) => ({
                text: element.textContent,
                rect: element.getBoundingClientRect().toJSON(),
              })),
            })),
          );
          throw error;
        });
      await page.screenshot({
        path: 'artifacts/resources-settings-' + scheme.toLowerCase() + '.png',
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.locator('.workspace-scroll').evaluate((element) => element.scrollTo(0, 0));
    await page.screenshot({ path: 'artifacts/resources-settings.png', fullPage: true });
    failNextCatalog = true;
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await page.getByText('Fixture catalog unavailable', { exact: true }).waitFor();
    failNextCatalog = false;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('textbox', { name: 'Execution profile', exact: true }).waitFor();
    const projectProfile = page.getByRole('textbox', { name: 'Execution profile', exact: true });
    await projectProfile.click();
    await page.getByRole('option', { name: 'Local team', exact: true }).click();
    assert.equal(await projectProfile.inputValue(), 'Local team');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByText('Settings saved', { exact: true }).waitFor();
    assert.equal(
      host.ctx.projects.registry.get('codex-panel').snapshot().profile.resourceProfile,
      'local',
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, '.buro/project.json'), 'utf8')).profile
        .resourceProfile,
      'local',
    );
    await page.reload();
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await page.getByRole('textbox', { name: 'Execution profile', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: 'Execution profile', exact: true }).inputValue(),
      'Local team',
    );
    await page.getByRole('button', { name: 'User settings', exact: true }).click();
    await page.getByRole('textbox', { name: 'Default execution profile', exact: true }).click();
    await page.getByRole('option', { name: 'Codex', exact: true }).click();
    await page.getByText('Hybrid', { exact: true }).waitFor();
    assert.equal(
      host.ctx.agentRuntime.selection.forProject('codex-panel').profileId,
      'local',
      'An explicit project choice survives a default change',
    );
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await page.getByRole('textbox', { name: 'Execution profile', exact: true }).click();
    await page.getByRole('option', { name: 'Inherit default profile', exact: true }).click();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByText('Settings saved', { exact: true }).waitFor();
    assert.equal(
      host.ctx.projects.registry.get('codex-panel').snapshot().profile.resourceProfile,
      undefined,
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, '.buro/project.json'), 'utf8')).profile
        .resourceProfile,
      undefined,
    );
    assert.equal(host.ctx.agentRuntime.selection.forProject('codex-panel').profileId, 'codex');
    await page.reload();
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await page.getByRole('textbox', { name: 'Execution profile', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: 'Execution profile', exact: true }).inputValue(),
      'Inherit default profile',
    );
    assert.equal(generations, 2, 'Settings saves and reloads must not generate model responses');
    assert.deepEqual(errors, []);
    await fs.writeFile(
      'artifacts/resources-ui-verification.json',
      JSON.stringify(
        {
          passed: true,
          profile: 'local',
          modelDiscovery: modelsRequested,
          diagnosticRequests: generations,
          schemes: checkedSchemes,
          projectOverridePersisted: true,
          projectOverrideReloaded: true,
          inheritedDefaultPersisted: true,
          catalogRetryRecovered: true,
          errors,
        },
        null,
        2,
      ),
    );
    console.log(
      'Resource settings UI: profile selection, model discovery, explicit diagnostic and project override passed.',
    );
  } finally {
    await browser?.close();
    await vite?.close();
    await host?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
