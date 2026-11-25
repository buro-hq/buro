# Execution plan after repository review

Requested by the user: complete the review, save the plan, then use five agents to implement it. Baseline and findings are in [REVIEW-2026-11-20.md](REVIEW-2026-11-20.md). Each stage ends with tests, architecture review, a separate local commit and a short report; continue within the approved scope.

## Stage 1 — durable managed-run budget

Address R1, R2 and the storage boundary in R7 first. This is the foundation for work segments.

### Contract

- One authoritative ledger per project/run, shared by Buro-managed coordinator, workers, replacement attempts, derived environment sessions and fresh reviewer. Model API calls and managed tool calls are covered; native Codex provider requests are explicitly outside this initial metering capability.
- Keep full reservations/operation receipts private in `ProjectDocument`, committed through the existing `ProjectStore.transact` and writer lease. Export only a bounded `Run.managedBudget` summary and frozen numeric policy. No parallel private-file counter or process-global mutable budget authority.
- Version limits for aggregate generation requests, conservatively reserved output tokens and managed tool calls. Protect a fixed subset of each for review. Freeze policy for an attempt; resume/replacement/default changes cannot reset or expand it.
- Add an optional advanced project profile policy; new managed runs use a documented default. Legacy runs attach with explicit prior-usage-unknown coverage, never claim reconstructed lifetime usage. Native-only runs retain current behavior.
- Reserve atomically before provider/tool dispatch. Smaller output caps may fit remaining unprotected allowance; keep a usable minimum and existing per-session/context limits. No refunds, retries or provider fallback based on low/missing usage.
- Record only observed numeric usage. Provider output above its reservation poisons the ledger and stops further work after the evidence is durably saved. Missing responses remain conservatively charged/unknown.
- Persist the budget observation before dispatching tools from the response. Persistence failure prevents the next external effect.
- Classify review from the service-owned immutable purpose/read-only session, not model output. Project/run identity must match the saved scope; unknown owning runs fail closed.
- Stop with a typed resource/budget outcome; keep scope, acceptance and recovery rules unchanged.

Initial defaults to validate in implementation: 64 managed generation requests, 131,072 reserved output tokens, 256 managed tool calls; protect 8 requests, 16,384 output tokens and 32 tool calls for review. These are guardrails, not model-specific quality claims or monetary accounting. Per-request output remains bounded by the runtime and request policy. An overall workflow wall-time limit is Stage 2 work, not implied by this ledger.

### Five-agent ownership

Four concurrency slots include the primary agent, so execute five delegated tasks in two waves:

1. **Budget contracts and pure rules:** protocol schemas/types, core port and pure reservation/usage rules; atomicity-independent tests.
2. **Transactional persistence:** adapter over the project transaction, private ledger validation, compact public summaries, restart/idempotency/concurrency tests. Wait for the contract before mutation integration.
3. **Managed integration:** private purpose/checkpoint fields, request/tool gates, resource factory/Cordis wiring and owned-run classification. Preserve unknown-action and existing resume contracts.
4. **Workflow and verification:** initialize frozen budgets with new runs, retain them on continuation, typed outcomes; cross-role/repair/restart integration tests with fake providers. No live costs.
5. **Independent architecture/recovery review:** inspect all final changes for ordering, spoofing, counter reset, private-data leakage, review-reserve bypass and native compatibility. Fix findings before commit.

[Private-project evaluation details removed.]

### Acceptance

Meaningful deterministic checks: two workers and coordinator cannot collectively exceed a cap; review remains possible after work allowance is spent; output caps shrink without raising context; replacement/resume/reopen retain all charges; duplicate operations are idempotent and conflicts fail; unknown usage remains charged; malformed/over-reservation usage stops later effects; a failed transaction/checkpoint dispatches no subsequent request/tool; derived environment uses its owner budget; transport round-trips summaries without private receipts; native routes are not falsely metered.

Run relevant focused suites, then full `npm test`, production build, formatting/boundary checks and the affected browser resource/project scenarios. Live provider calls are not required to establish ledger correctness and remain separately bounded/authorized.

## Stage 2 — work-segment protocol and lifecycle

Implementation order: 2A introduces safe managed-worker context segments; 2B tracks a separately persisted optional workflow deadline. After the live Qwen trial, prioritize Stage 3's check-backed loop before 2B: the observed failure is a worker claiming absent edit permissions, while existing request/token/tool ceilings stop excess work. Use five agents, review boundaries during integration, then test, commit, report and continue. Live testing now uses DeepSeek and Ollama on the Mac only; the RTX computer is being switched off.

### Stage 2A contract

Only implementation sessions with a real worker assignment and injected workspace evidence use segments. Keep a single logical managed/router session and the original model/role/scope. A pure injected policy (initially three completed tool rounds or 60% conservative context pressure, at most four windows per session) asks for a tools-free closing handshake. The full provider/tool-result chain remains intact through this response. Invalid, incomplete or unknown outcomes cannot trigger automatic rotation.

Core compares verified current workspace fingerprints against the original assignment baseline, including disappeared entries and prior specialists' changes. A model's bounded next-task text remains an untrusted proposal. Archive the full previous private messages/continuation and activate the fresh task/scope/evidence handoff in one checkpoint write, adopting it only after persistence. Retain cumulative requests, usage, actions and all per-turn/session/run limits; closure overhead consumes the same allowance. Keep pending generation outcomes fail-closed across restart. Step events do not complete the worker. Native, coordinator and reviewer rotation remain unsupported in this slice. An oversized unresolved tool result still fails safely rather than being silently trimmed.

Delegated ownership: workspace evidence adapter/tests; private checkpoint validation/tests; managed loop and composition; deterministic integration/recovery tests; independent architecture/recovery review. Primary agent owns core contracts/pure policy, projection semantics, plan/docs, live bounded validation and commits. Preserve untracked UX prototypes and all original source projects.

Address R3/R14. Keep one logical agent and stable `B → M` routing. Introduce step events distinct from logical completion, a cumulative request/action journal and a core-validated segment handoff. Archive previous messages/private continuation atomically before using a fresh window; never split pending tool-result chains or unknown actions. Add deadline semantics without resetting on context rotation. Managed providers first; native rotation requires a separate contract.

The handoff is built from frozen objective/criteria, next bounded task, verified workspace/diff identity and actual action/check evidence. A model summary is a proposal, not proof. A pure `WorkSegmentPolicy` is injected through Cordis; core owns budgets, permissions, persistence and acceptance.

## Stage 3 — short check-backed work loop

Address R4/R11. A small patch can request a registered service-owned check, then receive a fresh focused step containing actual failure evidence. Reuse existing `CheckPort` rather than exposing oracle source or letting workers redefine checks. Invalidate evidence when its workspace fingerprint changes. Final acceptance still requires independent checks and a fresh reviewer. Distinguish not-run/unavailable/failed/passed in UI.

First implementation: automatically inspect/check a managed assigned worker's completed tools-free work response before logical completion (including a forced closing reply with `status=complete`). Do not repeat checks during final serialization or a `continue` handshake. Apply automatic feedback only to the sole assigned worker; full-goal checks can legitimately fail before other specialists run. Pin exact frozen run check IDs/profile and a registered isolated execution world; missing environment must never cause host fallback.

Reserve the selected check count through the same managed tool ledger before effects, then persist a private pending check receipt. Known complete failures can create at most two service-owned feedback windows within the existing four-window session ceiling. Archive the terminal response and add exact observed diagnostics/available tool names, retaining the original task/scope/counters. A check-feedback archive must reference its immutable completed receipt and core-generated next task. Unknown/incomplete check outcomes remain unreplayed; unavailable checks stop instead of initiating code repair. Before/after fingerprints must match, and original assignment scope is checked again. Final acceptance checks and fresh review remain separate and required. Five delegated tasks cover adapter, storage, runtime integration, regression tests and independent review; root owns pure contracts and live synthetic evidence.

## Stage 4 — measured real-case quality

[Private-project evaluation details removed.]

## Stage 5 — scheduling, connection lifecycle and product UI

Dynamic specialists/task graph, queued/concurrent runs with one writer per workspace, durable operator questions, versioned disclosure grants, RTX connection/reconnect lifecycle, then agreed dense goals/material hierarchy/office-feed/agent details on real service data. Extract workflow responsibilities in small reviewed increments. SQLite, pagination and retention follow bounded read-model design, with migration/replay evidence.

### Model/profile setup without manual JSON

Complete the agreed resource onboarding as a separate bounded slice: an active API's discovered model can create managed runtime definitions and one new execution profile atomically. `resources.setup.save` accepts a semantic configuration revision, zero to eight new managed definitions and an explicit profile with coordinator/worker/reviewer/authorized pool/local-or-hybrid policy. Create-only IDs, no default change, no old runtime/profile overwrite, no inference or diagnostic on save. Per-connection editing remains separate. The revision excludes command receipts and credential values; stale/external edits cannot be overwritten.

Active catalogs remain authoritative for run/role selection. Expose configured pending definitions separately; new definitions activate only after service restart. Server-side `resources.use` must reject a pending profile/dependency before cached receipts, and new pending runtime probes must not contact the old client. Existing owned/frozen routes and defaults remain intact. After restart the user explicitly selects the new machine/project profile, then role preferences can use its authorized pool. A new endpoint currently needs restart before discovery and another after model/profile creation; display this honestly until draft metadata has its own contract.

Five-agent ownership: shared protocol/configuration storage/CLI; factory lifecycle and server guards; Mantine model/team wizard and EN/RU/browser gate; integration/concurrency/restart tests; independent architecture/boundary review. Primary agent maintains plan/docs and verifies final artifacts. Preserve the Mac-only live testing constraint and the existing source grants. Onboarding is metadata-only and needs no new live model calls.

## Stage log

[Private-project evaluation details removed.]

## Bounded planning and controlled model comparison — 2026-11-21

The Mac-only pilot exposed coordinator context exhaustion before a plan or worker existed. Worker segments cannot fix that phase. New managed runs freeze `bounded-planning-v1`: one structured, tools-free planning response (existing one correction retained), required goal/criteria/context/scope preserved, bounded optional diagnostic excerpts. Tool authority is enforced and privately journaled before HTTP; no implicit capability expansion. Native Codex explicitly retains `legacy-planning-v1`, and absent historical policy remains legacy across resume. Implementation and fresh review retain their existing tools, scope, budgets and acceptance. Oversized required briefs fail explicitly.

[Private-project evaluation details removed.]

### Comparison-driven planning correction

Committed the controlled comparison harness and first eight synthetic results in `16cf5d0`; full default validation passed 551 tests. Native Codex and DeepSeek produced externally verified fixes; local Qwen and mixed runs remained unaccepted. A native measurement collector error was fixed and the already completed candidate reverified without another model call, retaining its original error receipt.

[Private-project evaluation details removed.]

### Policy-shaped output and file search repair

[Private-project evaluation details removed.]

### Measured outcome and next priorities — 2026-11-21

[Private-project evaluation details removed.]

[Private-project evaluation details removed.]

## Same-model team-quality experiment — 2026-11-21

Implement a research-only comparison of executor/checks, executor/checks/fresh-review/repair, and coordinator/independent-test-author/executor/checks/fresh-review/repair. Preserve the same model/settings, initial fixture and final public/holdout oracles, bounded aggregate generations/output/tools/wall time and source scope. Baseline without LLM review must never become a production acceptance option or create an accepted commit. All role overhead consumes the same envelope. Test-author proposals are bounded declarative inputs; the trusted controller derives expected results from fixed requirements and runs candidate code only in the confined child. Generated probes supplement frozen checks rather than rewrite them.

Use five delegated roles in waves: pure control flow/contracts, actual managed runtime/private accounting adapter, matrix/CLI, independent recovery/integration tests and architecture review. Core owns bounded flow/evidence staleness/repair decisions; adapters own file/network/process effects. Keep one logical executor for at most two total repair steps, fresh readonly review per changed candidate, no unknown-action replay and no model-claimed success. Compare final code correctness separately from experiment workflow completion, with all stopped candidates externally checked after cleanup.

RTX remains offline until the user explicitly reports it available. Prepare and test on Mac; first live smoke uses only Mac-loopback Ollama and synthetic inputs. The larger Qwen3.5 9B/RTX repeat is the meaningful later hardware/model comparison; success on Mac does not prove faster or higher-quality RTX results. Preserve original projects and untracked UX files. Run focused/full tests, build, independent boundary review, then commit/report and proceed to bounded local smoke.

### Research result and user resource-policy direction

Saved the same-model experiment implementation as `77a016e`: 605 default tests, production build/typecheck/formatting and five-agent independent review passed. The first Mac smoke has three failed workflows (12/10/11 generations; one/zero/zero edits), stopped by conservative admission or the four-window worker policy before independent review. No claim of multi-agent quality improvement follows. Evidence is in `output/evaluation-2026-11-21/team-quality-mac.json`.

Primary-source research and a local code audit are summarized in `docs/ARCHITECTURE-RESEARCH-2026-11-21.md`, with three supporting reports under `output/research/`. Keep core/workspace/provider/evidence boundaries; change workflow and context contracts rather than replace the framework. Priorities: optional user-configured aggregate ceilings with default observation-only accounting; explicit audit of hidden repair/session/window ceilings; full verified review input and same-executor repair; accurate context admission; compute-matched extra-candidates/self-debug control and broader real-task evaluation.

The user explicitly requests no default hard request/token/time/session budget in ordinary product work. Do not merely raise constants or delete accounting/idempotency. Propose a versioned optional-quota policy, retain historical receipts/counters and explicit prior-run settings, and preserve permission/evidence/unknown-effect guards. Physical context/memory and transport-failure handling are separate concerns. Production defaults have not yet been migrated; the next implementation must apply this agreed direction deliberately.

## Selected design and full constraint audit

Completed five-role research/audit on2026-11-21: runtime32groups, workflow37groups and primary-source reuse/migration/review; primary agent added10tool-interface groups. The normalized inventory has79layeredgroups and185validatedsource references across49files. Sources distinguish actual defaults, schema ranges, quotas, operation health, payload projections, concurrency and authority. Pure schema/decision probes confirm finite fallback/null rejection and byte-admission behavior; no model, RTX or user-source calls were made.

[Private-project evaluation details removed.]

The chosen sequence and acceptance gates are in `docs/EXECUTION-DESIGN-DECISION-2026-11-21.md`; reusable boundaries in `docs/REUSABLE-AGENT-PACKAGES-2026-11-21.md`; inventory `output/research/buro-constraints-inventory-2026-11-21.json`; supporting reuse/quota/independentreview reports are retained. Target VISION/ARCHITECTURE documentation is aligned. Production behavior and all existing records remain unchanged by this research; implementation of the clean cutover is the next work.

## Full-project review and user autonomy clarification, 21 November 2026

The full review in `docs/PROJECT-ARCHITECTURE-REVIEW-2026-11-21.md` supersedes the previous implementation order. Fix revision-bound acceptance, owning-run unresolved effects and result-apply reconciliation first, before package/storage extraction. Fresh605tests, build/typecheck, formatting and production offline browser smoke passed; a separate controlled three-case reproducer exposes gaps not covered by that suite.

Codex is an equal AgentBackend; four target packages include agent-adapters. Task path scope is advisory by default, strict only explicitly; accepted bytes must always match check/review evidence. `docs/AUTONOMY-POLICY-2026-11-21.md` defines no default aggregate quota, visible effective policy, queues and typed stop/continue actions. SDK reuse starts with a narrow pi-ai/pi-agent-core spike, AI SDK transport fallback/control and optional mini backend; no SDK/dependency/code adoption has occurred. Future implementation keeps one host transaction authority and no legacy checkpoint compatibility.
