# Stage 5A3a independent entity-port and transaction-parity review

Date: 2026-11-22. Baseline `a51dbee` plus the required Core entity port, SQL entity rows and sole-authority File bridge. **Clear within the Goal/Role use-case migration and shared entity/usage transaction scope**, after the requested-project/facet identity correction below. This reviewer added tests and this report only, with no production edits or commit. The parent owns final repository gates.

## Independent evidence

**69/69 focused tests passed** in an independent combined run: the new mismatch/whitelist cases, semantic entities, actual SQL/File business cases, SQL entity/usage receipts, File event batches, existing event-delta/reopen/GC behavior, unknown-outcome/private projection contracts, worker recovery metadata, immutable workflow-role history and architecture boundaries. The architecture review's two additional tombstone/caught-conflict/reopen cases were then independently rerun and passed **2/2**. Full `npm run typecheck`, `git diff --check` and formatting of this review's files passed. Counts overlap the owners' runs; this reviewer did not run the whole repository suite.

Local receipts: `/private/tmp/buro-stage5a3a-independent-new.log`, `/private/tmp/buro-stage5a3a-independent-tests.log`, `/private/tmp/buro-stage5a3a-independent-tombstones.log` and `/private/tmp/buro-stage5a3a-independent-typecheck.log`. Authorities and databases are actual temporary File/SQLite fixtures. No model, network endpoint, RTX host, original user repository, key value, external message, deployment or Git commit was used.

## Independent regressions added

`tests/stage5a3a-review.test.ts` adds four passing cases, covering both File and SQLite:

1. Two actual authorities belong to different projects. A deliberately incoherent registry store for project `p` supplies project `q`'s entity facet. Goal create/update/delete and role create/edit for `p` must reject with `INVALID_PROJECT_ENTITY` before any foreign transaction. The foreign goal, immutable role version, absence of a new role and command-receipt list remain unchanged. The correctly addressed project is also untouched. Old snapshot/transact/receipt methods are traps in the registry stub, so this proof requires the narrow port and its own identity.
2. Actual entity-backed Goal/Role services construct their permitted fields rather than spreading a caller's record. Forged goal ID/status/run/revision/timestamps cannot override host-created identity or state; update preserves host state and increments the real revision. Forged workflow/coordinator provenance, version, timestamps and capabilities cannot enter a user-authored role. Legitimate user instructions and a fixed model preference remain stored. Each case checks actual persisted entity reads.

## Identity finding and correction

The parent raised a useful new-port boundary: selecting `projects.get(input.projectId).entities` did not itself prove that the facet belonged to that project. Goal creation included project identity and would fail schema validation, but update/delete operate on the facet's own stored goal and roles have no embedded project ID. An incorrectly wired custom factory could therefore target another team's real authority without using old snapshot APIs.

The parent added one shared Core resolver that requires the entity facet and checks `entities.projectId === requestedProjectId` before all four business methods begin a transaction. The independent two-authority regressions above confirm rejection before writes or successful receipts. This is defensive validation of a trusted port's identity, not a claim to sandbox malicious in-process adapters. It does not reintroduce a whole-document snapshot dependency.

## Business parity independently rerun

Actual `GoalService`/`RoleService` instances run against both adapters. SQL fixtures trap legacy snapshot/transact/receipt access, proving the new required port is the actual mechanism. Creation and edits preserve titles, body/criteria, environment-repair choices, parent/outcome fields, immutable material references and expected revisions. Unknown materials reject; inactive but still retained material references remain usable. Omitted material IDs preserve existing attachments; explicit empty arrays clear them and supplied IDs are deduplicated on update.

Parents require a stored completed status and nonempty commit, not merely an existing run ID. Goal deletion checks running state and actual busy delivery/preview facts. The regression with an older busy result behind 1,000 newer idle rows passes on both adapters; the guard does not rely on a recent-history window. Settled results do not keep deletion blocked.

Role edits retain user preferences unless explicitly changed, retain available workflow/template lineage under a new user origin and append the next immutable version. Two saves using one expected head cannot both win. Historical instructions/preferences/provenance remain readable after reopen. Existing workflow-generated and coordinator-generated content cannot be relabeled by a forged public save payload.

Exact command replay does not consume another ID/time, write another version or resurrect a deleted goal. Tombstones preserve goal identity after deletion. File tombstones remain private document state, while SQL retains a deleted row hidden from normal goal reads; recreating the same ID cannot silently replace the old entity.

## SQL authority boundaries

The SQL authority now exposes `{usage, entities}` under one synchronous callback, command-receipt namespace and union event stream. Goal rows use indexed identity, revision and complete previous-JSON comparison; deletion is a guarded tombstone update. Role versions use a composite identity plus immutable update/delete triggers, while head advancement checks the expected prior version. These mechanisms supplement the Core business guards rather than replacing them.

A physical storage-write failure latches the transaction as failed. The independently rerun injected role-head failure proves that catching the immediate error in application code cannot commit an orphan role version, earlier entity changes, usage charges, events or the command receipt. Core validation errors before a write remain ordinary business errors; the storage latch protects partially executed adapter writes.

Material references and parent/busy-run facts are narrow read-only indexes for the current business guards. This source slice provides no production API that invents accepted Run data merely to satisfy a parent reference. Tests seed explicitly marked temporary indexes and do not claim a whole Run migration or real code acceptance.

The fresh format is explicitly v2, with no v1 SQL reader or parallel event/receipt authority added. Callback capability expiry, JSON/void result normalization and replay use the shared transaction-value codec. The previous independent SQL cases for pending observer isolation, invalid array rollback and separated owner namespaces were rerun after that extraction. Public entity changes carry their actual project binding; usage projections retain their previous bounded/private-data exclusions.

## File bridge and batched event review

Live File-backed stores implement the same entity semantics over their **sole existing document authority**. Goal/Role services no longer directly use a document snapshot/transact callback, but other unmigrated use cases still do. The existing one-event `transact` method wraps the common batch commit; this is an API transition within that same File authority, not an active JSON/SQL sidecar or a legacy SQL-format reader.

An entity callback may emit zero or several changes. One File persistence operation commits the final document and command receipt, increments the document revision once and assigns sequential event positions for the emitted batch. Zero changes do not manufacture a domain event. All changes are checked by the existing budget/planning/role/reconciliation/result-application validators before adoption. Persist failure leaves the old document, events and receipt intact.

The reentrant subscriber regression passes: subscribing from the first event of an already committed batch replays the committed batch without receiving its later live events a second time. Each subscription tracks its delivered cursor. Existing event-delta tests independently preserve exact historical snapshots, sequence, receipts and reopen/compaction behavior. Existing unknown-outcome and worker-contract tests preserve private canonical references without exposing raw errors or inventing recovery eligibility. No acceptance or effect-reconciliation check was weakened to make entity batching pass.

## Quality, simplicity and remaining limits

The shared semantic facade removes duplicated business rules from Core services and lets both adapters use the same guarded writes. A single SQL transaction and one File commit path keep receipt/event atomicity explicit. The small requested-project identity check is preferable to reaching back through a full snapshot or adding another registry. Shared canonical result handling avoids divergent replay behavior between the adapters.

The shared codec still uses the earlier usage-oriented error vocabulary; it can be renamed to authority-neutral terms when the wider API vocabulary is consolidated. That is not a reason to add another codec, compatibility layer or database framework in this increment.

The migration is real at the Goal/Role port boundary, but production File stores still own the rest of each project. SQL does not yet provide a whole project store, full Run/session/artifact authority, model/tool dispatch claims or an end-to-end migrated runtime. Read-only reference indexes are not accepted-run evidence. Existing finite runtime budgets/defaults, private routes, machine settings and the remaining whole-document use cases remain unchanged. Default-none quotas, package distribution and full runtime cutover are separate work.

The review assumes trusted service/adapter code and a correctly derived command fingerprint. It does not claim to authenticate arbitrary database rewrites or sandbox callbacks that perform external effects. Capturing mutable direct-service input objects before queuing was not newly promised by this migration; the tested boundary constructs whitelisted fields and validates their owning facet.

No blocking finding remained in the reviewed 5A3a scope after the final checks.
