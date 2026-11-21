# Independent review of the selected limit and workflow direction

Date: 2026-11-21. Read-only review against current source and the runtime/workflow inventories, reusable-pattern report and optional-quota clean-cutover design. Only this report was created. No production code, models, network, RTX, credentials or original user projects were accessed.

## Verdict

The selected direction is sound: retain Core/Cordis, runtime/provider separation, scoped effects and independent acceptance; use one writing executor with fresh criticism and repair by that executor; introduce observation-only usage by default and explicit optional user quotas. This is a workflow/context/accounting contract cutover, not a reason to replace the framework. The user confirms the product is unreleased and does not require compatibility with old execution state.

It is **not safe to implement the direction by deleting the visible run-budget check or setting large numbers**. Several independent lifetime counters, materialized configuration defaults, storage invariants and runtime identity checks would still reject healthy work or break recovery. The clean-cutover design is acceptable if the gates below remain part of implementation. This is a design review, not a claim that the new behavior is implemented or tested.

## Required cutover gates

### 1. No-quota must be an end-to-end policy state

Current `ManagedRuntime` requires every configured limit to be a positive safe integer ([constructor](../../core/managed-runtime.ts), lines 76–87). Resource schemas materialize 24 requests/turn, 64 tools/turn and 256 requests/session; their absence is not an unlimited state. Current project/UI schemas also require finite repair/team fields. New v2 policy needs separate request-capacity, optional-quota, scheduling and health concepts, with consumers that do not restore an old finite fallback.

A finite scheduling quantum may yield a session fairly, but it must not fail the goal, fabricate completion or start the old request again. A resumed managed loop must retain durable operation sequencing. Resetting the local round index while keeping a prior turn/operation ID could turn an apparently idempotent grant into another dispatched model request. Unknown outcomes still require reconciliation.

Keep finite per-message and per-request constraints where the actual API, memory or transport requires them. Those bounds should lead to context selection, paging or a typed recoverable blocker, not an unexplained lifetime goal cap.

### 2. Make an explicit clean cutover; preserve current-run correctness

The user does not require old runtime, checkpoint, quota or resource-policy compatibility. Select one new contract and stop accepting old execution state. Do not implement a trusted legacy resolver, old-run resume, execution-ledger/checkpoint import or inference of whether historical materialized fields were user choices.

Before an explicitly requested reset, stop or drain owned work and archive the existing state read-only in protected storage. Retain unknown-outcome evidence in that archive; never dispatch its old actions again. Archival is not deletion, and this research does not authorize or perform either reset or deletion. The reset boundary should be clear about execution state versus credentials and original repositories. Explicit reimport of project/goal/material definitions or reviewed connection references is a separate domain-input operation and is allowed; it must not import executable ledgers, receipts or old implicit quota defaults.

New configurations still need explicit `inherit`, `none` and bounded policy states. Missing override inherits a root default of `none`; a deliberately configured finite quota remains visible. Zero can mean no further admissions, never infinity. New session/run snapshots must preserve identity, counters and operation IDs across normal restart and cooperative yield. Removing backward compatibility does not remove recovery for work started under the new contract.

Model, endpoint, provider and data-policy identity checks remain mandatory for the new state. Refuse mismatches rather than bypassing them to open an archive. The current resource hash and checkpoint policy equality are evidence of the old contract boundary, not a requirement to support its restore logic indefinitely.

### 3. SQLite must replace the transactional authority, not only the file format

Current budget validation and summaries iterate the entire operation record; `ProjectStore.transact` clones and persists private records together with the owning public run. SQLite does not remove that cost if code reloads all rows into the same `Record` each time.

New-contract admission should evaluate the current incremental summary, exact prior operation receipt and proposed operation. Its private record, public run projection, event sequence and idempotency receipt must commit under one transaction authority before effects. A separate SQLite ledger and authoritative JSON summary introduce a two-commit consistency gap. Likewise, an independent JSONL append plus JSON summary needs a real WAL/replay protocol, not optimistic ordering.

Paged immutable archives are suitable for large private history, with transactionally committed references and checksums. An unreferenced artifact can be collected later. A committed missing page blocks recovery. Keep opaque provider continuation private and preserve its protocol dependencies; public evidence retrieval must not expose private reasoning or credentials.

### 4. Usage and quota exposure are different quantities

The present aggregate output counter permanently sums admitted output upper bounds. It is a reservation metric, not measured token spend. The new accounting contract may release unused pending capacity when the relevant usage dimension is actually observed, while keeping lifetime audit records monotonic.

Do not refund because the model said it finished. Output-only quota settlement requires known output usage; total-token settlement requires the relevant input and output counts. Unknown usage retains a conservative exposure until reconciled. A response may have a known code outcome but unknown usage, which is different from an unknown tool effect.

Native Codex internal API traffic is not equivalent to Buro completed-turn calls. The product must not promise an exact whole-run request/currency cap for a mixed or opaque native route. Scope and coverage need to be explicit. Price estimates are not billing receipts, and per-request cap/usage corruption remains an integrity problem even with aggregate quotas disabled.

### 5. Health, concurrency and correctness need accurate names

The production inactivity value is 10 minutes, not the 120 seconds used by an experimental adapter. `turnTimeoutMs` is currently a misleading configuration field because completed execution turns receive the run inactivity policy instead. Queueing, model loading, active streaming and command execution need distinct observable states; silence while a known operation is active is not proof that the goal stopped progressing.

A command timeout is an operation outcome after the owned process is confirmed stopped. Depending on baseline and diagnostics, a hanging candidate may be a real code defect and valid repair input. Do not classify every timeout as either a quota or an infrastructure pause. If termination/outcome is unknown, no automatic replay is permitted.

Current `maxWorkers:2` limits the total logical plan, although the UI calls it concurrency; dispatch itself is serial. Goal-wide task count, active inference capacity and active writers are different controls. Preserve one writer per shared worktree. The present nonoverlap check is appropriate for its current topology, not a permanent ban on sequential or isolated tasks touching the same file; change that guard only with a tested ownership/integration model.

### 6. Keep truthful evidence and fix capability gaps separately

The workflow inventory identifies loss of earlier command output while some prompts claim the complete log remains available. Retain full output as a protected artifact before presenting a bounded excerpt, or stop claiming it is retained. Large code/material/message limits should use references and pages without silently omitting required criteria.

The absence of rename/delete operations in the managed broker is a capability gap, not a token-budget failure. A new editing interface needs scoped source/destination validation, base-version checks, durable per-operation intent and recovery tests. Replacing the broker with arbitrary bash merely to match a minimal external agent would expand authority.

## Ranked implementation sequence

1. Specify one new override/accounting/runtime contract, default-none semantics and an explicit protected archive/reset boundary. Reject old execution state instead of adding compatibility or execution-state import. Audit constructors, schemas, UI, CLI and new-contract restart/yield transitions together.
2. Introduce incremental accounting transactions and paged history under one authoritative store. Verify crash boundaries and large-history behavior before claiming unrestricted-duration work.
3. Remove default terminal turn/session/repair/window counters across new strategies. Where useful, replace a counter with a durable cooperative yield, not another hidden failure threshold.
4. Deliver complete verified review context, return findings to the original executor, and freshly review each changed revision. Treat incomplete context as a request for a new view, not permission to drop constraints.
5. Compare editing/context strategies and add a compute-matched candidate/self-debug control. Equal maximum allowances alone do not isolate the benefit of additional roles. Preserve final hidden evaluation outside candidate selection.

## Verification status

Independently validated both inventory JSON files: 69 grouped entries and 175 source path/line references; all referenced files exist and line numbers are within bounds. This validates traceability, not exhaustiveness of every possible provider or operating-system constraint. Crosschecked serial worker dispatch, 10-minute inactivity, the positive-limit constructor, runtime hash inputs, checkpoint policy equality and private/public transaction coupling.

No new implementation tests or live trials were run for this review. The earlier 605-test baseline remains historical evidence. Required new tests include former 64/256/17408 operation and 4/15 archive boundaries; explicit-none overriding inheritance; rejecting archived old state; normal restart/recovery of new-contract runs; admission/commit/publication crashes; duplicate/conflicting receipts; partial/unknown usage; a live operation crossing a scheduler yield without duplicate effects; and UI round trips that do not reinsert finite defaults.

## Final consolidated decision review

Reviewed [the selected decision](../../docs/EXECUTION-DESIGN-DECISION-2026-11-21.md) and the target updates to VISION/ARCHITECTURE versus the operational-v1 provider callout. No blocking contradiction remains. The document explicitly distinguishes proposed behavior from current production, user quota from health/request capacity, incremental transactional accounting from a file-format swap, and current-run identity from resource policy. The updated target must specify one clean cutover, protected read-only archive before an explicit reset, no old execution-state import/resume, no operation-sequence reset across new-contract yield, dimension-specific reservation settlement and honest native accounting coverage. Earlier compatibility requirements in this review are withdrawn following the user’s unreleased-product clarification.

Independently checked the normalized inventory: 79 entries, 185 valid source references, 49 source hashes with no mismatch. A nonblocking implementation clarification remains: the current 15-minute command-schema maximum is a prototype policy, not a physical provider limit. The new health policy should permit legitimate longer active checks or an explicitly chosen operation deadline, rather than retain 900000 ms as another hidden terminal ceiling.

## User clarification: no backward compatibility

This revision supersedes the earlier legacy/provenance migration requirement. The product is unreleased; do not spend implementation scope on restoring old checkpoints or importing old budget/configuration records. Protected read-only archival precedes an explicit reset, with no implied deletion. The new contract still requires authoritative accounting transactions, endpoint/data-policy validation, durable receipts, idempotent operation IDs and restart/recovery of its own runs. The 15-minute command-schema maximum remains a prototype ceiling to remove or replace with a meaningful operation-health setting; it is not a physical limit.

## Final clean-cutover and reusable-package review

Rechecked the updated selected decision and [reusable-package plan](../../docs/REUSABLE-AGENT-PACKAGES-2026-11-21.md). **Clear for the proposed implementation sequence; no blocking design contradiction found.** This is approval of a target plan, not evidence that the new runtime, storage or packages already work.

The clean break now rejects old executable state, keeps a protected archive before an explicit reset, allows deliberate domain-input reimport and preserves new-contract recovery and endpoint identity. It makes the 15-minute command maximum a replaceable prototype health setting rather than a physical model limit.

The three-package split keeps domain-neutral contracts, execution mechanics and provider transports independent of Buro's projects, repositories, checks, Cordis and UI. Repository tools and acceptance remain Buro-owned. Generic tool authority is host-issued and opaque to the model; the injected journal must give durable grants and conflicting-receipt/unknown-outcome semantics. In Buro that journal shares one authoritative transaction with usage, events, run projection and command receipts. Pure runtime decisions cannot dispatch from an uncommitted or stale host grant.

[Private-project evaluation details removed.]