const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
(async () => {
  const { createHost } = await import('../plugins/host.ts');
  const { websocketPlugin } = await import('../daemon/websocket.ts');
  const { sampleRun } = await import('../tests/fixtures/sample-run.ts');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-service-ui-'));
  const runs = [sampleRun()];
  let host, browser, emptyHost;
  try {
    host = await createHost({
      projects: [
        { directory, project: { id: 'codex-panel', name: 'Codex Panel', root: directory }, runs },
      ],
    });
    let port = 0;
    await host.ctx.plugin(websocketPlugin, { port: 0, onListen: (p) => (port = p) });
    const endpoint = 'ws://127.0.0.1:' + port,
      url = 'http://127.0.0.1:4317/?daemon=' + encodeURIComponent(endpoint);
    const cli = async (...args) =>
      JSON.parse(
        (
          await promisify(execFile)(process.execPath, ['cli/main.ts', ...args], {
            cwd: process.cwd(),
            env: { ...process.env, PROJECT_DAEMON_URL: endpoint },
            timeout: 5000,
          })
        ).stdout,
      );
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1512, height: 1080 } });
    const a = await context.newPage(),
      b = await context.newPage(),
      errors = [];
    for (const p of [a, b]) p.on('pageerror', (e) => errors.push(e.message));
    await Promise.all([a.goto(url), b.goto(url)]);
    for (const p of [a, b]) {
      await p.locator('.office-canvas').waitFor();
      await p.waitForFunction(
        () => document.querySelector('.source-select input')?.value === 'Service connected',
      );
      await p.locator('.sidebar').getByRole('button', { name: 'Goals', exact: true }).click();
    }
    await a.getByRole('button', { name: 'Projects', exact: true }).click();
    assert.equal(
      await a.getByRole('button', { name: 'Connect project', exact: true }).isDisabled(),
      true,
    );
    assert.ok((await a.locator('.projects-modal').innerText()).includes('outdated'));
    await a.locator('.mantine-Modal-close').click();
    await a.locator('.hero-actions').getByRole('button', { name: 'New goal' }).click();
    await a.getByRole('textbox', { name: 'What should we achieve?' }).fill('Shared goal');
    await a
      .getByRole('textbox', { name: 'Context and expected result' })
      .fill('Save in the independent core.');
    await a.getByRole('button', { name: 'Save goal', exact: true }).click();
    await b.locator('.draft-card').filter({ hasText: 'Shared goal' }).waitFor();
    assert.equal((await cli('status')).goals, 1);
    await a.close();
    await cli('goal', 'create', 'From CLI', 'The UI may be closed');
    await b.locator('.draft-card').filter({ hasText: 'From CLI' }).waitFor();
    await b.locator('.sidebar').getByRole('button', { name: 'Team', exact: true }).click();
    await b.getByRole('button', { name: 'New role', exact: true }).click();
    await b.getByRole('textbox', { name: 'Role ID' }).fill('fixture_observer');
    await b.getByRole('textbox', { name: 'Role name' }).fill('Observer');
    await b.getByRole('textbox', { name: 'When to use' }).fill('For observing checks');
    await b
      .getByRole('textbox', { name: 'Persistent instructions' })
      .fill('Collect evidence and report the result.');
    await b.getByRole('button', { name: 'Save role', exact: true }).click();
    await b.locator('.team-role').filter({ hasText: 'fixture_observer' }).waitFor();
    assert.equal((await cli('roles')).find((r) => r.id === 'fixture_observer').version, 1);
    await b.getByRole('button', { name: 'Edit role fixture_observer' }).click();
    await b.getByRole('textbox', { name: 'Role name' }).fill('Observer v2');
    await b.getByRole('button', { name: 'Save version 2', exact: true }).click();
    await b.locator('.team-role').filter({ hasText: 'Observer v2' }).waitFor();
    const status = await cli('status');
    assert.equal(status.roles.find((r) => r.id === 'fixture_observer').version, 2);
    await b.reload();
    await b.locator('.office-canvas').waitFor();
    await b.locator('.sidebar').getByRole('button', { name: 'Team', exact: true }).click();
    await b.locator('.team-role').filter({ hasText: 'Observer v2' }).waitFor();
    await b.screenshot({ path: 'artifacts/service-roles.png' });
    await b.locator('.sidebar').getByRole('button', { name: 'Office', exact: true }).click();
    await b.screenshot({ path: 'artifacts/service-office.png' });
    assert.equal(await b.locator('.desk').count(), 3); // A reusable role is not an invented running agent.
    await b.locator('.sidebar').getByRole('button', { name: 'Goals', exact: true }).click();
    await b.screenshot({ path: 'artifacts/service-goals.png' });
    assert.equal(await b.locator('.draft-card').count(), 2);
    emptyHost = await createHost({
      projects: [
        {
          directory: path.join(directory, 'empty'),
          project: { id: 'codex-panel', name: 'Empty Project', root: directory },
          runs: [],
        },
      ],
    });
    let emptyPort = 0;
    await emptyHost.ctx.plugin(websocketPlugin, { port: 0, onListen: (p) => (emptyPort = p) });
    await b.goto(
      'http://127.0.0.1:4317/?daemon=' + encodeURIComponent('ws://127.0.0.1:' + emptyPort),
    );
    await b.getByRole('heading', { name: 'Empty Project', exact: true }).waitFor();
    await b.locator('.empty-office-canvas').waitFor();
    assert.equal(await b.locator('.sidebar').count(), 1);
    assert.equal(await b.locator('.project-nav>button').count(), 4);
    assert.equal(await b.locator('.desk').count(), 0);
    assert.equal(await b.locator('.player').count(), 0);
    for (const [label, heading] of [
      ['Runs', 'No runs yet'],
      ['.buro files', 'Project files'],
      ['Project settings', 'Project settings'],
    ]) {
      await b.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
      await b.getByRole('heading', { name: heading, exact: true }).waitFor();
      assert.equal(await b.locator('.sidebar').count(), 1);
    }
    await b.setViewportSize({ width: 320, height: 980 });
    await b.getByRole('button', { name: 'Navigation', exact: true }).click();
    await b.locator('.mobile-sidebar').getByRole('button', { name: 'Office', exact: true }).click();
    await b.locator('.empty-office-canvas').waitFor();
    assert.equal(await b.evaluate(() => document.documentElement.scrollWidth), 320);
    await b.setViewportSize({ width: 1512, height: 1080 });

    await b.getByRole('button', { name: 'New goal', exact: true }).click();
    await b.getByRole('textbox', { name: 'What should we achieve?' }).fill('First goal');
    await b
      .getByRole('textbox', { name: 'Context and expected result' })
      .fill('Start without run history');
    await b.getByRole('button', { name: 'Save goal', exact: true }).click();
    await b.locator('.goal-card').filter({ hasText: 'First goal' }).waitFor();
    assert.equal(await b.locator('.desk').count(), 0);
    assert.equal(await b.locator('.app-shell').count(), 1);
    await b.locator('.sidebar').getByRole('button', { name: 'Team', exact: true }).click();
    assert.equal(await b.locator('.team-role').count(), 4);
    assert.deepEqual(errors, []);
    const result = {
      passed: [
        'legacy daemon shows an upgrade hint instead of sending unsupported commands',
        'two browser connections share committed goals',
        'CLI reads same project',
        'core works after one UI closes',
        'CLI mutation appears in UI',
        'new role persists',
        'version update survives reload',
        'unassigned role creates no fake agent',
        'empty projects keep the common frame across every section and mobile navigation',
        'empty project can create its first goal',
        'role catalog works before first run',
      ],
      errors,
    };
    await fs.writeFile('artifacts/service-verification.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close();
    await emptyHost?.dispose();
    await host?.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
