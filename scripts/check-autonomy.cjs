const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium, expect } = require('@playwright/test');

(async () => {
  const { createServer } = await import('vite');
  const { createHost } = await import('../plugins/host.ts');
  const { websocketPlugin } = await import('../daemon/websocket.ts');
  const { sampleRun } = await import('../tests/fixtures/sample-run.ts');
  const { fixtureCapabilities } = await import('../tests/fixtures/backend-capabilities.ts');
  const { effectiveProjectPolicy, projectRunAutonomy } = await import('../core/autonomy-policy.ts');
  const { roleResourceContext, roleResourceEligibility } = await import('../core/role-routing.ts');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-autonomy-ui-')));
  let host, vite, browser;
  const errors = [],
    commands = [],
    externalRequests = [];
  try {
    const local = {
      id: 'local-fixture',
      client: 'managed',
      providerId: 'fixture',
      model: 'Fixture model',
      configurationRevision: 'local-v1',
      local: true,
      capabilities: fixtureCapabilities({
        structuredTurns: true,
        toolsFreeTurns: true,
        readOnlySessions: true,
        immutableReview: true,
        hostToolLifecycle: true,
        usage: 'reported',
        resumeSessions: true,
        cancellation: 'settled-or-unknown',
      }),
    };
    const unsupported = {
      id: 'unsupported-fixture',
      client: 'codex',
      configurationRevision: 'native-v1',
      local: false,
      capabilities: fixtureCapabilities(),
    };
    const alternate = {
      ...local,
      id: 'alternate-fixture',
      model: 'Alternate model',
      configurationRevision: 'alternate-v1',
    };
    const resources = {
      profileId: 'fixture-team',
      policy: 'hybrid',
      coordinator: local,
      worker: local,
      reviewer: local,
      workerPool: [local, alternate, unsupported],
    };
    const profile = {
      version: 1,
      revision: 4,
      context: '',
      scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['checks/'] },
      checks: [{ id: 'unit', title: 'Unit tests', command: 'node --test', timeoutMs: 10000 }],
      defaultCheckIds: ['unit'],
      setup: [],
      dependencies: 'none',
      maxWorkers: 1,
      maxRepairs: 1,
      turnTimeoutMs: 10000,
    };
    const policy = {
      scope: profile.scope,
      checks: [{ id: 'unit', title: 'Unit tests' }],
      defaultCheckIds: ['unit'],
      maxWorkers: 1,
      maxRepairs: 1,
      turnTimeoutMs: 10000,
      profile,
    };
    const run = {
      ...sampleRun(),
      status: 'needs-attention',
      phase: 'checking',
      workspace: path.join(root, 'workspace'),
      baseCommit: 'a'.repeat(40),
      planSavedAt: 'now',
      executionPolicySnapshot: policy,
      resources,
      checkIds: ['unit'],
    };
    Object.assign(
      run,
      projectRunAutonomy(run, {
        goalExists: true,
        projectBusy: false,
        resumeSupported: true,
        startSupported: true,
        settingsSupported: false,
      }),
    );
    host = await createHost({
      projects: [
        {
          directory: path.join(root, 'state'),
          project: { id: 'autonomy', name: 'Autonomy fixture', root },
          runs: [run],
        },
      ],
    });
    const store = host.ctx.projects.registry.get('autonomy');
    await store.transact('fixture-goal', 'fixture-goal', (draft) => {
      draft.profile = profile;
      const goal = {
        id: run.goalId,
        projectId: 'autonomy',
        title: 'Synthetic goal',
        body: 'Check visible policy and recovery controls.',
        criteria: 'No model requests.',
        status: 'failed',
        createdAt: run.createdAt,
        runId: run.id,
        revision: 1,
      };
      draft.goals.push(goal);
      return { result: goal, change: { type: 'goal.created', goal } };
    });
    host.ctx.commands.bus.register('resources.list', () => {
      const roles = store.snapshot().roles;
      return {
        defaultProfile: resources.profileId,
        profiles: [
          {
            id: resources.profileId,
            name: 'Fixture team',
            policy: 'hybrid',
            coordinator: local.id,
            worker: local.id,
            reviewer: local.id,
            workerPool: [local.id, alternate.id, unsupported.id],
          },
        ],
        runtimes: [local, alternate, unsupported],
        connections: [],
        probes: [],
        selected: resources,
        probeRuntimeIds: [],
        roleChoices: [...roles, { id: '*' }].map((role) => ({
          roleId: role.id,
          ...(role.version ? { roleVersion: role.version } : {}),
          ...roleResourceContext(role.id, false),
          choices: roleResourceEligibility(
            resources,
            roleResourceContext(role.id, false).requirements,
          ),
        })),
      };
    });
    host.ctx.commands.bus.register('run.resume', (params) => {
      commands.push(structuredClone(params));
      return { runId: run.id };
    });
    host.ctx.commands.bus.register('run.start', () => {
      throw Error('This browser test must not start model work.');
    });
    host.ctx.on('project/snapshot', (snapshot) => {
      const { turnTimeoutMs, profile: configuredProfile, ...view } = policy;
      snapshot.executionPolicy = view;
      snapshot.effectivePolicy = effectiveProjectPolicy({
        policy,
        profile,
        resources,
        roles: snapshot.roles,
      });
      for (const saved of snapshot.runs)
        Object.assign(
          saved,
          projectRunAutonomy(saved, {
            goalExists: snapshot.goals.some((goal) => goal.id === saved.goalId),
            projectBusy: snapshot.runs.some(
              (other) =>
                other.id !== saved.id && ['queued', 'running', 'canceling'].includes(other.status),
            ),
            goalUnsettled: snapshot.runs.some(
              (other) =>
                other.id !== saved.id &&
                other.goalId === saved.goalId &&
                (other.pendingTurn || other.reconciliation),
            ),
            resumeSupported: true,
            startSupported: true,
            settingsSupported: false,
          }),
        );
      snapshot.capabilities.push('resources.list', 'run.resume', 'run.start');
    });
    let daemonPort = 0;
    await host.ctx.plugin(websocketPlugin, {
      port: 0,
      onListen: (value) => {
        daemonPort = value;
      },
    });
    vite = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
    await vite.listen();
    const address = vite.httpServer.address();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname))
        externalRequests.push(request.url());
    });
    await page.addInitScript(() => localStorage.setItem('buro.locale', 'en'));
    await page.goto(
      `http://127.0.0.1:${address.port}/?project=autonomy&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}`)}`,
    );
    await page
      .locator('.office-canvas')
      .waitFor({ timeout: 10000 })
      .catch(async () => {
        throw Error(
          'Synthetic UI did not load: ' +
            JSON.stringify(errors) +
            '\n' +
            (await page.locator('body').innerText()),
        );
      });
    await page.locator('.sidebar').getByRole('button', { name: 'Goals', exact: true }).click();
    const card = page.locator('.draft-card').filter({ hasText: 'Synthetic goal' });
    await expect(card.locator('[data-policy-source="project"]')).toContainText(
      'Additional files allowed',
    );
    await expect(card.locator('[data-policy-source="project"]')).toContainText('Up to 64 requests');
    await card.getByRole('button', { name: 'Continue', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox', { name: 'Clarification (optional)' })).toHaveValue('');
    await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
    await store.transact('fixture-busy', 'fixture-busy', (draft) => {
      const active = {
        ...sampleRun(),
        id: 'R-other',
        goalId: 'G-other',
        status: 'running',
        completedAt: undefined,
      };
      const goal = { ...draft.goals[0], id: 'G-other', status: 'running', runId: active.id };
      draft.runs.push(active);
      draft.goals.push(goal);
      return { result: null, change: { type: 'run.changed', run: active, goal } };
    });
    await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    assert.equal(commands.length, 0);
    await store.transact('fixture-settled', 'fixture-settled', (draft) => {
      const active = draft.runs.find((saved) => saved.id === 'R-other');
      active.status = 'completed';
      const goal = draft.goals.find((saved) => saved.id === 'G-other');
      goal.status = 'completed';
      return { result: null, change: { type: 'run.changed', run: active, goal } };
    });
    await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].instructions, '');

    await page.locator('.sidebar').getByRole('button', { name: 'Team', exact: true }).click();
    await page.getByRole('button', { name: 'Edit role coordinator', exact: true }).click();
    const roleDialog = page.getByRole('dialog');
    await roleDialog.getByText('Only this model', { exact: true }).click();
    await roleDialog.getByRole('textbox', { name: 'Model from project pool', exact: true }).click();
    await expect(page.getByRole('option').filter({ hasText: 'unsupported-fixture' })).toContainText(
      'This backend cannot complete structured requests.',
    );
    await page.getByRole('option').filter({ hasText: 'Alternate model' }).click();
    await roleDialog.getByRole('button', { name: 'Save version 2', exact: true }).click();
    await expect(roleDialog).toHaveCount(0);
    assert.deepEqual(
      store.snapshot().roles.find((role) => role.id === 'coordinator').runtimePreference,
      { mode: 'fixed', runtimeId: alternate.id },
    );
    await page.locator('.sidebar').getByRole('button', { name: 'Goals', exact: true }).click();
    await card.locator('[data-policy-source="project"] summary').click();
    await expect(card.locator('[data-policy-source="project"]')).toContainText(
      'coordinator: Alternate model',
    );
    await card.locator('[data-policy-source="project"] summary').click();

    await store.transact('fixture-unknown', 'fixture-unknown', (draft) => {
      const current = draft.runs[0];
      current.reconciliation = {
        version: 1,
        status: 'required',
        code: 'ACTION_RECONCILIATION_REQUIRED',
        detectedAt: 'now',
        operationId: 'synthetic-operation',
      };
      Object.assign(
        current,
        projectRunAutonomy(current, {
          goalExists: true,
          projectBusy: false,
          resumeSupported: true,
          startSupported: true,
          settingsSupported: false,
        }),
      );
      return { result: null, change: { type: 'run.changed', run: current, goal: draft.goals[0] } };
    });
    await page.locator('.sidebar').getByRole('button', { name: 'Goals', exact: true }).click();
    await expect(card.locator('.recovery-actions')).toContainText('unknown outcome');
    await expect(
      card.locator('.recovery-actions').getByRole('button', { name: 'Continue', exact: true }),
    ).toHaveCount(0);
    await expect(
      card.locator('.recovery-actions').getByRole('button', { name: 'Start new run', exact: true }),
    ).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Run again', exact: true })).toBeDisabled();
    await page.evaluate(() => {
      localStorage.setItem('buro.locale', 'ru');
      window.dispatchEvent(new StorageEvent('storage', { key: 'buro.locale', newValue: 'ru' }));
    });
    await expect(card.locator('.recovery-actions')).toContainText(
      'Исход предыдущего действия неизвестен.',
    );
    await fs.mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/autonomy-controls.png', fullPage: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log(
      JSON.stringify({
        policyProjection: true,
        optionalClarification: true,
        coordinatorFixedPreference: true,
        unavailableReasonVisible: true,
        unknownActionsBlocked: true,
        openModalBusyGuard: true,
        translatedServiceReason: true,
        modelRequests: 0,
        errors,
      }),
    );
  } finally {
    await browser?.close();
    await vite?.close();
    await host?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
