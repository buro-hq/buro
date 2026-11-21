# Execution refactor implementation progress

Authorized sequence: [full project review](PROJECT-ARCHITECTURE-REVIEW-2026-11-21.md), [autonomy policy](AUTONOMY-POLICY-2026-11-21.md), [package boundaries](REUSABLE-AGENT-PACKAGES-2026-11-21.md). The user authorized all stages, five collaborating agents, architecture/code/boundary review, tests, a separate commit and brief report after each stage, then continuation without asking for confirmation.

Baseline: `601f26e`. Existing untracked `output/ux/` is preserved. Original user repositories and the offline RTX host are outside implementation/evaluation writes. Model evaluation uses local Ollama and DeepSeek only when required, with approved synthetic/frozen inputs and no secret logging.

## Stage 1 — revision integrity and recovery

Status: substeps **1A and 1B complete**, independent architecture/code/boundary review clear within their stated scope. Stage 2 follows.

Implemented working-tree changes:

- WorkspaceRevision captures an immutable Git tree, HEAD, semantic index and changes from the captured blobs. Acceptance binds check/review/checkpoint to that revision. Checkpoint commits the captured tree rather than staging later working-copy bytes; HEAD CAS uses no-deref to avoid source-branch redirection.
- Owning-run pending turns and required reconciliation survive restart/replacement. Required markers cannot be silently cleared or changed through another project transaction. Known HTTP rejection and confirmed cancellation remain distinct from an unknown response/effect.
- All managed roles privately journal generation intent and normalized response/continuation. Backend errors expose typed unknown outcomes. Native completion and assistant text must be correlated with the actual turn.
- Result application persists intent and a unique dispatch grant before Git. Same-command recovery at the exact target branch/commit settles its receipt; an unobserved dispatched effect is not repeated.
- Observed malformed planning JSON enters the existing format-correction path. Transport/admission/persistence failures do not become format retries. Repair preserves successful workers when the goal is unchanged.

Five agents worked in waves: apply recovery, runtime reconciliation, immutable workspace revisions, independent architecture/code review, independent host/test-contract review. Parent owns orchestration integration, regressions, full validation and commits.

Validation: final full suite **638/638 passed**, build/typecheck and formatting passed. Five agent roles contributed implementation and independent review in waves. Focused counts overlap the full suite and are not summed. [Bounded review and remaining VerificationView contract](../output/research/stage1-verification-view-review-2026-11-21.md).

Known deliberate substep-1A boundaries: before/after equality cannot exclude transient source mutation during a check; immutable verification input is still required for1B. Also, a crash after creating an owned Git checkpoint but before durable Run finalization is conservative/reconciliation-required. No automatic checkpoint recovery is claimed. Existing quota/scope defaults are unchanged until their complete later contract cutover.

### Substep 1B — immutable verification input

Status: complete. Final full suite **682/682 passed**, with no skips; build/typecheck, formatting and desktop/mobile production smoke passed. Five agent roles contributed implementation, independent review and the next contract/scope preparation in waves. [Validation receipt](../output/research/stage1b-validation-2026-11-21.json).

The workspace adapter materializes the captured Git tree and its baseline into an independent read-only input, with its own shallow Git metadata and no live repository pointer. Checks write only into explicitly declared output directories; the fresh reviewer receives that same source view and read-only check outputs. Core retains the view/tree/check/reviewer identity before checkpointing the exact captured tree. Managed sessions reject replaced or revoked view grants before further generation/tool work.

Real Darwin sandbox regressions exercise source writes, restore-after-write, rename/chmod/link attempts, live-source reads, writable outputs and prepared toolchains. Trusted Node checks no longer receive their original script directory as a filesystem grant. Their registered entrypoint bytes are pinned before model dispatch, so copying a candidate checker into the view cannot silently adopt an always-pass replacement; arbitrary imported test dependencies are a separate trust boundary. Native review uses an acknowledged named permission profile on start and every turn, never legacy `readOnly` as an equivalent fallback. [Independent review](../output/research/stage1b-review-2026-11-21.md), [installed-client offline permission proof and limits](../output/research/native-verification-policy-probe-2026-11-21.json).

Current boundaries: Linux execution and Docker verification support require separate evidence/implementation. Prepared dependencies are read-only environment inputs, not a claimed immutable dependency snapshot. Live monorepo dependency aliases and submodules reject explicitly. Normal lifecycle cleanup is implemented; complete descendant-process leases and crash-orphan cleanup are not claimed. Existing quota and strict planned-path behavior remain unchanged until stage 2/5 cutover.

Stage 2 preparation is recorded in the [scope map](../output/research/stage2-scope-cutover-2026-11-21.md) and [backend contract map](../output/research/stage2-backend-cutover-2026-11-21.md). These are implementation plans, not implemented behavior or published reusable packages.

## Stage 2 — common capabilities and autonomy

### Substep 2A — capability admission and configured backend instances

Status: complete. Final full suite **707/707 passed**, with no skips; build/typecheck, formatting and desktop/mobile production smoke passed. Five agent roles contributed implementation, independent admission tests and architecture/code/boundary review in waves. [Validation receipt](../output/research/stage2a-validation-2026-11-22.json).

Portable ModelProvider/message/tool/usage contracts now live in `agent/contracts`, are used by production consumers, and compile separately without ambient Node types. Repository ToolScope, Buro sessions and provider transport errors remain application-owned. This is a real type boundary, not a finished neutral AgentBackend loop or distributable SDK.

Registered backends provide explicit immutable capability descriptors. Resources and routes freeze their revision and operation requirements; the router validates those against the actual registered implementation before dispatch. Known preflight failure remains distinct from an unknown error after backend dispatch. Worker feedback requires host-tool lifecycle capability rather than a client label. Native instances have arbitrary IDs and individual model/reasoning settings; managed instances may use the ID `codex`. The historical direct-Codex resume fallback is removed.

Original runtime/thread leases preserve stop and idempotent cleanup after view/configuration revocation. Released sessions need explicit resume. [Independent review](../output/research/stage2a-review-2026-11-22.md).

The new execution record format requires capability and route-admission metadata. Prototype records are intentionally not silently upgraded or resumed; archive old execution state before the operational cutover. Validation uses fresh synthetic state. The advisory/strict scope cutover follows in 2B below; read-only planning strategy, common role routing, default-none quotas, plugin contributions, durable SQLite authority and packaged AgentBackend remain subsequent work.

### Substep 2B — advisory scope and optional strict prevention

Status: complete. Final full suite **739/739 passed**, with no skips; build/typecheck and formatting passed. Browser checks passed project onboarding/settings with real strict/advisory persistence, planned-path/material selection and desktop/mobile production smoke. Five agent roles contributed implementation, fixture/contract verification and independent review. [Validation receipt](../output/research/stage2b-validation-2026-11-22.json).

Project profiles and frozen policies now carry explicit WorkScope: mode, planned paths and protected paths. New discovery is advisory with no required advance file list. Additional permitted edits are verified and reported against the captured source tree rather than rejected as a planning violation. The mode reaches workers, envelopes, private checkpoints, context rotation and explicit resume. Prior-worker reversions in advisory mode are review evidence rather than an invented file-permission failure.

Strict mode uses actual managed-tool prevention: bounded edits validate the target before writing; agent commands and mutable-input intermediate checks are unavailable. Final immutable checks and a fresh reviewer remain required. Native or other unsupported writable backends reject before session dispatch, including coordinator work and an explicit strict-policy change on resume. A shared selector-containment rule prevents exact-file grants from expanding into directories through path aliases. Protected/service paths, read-only review, check integrity and unknown-effect recovery remain independent of advisory planning.

Run.scopeObservation binds the mode and observed additional files to the accepted Git tree and check/review evidence. The UI renders that service evidence and the actual policy setting. Planning boilerplate was shortened to retain the same 16K correction headroom without removing the goal or canonical response history. [Independent architecture/code/boundary review](../output/research/stage2b-review-2026-11-22.md).

Default aggregate quotas, finite lower-level counters and the remaining client-specific planning/role rules are unchanged. Full automatic role/model selection, the neutral AgentBackend loop, SDK adoption, plugin contributions, SQLite authority and controlled state archive are still pending; these scope changes are not evidence of live-model coding quality.

### Substep 2C — capability planning, common role choices and visible policy

Status: complete. Final full suite **770/770 passed**, with no skips; build/typecheck, formatting and desktop/mobile production smoke passed. The synthetic autonomy browser check passed real role preference persistence, policy refresh, optional continuation clarification, unknown-outcome blocking, busy modal guards and Russian stop text with zero model requests/page errors. Five agent roles contributed implementation and independent reviews in waves. [Validation receipt](../output/research/stage2c-validation-2026-11-22.json), [architecture/code/boundary review](../output/research/stage2c-architecture-review-2026-11-22.md), [independent tests/UI review](../output/research/stage2c-tests-review-2026-11-22.md).

New runs freeze coordinator/reviewer role versions and their actual Auto/Prefer/Fixed resource decisions before dispatch. Operational preparation similarly saves its role and selected backend before starting; worker proposals use the same authorized profile pool and operation requirements. Fixed never silently falls back, and a role's descriptive kind does not grant execution authority.

Planning selects structured tools-free turns or a read-only inspection session from capabilities rather than a client name. An accepted read-only plan clears its planner thread from the writer slot durably before a separate writable session starts. Backends without session resumption can continue in a fresh session with the frozen role, saved workspace and full goal/plan; uncertain operations still block execution. Another unresolved run of the same goal blocks both a new run and continuation of a settled sibling.

The service projects effective file, model, check and actual current usage policy, together with stop reasons and available recovery actions. The UI consumes that projection; configuration changes refresh it without rolling later events back. Default aggregate budgets remain finite in this slice. The package/SDK and contribution cutovers below are not implemented by these UI and routing changes.

Bounded follow-ups retained: readonly operational preparation still lacks a separate durable preparation-outcome receipt; a failed preparation never dispatches delivery. Machine-default selection refreshes the initiating client, while cross-client invalidation requires the later service contribution/API work. Neither is evidence of complete operational effect recovery or multi-client policy broadcasts. Custom environment role IDs also need contribution-aware catalog eligibility; actual delivery dispatch still validates its operation requirements.

## Stage 3 — neutral execution and SDK integration

### Substep 3A — portable provider implementation and explicit request outcomes

Status: complete. Final full suite **812/812 passed**, with no skips; build/typecheck and formatting passed. Real portable wire parsing, a compiled source-removed consumer and composed private-journal/reopen outcomes passed independently. The UI bundle is unchanged from 2C; transient runtime deltas do not imply a WebSocket/UI streaming feature. Five agent roles contributed implementation and independent review in waves. [Validation receipt](../output/research/stage3a-validation-2026-11-22.json), [architecture/outcome review](../output/research/stage3a-architecture-review-2026-11-22.md), [independent durable host tests](../output/research/stage3a-tests-review-2026-11-22.md). Stage 2C is committed as `02aa411`.

The real Ollama/DeepSeek HTTP transports, streaming parsers and continuation codecs are extracted into `agent/providers`, using explicit fetch/configuration and only neutral contracts. Buro wrappers retain connection identity, endpoint trust, locality admission and application error translation. Optional visible-text/usage/terminal observers are separate from private reasoning and canonical complete responses. Transient runtime text deltas are not durable event receipts or per-token project transactions.

Explicit provider outcomes distinguish confirmed preflight/non-dispatch, observed rejection and unknown dispatched results; unknown overrides a familiar error code and generic positive observation. This avoids poisoning a generation with a failed metadata lookup while preventing a partial stream error from silently permitting replay. Default aggregate quotas are unchanged.

[Private-project evaluation details removed.]

### Substep 3B1 — application host authority, effects and context seams

Status: complete. Final full suite **832/832 passed**, with no skips; build/typecheck and formatting passed. Five agent roles contributed implementation and independent reviews in waves. [Validation receipt](../output/research/stage3b1-validation-2026-11-22.json), [architecture/boundary review](../output/research/stage3b1-architecture-review-2026-11-22.md), [independent context/cancellation review](../output/research/stage3b1-tests-review-2026-11-22.md).

ManagedAgentRuntime now owns lifecycle, cache, cancellation and exactly one request/tool loop. Its active production calls delegate start/resume/scope/review binding to managed-session-authority, generation/batch/tool/failure receipts to managed-host-effects, and coding checks/feedback/context rotation to managed-coding-context. These are Buro application modules, not generic SDK contracts disguised with repository types.

The full tool batch must be admitted and durable before any effect. Dispatch uses only the saved action ID, detached canonical arguments and scope, enforces original order and waits for the prior receipt. A scheduler/provider/broker object cannot mutate the recorded response or action. Failed cleanup preserves foreign pending markers; same-request generation replay rejects before another reservation or HTTP call. Context decisions read the canonical saved generation and require the current batch's receipts. A cloned context cannot clear a concurrent cancellation latch.

The original scheduler remains the sole loop; Pi is not adopted by this extraction. The following bridge must provide single-use phase sequencing (including exactly one context decision per batch), cooperative yield for SDK transcript memory, original fatal-error preservation and cleanup that drains in-flight host work. No new lifetime limit, provider fallback, SDK ledger, default-none quota or generic package distribution is claimed. Existing operational preparation, custom delivery-role catalog and cross-client machine-profile follow-ups remain unchanged.

### Substep 3B2 — one pinned SDK scheduler behind a neutral host port

Status: complete. Final full suite **865/865 passed**, with no skips; build/typecheck and formatting passed. All existing managed fixtures and the production factory use the actual pinned Pi runner. Five agent roles contributed implementation and independent reviews in waves. [Validation receipt](../output/research/stage3b2-validation-2026-11-22.json), [SDK/authority review](../output/research/stage3b2-architecture-review-2026-11-22.md), [composed private-journal recovery review](../output/research/stage3b2-tests-review-2026-11-22.md).

Pi 1.6.0 now owns managed model/tool scheduling through the domain-neutral AgentLoopRunner/AgentLoopHost contract. The former request-round and action loops are removed; the lifecycle pumps only committed context windows. ManagedLoopHost uses private fields, explicit phases, single-use opaque IDs and canonical saved responses. The runner cannot replace model/tool arguments, skip context checks or manufacture completion. Whole-batch executability is validated before any SDK projection; ordinary known tool errors remain repairable, while original host failures end the SDK window after callbacks drain.

The production factory lazily loads the SDK for managed backends. Direct model calls remain behind the verified ModelProvider; SDK catalog, credentials, default transport and retries are not enabled. SDK messages/usage are disposable projections. Parent cancellation and internal SDK failure remain distinct, and exact pending/unknown markers survive reopen. Durable context compaction yields a scheduler window without resetting logical requests/tools/usage or changing the original goal.

This is actual scheduler adoption, not merely a fake spike or interface move. It does not complete a portable backend lifecycle, four installable packages, history paging, default-none quotas, operational-preparation recovery or live-model quality evaluation. Those remain in contribution/persistence/package work below; no public alias over Buro-specific session data is called a reusable AgentBackend. [Source-derived SDK integration plan](../output/research/stage3-sdk-integration-plan-2026-11-22.md) records the earlier gates and why host authority was retained.

## Remaining authorized stages

Stage 2A–2C is complete within the recorded scope. Portable ModelProvider contracts, capabilities, common role choices, scope and policy projection are implemented; the neutral AgentBackend loop belongs to stage 3 below.
The pinned SDK spike and production scheduler adoption are complete in 3A/3B1/3B2. Portable backend lifecycle/package exports still require the contribution/persistence/package cutover below; an optional mini backend remains conditional, not a required second loop.
4. Contribution-based Cordis composition, project services/store factory and empty production startup; demo fixtures remain explicit.
5. One transactional SQLite authority, incremental accounting, complete private artifacts and paged context/history; clean pre-release cutover and default-none quotas only after every hidden lifetime stop is removed.
6. Same-writer repair, fresh criticism, complete revision-bound review packets and independently consumable packages proved by a second host.
7. Incremental teams, isolated concurrent runs/capacity queues, accurate attempts/sessions and MCP over the same application API; controlled quality comparisons.

Each stage records actual test/review results and a commit before continuing. Documentation-only research is not evidence that later target behavior is implemented.
