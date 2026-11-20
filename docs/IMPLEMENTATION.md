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

Before this refactor, module import boundaries and Cordis composition were in place. Execution used a single Codex adapter, consumed native event payloads in core, asked Codex to create workers, and rejected concurrent project runs. Ollama and DeepSeek were not implemented. The audit passed 37 focused boundary/execution/recovery/storage tests; this is historical baseline evidence, not provider acceptance.

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

## Resource routing and isolation increment

Private machine configuration now defines connections, managed/native runtimes and local-only or hybrid profiles. Projects can inherit or pin a profile. Each run freezes its role routes, policy and configuration revisions. The runtime router persists Buro session handles and client-start intents separately from native references, rejects mismatched continuations and never substitutes the current default for an existing session. Research, environment preparation, workers, integration, review and result preparation use this routing; owner-run identity is explicit for derived activities.

Daemon and CLI commands expose metadata, configuration initialization, model discovery, explicit bounded probes and default-profile selection. Credentials remain environment references. Capability probes are a core application service with durable receipts; neither opening settings nor selecting a profile starts inference. The minimal Mantine settings interface adds machine defaults and per-project inheritance, and the inspector displays saved requested/reported model identity.

Manual managed repair saves new scope revisions while retaining historical criteria/materials. Workers retain assignment boundaries. Unknown tool or client-start outcomes stop continuation. Managed commands are restricted from private client/daemon data and network access; explicit service-owned environment setup can use the network. Managed Docker execution fails closed until equivalent private-data isolation exists.

Independent reviews also required hardening host-side Git operations: configured hooks, filters, diff drivers and network helpers must not be activated by generated files during workspace inspection, checkpointing or local apply. Regression cases use hostile attributes and synthetic repositories. These protections supplement the tool executor because the service also reads and commits changes after model work.

Deterministic HTTP-fixture goals cover Ollama, DeepSeek and a mixed team through real repository tools, service checks and fresh review without Codex. Live evidence remains separate. Initial Qwen3 4B probing showed that combining Ollama tools and JSON format can suppress native tool calls; the managed route now uses a tool phase followed by a bounded tools-free JSON turn. A passing capability probe does not establish coding acceptance.

Validation after resource routing and isolation: 193 default tests passed, including hostile Git configuration, symlink ancestors, local-only policy, saved-route recovery, revised material scope, endpoint cancellation and HTTP-backed mixed-team acceptance. Type checking, production build, frontend/backend formatting and local documentation links passed. Five delegated implementation/review tasks covered routing, recovery, live validation, interface checks and isolation; findings were fixed before commit.

Opt-in live evidence on the user's 16 GB Mac: Qwen3 4B was downloaded, and one native tool-to-JSON diagnostic passed after separating the phases. A tiny synthetic coding goal then exhausted its 2048-token planning output before edits or review. The final bounded attempt stopped at the probe because the model requested the diagnostic tool twice rather than once; it never reached the goal's increased 4096-token limit. Across three attempts there were five local generations, no cloud calls and no changes to the user's default or original project source. The live coding gate remains open. DeepSeek's live gate also remains open because no API credential is configured. Sanitized local reports are under ignored `artifacts/live-ollama-*.json`; `scripts/check-live-ollama.cjs` reproduces the opt-in check against a temporary repository.

The next orchestration increment is bounded coordinator decisions and reusable/proposed specialists. A general task graph, parallel project runs and SQLite remain separately tracked work; the resource increment does not claim those capabilities.

## Resource interface increment

The resource settings interface uses Mantine controls and the public command client. Profile selection changes future runs without starting inference. Diagnostics are explicit, model discovery is lazy, and missing DeepSeek credentials remain visible. Project settings preserve an explicit profile when the machine default changes; clearing the override restores inheritance. Catalog failures show an error and a retry control instead of hiding the field. The run inspector uses saved session identity. The resource accordion uses automatic height without a height transition so asynchronously added model rows cannot clip its final explanation.

Browser validation uses a temporary repository, the production project configuration service and deterministic HTTP responses. It verifies persisted machine defaults, saved/exported project overrides, reload, return to inheritance, catalog outage/retry, exactly one discovery request and two explicit diagnostic requests, no private continuation in the DOM, and light/dark layouts. Type checking, production build and formatting passed. Local Qwen3 4B was registered as an optional private profile; the machine default remains Codex. This registration does not change the open live coding gate.

## Interruption contract increment

Both actual managed HTTP adapters now share integration cases through RuntimeRouter, private route/session files and real repository edits. Incomplete tool streams dispatch nothing. A lost round after a durable edit preserves provider-native continuation and its tool result across fresh runtime/router instances; explicit resume edits once and does not reselect the route. Cancellation before or after an edit interrupts active and queued generations, persists intent and releases endpoint capacity. Exact request counts detect automatic retries; private fields remain outside public events.

Native Codex parity checks found a production bug: cancellation before the `turn/start` reply could still wait for the 45-second RPC timeout. Its RPC wait now accepts cancellation and cleans pending entries, timers and listeners. An unknown native outcome closes the owned transport and blocks further submission until explicit resume; known turns use native interrupt. A partial visible answer followed by process exit remains a failure. The regression was observed failing before the fix and passing afterward. Local transport closure is not proof of remote inference termination.

Independent architecture review verified the boundaries and the retry/cancellation assertions. The [runtime evidence matrix](RUNTIME-CONTRACTS.md) maps common guarantees to native and managed contracts while preserving their different continuation capabilities. Live model acceptance, automatic crash reconciliation and dynamic task graphs remain open.

Validation after this increment: all 205 default tests passed, including the 12 new native/managed interruption cases. Type checking, formatting and documentation link checks passed. This stage made no live or paid requests and did not modify original user repositories or resource defaults.
