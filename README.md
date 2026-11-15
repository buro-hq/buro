# Buro

A local office for coding agents, organized around your projects. Give a project a goal; a coordinator plans the work, selects reusable roles, runs workers, and sends the result through checks and independent review. The interface and CLI are clients of the same local service.

Buro is an early local MVP. It uses your installed Codex CLI and keeps project configuration next to the repository in `.buro/`.

## Requirements

- Node.js **24 or newer**, with native TypeScript execution, and npm.
- Git and a repository with at least one commit for each connected project.
- An installed and authenticated **Codex CLI** for research and agent execution. Reading recordings and editing local drafts do not require a model session.
- Optional: authenticated GitHub CLI (`gh`) and a GitHub remote for draft PR delivery.

## Install

Clone or copy the repository, then run:

```sh
cd /path/to/buro
npm ci
```

There is no global installer or packaged desktop application yet.

## Run

Start the service and React development server together from the repository root:

```sh
npm start
```

Ctrl+C stops both processes. If either process exits, the other is stopped too.

To run them separately, open two terminals:

```sh
# Terminal 1: core, persistence, Codex runtime and WebSocket API
npm run daemon
```

```sh
# Terminal 2: React development server
npm run dev
```

Open **http://127.0.0.1:4317**. The service listens on **ws://127.0.0.1:4341**. It binds to loopback; no account or hosted Buro service is needed. Stop foreground processes with Ctrl+C.

For a built interface:

```sh
npm run build
npm run preview
```

Open **http://127.0.0.1:4327** and keep the daemon running. A build contains the frontend; it does not bundle the Node service or Codex CLI.

Use `/?source=replay` to manage browser-local drafts without the service. This mode starts with an empty history. The service mode connects automatically when the daemon is available.

## Connect a project

1. Open **Projects → Connect project**.
2. Type a Git repository path or use the directory picker.
3. Keep research enabled to let a read-only agent suggest components, checks and startup commands, or configure the project manually.
4. Review the suggestions, allowed/protected paths and commands; save the profile.
5. Create a goal, add acceptance criteria and optional materials, choose its outcome, then start it with selected checks.

Research does not install dependencies, start servers, run migrations or enable deployment. Suggested commands are proposals until they have been checked. Projects retain their own goals, roles and history.

## Goals, materials and results

Each new goal starts from the configured base branch. Choose a completed parent run to continue its commit instead. Work happens in an isolated Git worktree; uncommitted source edits stay in the original checkout. Agents do not change your source branch automatically.

Project materials are shared context for future goals. Goal materials belong to that goal. Choose local files/directories or upload files through the system dialog. Supported formats: UTF-8 text/code, PNG/JPEG/WebP/GIF, PDF and DOCX. The limit is **8 MiB per file**, **32 goal attachments**, or **64 active project materials**. Filesystem imports accept up to 64 files/48 MiB in one batch.

Imported copies are stored privately. Runs freeze their selected materials and stage verified read-only copies for the coordinator, workers and reviewer. Removing an attachment does not delete the original or invalidate past runs. PDF text extraction uses PDFKit on macOS or `pdftotext` elsewhere; DOCX extraction currently uses macOS `textutil`. If extraction is unavailable, the original remains attached and a note explains the limitation. OCR is not included.

A goal is accepted after implementation, configured checks and independent review succeed. The result can then be:

- **Inspected locally** using configured web/API/worker commands and readiness checks.
- **Delivered as a draft PR** when enabled, using a separate branch and `gh`.
- **Deployed to a configured environment** with an explicit command, verification URL and optional commit-specific confirmation.
- **Applied to the source branch** through the separate apply action, which checks branch identity, cleanliness and ancestry.

Delivery errors do not undo implementation acceptance. Redeploy repeats delivery of the accepted commit; it preserves earlier delivery records and asks for fresh confirmation when required. Buro never automatically repeats an ambiguous deployment after restart. See [onboarding and delivery](ONBOARDING-AND-DELIVERY.md).

## Language and appearance

Click the user icon, then open **User settings**. Choose **English** or **Russian**, a light/dark/system color scheme, and a palette. Changes apply immediately and persist in this browser across projects. English is the default language; Iris is the default palette. User-authored goals, materials, role definitions and historical outputs retain their original language.

UI messages live in `src/i18n/locales/en.json` and `ru.json`. Product source, service/CLI messages, agent instructions and current documentation use English.

Managed goal runs prepare their execution environment before baseline and acceptance checks. The default native provider confines service command writes on macOS (Seatbelt) and Linux (bubblewrap); it is a filesystem boundary, not a VM. A read-only setup session discovers a language-independent recipe from project files. Recipes are cached, setup inputs are hashed, and readiness commands run again on every check/resume. Failed preparation has its own bounded repair loop and never changes the registered acceptance commands. Source changes still pass the same scope and manifest checks.

Choose Docker in project settings for a container execution world. The selected image must contain `codex`, Git and a POSIX shell. Build the supplied agent image once with `node scripts/build-agent-image.mjs`, then set its printed tag in the profile. The Codex controller and service commands run inside the same container. The source checkout is mounted read-only; the run workspace, project artifact cache and private agent state have separate writable mounts. Containers stop after a run and retain files for continuation. No provider silently falls back to an unconfined host process.

Private HOME directories keep installed project state separate. Download caches are reused within the same project/provider/platform. Environment configuration may include an explicit `recipe` with `inputs`, `setup`, `ready` and optional toolchain `variables`; otherwise the service discovers it. `${WORKSPACE}`, `${HOME}` and `${PATH}` placeholders expand without shell evaluation. Dependency/lockfile source edits still require the goal's environment-repair option.

Small coherent goals may use an empty worker team: the coordinator implements directly, and independent checks and a fresh reviewer remain mandatory. `checkConcurrency` defaults to 1; increase it only for commands that do not share writable outputs. Prompts carry concise check summaries and changed-file inventories; complete logs remain in run history and reviewers inspect the actual diff.

`npm run cli -- run timings <runId>` reports active phase time (excluding pauses between attempts) and measured model/startup/check operations. Operation timers may be nested and must not be summed as total run duration.

## Develop

```sh
npm start             # daemon + Vite; Ctrl+C stops both
npm run dev           # Vite HMR on port 4317
npm run daemon        # Node service; restart after backend changes
npm run typecheck     # frontend and server TypeScript checks
npm test              # domain, adapters, transport and migration tests
npm run build         # typecheck + production frontend build
npm run format        # format frontend, clients and protocol
npm run format:check
```

Browser verification requires a running dev server and Playwright Chromium. If the browser is missing, install it with `npx playwright install chromium`.

```sh
npm run check:ui          # offline drafts and interactions
npm run check:service     # multiple clients against a test service
npm run check:projects    # connect, execute, recover and apply in a fixture repo
npm run check:setup       # research, configuration, preview and delivery
npm run check:context     # filesystem selection, uploads and persistence
npm run check:appearance  # theme behavior and responsive layout
npm run check:localization # EN/RU switching, persistence and fixture screenshots
```

The integration scripts create isolated temporary repositories. Real model calls are not required for the deterministic fixture checks. Screenshots and verification reports go to ignored `artifacts/`. Browser checks use synthetic fixtures; captured local sessions are not distributed.

## Architecture

```text
core/          goals, role versions, execution, acceptance and ports
protocol/      shared DTOs, schemas and storage directory contract
adapters/      files, Git workspaces, processes, dependencies and Codex
plugins/       Cordis service composition and lifecycle
daemon/       local entry point and WebSocket transport
clients/       socket and replay clients
cli/           independent CLI client
src/           React/Mantine interface and localization
checks/ tests/ scripts/
.buro/         private runtime state, linked-project catalog and worktrees
```

Core has no React, Node, Cordis or transport imports. UI and clients do not import backend modules. Cordis composes trusted in-process plugins; it does not provide a security sandbox. The runtime and filesystem adapters remain replaceable.

Commands have protocol version 1, a request ID and validated parameters. Metadata changes, durable receipts and events are committed atomically before publication. Retries reuse their receipts; conflicting payloads are rejected. Clients reconnect from sequence numbers. Git operations and external delivery are separate effects, not part of the metadata transaction.

## Project files and migration

Each connected repository owns:

```text
.buro/project.json          shared project profile
.buro/control-state.json    private goals, role versions, runs, events and receipts
.buro/worktrees/            isolated workspaces
.buro/local/                machine settings, imported context and migration backups
.buro/.gitignore            excludes private runtime data
```

The Buro checkout additionally stores the catalog of connected repository paths. User projects remain in their original folders.

Existing legacy metadata is migrated when a project is opened. The migration checks for a live writer and conflicting directory names, backs up JSON files in `.buro/local/metadata-migration/original/`, relocates operational paths, moves nested workspace metadata and repairs Git worktree links. A pending manifest resumes an interrupted migration. User text and event sequences are preserved. If both directory names exist, opening stops with a conflict instead of merging them.

Keep private state out of Git. Only the shared profile is intended for version control. Never add credentials to it. Local preview reads source project/component `.env` and `.env.local`, then private `.buro/local/` overrides, without copying source env files into workspaces. Deployment reads private environment files rather than inheriting development variables. Secret values are redacted from stored/displayed process output.

## CLI and configuration

```sh
npm run cli -- status
npm run cli -- projects
npm run cli -- project connect /absolute/path/to/repository
PROJECT_ID=p-ID npm run cli -- project info
PROJECT_ID=p-ID npm run cli -- goal create "Add search" "Expected behavior" "Acceptance criteria"
PROJECT_ID=p-ID npm run cli -- run start G-ID
PROJECT_ID=p-ID npm run cli -- run show R-ID
PROJECT_ID=p-ID npm run cli -- run watch R-ID
```

Environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PROJECT_DAEMON_PORT` | Service listen port | `4341` |
| `PROJECT_DATA_DIR` | Buro service data directory | checkout `.buro/` |
| `PROJECT_DAEMON_URL` | CLI WebSocket endpoint | `ws://127.0.0.1:4341` |
| `PROJECT_ID` | Selected CLI project ID | built-in Buro project |

To connect the UI to another local daemon, use `?daemon=ws%3A%2F%2F127.0.0.1%3APORT`. To open a project directly, use `?project=p-ID`.

## Recovery and limits

Stopped runs preserve their worktree and history. Edit the goal, continue with clarification, or rerun checks without implementation. Continuing can reuse the saved coordinator session; old attempts remain inspectable. See [recovery](RECOVERY.md).

There is no total goal time limit. The service stops a stalled turn after **10 minutes without coordinator or child-agent progress**. Time-policy editing is a disabled TODO in settings. Command checks, environment setup, readiness and delivery have separate bounded timeouts.

Event snapshots use deltas. Automatic garbage collection removes only owned atomic-write temporary files older than one day. Worktrees, historical material copies and dependency caches are retained until an explicit retention policy is implemented. See the [roadmap](ROADMAP.md).

Further details: [UI architecture](UI-ARCHITECTURE.md), [user repositories](USER-PROJECTS.md), [execution PoC](GOAL-EXECUTION-POC.md).
