# Buro roadmap

Buro currently runs tasks through Codex CLI. The next priority is support for other coding clients and model providers. The items below are planned; they are not available yet.

## First: more clients and providers

- [ ] Make runtime selection a project setting. Keep Codex working through the same adapter interface.
- [ ] Add a Claude Code adapter: start, stop and resume sessions; show tool calls, output and errors in the run timeline.
- [ ] Add support for Kimi, GLM and DeepSeek through suitable coding clients or provider APIs. Choose the integration route for each after checking its capabilities.
- [ ] Configure the client, provider, model and endpoint locally. Keep API keys out of project profiles, exported settings and logs.
- [ ] Choose different clients or models for the coordinator, workers and reviewer. Save those choices with each run.
- [ ] Check client capabilities before starting a run, including structured output, tool execution, cancellation and session recovery. Explain unsupported operations in the UI.
- [ ] Run the same task, check and recovery scenarios against each adapter before marking it supported.

## Delivered

- [x] Local service with independent UI and CLI clients; pure core and Cordis composition.
- [x] Per-project profiles, roles and history; project research and configuration.
- [x] Versioned role selection/creation, real workers, checks and independent review.
- [x] Isolated Git workspaces, saved attempts, repair and check-only recovery.
- [x] Optional isolated dependency repair without changing check commands.
- [x] Local previews, draft PR delivery, confirmed deployment and delivery retries.
- [x] Event deltas and conservative collection of stale atomic-write temporary files.
- [x] Shared path picker and project/goal context materials.
- [x] Buro naming and repository/prototype consolidation.
- [x] Backed-up, resumable migration from the legacy metadata directory to `.buro`.
- [x] English source and current documentation; English/Russian UI preferences.
- [x] Installation/development README with real screenshots.

## Execution and operator controls

- [ ] Configurable time policy and inactivity threshold. Default remains no total limit and 10 minutes without coordinator/child progress. The disabled selector in user settings marks future functionality.
- [ ] Queue of concrete operator questions/approvals with durable answers.
- [ ] Broader project types and environment templates, preserving explicit migration/deployment boundaries.
- [ ] More runtime compatibility checks and adapter observability.

## Storage and retention

- [ ] Append-only event segments with bounded hot checkpoints for long-lived projects.
- [ ] Configurable retention/archival with a preview of reclaimable space.
- [ ] Reclaim dependency caches/worktrees only under an explicit retention policy. Protect active runs, unapplied results and recoverable work.
- [ ] Reclaim unreferenced context blobs after a retention period, preserving references from goals, runs, attempts and durable receipts.
- [ ] Show storage usage by context, worktrees and dependency caches.

## Context and delivery

- [ ] Browse/reuse previously imported goal materials.
- [ ] Cross-platform document extraction, optional OCR and inline material previews.
- [ ] Additional PR providers and delivery integrations.
- [ ] Packaged application/global CLI distribution and coordinated service startup.
