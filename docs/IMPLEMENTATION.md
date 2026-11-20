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

Initial opt-in live evidence on the user's 16 GB Mac: Qwen3 4B was downloaded, and one native tool-to-JSON diagnostic passed after separating the phases. A tiny synthetic coding goal then exhausted its 2048-token planning output before edits or review. A later bounded attempt stopped at the probe because the model requested the diagnostic tool twice rather than once; it never reached the goal's increased 4096-token limit. Across those three attempts there were five local generations, no cloud calls and no changes to the user's default or original project source. At that stage DeepSeek had no configured credential. Subsequent live evidence is recorded below; sanitized local reports remain under ignored `artifacts/live-*.json`.

The next orchestration increment is bounded coordinator decisions and reusable/proposed specialists. A general task graph, parallel project runs and SQLite remain separately tracked work; the resource increment does not claim those capabilities.

## Resource interface increment

The resource settings interface uses Mantine controls and the public command client. Profile selection changes future runs without starting inference. Diagnostics are explicit, model discovery is lazy, and missing DeepSeek credentials remain visible. Project settings preserve an explicit profile when the machine default changes; clearing the override restores inheritance. Catalog failures show an error and a retry control instead of hiding the field. The run inspector uses saved session identity. The resource accordion uses automatic height without a height transition so asynchronously added model rows cannot clip its final explanation.

Browser validation uses a temporary repository, the production project configuration service and deterministic HTTP responses. It verifies persisted machine defaults, saved/exported project overrides, reload, return to inheritance, catalog outage/retry, exactly one discovery request and two explicit diagnostic requests, no private continuation in the DOM, and light/dark layouts. Type checking, production build and formatting passed. Local Qwen3 4B was registered as an optional private profile; the machine default remains Codex. This registration does not change the open live coding gate.

## Interruption contract increment

Both actual managed HTTP adapters now share integration cases through RuntimeRouter, private route/session files and real repository edits. Incomplete tool streams dispatch nothing. A lost round after a durable edit preserves provider-native continuation and its tool result across fresh runtime/router instances; explicit resume edits once and does not reselect the route. Cancellation before or after an edit interrupts active and queued generations, persists intent and releases endpoint capacity. Exact request counts detect automatic retries; private fields remain outside public events.

Native Codex parity checks found a production bug: cancellation before the `turn/start` reply could still wait for the 45-second RPC timeout. Its RPC wait now accepts cancellation and cleans pending entries, timers and listeners. An unknown native outcome closes the owned transport and blocks further submission until explicit resume; known turns use native interrupt. A partial visible answer followed by process exit remains a failure. The regression was observed failing before the fix and passing afterward. Local transport closure is not proof of remote inference termination.

Independent architecture review verified the boundaries and the retry/cancellation assertions. The [runtime evidence matrix](RUNTIME-CONTRACTS.md) maps common guarantees to native and managed contracts while preserving their different continuation capabilities. Live model acceptance, automatic crash reconciliation and dynamic task graphs remain open.

Validation after this increment: all 205 default tests passed, including the 12 new native/managed interruption cases. Type checking, formatting and documentation link checks passed. This stage made no live or paid requests and did not modify original user repositories or resource defaults.

## Worker model selection increment

Configured profiles can now declare a bounded `workerPool`; every run freezes the complete candidate descriptors and revisions. Historical profiles without that field authorize only their original worker. A coordinator proposes a runtime and reason per planned specialist. A pure resolver enforces Auto/Prefer/Fixed role preferences and local-only policy. User pins remain separate from reusable instructions and coordinator choices never edit the role's preference.

Role preferences are versioned through the existing optimistic `role.save` contract. Older clients omitting the field preserve a saved pin; explicit Auto clears it. The model output schema requires explicit nullable selection fields while the domain parser still accepts historical plans. Changing a reused role during planning rejects the stale plan inside the same transaction that would save its assignments. The next bounded planning attempt receives the refreshed catalog. Accepted decisions retain their original role version even when the role changes later.

The plan transaction saves each selected resource, preference, source and reason. Before dispatch, the service records that exact selection in AgentSession. RuntimeRouter verifies the saved owning run, role snapshot, paths, starting-session intent and configuration against the frozen decision. A missing run cannot bypass the assignment guard. Repair continues using saved role/selection snapshots. A fixed runtime outside the pool stops at `needs-attention` without spending a second planning turn or falling back.

The Mantine team editor exposes Auto/Prefer/Only this model, pool-filtered choices, unavailable saved selections and catalog retry. The inspector displays actual resources and selection reasons. Coordinator, reviewer and operational roles remain profile-controlled in this increment. Automatic initial-coordinator selection, dynamic team changes, measured quality/cost routing and goal overrides remain open.

Five agents covered the contracts/resolver, interface, integration tests and two independent architecture/recovery reviews. HTTP-backed goals verify two workers using different models with real edits, service checks and fresh review. Additional cases cover invalid proposals, fixed conflicts, non-retryable unavailable pins, role edits during planning and after dispatch, tampered/missing assignments, saved-route restart and legacy recovery. Browser fixtures verify real role versions, reload, preserved instructions, pool filtering and zero inference from preference editing. No live or paid requests were made for this increment.

## Live-provider readiness

Private credential loading now supports a mode-0600 local record alongside environment references; keys never enter catalog DTOs or process-environment mutations. Tool-only capability requests no longer force DeepSeek JSON mode. Ollama introduces the final schema after work and projects completed commentary only when thinking is explicitly disabled. Core-owned intermediate-note markers are validated and persisted atomically with the following serialization request; raw durable history is retained.

The opt-in shared runner bounds the entire evaluation, including diagnostics, workers, repairs and fresh review: 24 generations, 65,536 reserved output tokens, a 120-second diagnostic limit and a five-minute coding limit. Reservations happen before HTTP and are not refunded. The sanitized report records observed usage, unknown accounting, model identities and separate failure classes; no automatic retries or provider fallback occur. Default tests never call live providers.

On 20 November 2026, `deepseek-flash` passed a synthetic one-line repair through real repository tools, service checks, fresh independent review and accepted commit, without Codex installed in the fixture. The run took about 18 seconds and used 12 generations including diagnostics, with observed usage of 31,430 input and 882 output tokens. Its configured context was 32,768 tokens; the 16,384-token attempt had stopped at the conservative context guard. Monetary cost is unknown. This proves one bounded route, not broad coding quality.

Qwen3 4B remains unaccepted as an all-local coordinator. At context 16,384/output 4,096, a later diagnostic passed and a real worker made the correct edit, but the coordinator hit the context guard before service acceptance and fresh review. A separate manual check after failure passed and is explicitly not acceptance evidence. Nine generations stayed within the shared budget. Local context was not increased on the 16 GB machine, and duplicate diagnostic calls remain failures.

Validation after these changes: 271 default tests, type checking and production build pass. Delegated architecture/recovery review also passed 78 focused contracts. Original user project repositories and the machine's default resource profile remain unchanged. Mixed and source-derived evaluations are separate gates.

## Compact managed assignments

The coordinator can now propose a versioned compact task per worker: objective, exact public file inputs, expected result and criteria. Core validates and saves it with the plan, then persists a complete worker envelope before dispatch. Workers receive their task instead of a duplicated full goal; legacy plans keep the whole goal without silent truncation. All check identities remain in the envelope, diagnostic excerpts share a 2,048-byte bound and full evidence remains in the run. Materials appear once as staged references. Edited goals invalidate old compact tasks on manual continuation.

One automatic refinement per run is allowed only for a known managed context/incomplete-output failure after the actual turn, scope inspection, event flush and client release have settled. Core saves the consumed refinement intent before asking the coordinator. Only objective and a subset of original inputs may change; expected result, criteria, role, resource and write scope remain fixed. Successful roles are not dispatched again. Unknown outcomes, cancellation, infrastructure/persistence errors and a second failed attempt stop normally. Snapshot/event schemas retain the saved contract and consumed intent across restart.

`ManagedRequestPolicy` is a pure core extension supplied through resource composition/Cordis. The default counts only the actual phase schema and can reduce the output reservation to fit remaining conservative context. It never raises context, drops messages or weakens tool authority. Core independently validates plugin decisions. Session limits remain frozen, and a policy revision participates in resource identity. At this increment, production limits were per session plus the one-refinement count; the aggregate live-evaluation ledger was separate. The subsequent managed-run ledger is recorded below.

The installed `qwen3:4b` alias was identified as the thinking-only July variant. A separate explicit `qwen3:4b-instruct-2507-q4_K_M` was downloaded and verified by digest. With the new compact route, DeepSeek coordination/review and this local worker completed a synthetic repair: service check passed, fresh reviewer approved, accepted commit recorded and source fixture preserved. The run took about 44 seconds, used 17 generations, and observed 35,654 input / 1,766 output tokens including diagnostics; the worker used 701 output tokens. The variant and prompt/policy changes were combined, so this is route acceptance, not a causal model comparison. A separate all-local 16K-context attempt still stopped after planning at the context guard.

Validation: 302 default tests and production build passed, with five delegated tasks covering compact envelopes, request policy, durable schemas/recovery review, remote inventory and official model research. [GPU host setup](REMOTE-OLLAMA.md) records the remote-inference boundary; original project repositories remain unchanged.

## Durable managed-run budget

The repository review and execution plan were committed before implementation. Five agents covered pure rules/contracts, transactional storage, runtime integration, workflow/tests and independent architecture/recovery review. The existing modular monolith and Cordis boundaries remain intact.

New managed runs create a frozen budget atomically with the run. Defaults: 64 API generations, 131,072 conservatively reserved output tokens and 256 managed tool calls; 8 requests, 16,384 output tokens and 32 tool calls are protected for review. An optional project `managedBudget` policy overrides defaults for new runs. Private operation receipts share the owning project transaction/writer lease with the bounded public `Run.managedBudget` summary. Snapshot/event exports never contain the private ledger.

The runtime reserves before HTTP/tool effects and stores numeric observed/unknown usage before dispatching tools from a response. A grant can lower the output limit but cannot raise session/context limits. No reservation is refunded. Replacement, resume and changed project defaults retain the same ledger. Storage rejects counter removal, policy/receipt rewrites, rewinding terminal observations and clearing a poisoned budget. Replaying an old reservation still checks the current ledger rather than returning a stale project command receipt.

Read-only review purpose is stored privately and cannot be requested by a model. Derived environment work uses its owner run. Standalone research/probes remain outside a goal ledger and keep their existing bounds. Native-only runs retain their behavior; native clients' hidden provider calls are not falsely counted. Legacy activation has explicit unknown prior usage and requires an actual owning run/goal.

Budget stops become `needs-attention` with typed `MANAGED_BUDGET_BLOCKED` details. Invalid/excessive usage is persisted before further work is rejected. Poisoned runs cannot be queued for repair/recheck or accepted after late reviewer/checkpoint completion. UI recovery explains the frozen budget and disables those poisoned-run actions. A full-run wall-time policy and a cancellable cross-session resource lease are not part of this slice.

Validation: 342 default tests, typecheck/production build and changed-file formatting pass. Resource UI verifies budget retention through unrelated profile edits/export/inheritance; project/recovery and localization browser scripts pass. The plan-type duplication was removed by deriving the core type from the protocol schema. No paid/live calls or original-project modifications were made in this stage. Work-segment rotation remains the next stage.

## API connection settings and direct GPU access

Machine settings now add/edit Ollama and DeepSeek API connections through the same validated application command used by CLI. Mantine controls expose endpoint, capacity, Ollama private-network trust and thinking options, or a DeepSeek credential environment reference. Keys are never entered or exported through this form. Metadata discovery and bounded diagnostics remain separate explicit actions. Adding a connection does not invent a runtime or change a profile.

Connection writes are atomic and idempotent with per-connection optimistic revisions; externally edited configuration cannot be overwritten. Saved settings apply after a service restart. Catalogs show active versus pending settings, hide stale successful diagnostics and block discovery/probes/new work for pending connections. Existing owned runs keep their active provider; after restart, incompatible historical resource identities fail closed rather than silently retargeting.

The RTX host now runs Ollama independently in a Windows startup task at `http://192.168.50.10:11434`. Its firewall permits only the Mac's current addresses. The old loopback server and SSH tunnel were stopped before a direct Buro capability diagnostic passed with exactly two local generations. No source project data or paid API was used. Explicit private-network trust preserves local-only routing without accepting cloud-backed Ollama models.

Five agents covered contracts/storage, endpoint trust, runtime/composition, interface/browser checks and independent architecture review. A review finding that remote DeepSeek HTTP could prevent the next daemon startup was fixed in shared validation and covered in backend/browser regressions. Validation: 365 default tests, type checking, production build, changed-file formatting, localization contracts and the expanded resource browser gate pass. The live diagnostic receipt is private ignored evidence at `artifacts/direct-rtx-api-verification.json`. [Current GPU setup](REMOTE-OLLAMA.md) records operation and lifecycle limits; managed work segments remain next.

## Managed worker context segments

Five agents implemented the pure policy, verified workspace evidence, private storage, runtime/composition and deterministic integration/recovery checks, with independent reviews during integration. Only managed implementation assignments rotate; coordinator, reviewer and native clients retain their lifecycle. A tools-free closing handshake consumes the existing allowance and retains required tool results/provider continuation until terminal completion. Core verifies the original assignment baseline and atomically saves the full private archive plus fresh task/scope/evidence handoff before using it. Logical thread/model/role identity, cumulative requests/actions/usage and all turn/session/run ceilings remain unchanged.

Private checkpoints reject archive/counter/receipt rewrites, unresolved generations, incomplete tool chains and stale active-context writes. Handoffs include bounded actual historical tool receipts, not model claims of success. Step events only record progress. Default policy closes after three tool rounds or 60% conservative pressure, with four lifetime windows; it cannot rescue an already oversized unresolved result. Overall workflow deadlines remain separate optional work.

Validation: 412 default tests, typecheck/build and changed-file formatting pass. Live synthetic DeepSeek with a two-round diagnostic policy rotated once and reached service acceptance/fresh review in 16 requests (42,373 observed input / 1,634 output tokens). Two overly short one-round experiments exhausted the window cap; the failure evidence is retained. Mac Qwen Instruct in a mixed route rotated once but falsely claimed unavailable edit permissions, made no edit and was not accepted. There were no RTX requests or original-project changes. Receipts live under ignored `artifacts/live-segments-*.json`. Prioritize check-backed focused feedback next; no small-model quality improvement is claimed from mechanics alone.

## Check-backed managed worker feedback

The shared service CheckPort can now verify a sole managed worker before its terminal work response completes the logical assignment, including an explicit closing `complete`. It uses exact frozen run check IDs/profile and a prepared private execution world. A known failed check creates a core-generated task and fresh window with bounded actual diagnostics and available tool names. At most two feedback transitions share the existing four-window ceiling; service check commands consume both the per-turn action allowance and aggregate managed tool ledger. The final service acceptance checks and fresh reviewer remain mandatory.

Core stores private pending intent before dispatch, then a validated result tied to the observed workspace. Both the adapter and core independently inspect before/after state; changing files, unknown processes, unavailable checks, cancellation and failed persistence cannot trigger automatic repair/replay. Check-feedback archives require the exact immutable completed receipt, scope revision and fingerprint. Multi-worker goals retain the existing coordinator/final-check path until check ownership is mapped. No oracle command definitions or source enter the handoff; diagnostics are bounded and absolute paths redacted.

Five agents covered the check adapter, private journal, runtime wiring, deterministic integration and independent architecture review. Findings fixed: an execution world disappearing before command dispatch must never fall back to the host; managed pools require private preparation even with native defaults; normalized checkpoint command fields must retain the same check-plan revision; post-check evidence cannot become stale; service checks cannot escape per-turn limits. Validation: 465 default tests, production build/typecheck and formatting pass. Live DeepSeek completed one rotation, worker check, final acceptance and fresh review in 17 requests (42,958 input / 1,658 output tokens). Mac Qwen took two actual failed-check feedback steps but made no accepted edit and stopped at the window limit after 15 requests. Neither trial used RTX or modified original projects. Ignored evidence: `artifacts/live-stepchecks-deepseek.json` and `artifacts/live-stepchecks-mixed.json`. Check-state UI and measured source quality remain separate follow-ups.

## Honest check and result presentation

ChecksPanel, RunRail and ResultPanel now share a pure projection over public service evidence. A terminal run with zero checks is not labelled failed checks; null/missing/negative command exits are unavailable, never PASS. A reviewer flag alone is not an approved review, and blocking findings prevent an approved label. Strong result readiness requires service completion, an accepted commit, actual passing checks and independent review with preserved boundaries. Existing apply/delivery permissions are unchanged.

The timeline exposes only the latest observed evidence at the cursor; later check/review results and future command output/exit fields are hidden, including across manual repair iterations. Problems appear first and existing inspection targets are at least 44 pixels. No backend or private check journal is imported into the UI. Validation: 479 default tests, build/typecheck, localization and a real Chromium gate over all three panels in English/Russian pass. The local receipt is `artifacts/checks-ui-verification.json`.

## Model and team onboarding

Resource settings now support API discovery → model → new team profile through Mantine controls and the same CLI/WebSocket command. The user reviews coordinator, primary worker, reviewer, explicit worker pool, local/hybrid policy and optional limits. Existing runtimes are reused; new Ollama definitions use a 16K/2K default instead of increasing Mac context implicitly. Opening/saving starts no inference, downloads or diagnostics. Per-project overrides and role preferences retain their existing meaning.

`resources.setup.save` creates new managed definitions and one new profile atomically under a full semantic configuration revision. Existing IDs/native definitions/default are not overwritten. Receipts are idempotent without rolling back newer settings; stale/external edits, invalid references, data-policy violations and storage failure leave no partial setup. Shared schema definitions remain platform-free, and private credentials are absent from both input and catalog.

Saved definitions remain separate from active catalogs until service restart. Profile selection and model probe revalidate pending state before cached evidence; public mutations are serialized, and metadata/probe admission waits for earlier writes without holding HTTP behind the queue. Old frozen runtime identities remain stable when adding definitions. Model lists are bound to connection revisions across service reconnects, and new profiles require explicit selection after activation. Five agents covered contracts/storage/CLI, lifecycle, wizard/browser behavior, real transport and independent review. Deterministic/browser validation and final test count are recorded in the execution plan; no new live model calls were needed for onboarding.

Final onboarding validation: 507 default tests, production build/typecheck, frontend/backend formatting and independent architecture review pass. Six tests use two real WebSocket clients for competing writes, reconnect/idempotency, pending guards and credential-value exclusion. The isolated resource browser gate exercises stale forms, save failures, local-only rejection, ID collisions/reuse, real service restart without page reload, revision-bound rediscovery, correct ready-after-restart wording and project/role-pool inheritance. It performs only explicit metadata and its pre-existing two fake diagnostic generations; saving never generates. The main service/private machine default was not changed by these temporary fixtures.

## Managed coordinator planning — 2026-11-21

New managed runs freeze `bounded-planning-v3` before execution (historical v1/v2 keep their original algorithms). Planning receives the full goal/criteria, project context, permitted/protected paths and routing preferences, with bounded diagnostic/catalog excerpts and an explicit 24 KB required-input envelope. The planning turn advertises no tools, rejects any requested tool before effects and directly requests structured output on Ollama. Its private turn-authority journal is append-only and persisted before generation. Repository/material discovery belongs to implementation; successful plan validation restores ordinary tools without expanding the session scope or resetting any budget. The existing two-attempt plan validation limit remains.

New native runs explicitly freeze legacy planning; historical runs without a policy remain legacy on resume. Planning policies and attempt history cannot be rewritten in project storage. Native Codex rejects unsupported tools-free turns rather than pretending to enforce them. Its optional model/effort/network settings are shared by completed and submitted turns; benchmark usage can be observed, but internal native API request/token ceilings are not enforced by the managed ledger.

Architecture review and full validation: 540 default tests passed, production build/typecheck and formatting passed. The reproducible cross-model comparison is a separate validation stage; these deterministic checks establish workflow boundaries rather than model coding quality.

The first cross-model matrix exposed a second planning cost: repeating the complete brief/schema after an invalid plan can exhaust a 16K session before the correction HTTP request. V2 compresses service guidance and sends only the exact validation error on its existing second attempt, retaining the full original brief/assistant response in the same history. Concurrent role edits send the updated catalog/pins. No estimator or limit was relaxed. Exact 5.3 KB reply tests enforce at least 1,024 output tokens of correction headroom at 16K and retain the negative v1 case; full managed workflow coverage includes worker, integration and fresh review.

V2 validation: 558 default tests passed, production build/typecheck and formatting passed; independent architecture review found no blocking issue. Live v2 quality remains separately evaluated.

The live v2 Qwen pilot completed both planning generations but twice exceeded the frozen one-worker bound. New v3 runs additionally derive `team.maxItems` in the planning output schema from `min(schema hard cap, frozen maxWorkers)`; complete server-side plan/scope/resource validation still runs. Saved v2 retains compact text with its prior generic schema, and saved v1 retains full-brief retries. Native legacy stays unchanged.

Worker diagnostics also exposed a real broker defect: `search_text` accepted a file target but attempted `readdir`, returning `ENOTDIR` (two local and four mixed-worker occurrences in the v1 fixtures). File targets now use the same validated filename, no-follow reader, size/binary/privacy checks and bounded match output. Directory behavior and write scope are unchanged. Regression coverage includes the actual managed worker tool journal, check-feedback repair, protected-write denial and cumulative budgets; a successful tool fix alone does not prove model quality.

V3 plus broker repair validation: 567 default tests, production build/typecheck, formatting and independent runtime boundary tests passed. Prior failed v1/v2 live receipts remain saved.
