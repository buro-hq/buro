# Buro roadmap

[VISION.md](VISION.md) defines the product, [ARCHITECTURE.md](ARCHITECTURE.md) defines the target boundaries, and [provider integration](docs/PROVIDERS.md) defines the first direct model connections. This roadmap distinguishes shipped behavior from the next milestone.

[Implementation sequence](docs/IMPLEMENTATION.md) records the agreed order: refactor the current route, add Ollama and DeepSeek, then expand orchestration and the production interface.

The current production runtime is Codex CLI. The first multi-provider milestone includes **Ollama and the DeepSeek model API**, a shared Buro-managed runtime, and delegation controlled by Buro. DeepSeek Harness is a reference and possible later runtime, not a prerequisite.

## First milestone

[Private-project evaluation details removed.]

The milestone is ready when Ollama and DeepSeek can each complete a supported verified coding goal without Codex installed, and Buro can complete a mixed-provider goal with independently recorded sessions. A successful chat response, provider selector or simulated office is not sufficient.

Full automatic crash reconciliation, a general task graph and concurrent project runs are not prerequisites for the first provider integration. Conservative interrupted-state recovery is acceptable for that slice when it preserves work and never fabricates success or silently repeats an unknown side effect.

## Next orchestration slice

- [ ] Expand the delegation protocol into a versioned task graph with bounded replanning and targeted evidence invalidation.
- [ ] Replace PROJECT_BUSY and the fixed two-worker plan schema with queued runs, multiple runs per goal, resource budgets and one writer per run worktree initially.
- [ ] Add durable operator questions and clarifications that block only dependent work.
- [ ] Add full per-action dispatch reconciliation and resource leases for automatic recovery where the outcome can be established.
- [ ] Complete in-place resource overrides and the reviewed office/feed/materials interaction model using real service state.

## Subsequent runtime integrations

- [ ] Add Claude Agent SDK and ACP adapters using the same runtime contract and capability checks.
- [ ] Evaluate Kimi, GLM and other model/provider routes against the managed runtime instead of duplicating tool orchestration.
- [ ] Evaluate DeepSeek Harness as an optional runtime only if its adapter offers a concrete benefit over the supported routes.
- [ ] Add parallel task worktrees and serialized integration after measuring the benefit over one writer per run.
- [ ] Revisit LangGraph or Temporal only when recovery complexity or multiple execution hosts justify a workflow-runtime change.

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

- [ ] Configurable time policy and inactivity threshold. Current behavior remains no total limit and 10 minutes without coordinator/child progress. The disabled selector in user settings marks future functionality.
- [ ] Richer environment templates and remote/native verification resources, preserving explicit migration/deployment boundaries.
- [ ] Broader capability probes, routing observations and reproducible model-profile evaluation.

## Storage and retention

- [ ] Add a transactional SQLite StateStore adapter with bounded read models, event/outbox/action receipts and backed-up JSON migration. Preserve existing IDs, history and worktree references.
- [ ] Keep large logs, provider continuation and artifacts outside hot domain state; add paginated history and incremental subscriptions for large projects.
- [ ] Configurable retention/archival with a preview of reclaimable space.
- [ ] Reclaim dependency caches/worktrees only under an explicit retention policy. Protect active runs, unapplied results and recoverable work.
- [ ] Reclaim unreferenced context blobs and private checkpoints after a retention period, preserving references needed for accepted evidence and recoverable attempts.
- [ ] Show storage usage by context, worktrees, checkpoints and dependency caches.

## Context and delivery

- [ ] Browse/reuse previously imported goal materials and explicitly promote useful outputs to project input.
- [ ] Cross-platform document extraction, optional OCR and inline material previews.
- [ ] Additional PR providers and delivery integrations.
- [ ] Packaged application/global CLI distribution and coordinated service startup.
