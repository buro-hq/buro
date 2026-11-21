# Persistence, policy, and recovery audit

Date: 2026-11-21. Read-only implementation audit; this document changes no production behavior. Scope: file persistence, usage accounting, configuration authority, project operations, and materials. The coordinator reports the current 605 tests, typecheck/build, and formatting passing. This audit adds two isolated temporary reproductions; it does not repeat that suite or call any model, API, RTX host, or user repository. The clean execution/storage contracts may break compatibility: old runs can remain a read-only archive without becoming resumable.

Severity: P1 means a recoverability/correctness issue to address before relying on autonomous delivery; P2 means a scoped defect or an architectural blocker for the planned workloads. Findings distinguish current behavior from the proposed single-host SQLite target.

## Existing guarantees worth keeping

`FileProjectStore` already has a project writer lease and a serialized mutation queue. Its transaction commits private usage records, the public Run projection, domain event, and command receipt together. The implementation persists before adopting the new in-memory document or publishing events: [project-store.ts:151](../../adapters/files/project-store.ts), [project-run-budgets.ts:25](../../adapters/files/project-run-budgets.ts). A failed replacement therefore does not publish an uncommitted result. File writes use a unique private temporary file, file fsync, and atomic rename. This is not an existing public/private split-brain bug.

Event replay and listener installation are synchronous, avoiding a replay/live subscription gap. Managed recovery also correctly refuses to repeat an unsettled generation, action, or service check: [managed-runtime.ts:885](../../core/managed-runtime.ts). Material staging checks hashes and rejects symlink destinations: [context-materials.ts:293](../../adapters/files/context-materials.ts). Neither optional quotas nor advisory task scope should weaken these guarantees.

## Findings and smallest useful corrections

### P1 — Applying a result has an external-effect receipt gap

[project-manager.ts:657](../../adapters/files/project-manager.ts) checks a saved receipt, examines the original repository HEAD, and runs `git merge --ff-only` at line690. Only afterwards does line691 persist `appliedAt`, branch, and the command receipt. If Git succeeds and the store write fails, the repository is changed but the command is unrecorded. Retrying the same request with the original `expectedHead` fails the branch check at line667. Existing managed-tool receipts do not cover this separate project-management operation.

Persist an apply intent containing command ID/fingerprint, expected original HEAD/branch, target commit, and Run before invoking Git. Settle the receipt afterwards. Recovery must inspect actual Git state: exact target on the expected branch can settle success; another state requires reconciliation. Do not automatically repeat an unknown merge, infer acceptance from prose, or report a completed operation before recording it.

Required test: inject persistence failure after successful fast-forward, restart, retry the exact command, and recover the actual completed operation once without a second Git mutation; separately test an independently changed branch.

### P1 for long-running autonomy — Removing run ceilings exposes quadratic persistence work

[core/run-budget.ts:83](../../core/run-budget.ts) recounts all operations for each summary; validation adds another full scan at line122. [project-store.ts:166](../../adapters/files/project-store.ts) clones the entire mutable document, validates all ledgers, scans historical events for a previous Run, copies event history, and serializes the entire document for every reservation/usage update. Old history is excluded from the initial structured clone, but still copied/scanned/rewritten. The private ledger also has a 17408-operation rejection at [run-budget.ts:130](../../core/run-budget.ts).

This is presently bounded by multiple lifetime ceilings; simply deleting those ceilings produces cumulative roughly quadratic work and growing atomic-write latency. Replacing JSON with SQLite while reconstructing all SQL rows into the existing `Record` and whole `ProjectDocument` leaves the core problem intact. The full-document callback is part of the limiting contract: [ports.ts:35](../../core/ports.ts).

Use a narrow transactional state port and pure incremental accounting on the current summary plus the particular operation receipt. Commit operation row, usage projection, Run change, event, and command receipt in one authoritative SQLite transaction. Page history and private session archives separately from active context. Do not add a second authoritative accounting store beside JSON Run summaries. Test crash boundaries, duplicate operations, unknown usage, and recovery invariants; add a scaling check comparing 1K and 10K operations that detects history-sized work per charge.

### P2 — Material deduplication can acknowledge an attachment that is inactive

[context-materials.ts:151](../../adapters/files/context-materials.ts) captures a snapshot before asynchronous file preparation. Lines220–225 deduplicate against that snapshot and return its existing active record. Removal at line277 goes straight to the store queue and does not join the importer queue at line127. A removal between snapshot capture and the import transaction leaves the acknowledged old material inactive; the transaction at line263 appends only `fresh` records and never rechecks the deduplicated ones.

Verified with the real adapters in a temporary project and a deterministic barrier immediately before the import transaction: `returnedActive=true`, `storedActive=false`. No production source was patched.

Keep blob preparation outside the store transaction, but resolve authoritative deduplication/activation and construct the returned records against the live draft inside it. Specify whether a fresh import reactivates an old attachment or creates a new attachment identity. Test import/remove ordering, duplicate uploads, and the final event and returned record against the committed state.

### P2 — Material removal never restores library capacity; failed imports leave unreachable blobs

[context-materials.ts:235](../../adapters/files/context-materials.ts) writes original/extracted blobs before the metadata transaction. Store failure or rejection can leave unreachable files. The 1000-record guard at line264 counts inactive records, while removal only sets `active=false` at line281. Repeated attach/remove eventually fills the library even with few active attachments. Current [collectGarbage:248](../../adapters/files/project-store.ts) only rewrites project state and removes stale state temporary files; it does not reclaim these blobs or inactive metadata.

Separate attachment history from active navigation and retention. Store immutable blobs before publishing references, track staged blob leases, then collect only unreachable blobs after a grace period using all retained Run/session references. Do not delete a removed attachment's blob while an earlier Run still needs it. Physical per-file/request bounds can remain visible resource constraints; a permanent lifetime attachment quota should not be implicit. Test rejected imports, interrupted extraction, removed-but-still-referenced materials, and eventually reclaimable orphans.

### P2, multi-writer contract gap — Resource configuration CAS is not atomic across instances

[resource-configuration.ts:176](../../adapters/files/resource-configuration.ts) serializes one instance and checks revisions, then `assertUnchanged` reads disk at line342 before a separate save. `PrivateJSONFiles` also queues only one instance: [private-json.ts:9](../../adapters/files/private-json.ts). Two configuration instances can both pass the disk check and both acknowledge conflicting saves; the last rename silently loses the other's connection and command receipt.

Verified using two opens of the same temporary directory and a barrier after both reads: both saves fulfilled; persisted state contained connection B and receipt B, with A and its receipt absent. This is not a same-instance queue defect. The standard daemon opens its root project writer before resources, which mitigates duplicate normal daemons; the reusable configuration adapter itself has no shared ownership/CAS guarantee.

Give the host one configuration authority, enforced by a lease or the same authoritative transactional store. External file edits should enter through an explicit validated reload/import with revision conflict reporting. Test two actual independent instances/processes and require one conflict or a merged authoritative outcome, never two successes with a lost acknowledged write.

### P2 — A crash during lock takeover can strand the project

[writer-lock.ts:18](../../adapters/files/writer-lock.ts) creates `writer.lock.recovery` exclusively; any creation failure reports another checker. If that process dies after creating the guard, the guard has no owner record or stale-recovery path. Future opens cannot reach the check for the already-dead main writer. This is fail-closed rather than unsafe concurrent access, but requires manual filesystem intervention.

For the interim adapter, use an OS-held lock or an owned, recoverable guard with careful nonce checks; do not simply delete a guard assumed old by wall time. SQLite's native transaction locks can replace this particular file ownership mechanism in the new store. Test child-process termination after each takeover boundary and confirm exactly one later opener succeeds.

### P2 — Profile export and authoritative state can silently exchange authority

Saving a profile commits control-state first, updates in-memory execution policy, and exports `.buro/project.json` afterwards: [project-manager.ts:472](../../adapters/files/project-manager.ts). Export failure is correctly disclosed as a partial success at line513; the store receipt supports retry. However [project-store.ts:99](../../adapters/files/project-store.ts) accepts the supplied profile when its revision is **equal to** or newer than persisted state. A manually edited/exported file with an equal revision can replace the service's saved profile at open, without a configuration event/CAS or explicit import.

Choose one authority. Recommended: service configuration is authoritative; repository configuration is a proposed import/export. An equal revision with different bytes is a conflict, not silent replacement. New imports should show the effective policy diff and create a new audited revision. Also close a newly opened store on all pre-registration failures in [project-manager.ts:306](../../adapters/files/project-manager.ts), so failed role initialization cannot retain an unregistered live writer lease until process exit. Test export failure/retry, equal-revision divergence, initialization failure, and explicit import.

## Restrictions that currently look like physical limits but are product policy

- [project-manager.ts:473](../../adapters/files/project-manager.ts) rejects **all** project settings changes whenever any Run is nonterminal; line664 applies the same project-wide busy test to result application. A waiting/paused Run can therefore block unrelated settings and accepted results. Separate future-Run defaults from frozen active-Run authority. Permit default changes immediately; apply explicit active-Run changes through revisioned commands. Guard actual Git branch/worktree overlap when applying results, rather than requiring every goal to finish.
- Resource connection/setup saves return `service-restart`: [resource-configuration.ts:224](../../adapters/files/resource-configuration.ts), line331. This is a current construction/lifecycle restriction, not an API-provider requirement. A new backend registry can install a new configuration revision for future sessions while old sessions keep their pinned authority. Do not reinterpret a running session's endpoint, credentials, model, or data policy silently.
- Missing policy values become finite defaults: [run-budget.ts:42](../../protocol/run-budget.ts), [resources.ts:75](../../protocol/resources.ts), and the default segment policy [runtime-resources.ts:75](../../adapters/resources/runtime-resources.ts). Checkpoint schemas additionally encode archive15 and feedback2 bounds: [managed-sessions.ts:85](../../adapters/files/managed-sessions.ts), line155. These are software policy/storage assumptions, not GPU capacity. The old finite execution formats need not be made resumable; use a clean new contract instead of making `0`, absent values, or large integers mean several things.

For new intentional settings use a root quota `none` and explicit `inherit | none | bounded` overrides, with source/revision shown in one shared effective-policy view. Advisory task scope is the default; an explicit strict checkbox can add enforcement. Acceptance still records actual files/bytes checked and the relevant workspace fingerprint. OS permissions, protected secrets/data destinations, provider context/output capacity, and unsettled side effects remain separately identified facts. A task recommendation mismatch is not itself permission to suppress delivery.

Return structured stop/resume transitions containing category, effective policy source, operation/receipt identity, observed evidence, and available resolution. Distinguish `user_quota`, `capacity`, `permission`, `provider_failure`, `strict_scope`, `review_not_accepted`, and `effect_unknown`. Let users revise optional caps without resetting usage or replaying effects. Native clients with incomplete accounting must say observed/unknown coverage, not claim that all internal provider calls were measured.

## Recommended order

1. Close the apply receipt gap and material transaction race; add their targeted failure/interleaving tests.
2. Define clean policy, receipt, incremental accounting, and transactional storage contracts together. Implement one host authority, then remove default lifetime ceilings and embedded finite archive structures. Keep existing history read-only; no deletion or automatic replay is authorized.
3. Split project defaults from active-Run policy changes, add configuration revisions with controlled lifecycle, and expose the same effective-policy/stop explanation through UI, CLI, MCP, and plugins.
4. Add safe artifact retention/GC and crash/scale tests. Keep plugins behind ports; a plugin must not own a competing Run ledger or bypass receipts, permission boundaries, or acceptance evidence.

The actionable change is an incremental, transactional authority plus transparent optional policy. Neither an extra orchestration package nor SQLite alone supplies those invariants.
