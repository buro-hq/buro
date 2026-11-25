# Buro

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="branding/logo-light.svg">
  <img src="branding/logo.svg" alt="Buro Links logo" width="240">
</picture>

Buro is a local workspace for coding with agents. Describe the result, select a model and start an attempt. Agents choose tools, invite collaborators and change models within their conversations. Review and testing are useful actions available to the team, without a fixed sequence of roles or a universal acceptance gate.

Every run has a separate Git worktree. Inspect its conversations and changes, start an optional preview, apply its patch to your project, or explicitly publish a draft PR. Your existing source changes become the run's baseline and are excluded from its result patch.

## Run locally

You need Node.js 24+, npm and Git. Command execution uses macOS `sandbox-exec` or Linux `bubblewrap`. Models may run on another machine; the application and its command tools run on this host.

```sh
npm ci
npm start
```

The launcher starts the service and interface, then opens an authenticated browser tab. The tab removes its temporary credential from the address bar. Ctrl+C stops the service, model work and preview processes.

1. Open **Projects** and connect a directory. A Git repository with at least one commit is needed to start a run.
2. Open **Models**, add a connection, load the model list or enter an ID, and save it. Thinking is enabled by default for transports that support the setting. No restart or team profile is needed.
3. Create a goal with its description and optional attachments, then start it.
4. Follow sessions in **Office** or **Runs**. Change the model for a conversation's next request when useful.
5. Read the result and diff. Applying changes, previewing and publishing are independent actions.

Supported connections are OpenAI compatible APIs, Ollama, DeepSeek and the installed Codex CLI. Native Codex can use its existing login. API keys are kept in the private application directory and are absent from model selectors and notifications.

Restarting an attempt creates a new run with its saved files and portable history. It does not replay uncertain tool actions. Each attempt remains available for inspection.

## CLI

The CLI calls the same feature APIs as the interface. Parameters can be inline JSON, `@file.json`, or `-` for stdin. Use a private file or stdin for credentials.

```sh
npm run cli -- status
npm run cli -- projects.list
npm run cli -- projects.connect '{"root":"/path/to/project"}'
npm run cli -- tasks.create @task.json
npm run cli -- runs.start '{"taskId":"TASK_ID"}'
npm run cli -- watch RUN_ID
npm run cli -- results.inspect '{"runId":"RUN_ID"}'
npm run cli -- open
```

`PROJECT_DATA_DIR` selects the application directory, defaulting to `.buro`. `PROJECT_DAEMON_PORT` selects the service port, defaulting to 4341; `PROJECT_DAEMON_URL` selects it for CLI clients. `BURO_UI_PORT` selects the launcher UI port, defaulting to 4317. Set `BURO_OPEN_BROWSER=0` for headless startup. `BURO_UI_URL` selects the local page opened by `cli open`.

## Development

```sh
npm run fix
npm run check
npm test
npm run build
npm run check:ui
```

EditorConfig sets two-space indentation and LF line endings. ESLint Stylistic formats TS/JS/TSX; Prettier formats the other supported text files. `npm run format` changes formatting only, `npm run fix` also applies available lint fixes, and `npm run check` checks lint, formatting and types. GitHub Actions runs these checks and the formatter regression tests.

`npm test` keeps native failure details, diagnostics, skipped tests and totals while omitting successful test listings. `npm run test:verbose` lists every test. Both commands discover all root and nested test suites and retain Node's exit status.

VS Code workspace settings apply ESLint fixes on save for source code and Prettier for the other formats. Install the recommended extensions when prompted. The 100-column ruler is a guide: source formatting preserves deliberate line breaks and logical groups. See [code style](docs/CODE-STYLE.md) for the selected conventions and automatic checks.

The test suite covers portable model streams, thinking and tool calls, feature persistence, cancellation, real Git workspaces, OS process isolation, publication to a local test remote, and browser interactions. These checks do not make live model calls or publish real PRs.

See [architecture, diagrams and comparisons](ARCHITECTURE.md), [model connections](docs/MODELS.md) and the [refactor checkpoint](docs/ARCHITECTURE-REFACTOR-2026-11-25.md). Earlier designs and workflow tests belong to the archived implementation; historical documents are under [docs/archive](docs/archive/README.md).

For an explicitly requested live model check, use `npm run evaluate:model -- queue MODEL_CONNECTION_ID` or `npm run evaluate:model -- review MODEL_CONNECTION_ID` while the daemon is stopped. These create synthetic projects and call the saved model connection. Reports retain the fixture identity, code revision, final independent checks, actual sessions, reported tokens and whole-run time. Token throughput over wall time is separate from provider decode speed.

The [DeepSeek Flash thinking validation](docs/FLASH-VALIDATION-2026-11-25.md) records the live functional checks, collaboration trace, whole-run timings and current limitations.

The [RTX thinking matrix](docs/RTX-THINKING-VALIDATION-2026-11-25.md) compares five local models on ordinary and review tasks, including actual tool execution, final file checks, whole-task time and server-reported generation rates.
