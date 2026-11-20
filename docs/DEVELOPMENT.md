# Development and configuration

Run commands from the Buro checkout. The frontend and CLI connect to the same Node service.

This guide documents the current Codex-backed service. [Product vision](../VISION.md), [target architecture](../ARCHITECTURE.md) and [provider integration](PROVIDERS.md) define the next milestone, including Ollama and the DeepSeek API. They are design contracts, not current configuration instructions. Provider API keys alone do not enable those routes in the existing daemon.

## Local processes

```sh
npm start             # service and Vite; Ctrl+C stops both
npm run dev           # frontend on 127.0.0.1:4317
npm run daemon        # service on 127.0.0.1:4341
npm run typecheck
npm test
npm run build
npm run format:check
```

Vite reloads frontend changes. Restart the daemon after backend changes.

To serve a production frontend build:

```sh
npm run build
npm run preview
```

Open http://127.0.0.1:4327 and keep the daemon running. The build does not bundle the service or Codex CLI.

`/?source=replay` opens browser-local drafts without the service. It starts with an empty run history.

## Service configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PROJECT_DAEMON_PORT` | Listen port | `4341` |
| `PROJECT_DATA_DIR` | Service data directory | checkout `.buro/` |
| `PROJECT_DAEMON_URL` | CLI endpoint | `ws://127.0.0.1:4341` |
| `PROJECT_ID` | CLI project | built-in Buro project |

The UI accepts `?daemon=ws%3A%2F%2F127.0.0.1%3APORT` and `?project=p-ID` for another local endpoint or project.

Useful inspection commands:

```sh
npm run cli -- status
PROJECT_ID=p-ID npm run cli -- project info
PROJECT_ID=p-ID npm run cli -- run show R-ID
PROJECT_ID=p-ID npm run cli -- run timings R-ID
```

Timings exclude pauses between attempts. Individual operation timers may overlap, so adding them does not give the total run duration.

## Browser checks and screenshots

Start Vite with `npm run dev`. The scripts below create temporary services and repositories where needed. Deterministic fixture checks do not start model sessions.

```sh
npm run check:ui
npm run check:service
npm run check:projects
npm run check:setup
npm run check:context
npm run check:appearance
npm run check:localization
npm run docs:screenshots
```

These scripts use Playwright Chromium. If it is missing, run `npx playwright install chromium`.

Reports and routine screenshots go to ignored `artifacts/`. `docs:screenshots` writes the English README images to `docs/images/`. It uses the actual interface with synthetic project and run data, forces Cobalt light, and checks visible text for personal paths and non-English content. It does not read saved user sessions or execute Codex.

Inspect generated images before committing them. Keep screenshot data fictional and do not publish local paths, credentials or project logs.

## Execution environments

A managed run prepares its environment before running baseline or acceptance checks. A read-only setup session proposes a recipe from project files; the service executes setup in the selected environment. Recipes are cached, setup inputs are hashed, and readiness commands run again on checks and resume.

The native provider uses `sandbox-exec` on macOS and `bwrap` on Linux to confine service command writes to the run workspace and cache. This is a filesystem boundary, not a VM. The Codex controller applies its own sandbox to agent tools.

Docker is available in project settings. The image must contain Codex CLI, Git and a POSIX shell. Build the supplied image with:

```sh
node scripts/build-agent-image.mjs
```

Use the printed image tag in the project profile. The source checkout is mounted read-only; the run workspace, cache and private agent state have separate writable mounts. Stopped containers retain their files for continuation. An unavailable provider reports an error instead of running commands unconfined.

An explicit environment `recipe` can define `inputs`, `setup`, `ready` and toolchain `variables`. `${WORKSPACE}`, `${HOME}` and `${PATH}` expand without shell evaluation. Source dependency or lockfile edits still require the goal's environment-repair option.

`checkConcurrency` defaults to 1. Increase it only for checks that do not share writable outputs.

## Project state

```text
.buro/project.json          shared project profile
.buro/control-state.json    goals, role versions, runs, events and receipts
.buro/worktrees/            run workspaces
.buro/local/                machine settings, imported context and migration backups
.buro/.gitignore            excludes private runtime data
```

The Buro checkout also stores the connected-project catalog. Keep credentials out of the shared profile.

Local preview reads the source project/component `.env` and `.env.local`, then private `.buro/local/` overrides. Deployment reads private environment files instead of inheriting development variables. Environment files are not copied into the run's source tree; process output redacts known secret values.

A run snapshots its policy, roles and materials. Independent goals start from the configured base branch. An explicit parent starts from an accepted commit. Repair and check-only recovery reuse saved worktrees; see [recovery](../RECOVERY.md).

Legacy metadata is migrated when a project opens. Migration checks writer locks and directory conflicts, backs up JSON metadata, relocates workspace paths and repairs Git worktree links. If both old and new metadata directories exist, opening stops rather than merging them.

## Code layout

```text
core/          goals, roles, execution, acceptance and ports
protocol/      DTOs, schemas and storage contracts
adapters/      files, Git, processes, environments and Codex
plugins/       Cordis composition and lifecycle
daemon/        service entry point and WebSocket transport
clients/       socket and offline clients
cli/           command-line client
src/           React/Mantine interface and localization
checks/ tests/ scripts/
```

Core has no React, Node, Cordis or transport imports. UI and clients do not import backend modules. Cordis composes trusted plugins; it does not sandbox them.

Runtime activity is typed in `core/runtime-events.ts`. The Codex adapter normalizes native notifications before publishing them; `core/runtime-projection.ts` applies public activity to saved runs. `core/runtimes.ts` holds available adapters, while `plugins/runtime.ts` owns generic composition and cleanup. Production still selects Codex as its only default route. `core/worker-assignments.ts` records and dispatches independent workers; native child tools are disabled and native activity cannot establish role identity. See [implementation progress](IMPLEMENTATION.md).

The protocol uses versioned requests, IDs and validated parameters. Metadata, receipts and events are written before publication. Retries reuse receipts; conflicting payloads are rejected. Reconnecting clients catch up from a sequence number. Git operations and delivery are separate from metadata transactions.

Event history uses deltas. Automatic garbage collection removes owned atomic-write temporary files older than one day. It does not remove worktrees, material history or caches.

UI messages are in `src/i18n/locales/en.json` and `ru.json`. User content is not translated.
