async function showConnections(page) {
  if (!(await page.getByRole('button', { name: 'Add API connection', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Models and connections', exact: true }).click();
}
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium, expect } = require('@playwright/test');
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
  let failConnectionSave = false;
  let failSetupSave = false;
  const errors = [];
  try {
    await privateFiles.save('resources', {
      version: 1,
      defaultProfile: 'codex',
      connections: [
        {
          id: 'ollama',
          provider: 'ollama',
          config: { endpoint: 'http://127.0.0.1:11434', think: 'high', capacity: 2 },
        },
        {
          id: 'deepseek',
          provider: 'deepseek',
          config: { apiKeyEnv: 'BURO_UI_FAKE_MISSING_KEY', thinking: 'enabled', capacity: 3 },
        },
      ],
      runtimes: [
        { id: 'codex', backend: 'codex', config: {} },
        {
          id: 'local-coder',
          backend: 'managed',
          config: { connectionId: 'ollama', model: 'fixture-coder' },
        },
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
          workerPool: ['local-coder'],
        },
      ],
    });
    const profile = ProjectProfileSchema.parse({
      version: 1,
      revision: 1,
      context: '',
      scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: [] },
      checks: [],
      defaultCheckIds: [],
      setup: [],
      dependencies: 'none',
      maxWorkers: 1,
      maxRepairs: 0,
      turnTimeoutMs: 10000,
      managedBudget: {
        version: 1,
        maxRequests: 24,
        maxReservedOutputTokens: 32768,
        maxToolCalls: 64,
        reviewReserve: { requests: 4, outputTokens: 4096, toolCalls: 8 },
      },
    });
    host = await createHost({
      projects: [
        {
          storageAddress: path.join(root, 'project'),
          project: { id: 'codex-panel', name: 'Resource settings fixture', root, managed: true },
          profile,
          roles: [
            ...['legacy_worker', 'retired_worker', 'coordinator'].map((id) => ({
              provenance: { origin: 'user' },
              id,
              version: 1,
              title: id,
              description: 'Fixture specialist',
              instructions: 'Keep these instructions exactly. No model metadata.',
              kind: id === 'coordinator' ? 'coordination' : 'implementation',
              createdAt: '2026-11-20T00:00:00.000Z',
              updatedAt: '2026-11-20T00:00:00.000Z',
              ...(id === 'legacy_worker' ? { model: 'legacy-opaque-name' } : {}),
              ...(id === 'retired_worker'
                ? { runtimePreference: { mode: 'prefer', runtimeId: 'retired-runtime' } }
                : {}),
            })),
          ],
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
          return Response.json({
            models: [
              { name: 'fixture-coder' },
              { name: 'fixture-helper' },
              { name: 'fixture:cloud' },
            ],
          });
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
    const setupHandler = host.ctx.commands.bus.handlers.get('resources.setup.save');
    host.ctx.commands.bus.handlers.set('resources.setup.save', (...args) => {
      if (failSetupSave)
        throw new DomainError('FIXTURE_SETUP_UNAVAILABLE', 'Fixture team save unavailable');
      return setupHandler(...args);
    });
    const saveConnectionHandler = host.ctx.commands.bus.handlers.get('resources.connection.save');
    host.ctx.commands.bus.handlers.set('resources.connection.save', (...args) => {
      if (failConnectionSave)
        throw new DomainError('FIXTURE_SAVE_UNAVAILABLE', 'Fixture connection save unavailable');
      return saveConnectionHandler(...args);
    });
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
    await showConnections(page);
    const ollama = page.locator('[data-connection-id="ollama"]');
    await ollama.getByRole('button', { name: 'Available models', exact: true }).click();
    await ollama.locator('[data-model-id="fixture-helper"]').waitFor();
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
    assert.deepEqual(
      host.ctx.projects.registry.get('codex-panel').snapshot().profile.managedBudget,
      profile.managedBudget,
      'An unrelated profile edit must preserve the configured managed budget',
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, '.buro/project.json'), 'utf8')).profile
        .resourceProfile,
      'local',
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(root, '.buro/project.json'), 'utf8')).profile
        .managedBudget,
      profile.managedBudget,
      'The exported shared profile must retain its budget',
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
    assert.deepEqual(
      host.ctx.projects.registry.get('codex-panel').snapshot().profile.managedBudget,
      profile.managedBudget,
      'Returning to resource inheritance must not clear project budget policy',
    );
    await page.reload();
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await page.getByRole('textbox', { name: 'Execution profile', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: 'Execution profile', exact: true }).inputValue(),
      'Inherit default profile',
    );
    assert.equal(generations, 2, 'Settings saves and reloads must not generate model responses');
    // Role selection uses the effective project pool, never the global runtime catalog.
    await projectProfile.click();
    await page.getByRole('option', { name: 'Local team', exact: true }).click();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByText('Settings saved', { exact: true }).waitFor();
    failNextCatalog = true;
    await page.locator('.sidebar').getByRole('button', { name: 'Team', exact: true }).click();
    await page.getByRole('button', { name: 'Edit role legacy_worker', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Fixture catalog unavailable', { exact: true }).waitFor();
    failNextCatalog = false;
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await dialog
      .getByText('Fixture catalog unavailable', { exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(
      await dialog.getByRole('radio', { name: 'Auto', exact: true }).isChecked(),
      true,
      'Legacy role.model is not interpreted as a runtime preference',
    );
    await dialog.getByRole('button', { name: 'Save version 2', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const savedRole = () =>
      host.ctx.projects.registry
        .get('codex-panel')
        .snapshot()
        .roles.find((role) => role.id === 'legacy_worker');
    assert.deepEqual(savedRole().runtimePreference, { mode: 'auto' });
    assert.equal(savedRole().model, 'legacy-opaque-name');
    const roleModes = ['auto'];
    for (const [mode, label] of [
      ['prefer', 'Prefer'],
      ['fixed', 'Only this model'],
      ['auto', 'Auto'],
    ]) {
      const nextVersion = savedRole().version + 1;
      await page.getByRole('button', { name: 'Edit role legacy_worker', exact: true }).click();
      await dialog.getByText(label, { exact: true }).click();
      if (mode !== 'auto') {
        const select = dialog.getByRole('textbox', {
          name: 'Model from project pool',
          exact: true,
        });
        await select.click();
        await page
          .getByRole('option', { name: 'fixture-coder · local-coder', exact: true })
          .waitFor();
        assert.deepEqual(await page.getByRole('option').allTextContents(), [
          'fixture-coder · local-coder',
        ]);
        await page
          .getByRole('option', { name: 'fixture-coder · local-coder', exact: true })
          .click();
      }
      await dialog
        .getByRole('button', { name: 'Save version ' + nextVersion, exact: true })
        .click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(savedRole().version, nextVersion);
      assert.deepEqual(
        savedRole().runtimePreference,
        mode === 'auto' ? { mode } : { mode, runtimeId: 'local-coder' },
      );
      assert.equal(savedRole().model, 'legacy-opaque-name');
      assert.equal(savedRole().instructions, 'Keep these instructions exactly. No model metadata.');
      await page.reload();
      await page.locator('.sidebar').getByRole('button', { name: 'Team', exact: true }).click();
      await page.getByRole('button', { name: 'Edit role legacy_worker', exact: true }).click();
      assert.equal(await dialog.getByRole('radio', { name: label, exact: true }).isChecked(), true);
      if (mode !== 'auto')
        await expect(
          dialog.getByRole('textbox', { name: 'Model from project pool', exact: true }),
        ).toHaveValue('fixture-coder · local-coder');
      await dialog.locator('.mantine-Modal-close').click();
      roleModes.push(mode);
    }
    await page.getByRole('button', { name: 'Edit role retired_worker', exact: true }).click();
    assert.equal(
      await dialog
        .getByRole('textbox', { name: 'Model from project pool', exact: true })
        .inputValue(),
      'retired-runtime · Unavailable',
    );
    await dialog.locator('.mantine-Modal-close').click();
    await page.getByRole('button', { name: 'Edit role coordinator', exact: true }).click();
    assert.equal(await dialog.getByRole('radio', { name: 'Auto', exact: true }).isChecked(), true);
    assert.equal(await dialog.getByRole('radio').count(), 3);
    await dialog.locator('.mantine-Modal-close').click();
    await page.getByRole('button', { name: 'Edit role legacy_worker', exact: true }).click();
    await dialog.getByText('Prefer', { exact: true }).click();
    await expect(
      dialog.getByRole('textbox', { name: 'Model from project pool', exact: true }),
    ).toBeEnabled();
    await page.screenshot({ path: 'artifacts/role-model-preference.png', fullPage: true });
    await dialog.locator('.mantine-Modal-close').click();
    assert.equal(modelsRequested, 1, 'Role editing never discovers provider models');
    assert.equal(generations, 2, 'Role editing, model selection and role.save never run inference');
    // Model discovery leads to an explicit new team profile, never a new default or inference.
    await page.getByRole('button', { name: 'User settings', exact: true }).click();
    await showConnections(page);
    await ollama.getByRole('button', { name: 'Available models', exact: true }).click();
    const modelHelper = ollama.locator('[data-model-id="fixture-helper"]');
    await modelHelper.getByRole('button', { name: 'Use in team', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Profile ID', exact: true }).fill('helper-team');
    await dialog.getByRole('textbox', { name: 'Profile name', exact: true }).fill('Helper team');
    const beforeConcurrentSetup = await catalogHandler({});
    await host.ctx.commands.bus.execute(
      {
        method: 'resources.setup.save',
        params: {
          expectedRevision: beforeConcurrentSetup.configurationRevision,
          runtimes: [
            {
              id: 'ollama-fixture-helper',
              backend: 'managed',
              config: { connectionId: 'ollama', model: 'other-helper' },
            },
          ],
          profile: {
            id: 'concurrent-team',
            name: 'Concurrent team',
            policy: 'hybrid',
            coordinator: 'codex',
            worker: 'ollama-fixture-helper',
            reviewer: 'codex',
          },
        },
      },
      { id: 'concurrent-setup', fingerprint: 'concurrent-setup' },
    );
    await dialog.getByRole('button', { name: 'Save team profile', exact: true }).click();
    await dialog
      .getByText(
        'Resource settings changed elsewhere. Cancel, refresh, then create the profile again.',
        { exact: true },
      )
      .waitFor();
    await expect(dialog.getByRole('textbox', { name: 'Profile name', exact: true })).toHaveValue(
      'Helper team',
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('[data-pending-profile="concurrent-team"]').waitFor();
    await modelHelper.getByRole('button', { name: 'Use in team', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Profile ID', exact: true }).fill('helper-team');
    await dialog.getByRole('textbox', { name: 'Profile name', exact: true }).fill('Helper team');
    await dialog.getByRole('textbox', { name: 'Data policy', exact: true }).click();
    await page.getByRole('option', { name: 'Local only', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save team profile', exact: true }).click();
    await dialog
      .getByText('A local-only execution profile cannot include remote model runtimes.', {
        exact: true,
      })
      .waitFor();
    for (const label of ['Coordinator model', 'Reviewer model']) {
      await dialog.getByRole('textbox', { name: label, exact: true }).click();
      await page.getByRole('option', { name: 'fixture-coder · local-coder', exact: true }).click();
    }
    await dialog.getByRole('textbox', { name: 'Allowed worker models', exact: true }).click();
    await page.getByRole('option', { name: 'Codex · codex', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Allowed worker models', exact: true }).click();
    await page.getByRole('option', { name: 'fixture-coder · local-coder', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Profile name', exact: true }).click();
    failSetupSave = true;
    await dialog.getByRole('button', { name: 'Save team profile', exact: true }).click();
    await dialog.getByText('Fixture team save unavailable', { exact: true }).waitFor();
    await expect(dialog.getByRole('textbox', { name: 'Profile name', exact: true })).toHaveValue(
      'Helper team',
    );
    failSetupSave = false;
    await page.screenshot({ path: 'artifacts/model-team-setup.png', fullPage: true });
    await dialog.getByRole('button', { name: 'Save team profile', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page
      .locator('[data-pending-profile="helper-team"]')
      .getByText('Restart required', { exact: true })
      .waitFor();
    const configuredTeam = await privateFiles.load('resources');
    const helperRuntime = configuredTeam.runtimes.find(
      (runtime) => runtime.config.model === 'fixture-helper',
    );
    assert.equal(helperRuntime.config.connectionId, 'ollama');
    assert.equal(
      helperRuntime.id,
      'ollama-fixture-helper-2',
      'Generated runtime ID avoids a saved pending collision',
    );
    assert.equal(helperRuntime.config.limits.contextTokens, 32768);
    assert.equal(helperRuntime.config.limits.maxOutputTokens, 4096);
    assert.equal(configuredTeam.defaultProfile, 'codex');
    assert.ok(
      configuredTeam.runtimes.some(
        (runtime) => runtime.id === 'codex' && runtime.backend === 'codex',
      ),
    );
    assert.deepEqual(
      configuredTeam.profiles.find((profile) => profile.id === 'helper-team').workerPool.sort(),
      [helperRuntime.id, 'local-coder'].sort(),
    );
    assert.equal(
      (await catalogHandler({})).profiles.some((profile) => profile.id === 'helper-team'),
      false,
    );
    assert.equal(
      generations,
      2,
      'Opening, validation, conflicts and saving a team do not generate responses',
    );

    // Reusing an active model adds only a profile, never another runtime definition.
    const runtimeCountBeforeReuse = (await privateFiles.load('resources')).runtimes.length;
    await ollama
      .locator('[data-model-id="fixture-coder"]')
      .getByRole('button', { name: 'Use in team', exact: true })
      .click();
    await dialog.getByText('Existing model configuration', { exact: true }).waitFor();
    await dialog.getByRole('textbox', { name: 'Profile ID', exact: true }).fill('reuse-team');
    await dialog
      .getByRole('textbox', { name: 'Profile name', exact: true })
      .fill('Reused model team');
    await dialog.getByRole('button', { name: 'Save team profile', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await privateFiles.load('resources')).runtimes.length, runtimeCountBeforeReuse);
    assert.equal(
      (await privateFiles.load('resources')).profiles.find((item) => item.id === 'reuse-team')
        .worker,
      'local-coder',
    );
    // Unsupported cloud tags offer no server template, and manual setup is rejected too.
    await expect(
      ollama
        .locator('[data-model-id="fixture:cloud"]')
        .getByRole('button', { name: 'Use in team', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Add execution backend', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Backend implementation', exact: true }).click();
    await page.getByRole('option', { name: 'Buro agent', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'API connection', exact: true }).click();
    await page.getByRole('option', { name: 'ollama', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Model name', exact: true }).fill('fixture:cloud');
    await dialog.getByRole('textbox', { name: 'Data policy', exact: true }).click();
    await page.getByRole('option', { name: 'Local only', exact: true }).click();
    for (const label of ['Coordinator model', 'Reviewer model']) {
      await dialog.getByRole('textbox', { name: label, exact: true }).click();
      await page.getByRole('option', { name: 'fixture-coder · local-coder', exact: true }).click();
    }
    await dialog.getByRole('textbox', { name: 'Allowed worker models', exact: true }).click();
    await page.getByRole('option', { name: 'Codex · codex', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Profile name', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save team profile', exact: true }).click();
    await dialog
      .getByText('Cloud-backed Ollama models are not supported by this provider.', {
        exact: true,
      })
      .waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(
      (await privateFiles.load('resources')).runtimes.some(
        (runtime) => runtime.config.model === 'fixture:cloud',
      ),
      false,
    );

    // API settings only persist a pending configuration. They never contact a provider.
    const beforeConnections = await privateFiles.load('resources');
    const activeWorker = structuredClone(
      host.ctx.agentRuntime.selection.forProject('codex-panel').worker,
    );
    await page.getByRole('button', { name: 'User settings', exact: true }).click();
    if (!(await page.getByRole('button', { name: 'Add API connection', exact: true }).isVisible()))
      await showConnections(page);
    await page.getByRole('button', { name: 'Add API connection', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'API provider', exact: true }).click();
    await page.getByRole('option', { name: 'Ollama', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Connection ID', exact: true }).fill('rtx-fixture');
    await dialog
      .getByRole('textbox', { name: 'API base URL', exact: true })
      .fill('file:///tmp/model');
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Enter an HTTP or HTTPS API URL' }).waitFor();
    assert.deepEqual(
      (await privateFiles.load('resources')).connections,
      beforeConnections.connections,
    );
    await dialog
      .getByRole('textbox', { name: 'API base URL', exact: true })
      .fill('http://192.168.1.10:11434');
    await dialog.getByRole('textbox', { name: 'Server location', exact: true }).click();
    await page.getByRole('option', { name: 'My server · private network', exact: true }).click();
    await dialog.getByRole('button', { name: 'Advanced connection settings', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Concurrent model requests', exact: true }).fill('2');
    await dialog.getByRole('textbox', { name: 'Model reasoning', exact: true }).click();
    await page.getByRole('option', { name: 'Disabled', exact: true }).click();
    failConnectionSave = true;
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await dialog.getByText('Fixture connection save unavailable', { exact: true }).waitFor();
    await expect(dialog.getByRole('textbox', { name: 'Connection ID', exact: true })).toHaveValue(
      'rtx-fixture',
    );
    failConnectionSave = false;
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const newConnection = page.locator('[data-connection-id="rtx-fixture"]');
    await newConnection.getByText('Restart required', { exact: true }).waitFor();
    await expect(
      newConnection.getByRole('button', { name: 'Available models', exact: true }),
    ).toBeDisabled();
    const persistedNew = (await privateFiles.load('resources')).connections.find(
      (connection) => connection.id === 'rtx-fixture',
    );
    assert.equal(persistedNew.config.endpoint, 'http://192.168.1.10:11434');
    assert.equal(persistedNew.config.trust, 'private-network');
    assert.equal(persistedNew.config.capacity, 2);
    assert.equal(persistedNew.config.think, false);
    await expect(
      ollama.getByRole('button', { name: 'Available models', exact: true }),
    ).toBeEnabled();
    // Keep the revision from opening the form, even if another writer saves while it is open.
    await page.getByRole('button', { name: 'Edit connection ollama', exact: true }).click();
    await expect(
      dialog.getByRole('textbox', { name: 'Connection ID', exact: true }),
    ).toBeDisabled();
    await expect(dialog.getByRole('textbox', { name: 'API provider', exact: true })).toBeDisabled();
    await dialog
      .getByRole('textbox', { name: 'API base URL', exact: true })
      .fill('http://192.168.1.20:11434');
    const catalogBeforeConcurrentEdit = await catalogHandler({});
    const originalOllama = (await privateFiles.load('resources')).connections.find(
      (connection) => connection.id === 'ollama',
    );
    await host.ctx.commands.bus.execute(
      {
        method: 'resources.connection.save',
        params: {
          connection: { ...originalOllama, config: { ...originalOllama.config, capacity: 3 } },
          expectedRevision: catalogBeforeConcurrentEdit.connections.find(
            (connection) => connection.id === 'ollama',
          ).revision,
        },
      },
      { id: 'ui-concurrent-save', fingerprint: 'ui-concurrent-save' },
    );
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await dialog
      .getByText(
        'This connection changed elsewhere. Cancel, refresh, then edit the latest settings.',
        { exact: true },
      )
      .waitFor();
    assert.equal(
      (await privateFiles.load('resources')).connections.find(
        (connection) => connection.id === 'ollama',
      ).config.endpoint,
      originalOllama.config.endpoint,
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await ollama.getByText('Restart required', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit connection ollama', exact: true }).click();
    await dialog
      .getByRole('textbox', { name: 'API base URL', exact: true })
      .fill('http://192.168.1.20:11434');
    await dialog.getByRole('textbox', { name: 'Server location', exact: true }).click();
    await page.getByRole('option', { name: 'My server · private network', exact: true }).click();
    await dialog.getByRole('button', { name: 'Advanced connection settings', exact: true }).click();
    await expect(
      dialog.getByRole('textbox', { name: 'Concurrent model requests', exact: true }),
    ).toHaveValue('3');
    await expect(dialog.getByRole('textbox', { name: 'Reasoning value', exact: true })).toHaveValue(
      'high',
    );
    const saveButtonBox = await dialog
      .getByRole('button', { name: 'Save connection', exact: true })
      .boundingBox();
    assert.ok(saveButtonBox.height >= 44, 'Connection actions must have usable hit targets');
    await page.screenshot({ path: 'artifacts/api-connection-editor.png', fullPage: true });
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await ollama.getByText('Active API: http://127.0.0.1:11434/', { exact: true }).waitFor();
    await expect(
      ollama.getByRole('button', { name: 'Available models', exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Check model', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Edit connection deepseek', exact: true }).click();
    await dialog
      .getByRole('textbox', { name: 'API base URL', exact: true })
      .fill('http://models.example.org');
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await dialog.getByText('Remote DeepSeek endpoints require HTTPS.', { exact: true }).waitFor();
    assert.equal(
      (await privateFiles.load('resources')).connections.find(
        (connection) => connection.id === 'deepseek',
      ).config.endpoint,
      'https://api.deepseek.com',
    );
    await dialog
      .getByRole('textbox', { name: 'API base URL', exact: true })
      .fill('https://api.deepseek.com');
    await expect(
      dialog.getByRole('textbox', { name: 'API key environment variable', exact: true }),
    ).toHaveValue('BURO_UI_FAKE_MISSING_KEY');
    assert.equal(
      await dialog.locator('input[type="password"]').count(),
      0,
      'API setup never accepts plaintext keys',
    );
    await dialog
      .getByRole('textbox', { name: 'API key environment variable', exact: true })
      .fill('BURO_UI_OTHER_KEY');
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const afterConnections = await privateFiles.load('resources');
    const savedOllama = afterConnections.connections.find(
      (connection) => connection.id === 'ollama',
    );
    assert.equal(savedOllama.config.endpoint, 'http://192.168.1.20:11434');
    assert.equal(savedOllama.config.trust, 'private-network');
    assert.equal(savedOllama.config.capacity, 3);
    assert.equal(savedOllama.config.think, 'high');
    const savedDeepSeek = afterConnections.connections.find(
      (connection) => connection.id === 'deepseek',
    );
    assert.equal(savedDeepSeek.config.apiKeyEnv, 'BURO_UI_OTHER_KEY');
    assert.equal(savedDeepSeek.config.capacity, 3);
    assert.equal(savedDeepSeek.config.thinking, 'enabled');
    assert.deepEqual(afterConnections.runtimes, beforeConnections.runtimes);
    assert.deepEqual(afterConnections.profiles, beforeConnections.profiles);
    assert.equal(afterConnections.defaultProfile, beforeConnections.defaultProfile);
    assert.deepEqual(
      (await catalogHandler({})).runtimes.find((runtime) => runtime.id === activeWorker.id),
      activeWorker,
      'Saving connections cannot hot-swap active resources',
    );
    await page.reload();
    await page.getByRole('button', { name: 'User settings', exact: true }).click();
    await showConnections(page);
    await ollama.getByText('http://192.168.1.20:11434/', { exact: true }).waitFor();
    await ollama.getByText('Restart required', { exact: true }).waitFor();
    await expect(
      ollama.getByRole('button', { name: 'Available models', exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Check model', exact: true })).toBeDisabled();
    assert.equal(modelsRequested, 2, 'Connection edits never perform model discovery');
    assert.equal(generations, 2, 'Connection edits never perform inference');
    // A real fresh host activates saved definitions; selecting the profile remains explicit.
    await host.dispose();
    host = await createHost({
      projects: [
        {
          storageAddress: path.join(root, 'project'),
          project: { id: 'codex-panel', name: 'Resource settings fixture', root, managed: true },
        },
      ],
    });
    await host.ctx.plugin(projectManagementPlugin, {
      catalogFile: path.join(root, 'linked-projects.json'),
      policies: {},
      workspaces: new GitWorkspaces(host.ctx.projects.registry),
      checks: {
        async run() {
          throw Error('Settings cannot run checks');
        },
      },
    });
    await host.ctx.plugin(resourcesPlugin, {
      directory: root,
      executors: new EnvironmentExecutors(),
      fetch: async (url) => {
        if (new URL(String(url)).pathname === '/api/tags') {
          modelsRequested++;
          return Response.json({ models: [{ name: 'fresh-before-edit' }] });
        }
        throw Error('Restart or profile selection cannot contact providers');
      },
    });
    await host.ctx.plugin(websocketPlugin, {
      port: 0,
      onListen: (value) => {
        port = value;
      },
    });
    await page.goto(base + '?daemon=' + encodeURIComponent('ws://127.0.0.1:' + port));
    await page.getByRole('button', { name: 'User settings', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: 'Default execution profile', exact: true }),
    ).toHaveValue('Codex');
    await page.getByRole('textbox', { name: 'Default execution profile', exact: true }).click();
    await page.getByRole('option', { name: 'Helper team', exact: true }).click();
    await page.getByText('Local only', { exact: true }).waitFor();
    assert.equal((await privateFiles.load('resources')).defaultProfile, 'helper-team');
    assert.equal(
      host.ctx.projects.registry.get('codex-panel').snapshot().profile.resourceProfile,
      'local',
      'Project overrides survive machine setup and restart',
    );
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await page.getByRole('textbox', { name: 'Execution profile', exact: true }).click();
    await page.getByRole('option', { name: 'Helper team', exact: true }).click();
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByText('Settings saved', { exact: true }).waitFor();
    await page.locator('.sidebar').getByRole('button', { name: 'Team', exact: true }).click();
    await page.getByRole('button', { name: 'Edit role legacy_worker', exact: true }).click();
    await dialog.getByText('Prefer', { exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Model from project pool', exact: true }).click();
    await page
      .getByRole('option', { name: 'fixture-helper · ollama-fixture-helper-2', exact: true })
      .waitFor();
    await page.keyboard.press('Escape');
    await dialog.locator('.mantine-Modal-close').click();
    assert.deepEqual(
      host.ctx.projects.registry.get('codex-panel').snapshot().profile.managedBudget,
      profile.managedBudget,
    );
    assert.equal(
      generations,
      2,
      'Activation, profile selection and role editing do not generate responses',
    );

    // Keep the same settings component mounted across a real service reconnect.
    await page.getByRole('button', { name: 'User settings', exact: true }).click();
    await showConnections(page);
    await ollama.getByRole('button', { name: 'Available models', exact: true }).click();
    await ollama.locator('[data-model-id="fresh-before-edit"]').waitFor();
    await ollama
      .locator('[data-model-id="fresh-before-edit"]')
      .getByRole('button', { name: 'Use in team', exact: true })
      .click();
    await dialog.getByRole('textbox', { name: 'Profile ID', exact: true }).fill('reconnect-team');
    await dialog.getByRole('textbox', { name: 'Profile name', exact: true }).fill('Reconnect team');
    await dialog.getByRole('button', { name: 'Save team profile', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page
      .getByRole('status')
      .filter({ hasText: 'Team profile saved. Restart the service, then select it explicitly.' })
      .waitFor();

    const discoveryBeforeExternalEdit = modelsRequested;
    const liveCatalog = await host.ctx.commands.bus.execute(
      { method: 'resources.list', params: {} },
      { id: 'discovery-revision-catalog', fingerprint: 'discovery-revision-catalog' },
    );
    const configuredOllama = (await privateFiles.load('resources')).connections.find(
      (connection) => connection.id === 'ollama',
    );
    await host.ctx.commands.bus.execute(
      {
        method: 'resources.connection.save',
        params: {
          connection: { ...configuredOllama, config: { ...configuredOllama.config, capacity: 4 } },
          expectedRevision: liveCatalog.connections.find((connection) => connection.id === 'ollama')
            .revision,
        },
      },
      { id: 'external-discovery-revision-edit', fingerprint: 'external-discovery-revision-edit' },
    );
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await ollama.getByText('Restart required', { exact: true }).waitFor();
    assert.equal(await ollama.locator('[data-model-id="fresh-before-edit"]').count(), 0);
    const reconnectPort = port;
    await host.dispose();
    host = await createHost({
      projects: [
        {
          storageAddress: path.join(root, 'project'),
          project: { id: 'codex-panel', name: 'Resource settings fixture', root, managed: true },
        },
      ],
    });
    await host.ctx.plugin(resourcesPlugin, {
      directory: root,
      executors: new EnvironmentExecutors(),
      fetch: async (url) => {
        if (new URL(String(url)).pathname === '/api/tags') {
          modelsRequested++;
          return Response.json({ models: [{ name: 'fresh-after-edit' }] });
        }
        throw Error('Metadata reconnect must not run model inference');
      },
    });
    await host.ctx.plugin(websocketPlugin, {
      port: reconnectPort,
      onListen: (value) => {
        port = value;
      },
    });
    await expect(
      page.getByRole('textbox', { name: 'Default execution profile', exact: true }),
    ).toHaveValue('Helper team', { timeout: 15000 });
    if (!(await ollama.getByRole('button', { name: 'Available models', exact: true }).isVisible()))
      await showConnections(page);
    await expect(
      ollama.getByRole('button', { name: 'Available models', exact: true }),
    ).toBeEnabled();
    await expect(ollama.getByText('Restart required', { exact: true })).toHaveCount(0);
    assert.equal(
      modelsRequested,
      discoveryBeforeExternalEdit,
      'Reconnect never implicitly discovers models',
    );
    await page
      .getByRole('status')
      .filter({ hasText: 'Team profile ready. Select it explicitly to use it for new runs.' })
      .waitFor();
    assert.equal(
      await page
        .getByRole('status')
        .filter({ hasText: 'Team profile saved. Restart the service, then select it explicitly.' })
        .count(),
      0,
    );
    await page.getByRole('textbox', { name: 'Default execution profile', exact: true }).click();
    await page.getByRole('option', { name: 'Reconnect team', exact: true }).waitFor();
    await page.keyboard.press('Escape');

    assert.equal(
      await ollama.locator('[data-model-id="fresh-before-edit"]').count(),
      0,
      'A model list from the old connection revision cannot reappear after restart',
    );
    await ollama.getByRole('button', { name: 'Available models', exact: true }).click();
    await ollama.locator('[data-model-id="fresh-after-edit"]').waitFor();
    assert.equal(modelsRequested, discoveryBeforeExternalEdit + 1);
    assert.equal(generations, 2);

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
          roleModes,
          projectPoolFiltered: true,
          legacyModelPreserved: true,
          instructionsPreserved: true,
          unavailableRuntimeVisible: true,
          coordinatorRolePreferencesAvailable: true,
          apiConnectionsPersisted: true,
          pendingConnectionsDisabled: true,
          invalidEndpointRejected: true,
          remoteDeepSeekHttpRejected: true,
          staleConnectionEditRejected: true,
          activeResourcesUnchanged: true,
          modelTeamWizard: true,
          setupStaleRevisionRejected: true,
          setupLocalOnlyRejectsNative: true,
          setupLocalOnlyRejectsCloud: true,
          setupRuntimeIdsAvoidPendingCollision: true,
          setupReusesExistingModel: true,
          setupDefaultPreserved: true,
          setupActivatedAfterRestart: true,
          configuredModelAvailableInProjectPool: true,
          discoveryBoundToConnectionRevision: true,
          reconnectRequiresExplicitRediscovery: true,
          setupStatusUpdatesAfterReconnect: true,
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
