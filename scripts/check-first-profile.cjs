const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const childProcesses = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { promisify } = require('node:util');
const execute = promisify(childProcesses.execFile);

(async () => {
  const originalSpawn = childProcesses.spawn;
  const nativeStarts = [];
  childProcesses.spawn = function (command, ...args) {
    if (/(?:^|\/)codex(?:$|\s)/.test(String(command))) nativeStarts.push(String(command));
    return originalSpawn.call(this, command, ...args);
  };
  syncBuiltinESMExports();
  const { createBuroApplication } = await import('../daemon/application.ts');
  const { websocketPlugin } = await import('../daemon/websocket.ts');
  const { SocketProjectClient } = await import('../clients/socket-client.ts');
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-first-profile-ui-')),
  );
  const root = path.join(directory, 'repository');
  const serviceDirectory = path.join(directory, 'service');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/value.mjs'), 'export const value=1;\n');
  const checkCommand = `node --input-type=module -e "import assert from 'node:assert/strict';import {value} from './src/value.mjs';assert.equal(value,2);console.log('verified source')"`;
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'First profile fixture',
      scripts: { test: checkCommand },
    }),
  );
  const git = (args) => execute('git', args, { cwd: root });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial fixture']);
  const initialHead = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const requests = [],
    errors = [],
    passed = [];
  let reviewerReads = 0;
  const research = {
    summary: 'Read the synthetic module and configured check.',
    context: 'A synthetic single-module repository.',
    components: [],
    checks: [{ id: 'test', title: 'Tests', command: 'npm run test', timeoutMs: 30000 }],
    questions: [],
  };
  const recipe = {
    summary: 'Use the installed Node runtime.',
    inputs: ['package.json'],
    variables: [],
    setup: [],
    ready: [
      { id: 'node-ready', title: 'Node available', command: 'node --version', timeoutMs: 10000 },
    ],
  };
  const plan = {
    summary: 'One focused change and independent review.',
    steps: [
      { step: 'Update the module', owner: 'coordinator' },
      { step: 'Review', owner: 'reviewer' },
    ],
    team: [],
  };
  const work = {
    status: 'success',
    summary: 'Changed the fixture value to two.',
    artifacts: ['src/value.mjs'],
    notesForNextAgent: '',
  };
  const review = {
    verdict: 'approved',
    blockingFindings: [],
    summary: 'Read the verified value and actual service checks.',
  };
  const fakeFetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method || 'GET' });
    assert.ok(
      url.startsWith('http://127.0.0.1:11434/'),
      'The synthetic provider cannot contact another endpoint.',
    );
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'fixture-small' }] });
    if (url.endsWith('/api/show'))
      return Response.json({
        capabilities: ['completion', 'tools'],
        model_info: { 'fixture.context_length': 32768 },
      });
    assert.ok(url.endsWith('/api/chat'), url);
    const body = JSON.parse(init.body);
    const properties = body.format?.properties || {};
    const text = body.messages.map((message) => message.content).join('\n');
    const tools = body.tools || [];
    let value;
    let toolCalls;
    if (properties.team) value = plan;
    else if (properties.components) value = research;
    else if (properties.inputs) value = recipe;
    else if (properties.verdict) value = review;
    else if (properties.status) value = work;
    else if (/Review the changes and actual checks\./.test(text)) {
      const observed = body.messages.find(
        (message) => message.role === 'tool' && message.tool_name === 'read_file',
      );
      if (!observed)
        toolCalls = [{ function: { name: 'read_file', arguments: { path: 'src/value.mjs' } } }];
      else {
        assert.match(observed.content, /value=2/);
        reviewerReads++;
        value = review;
      }
    } else if (/environment recipe/.test(text)) value = recipe;
    else if (tools.some((tool) => tool.function.name === 'edit_file')) {
      const edited = body.messages.some(
        (message) => message.role === 'tool' && message.tool_name === 'edit_file',
      );
      if (!edited)
        toolCalls = [
          {
            function: {
              name: 'edit_file',
              arguments: {
                path: 'src/value.mjs',
                oldText: 'value=1',
                newText: 'value=2',
              },
            },
          },
        ];
      else value = work;
    } else value = research;
    return new Response(
      JSON.stringify({
        model: 'fixture-small',
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 40,
        eval_count: 30,
        message: {
          role: 'assistant',
          content: value ? JSON.stringify(value) : '',
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
      }) + '\n',
      { headers: { 'Content-Type': 'application/x-ndjson' } },
    );
  };
  let host, browser, admin, endpoint;
  async function startService() {
    host = await createBuroApplication({
      root: directory,
      directory: serviceDirectory,
      fetch: fakeFetch,
      credentials: () => undefined,
    });
    let port;
    await host.ctx.plugin(websocketPlugin, {
      port: 0,
      onListen: (value) => {
        port = value;
      },
    });
    endpoint = 'ws://127.0.0.1:' + port;
    admin = new SocketProjectClient(endpoint);
    await admin.connectService();
  }
  const catalog = (projectId) =>
    admin.command({ method: 'resources.list', params: projectId ? { projectId } : {} });
  const pageUrl = (projectId) =>
    (process.env.BURO_UI_BASE_URL || 'http://127.0.0.1:4317') +
    '/?daemon=' +
    encodeURIComponent(endpoint) +
    (projectId ? '&project=' + projectId : '');
  try {
    await fs.mkdir('artifacts', { recursive: true });
    await startService();
    const empty = await catalog();
    assert.equal(empty.defaultProfile, null);
    assert.deepEqual([empty.connections, empty.runtimes, empty.profiles], [[], [], []]);
    assert.deepEqual(host.ctx.agentRuntime.registry.list(), []);
    assert.deepEqual(host.ctx.projects.registry.list(), []);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1512, height: 1080 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(pageUrl());
    await page.getByRole('button', { name: 'Connect project', exact: true }).click();
    const picker = page.getByRole('dialog');
    await picker.getByRole('button', { name: 'Connect project', exact: true }).click();
    await picker.getByRole('textbox', { name: 'Repository path', exact: true }).fill(root);
    const autoResearch = picker.getByRole('checkbox', { name: 'Research project', exact: true });
    await expect(autoResearch).toBeDisabled();
    await expect(autoResearch).not.toBeChecked();
    await picker.getByRole('button', { name: 'Inspect directory', exact: true }).click();
    await picker.getByRole('button', { name: 'Connect and open', exact: true }).click();
    await page.getByRole('heading', { name: 'First profile fixture', exact: true }).waitFor();
    const project = host.ctx.projects.registry.list()[0];
    assert.ok(project?.managed);
    assert.deepEqual(host.ctx.projects.registry.get(project.id).snapshot().roles, []);
    assert.deepEqual(requests, []);
    assert.deepEqual(nativeStarts, []);
    passed.push(
      'clean service has no projects or resources; connecting without a model neither researches nor launches Codex',
    );
    await page.getByRole('button', { name: 'Configure models', exact: true }).click();
    await page.getByRole('button', { name: 'Add API connection', exact: true }).click();
    const connection = page.getByRole('dialog');
    await connection
      .getByRole('textbox', { name: 'Connection ID', exact: true })
      .fill('local-synthetic');
    await connection.getByRole('textbox', { name: 'API provider', exact: true }).click();
    await page.getByRole('option', { name: 'Ollama', exact: true }).click();
    await connection
      .getByRole('textbox', { name: 'API base URL', exact: true })
      .fill('http://127.0.0.1:11434');
    await connection.getByRole('button', { name: 'Save connection', exact: true }).click();
    await connection.waitFor({ state: 'hidden' });
    const connectionCard = page.locator('[data-connection-id="local-synthetic"]');
    await connectionCard.getByRole('button', { name: 'Add model by name', exact: true }).click();
    const setup = page.getByRole('dialog');
    await setup.getByRole('textbox', { name: 'Backend implementation', exact: true }).click();
    await page.getByRole('option', { name: 'Buro agent', exact: true }).click();
    await setup.getByRole('textbox', { name: 'Runtime ID', exact: true }).fill('first-model');
    await setup.getByRole('textbox', { name: 'Model name', exact: true }).fill('fixture-small');
    await setup.getByRole('textbox', { name: 'Profile ID', exact: true }).fill('first-team');
    await setup
      .getByRole('textbox', { name: 'Profile name', exact: true })
      .fill('Small local team');
    await setup.getByRole('button', { name: 'Save team profile', exact: true }).click();
    await setup.waitFor({ state: 'hidden' });
    await page
      .getByText('Team profile saved. Restart the service, then select it explicitly.', {
        exact: true,
      })
      .waitFor();
    const pending = await catalog(project.id);
    assert.equal(pending.defaultProfile, null);
    assert.equal(pending.selected, undefined);
    assert.equal(pending.configured.profiles[0].restartRequired, true);
    assert.equal(pending.configured.runtimes[0].definition.backend, 'managed');
    assert.deepEqual(requests, []);
    assert.deepEqual(nativeStarts, []);
    passed.push(
      'first connection, named model and team profile save before one restart without a model request or implicit profile selection',
    );
    await page.screenshot({ path: 'artifacts/first-profile-pending.png', fullPage: true });
    await page.goto('about:blank');
    admin.close();
    admin = undefined;
    await host.dispose();
    host = undefined;
    await startService();
    const activated = await catalog(project.id);
    assert.equal(activated.defaultProfile, null);
    assert.equal(activated.selected, undefined);
    assert.equal(activated.configured.profiles[0].restartRequired, false);
    assert.deepEqual(requests, []);
    await page.goto(pageUrl(project.id));
    await page.getByRole('button', { name: 'Configure models', exact: true }).click();
    const selectProfile = page.getByRole('textbox', {
      name: 'Default execution profile',
      exact: true,
    });
    await expect(selectProfile).toHaveValue('');
    await selectProfile.click();
    await page.getByRole('option', { name: 'Small local team', exact: true }).click();
    await expect
      .poll(async () => (await catalog(project.id)).selected?.profileId)
      .toBe('first-team');
    const selected = await catalog(project.id);
    assert.equal(selected.selected.coordinator.id, 'first-model');
    assert.equal(selected.selected.worker.id, 'first-model');
    assert.equal(selected.selected.reviewer.id, 'first-model');
    assert.deepEqual(requests, []);
    assert.deepEqual(nativeStarts, []);
    passed.push(
      'restart activates the saved configuration but only explicit selection enables a profile; one model serves all three independent roles',
    );
    for (const width of [1512, 390, 320]) {
      await page.setViewportSize({ width, height: 1080 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    }
    await page.setViewportSize({ width: 1512, height: 1080 });
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'Project settings', exact: true })
      .click();
    await page.getByRole('button', { name: 'Research project', exact: true }).click();
    const store = host.ctx.projects.registry.get(project.id);
    await expect
      .poll(() => store.snapshot().research?.status || '', { timeout: 30000 })
      .toMatch(/^(ready|failed|interrupted)$/);
    assert.equal(
      store.snapshot().research.status,
      'ready',
      JSON.stringify({ research: store.snapshot().research, requests }),
    );
    assert.ok(requests.length > 0);
    assert.equal(store.snapshot().research.roleResource.resource.id, 'first-model');
    passed.push(
      'optional research uses the explicitly selected small-model resource through the real managed provider path',
    );
    await page.locator('.sidebar').getByRole('button', { name: 'Goals', exact: true }).click();
    await page.getByRole('button', { name: 'New goal', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'What should we achieve?', exact: true })
      .fill('Update fixture value');
    await page
      .getByRole('textbox', { name: 'Context and expected result', exact: true })
      .fill('Change value to two. Preserve the configured checks.');
    await page.getByRole('button', { name: 'Save goal', exact: true }).click();
    await page.getByRole('button', { name: 'Start goal', exact: true }).click();
    await expect
      .poll(() => store.snapshot().runs[0]?.status || '', { timeout: 60000 })
      .toMatch(/^(completed|failed|needs-attention|interrupted)$/);
    const run = store.snapshot().runs[0];
    assert.equal(
      run.status,
      'completed',
      JSON.stringify({ result: run.result, issue: run.issue, events: run.events, requests }),
    );
    assert.equal(run.acceptance.passed, 1);
    assert.equal(run.independentReviewer, true);
    assert.equal(run.review.verdict, 'approved');
    assert.ok(reviewerReads > 0);
    const critic = run.agents.find((agent) => agent.name === 'reviewer');
    assert.ok(critic?.session);
    assert.notEqual(critic.threadId, run.threadId);
    assert.equal(critic.session.runtimeId, 'first-model');
    assert.equal(run.coordinatorSession.runtimeId, 'first-model');
    const rail = page.locator('.right-rail');
    await expect(
      rail.locator('.metric-row').filter({ hasText: 'External acceptance' }),
    ).toContainText('1 / 1');
    assert.equal(run.commands.length, 0);
    await expect(rail.getByText('Project tests', { exact: true })).toHaveCount(0);
    await expect(rail.getByText('Agent test commands', { exact: true })).toHaveCount(0);
    await expect(rail.getByText('Not run yet', { exact: true })).toHaveCount(0);
    assert.equal((await git(['rev-parse', 'HEAD'])).stdout.trim(), initialHead);
    assert.match(await fs.readFile(path.join(root, 'src/value.mjs'), 'utf8'), /value=1/);
    assert.deepEqual(nativeStarts, []);
    assert.deepEqual(errors, []);
    passed.push(
      'the first goal edits only its private workspace, passes immutable service checks and receives a fresh reviewer session on the same model',
    );
    passed.push(
      'accepted-result rail shows real service acceptance without inventing an unrun agent-test row',
    );
    await page.screenshot({ path: 'artifacts/first-profile-goal.png', fullPage: true });
    const result = {
      passed,
      errors,
      syntheticRequests: requests.length,
      nativeStarts,
      realModelRequests: 0,
    };
    await fs.writeFile(
      'artifacts/first-profile-verification.json',
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
    admin?.close();
    await host?.dispose();
    childProcesses.spawn = originalSpawn;
    syncBuiltinESMExports();
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
