const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const execute = require('node:util').promisify(require('node:child_process').execFile);

(async () => {
  const { z } = await import('zod');
  const { createServer } = await import('vite');
  const { createHost } = await import('../plugins/host.ts');
  const { websocketPlugin } = await import('../daemon/websocket.ts');
  const { resourcesPlugin } = await import('../plugins/resources.ts');
  const { EnvironmentExecutors } = await import('../adapters/environments/executors.ts');
  const { PrivateJSONFiles } = await import('../adapters/files/private-json.ts');
  const { fixtureCapabilities } = await import('../tests/fixtures/backend-capabilities.ts');
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-contribution-ui-')),
  );
  let host, vite, browser;
  let modelCalls = 0,
    networkCalls = 0,
    listings = 0,
    providerDisposals = 0,
    backendDisposals = 0;
  const errors = [],
    externalRequests = [];
  try {
    const files = new PrivateJSONFiles(path.join(directory, 'local'));
    await files.save('resources', {
      version: 1,
      defaultProfile: 'fixture-team',
      connections: [
        {
          id: 'fixture',
          provider: 'fixture-provider',
          config: { endpoint: 'http://127.0.0.1:19999', region: 'office' },
        },
      ],
      runtimes: [
        {
          id: 'fixture-agent',
          backend: 'fixture-backend',
          config: { connectionId: 'fixture', model: 'initial-model', note: 'initial' },
        },
      ],
      profiles: [
        {
          id: 'fixture-team',
          name: 'Fixture team',
          policy: 'local-only',
          coordinator: 'fixture-agent',
          worker: 'fixture-agent',
          reviewer: 'fixture-agent',
        },
      ],
    });
    host = await createHost();
    const providerConfig = z.strictObject({
      endpoint: z.string().min(1),
      region: z.string().min(1),
    });
    const backendConfig = z.strictObject({
      connectionId: z.string().min(1),
      model: z.string().min(1),
      note: z.string(),
    });
    await host.ctx.plugin({
      name: 'fixture-contributions',
      inject: ['resourceContributions'],
      apply(ctx) {
        ctx.resourceContributions.catalog.registerProvider({
          id: 'fixture-provider',
          label: 'Fixture Provider',
          revision: 'fixture-provider-v1',
          defaultConfig: { endpoint: 'http://127.0.0.1:19999', region: 'office' },
          parse: (config) => providerConfig.parse(config),
          describe: (config) => ({
            local: true,
            endpoint: config.endpoint,
            capacityKey: 'fixture:' + config.endpoint,
            capacity: 1,
            credentialReferences: [],
            modelListing: true,
          }),
          create: ({ id }) => ({
            provider: {
              id,
              revision: 'fixture-instance-v1',
              local: true,
              complete: async () => {
                modelCalls++;
                throw Error('Models must not run during settings');
              },
            },
            listModels: async () => {
              listings++;
              return [{ id: 'fixture-model' }];
            },
            dispose: async () => {
              providerDisposals++;
            },
          }),
        });
        ctx.resourceContributions.catalog.registerBackend({
          id: 'fixture-backend',
          label: 'Fixture Backend',
          revision: 'fixture-backend-v1',
          defaultConfig: { connectionId: 'fixture', model: 'manual-model', note: 'from-default' },
          parse: (config) => backendConfig.parse(config),
          dependencies: (config) => [config.connectionId],
          describe: () => ({ local: true }),
          template: (connection, model) => ({
            label: 'Fixture Backend',
            config: { connectionId: connection.id, model, note: 'server-template' },
            local: true,
          }),
          create: ({ id, config }) => ({
            revision: 'fixture-host-v1',
            local: true,
            providerId: config.connectionId,
            model: config.model,
            runtime: {
              id,
              capabilities: fixtureCapabilities(),
              start: async () => {
                modelCalls++;
                throw Error('No start');
              },
              submit: async () => {
                modelCalls++;
                throw Error('No submit');
              },
              interrupt: async () => {},
              dispose: async () => {
                backendDisposals++;
              },
            },
          }),
        });
      },
    });
    await host.ctx.plugin(resourcesPlugin, {
      directory,
      executors: new EnvironmentExecutors(undefined, path.join(directory, 'private-home')),
      credentials: () => undefined,
      fetch: async () => {
        networkCalls++;
        throw Error('No provider network');
      },
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
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname))
        externalRequests.push(request.url());
    });
    const address = vite.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/?daemon=${encodeURIComponent(`ws://127.0.0.1:${port}`)}`,
    );
    await page.getByRole('button', { name: 'Configure models', exact: true }).click();
    await page.getByRole('button', { name: 'Models and connections', exact: true }).click();
    await expect(page.getByText('fixture · Fixture Provider', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add API connection', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Connection ID', exact: true }).fill('extra-fixture');
    await dialog.getByRole('textbox', { name: 'API provider', exact: true }).click();
    await page.getByRole('option', { name: 'Fixture Provider', exact: true }).click();
    await dialog
      .getByRole('textbox', { name: 'Provider configuration (JSON)', exact: true })
      .fill('{"endpoint":"http://127.0.0.1:19998","region":"second-office"}');
    await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('[data-connection-id="extra-fixture"]')).toContainText(
      'Restart required',
    );
    let saved = await files.load('resources');
    assert.deepEqual(
      saved.connections.find((connection) => connection.id === 'extra-fixture'),
      {
        id: 'extra-fixture',
        provider: 'fixture-provider',
        config: { endpoint: 'http://127.0.0.1:19998', region: 'second-office' },
      },
    );
    await page.getByRole('button', { name: 'Add execution backend', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Backend implementation', exact: true }).click();
    await page.getByRole('option', { name: 'Fixture Backend', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Runtime ID', exact: true }).fill('custom-agent');
    await dialog.getByRole('textbox', { name: 'Profile ID', exact: true }).fill('custom-team');
    await dialog.getByRole('textbox', { name: 'Profile name', exact: true }).fill('Custom team');
    await dialog
      .getByRole('textbox', { name: 'Backend configuration (JSON)', exact: true })
      .fill('{"connectionId":"fixture","model":"manual-model","note":"configured-through-ui"}');
    await fs.mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/contribution-settings.png', fullPage: true });
    await dialog.getByRole('button', { name: 'Save team profile', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    saved = await files.load('resources');
    assert.deepEqual(
      saved.runtimes.find((runtime) => runtime.id === 'custom-agent'),
      {
        id: 'custom-agent',
        backend: 'fixture-backend',
        config: { connectionId: 'fixture', model: 'manual-model', note: 'configured-through-ui' },
      },
    );
    assert.equal(
      saved.profiles.find((profile) => profile.id === 'custom-team').worker,
      'custom-agent',
    );
    const connection = page.locator('[data-connection-id="fixture"]');
    await connection.getByRole('button', { name: 'Available models', exact: true }).click();
    const model = connection.locator('[data-model-id="fixture-model"]');
    await model.getByRole('button', { name: 'Use in team', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('textbox', { name: 'Backend configuration (JSON)', exact: true }),
    ).toContainText('server-template');
    await dialog.getByRole('button', { name: 'Save team profile', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    saved = await files.load('resources');
    assert.ok(
      saved.runtimes.some(
        (runtime) =>
          runtime.backend === 'fixture-backend' && runtime.config.note === 'server-template',
      ),
    );
    const connectionFile = path.join(directory, 'cli-connection.json');
    await fs.writeFile(
      connectionFile,
      JSON.stringify({
        id: 'cli-fixture',
        provider: 'fixture-provider',
        config: { endpoint: 'http://127.0.0.1:19997', region: 'cli-office' },
      }),
    );
    const cli = await execute(
      process.execPath,
      ['cli/main.ts', 'resources', 'connection-save', connectionFile],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, PROJECT_DAEMON_URL: `ws://127.0.0.1:${port}` },
      },
    );
    assert.equal(cli.stderr, '');
    assert.equal(JSON.parse(cli.stdout).connectionId, 'cli-fixture');
    saved = await files.load('resources');
    assert.equal(
      saved.connections.find((connection) => connection.id === 'cli-fixture').provider,
      'fixture-provider',
    );
    assert.equal(saved.defaultProfile, 'fixture-team');
    assert.equal(listings, 1);
    assert.equal(modelCalls, 0);
    assert.equal(networkCalls, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    await host.dispose();
    host = undefined;
    assert.equal(providerDisposals, 1);
    assert.equal(backendDisposals, 1);
    console.log(
      JSON.stringify({
        thirdProviderConfigured: true,
        thirdBackendConfigured: true,
        serverModelTemplate: true,
        genericCLI: true,
        restartVisible: true,
        defaultPreserved: true,
        models: 0,
        network: 0,
        errors: 0,
        screenshot: 'artifacts/contribution-settings.png',
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
