const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const exec = require('node:util').promisify(execFile);

// Capture the real UI against a disposable service. All project and run data is synthetic.
// No Codex sessions, user repositories or existing Buro data are used.
(async () => {
  const { Service } = await import('cordis');
  const { createHost } = await import('../plugins/host.ts');
  const { executionPlugin } = await import('../plugins/execution.ts');
  const { projectManagementPlugin } = await import('../plugins/project-management.ts');
  const { GitWorkspaces } = await import('../adapters/files/git-workspaces.ts');
  const { websocketPlugin } = await import('../daemon/websocket.ts');
  const { defaultRoles } = await import('../tests/fixtures/roles.ts');
  const { sampleRun } = await import('../tests/fixtures/sample-run.ts');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-doc-images-')));
  const repo = path.join(directory, 'field-notes');
  const output = path.resolve('docs/images');
  let host, browser;
  try {
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    const git = (args) => exec('git', args, { cwd: repo });
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Documentation demo']);
    await git(['config', 'user.email', 'demo@example.invalid']);
    await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
    await fs.writeFile(
      path.join(repo, 'package.json'),
      JSON.stringify({
        name: 'field-notes',
        scripts: { test: 'node --test' },
      }),
    );
    await fs.writeFile(path.join(repo, 'README.md'), '# Field Notes\n\nA sample activity log.\n');
    await fs.writeFile(
      path.join(repo, 'src/activity.ts'),
      'export type ActivityEvent = { agent: string; message: string };\n',
    );
    await git(['add', '.']);
    await git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Add demo project']);

    host = await createHost({ projects: [] });
    const policies = {},
      workspaces = new GitWorkspaces(host.ctx.projects.registry);
    const checkAdapter = {
      async run() {
        throw Error('Screenshot capture must not execute checks.');
      },
    };
    class DocumentationRuntime extends Service {
      constructor(ctx) {
        super(ctx, 'agentRuntime');
        const blocked = async () => {
          throw Error('Screenshot capture must not start model sessions.');
        };
        this.adapter = {
          id: 'documentation',
          start: blocked,
          turn: blocked,
          submit: blocked,
          subscribe() {
            return () => {};
          },
          async interrupt() {},
          async release() {},
          async dispose() {},
        };
      }
    }
    await host.ctx.plugin(DocumentationRuntime);
    await host.ctx.plugin(projectManagementPlugin, {
      catalogFile: path.join(directory, 'projects.json'),
      policies,
      workspaces,
      checks: checkAdapter,
    });
    let request = 0;
    const command = (method, params) =>
      host.ctx.commands.bus.execute(
        { method, params },
        { id: 'docs-' + ++request, fingerprint: 'docs-' + request },
      );
    const info = await command('project.inspect', { root: repo });
    const project = await command('project.connect', {
      root: repo,
      name: 'Field Notes',
      profile: {
        ...info.profile,
        dependencies: 'none',
        context: 'A small activity log. Keep existing event ordering and keyboard navigation.',
      },
    });
    await host.ctx.plugin(executionPlugin, { policies, workspaces, checks: checkAdapter });
    const at = (seconds) => new Date(Date.UTC(2026, 0, 5, 9, 0, seconds)).toISOString();
    const checks = [
      'Search matches agent names and messages',
      'Queries are case-insensitive',
      'An empty query shows every event',
      'Event ordering is unchanged',
    ].map((name) => ({ name, passed: true }));
    const run = {
      ...sampleRun(),
      id: 'R-demo-search',
      key: 'GOAL-001',
      goalId: 'G-demo-search',
      title: 'Add search to the activity log',
      summary: 'Find events by agent or message without changing their order.',
      goalText:
        'Add case-insensitive search across agent names and messages. A blank query must show every event.',
      createdAt: at(0),
      completedAt: at(300),
      updatedAt: at(300),
      planSavedAt: at(20),
      threadId: 'demo-coordinator',
      phase: 'done',
      roleSnapshots: structuredClone(defaultRoles),
      roleOrigins: { implementer: 'reused', test_author: 'reused', reviewer: 'reused' },
      agents: [
        {
          name: 'implementer',
          start: 25,
          end: 180,
          paths: ['src/activity.ts'],
          message:
            'Search now checks agent names and messages while preserving the original event order.',
        },
        {
          name: 'test_author',
          start: 40,
          end: 220,
          paths: ['tests/activity.test.ts'],
          message: 'Added cases for blank queries, mixed case, agent names and missing matches.',
        },
        {
          name: 'reviewer',
          start: 230,
          end: 285,
          paths: [],
          message: 'The change meets the acceptance criteria. No blocking findings.',
        },
      ].map((a) => ({
        name: a.name,
        threadId: 'demo-' + a.name,
        agentPath: '/root/' + a.name,
        startedAt: at(a.start),
        completedAt: at(a.end),
        status: 'completed',
        assignment: { paths: a.paths },
        commands: 1,
        messages: [a.message],
      })),
      commands: [
        {
          id: 'demo-types',
          threadId: 'demo-implementer',
          command: 'npm run typecheck',
          startedAt: at(150),
          completedAt: at(160),
          exitCode: 0,
          output: 'Type check passed.\n',
        },
        {
          id: 'demo-tests',
          threadId: 'demo-test_author',
          command: 'npm test',
          startedAt: at(200),
          completedAt: at(215),
          exitCode: 0,
          output: '# tests 8\n# pass 8\n# fail 0\n',
        },
        {
          id: 'demo-diff',
          threadId: 'demo-reviewer',
          command: 'git diff --check',
          startedAt: at(260),
          completedAt: at(265),
          exitCode: 0,
          output: '',
        },
      ],
      plan: [
        { step: 'Check current filtering and event ordering', owner: 'coordinator' },
        { step: 'Add agent and message search', owner: 'implementer' },
        { step: 'Test blank, mixed-case and missing queries', owner: 'test_author' },
        { step: 'Review the diff and check results', owner: 'reviewer' },
      ],
      changedFiles: [
        {
          path: 'src/activity.ts',
          before:
            'export function searchEvents(events: ActivityEvent[], query: string) {\n  return events.filter(event => event.message.includes(query));\n}\n',
          after:
            'export function searchEvents(events: ActivityEvent[], query: string) {\n  const needle = query.trim().toLowerCase();\n  if (!needle) return events;\n\n  return events.filter(({ agent, message }) =>\n    `${agent} ${message}`.toLowerCase().includes(needle),\n  );\n}\n',
        },
        {
          path: 'tests/activity.test.ts',
          before: '',
          after:
            "test('a blank query keeps every event', () => {\n  assert.deepEqual(searchEvents(events, ''), events);\n});\n\ntest('search matches an agent name without case sensitivity', () => {\n  assert.deepEqual(searchEvents(events, 'REVIEWER'), [events[1]]);\n});\n",
        },
      ],
      baseline: { passed: 5, total: 5, results: [{ name: 'Existing tests', passed: true }] },
      acceptance: { passed: checks.length, total: checks.length, results: checks },
      review: {
        verdict: 'approved',
        blockingFindings: [],
        summary: 'Search behavior and event ordering match the goal.',
      },
      result:
        'Added case-insensitive search by agent and message. Blank queries show all events. Eight tests pass; independent review found no blockers.',
      outcome: { kind: 'local' },
    };
    run.events = [
      { at: at(0), type: 'thread.started', threadId: run.threadId },
      {
        at: at(20),
        type: 'plan.saved',
        threadId: run.threadId,
        text: 'Split implementation, regression tests and review.',
      },
      ...run.agents.flatMap((a) => [
        { at: a.startedAt, type: 'agent.started', threadId: a.threadId, text: a.agentPath },
        { at: a.completedAt, type: 'message', threadId: a.threadId, text: a.messages[0] },
        { at: a.completedAt, type: 'agent.completed', threadId: a.threadId },
      ]),
      ...run.commands.flatMap((c) => [
        {
          at: c.startedAt,
          type: 'command.started',
          threadId: c.threadId,
          commandId: c.id,
          text: c.command,
        },
        { at: c.completedAt, type: 'command.completed', threadId: c.threadId, commandId: c.id },
      ]),
      {
        at: at(300),
        type: 'goal.completed',
        threadId: run.threadId,
        text: 'Checks and review passed.',
      },
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const store = host.ctx.projects.registry.get(project.id);
    await store.transact('docs-run', 'docs-run', (doc) => {
      const goal = {
        id: run.goalId,
        projectId: project.id,
        title: run.title,
        body: run.goalText,
        criteria: checks.map((c) => c.name).join('\n'),
        status: 'completed',
        runId: run.id,
        createdAt: run.createdAt,
      };
      doc.goals.push(goal);
      doc.runs.push(run);
      return { result: null, change: { type: 'run.changed', run, goal } };
    });
    let port;
    await host.ctx.plugin(websocketPlugin, {
      port: 0,
      onListen: (value) => {
        port = value;
      },
    });
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      locale: 'en-US',
      timezoneId: 'UTC',
      deviceScaleFactor: 1,
    });
    await context.addInitScript(() => {
      localStorage.setItem('buro.locale', 'en');
      localStorage.setItem('project-panel-theme', JSON.stringify('cobalt'));
      localStorage.setItem('project-panel-color-scheme', 'light');
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(
      'http://127.0.0.1:4317/?project=' +
        project.id +
        '&daemon=' +
        encodeURIComponent('ws://127.0.0.1:' + port),
    );
    await page.getByRole('heading', { name: 'Field Notes', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Full result', exact: true }).click();
    await fs.mkdir(output, { recursive: true });
    const capture = async (name, target = page) => {
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
      const text = await page.locator('body').innerText();
      assert.equal(/[\u0400-\u04ff]/.test(text), false, 'Non-English screenshot text');
      assert.equal(
        /\/Users\/|\/home\/|\/private\/(?:var|tmp)\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(
          text,
        ),
        false,
        'Private data in screenshot',
      );
      await target.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
    };
    await capture('office');
    const sidebar = (name) =>
      page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
    await sidebar('Runs');
    await page.getByRole('tab', { name: 'Changes', exact: true }).click();
    await page
      .locator('.diff-code')
      .getByText('const needle = query.trim().toLowerCase();', { exact: false })
      .waitFor();
    await capture('changes');
    await page.getByRole('tab', { name: 'Checks', exact: true }).click();
    assert.ok((await page.locator('.check-summary').innerText()).includes('8/8'));
    await capture('checks');
    await sidebar('Office');
    await page
      .locator('.hero-actions')
      .getByRole('button', { name: 'New goal', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'What should we achieve?', exact: true })
      .fill('Add CSV export for filtered events');
    await page
      .getByRole('textbox', { name: 'Context and expected result', exact: true })
      .fill(
        'Let users download the visible activity log as CSV. Export the current filtered results in their displayed order.',
      );
    await page
      .getByRole('textbox', { name: 'How will we know it is done?', exact: true })
      .fill(
        'Only visible events are exported. Include agent, message and date columns. Escape commas and quotes. Add tests for empty results.',
      );
    await page
      .getByRole('textbox', { name: 'Work with the completed result', exact: true })
      .click();
    await page.getByRole('option', { name: 'Local result', exact: true }).click();
    await capture('goal', page.locator('.mantine-Modal-content'));
    assert.deepEqual(errors, []);
    console.log('Saved 4 English screenshots to docs/images using synthetic project data.');
  } finally {
    await browser?.close();
    await host?.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
