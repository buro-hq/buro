const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
(async () => {
  const { z } = await import('zod');
  const { createServer } = await import('vite');
  const { createHost } = await import('../plugins/host.ts');
  const { resourcesPlugin } = await import('../plugins/resources.ts');
  const { websocketPlugin } = await import('../daemon/websocket.ts');
  const { EnvironmentExecutors } = await import('../adapters/environments/executors.ts');
  const { PrivateJSONFiles } = await import('../adapters/files/private-json.ts');
  const { ProjectProfileSchema } = await import('../protocol/projects.ts');
  const { fixtureCapabilities } = await import('../tests/fixtures/backend-capabilities.ts');
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-live-resource-ui-')),
  );
  let host, vite, browser;
  let models = 0,
    network = 0,
    holdCatalog = false,
    heldId;
  const captured = deferred(),
    release = deferred(),
    delivered = deferred();
  const errors = [];
  try {
    const files = new PrivateJSONFiles(path.join(root, 'local'));
    const team = (id, name, extra) => ({
      id,
      name,
      policy: 'local-only',
      coordinator: 'writer',
      worker: 'writer',
      reviewer: 'reader',
      workerPool: extra ? ['writer', 'extra'] : ['writer'],
    });
    await files.save('resources', {
      version: 1,
      defaultProfile: 'team-one',
      connections: [{ id: 'fixture', provider: 'ui-provider', config: { name: 'Local fixture' } }],
      runtimes: ['writer', 'reader', 'extra'].map((variant) => ({
        id: variant,
        backend: 'ui-backend',
        config: { connectionId: 'fixture', variant },
      })),
      profiles: [team('team-one', 'Team one', true), team('team-two', 'Team two', false)],
    });
    const profile = ProjectProfileSchema.parse({
      version: 1,
      revision: 1,
      context: '',
      scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: [] },
      checks: [],
      defaultCheckIds: [],
      setup: [],
      dependencies: 'none',
      maxWorkers: 1,
      maxRepairs: 0,
      turnTimeoutMs: 10000,
      delivery: {
        remote: 'origin',
        pullRequests: false,
        environments: [
          {
            id: 'staging',
            name: 'Staging',
            enabled: true,
            command: 'echo fixture',
            url: '',
            requireConfirmation: false,
            roleId: 'flexible',
          },
        ],
      },
    });
    const role = {
      id: 'flexible',
      version: 1,
      title: 'Flexible specialist',
      description: 'Implementation and deployment preparation',
      instructions: 'Use the assigned operation without external side effects.',
      kind: 'general',
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
    };
    host = await createHost({
      projects: ['a', 'b'].map((id) => ({
        storageAddress: path.join(root, id),
        project: {
          id,
          name: 'Project ' + id.toUpperCase(),
          root: path.join(root, id),
          managed: true,
        },
        profile,
        roles: [role],
      })),
    });
    await host.ctx.plugin({
      name: 'live-controls-fixtures',
      inject: ['resourceContributions'],
      apply(ctx) {
        const providerConfig = z.strictObject({ name: z.string().min(1) });
        const backendConfig = z.strictObject({
          connectionId: z.string().min(1),
          variant: z.enum(['writer', 'reader', 'extra']),
        });
        ctx.resourceContributions.catalog.registerProvider({
          id: 'ui-provider',
          label: 'UI Fixture Provider',
          revision: 'ui-provider-v1',
          defaultConfig: { name: 'Local fixture' },
          parse: (config) => providerConfig.parse(config),
          describe: () => ({
            local: true,
            capacityKey: 'ui-provider',
            capacity: 1,
            credentialReferences: [],
            modelListing: false,
          }),
          create: ({ id }) => ({
            provider: {
              id,
              revision: 'ui-instance-v1',
              local: true,
              complete: async () => {
                models++;
                throw Error('No model requests');
              },
            },
          }),
        });
        ctx.resourceContributions.catalog.registerBackend({
          id: 'ui-backend',
          label: 'UI Fixture Backend',
          revision: 'ui-backend-v1',
          defaultConfig: { connectionId: 'fixture', variant: 'writer' },
          parse: (config) => backendConfig.parse(config),
          dependencies: (config) => [config.connectionId],
          describe: () => ({ local: true }),
          create: ({ id, config }) => ({
            revision: 'ui-host-v1',
            providerId: config.connectionId,
            model:
              config.variant === 'reader'
                ? 'Reader model'
                : config.variant === 'writer'
                  ? 'Writer model'
                  : 'Extra model',
            local: true,
            runtime: {
              id,
              capabilities: fixtureCapabilities({
                structuredTurns: true,
                toolsFreeTurns: true,
                readOnlySessions: config.variant === 'reader',
                immutableReview: config.variant === 'reader',
                strictPlannedWrites: config.variant !== 'reader',
              }),
              start: async () => {
                models++;
                throw Error('No start');
              },
              submit: async () => {
                models++;
                throw Error('No submit');
              },
              turn: async () => {
                models++;
                throw Error('No turn');
              },
              interrupt: async () => {},
              dispose: async () => {},
            },
          }),
        });
      },
    });
    await host.ctx.plugin(resourcesPlugin, {
      directory: root,
      executors: new EnvironmentExecutors(undefined, path.join(root, 'private-home')),
      credentials: () => undefined,
      fetch: async () => {
        network++;
        throw Error('No provider traffic');
      },
    });
    const original = host.ctx.commands.bus.handlers.get('resources.list');
    host.ctx.commands.bus.handlers.set('resources.list', async (params, meta) => {
      const result = await original(params, meta);
      if (holdCatalog && params.projectId === 'b') {
        holdCatalog = false;
        heldId = meta.id;
        captured.resolve();
        await release.promise;
      }
      return result;
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
    const a = await browser.newPage({ viewport: { width: 1440, height: 1040 } }),
      b = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
    for (const page of [a, b]) page.on('pageerror', (error) => errors.push(error.message));
    b.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          if (frame.type === 'response' && frame.id === heldId) delivered.resolve();
        } catch {}
      }),
    );
    const address = vite.httpServer.address();
    const base = `http://127.0.0.1:${address.port}/?daemon=${encodeURIComponent(`ws://127.0.0.1:${port}`)}`;
    await Promise.all([a.goto(base + '&project=a'), b.goto(base + '&project=b')]);
    for (const page of [a, b])
      await page.getByRole('button', { name: 'User settings', exact: true }).click();
    const defaultField = (page) =>
      page.getByRole('textbox', { name: 'Default execution profile', exact: true });
    await expect(defaultField(b)).toHaveValue('Team one');
    const sequenceA = host.ctx.projects.registry.get('a').snapshot().sequence,
      sequenceB = host.ctx.projects.registry.get('b').snapshot().sequence;
    async function selectDefault(label, verifyOtherPage = true) {
      await defaultField(a).click();
      await a.getByRole('option', { name: label, exact: true }).click();
      await expect(defaultField(verifyOtherPage ? b : a)).toHaveValue(label);
    }
    await selectDefault('Team two');
    await selectDefault('Team one');
    holdCatalog = true;
    await b.locator('.sidebar').getByRole('button', { name: 'Team', exact: true }).click();
    await captured.promise;
    await b.getByRole('button', { name: 'Edit role flexible', exact: true }).click();
    await selectDefault('Team two', false);
    const dialog = b.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Used for', exact: true }).click();
    await b.getByRole('option', { name: 'Implement changes', exact: true }).click();
    await dialog.getByText('Prefer', { exact: true }).click();
    const choice = dialog.getByRole('textbox', { name: 'Model from project pool', exact: true });
    await choice.click();
    await expect(
      b.getByRole('option', { name: 'Writer model · writer', exact: true }),
    ).toBeVisible();
    await expect(
      b.getByRole('option').filter({ hasText: /^Reader model · reader · Unavailable/ }),
    ).toHaveAttribute('data-combobox-disabled', 'true');
    assert.equal(
      (await b.getByRole('option').allTextContents()).some((label) =>
        label.includes('Extra model'),
      ),
      false,
    );
    release.resolve();
    await delivered.promise;
    await b.evaluate(() => Promise.resolve());
    assert.equal(
      (await b.getByRole('option').allTextContents()).some((label) =>
        label.includes('Extra model'),
      ),
      false,
      'A held catalog cannot restore a removed pool member after invalidation.',
    );
    await b.keyboard.press('Escape');
    await dialog.getByRole('textbox', { name: 'Used for', exact: true }).click();
    await b.getByRole('option', { name: 'Prepare deployment: Staging', exact: true }).click();
    await choice.click();
    await expect(
      b.getByRole('option').filter({ hasText: /^Writer model · writer · Unavailable/ }),
    ).toHaveAttribute('data-combobox-disabled', 'true');
    await b.getByRole('option', { name: 'Reader model · reader', exact: true }).click();
    await expect(dialog.getByText(/Implement changes:/)).toBeVisible();
    await fs.mkdir('artifacts', { recursive: true });
    await b.screenshot({ path: 'artifacts/operation-role-controls.png', fullPage: true });
    await dialog.getByRole('button', { name: 'Save version 2', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    assert.deepEqual(
      host.ctx.projects.registry
        .get('b')
        .snapshot()
        .roles.find((item) => item.id === 'flexible').runtimePreference,
      { mode: 'prefer', runtimeId: 'reader' },
    );
    await b.getByRole('button', { name: 'User settings', exact: true }).click();
    for (const page of [a, b])
      await page.getByRole('button', { name: 'Models and connections', exact: true }).click();
    await a.getByRole('button', { name: 'Edit connection fixture', exact: true }).click();
    const editor = a.getByRole('dialog');
    await editor
      .getByRole('textbox', { name: 'Provider configuration (JSON)', exact: true })
      .fill('{"name":"Updated fixture"}');
    await editor.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(editor).not.toBeVisible();
    await expect(b.locator('[data-connection-id="fixture"]')).toContainText('Restart required');
    assert.equal(host.ctx.projects.registry.get('a').snapshot().sequence, sequenceA);
    assert.equal(
      host.ctx.projects.registry.get('b').snapshot().sequence,
      sequenceB + 1,
      'Only the explicit role save changes project history.',
    );
    assert.equal(models, 0);
    assert.equal(network, 0);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        twoProjectsLiveDefaults: true,
        heldCatalogDiscarded: true,
        customDeliveryOperation: true,
        operationEligibilityVisible: true,
        globalRolePreferencePreserved: true,
        liveConnectionSave: true,
        projectSequencesPreserved: true,
        models: 0,
        network: 0,
        errors: 0,
        screenshot: 'artifacts/operation-role-controls.png',
      }),
    );
  } finally {
    release.resolve();
    await browser?.close();
    await vite?.close();
    await host?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
