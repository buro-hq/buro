# Buro

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="branding/logo-light.svg">
  <img src="branding/logo.svg" alt="Buro Links logo" width="240">
</picture>

Buro is a local app for running coding tasks with Codex CLI. Connect a Git repository, describe a change, and choose the checks it must pass. Each task keeps its goal, plan, agent sessions, commands, diff and review in one place.

Work happens in a separate Git worktree. You can inspect the result, apply it to your branch, or have Buro open a draft PR. A coordinator plans the work and selects workers when needed; a separate reviewer checks the result.

Buro is still in development. It runs on your machine and uses your installed, signed-in Codex CLI.

![Buro project office with the coordinator, developer, test author and reviewer](docs/images/office.png)

*Screenshots show the actual interface with a fictional project and sample run data.*

## Run locally

You need Node.js **24+**, npm, Git, and an authenticated Codex CLI. Connected repositories must have at least one commit. Native command execution uses macOS `sandbox-exec` or Linux `bubblewrap`; a Docker provider is also available.

```sh
git clone https://github.com/buro-agents/buro.git
cd buro
npm ci
npm start
```

Open **http://127.0.0.1:4317**. `npm start` runs the local service and frontend together; Ctrl+C stops both. There is no packaged desktop app yet.

Draft PRs also need an authenticated GitHub CLI (`gh`) and a GitHub remote for the connected repository.

## Your first task

1. Open **Projects → Connect project** and select a Git repository.
2. Let Buro suggest the project setup, or enter it yourself. Review the base branch, allowed paths, protected files and check commands before saving.
3. Create a goal. Describe the change and how you will know it works. Attach relevant files or images if needed.
4. Choose the checks and start the run.
5. Read the diff, check results and review. Apply the result to your branch, keep it in the worktree, or use the configured PR or delivery action.

For example, a goal can ask for CSV export and specify which rows to include, how to escape values, and what to test:

![Creating a goal with its context, acceptance criteria and local result selected](docs/images/goal.png)

Project setup research reads the repository and proposes settings. Saving a proposal does not install packages, start servers or deploy the project.

## What to use it for

- **Fix a bug with a known reproduction.** Attach the failing input or a short log. Ask for a regression test and keep the change within the affected module.
- **Add a small feature.** For example: “Search the activity log by agent name or message. Ignore case, keep event order, and show all events for an empty query.”
- **Refactor code with existing tests.** For example: “Move CSV parsing into a helper without changing the public API.” Run the existing checks against the result.
- **Continue a stopped task.** Add clarification to the saved goal, repair the same worktree, or rerun checks without starting implementation again. A new goal can also build on a completed parent run.

Keep a goal small enough to review as one change. The project settings control which paths agents may edit and which checks Buro runs.

## Inspect the result

The run view shows the plan, timeline, changed files, check output and reviewer findings. You can replay the saved history or open an individual agent's commands and messages.

| Read the diff | Inspect checks and review |
| --- | --- |
| [![The Changes tab showing the activity-search diff](docs/images/changes.png)](docs/images/changes.png) | [![The Checks tab showing test results and independent acceptance criteria](docs/images/checks.png)](docs/images/checks.png) |

Applying a result is a separate action that checks the source branch and working tree. PR delivery and deployment follow the project settings. Deployment requires configured commands and verification; see [delivery setup](ONBOARDING-AND-DELIVERY.md).

## Files and saved work

Each connected repository stores its profile and local state in `.buro/`. Goals, roles, run history and worktrees survive closing the interface. The shared profile is `.buro/project.json`; runtime state, attachments and machine settings should stay out of Git.

Project materials are available to future goals. Goal attachments belong to that goal. Runs keep a snapshot of the materials they used. Text, code, images, PDF and DOCX are supported, with an **8 MiB per-file limit**. PDF/DOCX text extraction depends on tools available on the host; OCR is not included.

The interface supports **English and Russian**, five palettes, and light/dark/system modes. The default is **Cobalt light**. Appearance and language preferences are saved in the browser.

## CLI

The CLI uses the same local service as the interface:

```sh
npm run cli -- projects
npm run cli -- project connect /absolute/path/to/repository
PROJECT_ID=p-ID npm run cli -- goal create "Add search" "Search agent names and messages" "Ignore case and preserve order"
PROJECT_ID=p-ID npm run cli -- run start G-ID
PROJECT_ID=p-ID npm run cli -- run watch R-ID
```

Use the project and goal IDs returned by the preceding commands. See [development notes](docs/DEVELOPMENT.md) for service configuration and additional commands.

## Current limits

- Codex CLI is the only agent runtime included.
- A run stops after 10 minutes without coordinator or child-agent progress. Checks, environment setup and delivery have their own timeouts.
- Worktrees, past attachments and dependency caches are retained. Automatic cleanup only removes stale temporary writes.
- This is a local tool. The service listens on loopback; it is not a hosted or shared team service.

## Development

```sh
npm test
npm run build
```

[Development and configuration](docs/DEVELOPMENT.md) · [Project setup](USER-PROJECTS.md) · [Execution flow](GOAL-EXECUTION-POC.md) · [Recovery](RECOVERY.md) · [UI architecture](UI-ARCHITECTURE.md) · [Roadmap](ROADMAP.md) · [Branding](branding/README.md)
