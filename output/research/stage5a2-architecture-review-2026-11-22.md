# Stage 5A2 independent architecture and boundary review

Date: 2026-11-22. Baseline `5534809`. Final review after the SQLite source freeze and the hard-link storage correction.

## Decision

Bounded clear. No remaining blocking finding in the reviewed standalone project usage transaction kernel. The actual 5A1 engine is consumed through narrow semantic transaction methods, with account, specific operation, public change and outer command receipt committed atomically. This is not the production ProjectStore cutover, a second live authority beside JSON, or an external-effect dispatch lease.

## Finding resolved

P2 — the private-file checks rejected symlinks but accepted multiply linked regular files. A temporary `authority.sqlite` hard-linked to an outside empty file opened successfully and initialized the outside alias; permissions could also be changed through the alias. The independent regression reproduced the missing rejection. The corrected helper checks link count before chmod/open for the main database and preexisting WAL/SHM/journal companions, and again on the opened main-file handle. The final test covers all four paths and verifies that outside bytes and mode remain unchanged.

The checks establish the reviewed private-path preparation boundary. They are not a sandbox against hostile same-user code concurrently replacing directory entries or a promise of arbitrary-filesystem adversarial race isolation.

## Semantic and persistence authority

Core exposes synchronous `tx.usage` methods for explicit account creation, exact owner/operation reads, admission and observation. The callback cannot access SQL or raw row mutation through that capability. Methods invoke the existing 5A1 functions rather than duplicating its finite-policy, observation or replay calculations. The capability is frozen and expires on success, failure and rejected asynchronous return.

Owner keys encode kind and primary owner ID unambiguously. Additional result/run/operation binding fields are frozen registration data, not a second owner namespace. An account ID is unique within the project. Recreating an account with a changed policy or binding fails instead of changing old authority. Project identity and private directory are captured privately with immutable public accessors.

The SQLite adapter uses one `BEGIN IMMEDIATE` transaction with WAL and synchronous FULL. It stores the current fixed-shape account, indexed operation receipt, sanitized event and canonical JSON/void command receipt together. An exception, invalid result or asynchronous/thenable result rolls those changes back. Applied poison is returned after commit so an outer caller can raise its error without erasing an observed response.

Transition updates compare the original complete account record and the specific original operation record/status. This addresses the 5A1 saturated-revision requirement: settlement does not depend solely on an account revision increment. Indexed columns are checked against private JSON identity/kind/status on reads. JSON is the canonical payload for these records, with indexes as validated projections; there is no independently writable JSON-file sidecar in this slice.

## Idempotence, lifetime and events

The outer command ID/fingerprint is checked before callback execution. A matching saved receipt returns its original canonical JSON or void result without rerunning the callback or adding an event. A conflicting fingerprint fails first. Fingerprints are supplied by the trusted caller; this kernel does not infer future application-command semantics from an opaque string.

Canonical JSON omits optional undefined object fields and normalizes negative zero; unsupported arrays, getters, cycles and non-JSON values cannot commit a partial command. The persisted partial-usage regression confirms that this roundtrip preserves the 5A1 observation identity and known/unknown counts.

Events are recorded in the same transaction and observers receive detached public projections after commit. Observer exceptions/rejections do not turn a committed receipt into a failed transaction. Query instrumentation exposes operation tags and row counts, without SQL values or private provider payloads. These are trusted in-process callbacks, not isolation of arbitrary callback code or permission to perform external effects inside a transaction.

Public summaries omit private account IDs, provider-operation IDs and observation keys/raw malformed usage. Coverage explicitly describes recorded operations and the known usage subset. Event pagination uses a read-transaction watermark and ordered bounded pages, so later writes do not alter an already selected history window. A crash after commit but before observer delivery is recovered from the durable journal; replay does not claim to re-emit live notifications automatically.

## Reads, startup and cleanup

Account/operation/receipt paths use exact indexed identities, with no historical receipt enumeration as admission input. The 17,409-operation proof measures constant returned/changed SQL rows and source query structure; it is not a universal latency benchmark or an execution-plan guarantee for every SQLite build. Generic callback results may contain arbitrary JSON chosen by the caller; the constant-size claim concerns accounting inputs/records, not all possible outer result payloads.

Private database preparation rejects symlink ancestors/targets, nonregular files and multiply linked files, using private directory and file modes. Unsupported foreign databases without authority metadata are rejected without installing authority tables; a different project identity is rejected and the original authority remains usable. Failed initialization closes its database handle. Close drains already admitted queue work once, rejects new work and does not leave an active transaction capability.

## Independent validation

Final frozen-source run: **71/71 passed** across 5A1 accounting, Core semantic authority, SQLite adapter/contracts, atomicity tests and the independent hard-link regression. This includes real child-process termination before and after commit, same-command/conflicting-fingerprint races across two processes, rollback/retry, exact replay, out-of-order observations, unknown/poison reopen, saturated revision, event watermark paging and 1,000/10,000/17,409-operation boundaries. An earlier overlapping SQLite/Core run passed 26/26. These are overlapping runs, not 97 distinct tests.

Full typecheck, `git diff --check` and review-file formatting passed. Parent legacy-suite/build results are separate evidence. Only `tests/stage5a2-architecture-review.test.ts` and this report were added by this reviewer; production changes were made by the owner. Tests used temporary files and synthetic records/processes. No models, RTX, credentials, existing user repositories or Git mutations were used.

## Explicit limits for the next slice

Owners are kernel registrations, without a real Run/research/result entity foreign key yet. This does not authorize model dispatch, establish an exactly-once external effect, persist complete model packets, change default budget policy or replace production FileStore transactions. The future application cutover must place real entity admission and usage changes in its one authority and preserve existing frozen resource/role/effect acceptance owners. Single-use dispatch claims and unknown-effect reconciliation remain separate integration work; an old usage allowance or command receipt is not a new dispatch grant.
