# Implementation sequence

Agreed on 20 November 2026: preserve the product decisions, refactor the existing execution boundaries, add Ollama and the DeepSeek model API, then expand orchestration and the production interface toward the complete vision.

## Sources of truth

- [Product vision](../VISION.md): users, automation, quality, entities and interaction.
- [Architecture](../ARCHITECTURE.md): ownership, ports, composition and recovery guarantees.
- [Provider contract](PROVIDERS.md): shared managed runtime and provider-specific behavior.
- [Roadmap](../ROADMAP.md): delivered behavior and remaining milestones.
- [Current execution](../GOAL-EXECUTION-POC.md) and [recovery](../RECOVERY.md): operational behavior, not target capabilities.
- [UI architecture](../UI-ARCHITECTURE.md): production/prototype boundaries. The prototype is a design reference, not a working execution backend.

## 1. Refactor the existing route

- [x] Translate native Codex events in the adapter; give core a typed, provider-independent event contract.
- [x] Extract runtime-event projection from execution decisions without changing saved run/history formats.
- [x] Introduce a runtime registry independent of Codex composition, preserving existing consumers and explicit lifecycle cleanup.
- [x] Move worker creation and assignment identity under Buro ownership. Remove native spawn-agent requirements and prompt-based role matching.
- [x] Preserve trusted checks, fresh read-only review, role promotion, workspace isolation, cancellation and conservative recovery throughout.

Keep each step usable and verified. A registry alone does not implement provider routing, durable sessions or cross-provider delegation.

## 2. Add both direct providers

Implement the shared managed runtime, scoped tools, durable action IDs and private checkpoints. Connect Ollama native API and DeepSeek Chat Completions through separate ModelProvider adapters. Include provider selection in project research and environment preparation, so a supported managed goal does not depend on Codex being installed.

Use deterministic fake-provider contracts by default. Live model requests are opt-in. Gate the milestone on verified goals through each provider and a mixed team, including local-only policy, limits, cancellation and honest interrupted outcomes.

## 3. Complete the product model

Expand bounded delegation into Task/Attempt/AgentSession history and replanning. Add resource queues, multiple runs, durable questions and targeted evidence invalidation. Connect the approved compact project, goals, office/timeline/feed, roles and materials interface to real service state. Move storage to SQLite separately when required by the workload.

[Private-project evaluation details removed.]

## Current baseline

Before this refactor, module import boundaries and Cordis composition are in place. Execution still uses a single Codex adapter, consumes native event payloads in core, asks Codex to create workers, and rejects concurrent project runs. Ollama and DeepSeek are not implemented. The audit passed 37 focused boundary/execution/recovery/storage tests; this is baseline evidence, not provider acceptance.

## Refactor progress

The first increment normalizes Codex activity in `adapters/codex/events.ts`, defines the runtime-event union in `core/runtime-events.ts`, and moves saved run projection into `core/runtime-projection.ts`. Execution and project research consume normalized events. Duplicate delivery is suppressed only after successful persistence; text deltas remain outside domain transactions. Saved run DTOs and history encoding are unchanged.

`core/runtimes.ts` provides an explicit process-local catalog with duplicate/missing-route errors and coordinated disposal. `plugins/runtime.ts` composes it independently of Codex. Existing consumers retain the selected default adapter. This does not yet implement per-session model routing, capability probes or provider integrations.

Buro now persists worker dispatch intents and session IDs before opening clients, starts independent worker sessions itself, snapshots role/runtime identity, and saves formal results. A worker's observed edits must stay inside its assignment, including not reverting another worker's edits. Workers run sequentially in one run worktree. The coordinator integrates their results; the service still owns checks and fresh review. Native child tools are disabled in the production Codex configuration. Undeclared children can appear as unassigned activity but cannot satisfy planned roles. Existing historical runs can still be rechecked; explicit repair dispatches new Buro-owned assignments.

Validation after the event/catalog increment: 124 default tests passed. After Buro-owned delegation: all 128 default tests pass, including dispatch persistence, independent worker/coordinator sessions, impersonation rejection, worker cancellation, assignment scope, native adapter fixtures, event normalization, redelivery after failed persistence, registry selection/disposal, independent review, recovery, storage and transport. Type checking and the production build pass. Tests use synthetic repositories and adapters, not paid model calls or the user's example project source.

The shared managed runtime is implemented in `core/managed-runtime.ts`, with ModelProvider/ToolBroker/checkpoint ports in `core/model-ports.ts`. It persists request budgets, tool intents and results before continuing the conversation; duplicate tool IDs, exhausted budgets and unreconciled actions stop execution. Cancellation intent and private provider continuation survive in separate checkpoints. Context uses a conservative UTF-8-byte token upper estimate, not billed usage. Provider-reported usage is recorded separately when available.

`RepositoryTools` provides bounded reads, listing, literal search, exact edits, actual tracked/untracked diffs and exact configured check commands. Read-only sessions cannot edit or run commands. Writes validate assignment paths, symlinks and protected package fields; commands use the existing confinement executor and do not fall back to the host. Private metadata/secrets are excluded; only explicitly selected material files can be read from private context storage. Checkpoints use private atomic files with serialized writes, outside public project events.

The fake-provider acceptance case performs real file reading/editing and a sandboxed check in an isolated worktree, then passes independent service checks and fresh review without loading Codex. Additional contracts cover persistence failures at action boundaries, duplicate IDs, context limits, cancellation and scope restrictions. Live-provider acceptance is still pending.

Validation after the managed-runtime increment: all 133 default tests, type checking and the production build pass. No live model calls are part of this evidence.

Both provider transports are implemented in `adapters/models/`. Ollama uses native model discovery/details and NDJSON chat, checks advertised tools/context/thinking settings, and rejects cloud-backed routes. DeepSeek uses Chat Completions SSE with fragmented multi-tool calls and preserves required private reasoning continuation. Both report observed usage when available, bound response sizes, reject incomplete streams and share an abortable endpoint-capacity gate. Credentials are injected privately and never copied into model checkpoints. No automatic retry or provider fallback is performed after an interrupted response.

Validation after the transport increment: 138 default tests passed, including chunk boundaries/UTF-8, continuation across tool rounds, missing credentials, malformed/truncated responses, remote-model rejection and queued cancellation. Type checking and the production build passed; subsequent endpoint/thinking validation changes passed focused provider contracts and type checking. These are deterministic HTTP fixtures, not live-provider acceptance.

Next: per-session resource profiles, durable routing and daemon/CLI integration for research, environment setup and goal execution. Preserve the configured profile and data policy for each run, use Buro handles for client thread references, and never change an existing session's provider by following a newly selected default. Add end-to-end HTTP-fixture goals for each route and a mixed team before opt-in live probes.
