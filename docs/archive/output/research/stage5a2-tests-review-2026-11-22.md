# Stage 5A2 independent SQLite authority and transaction review

Date: 2026-11-22. Baseline `5534809` plus the new Core usage-authority facade, detached accounting validators and standalone SQLite project-usage kernel. **Clear within this transaction-kernel scope**, after the private-file hard-link correction independently reproduced by the architecture review. This reviewer added tests and this report only, with no production edits or commit.

## Independent evidence

**74/74 focused tests passed** in an independent final run: the 44 finite-accounting foundation tests and 30 semantic-authority/actual-SQLite cases, including three new independent regressions, actual child-process contention and crash tests, private-file alias checks and 17,409 stored SQL operations. Full `npm run typecheck`, `git diff --check` and formatting of this review's files passed. The counts overlap the owners' runs and are not additive. The parent owns the repository-wide final suite/build.

Local receipts: `/private/tmp/buro-stage5a2-independent-new.log`, `/private/tmp/buro-stage5a2-independent-tests.log` and `/private/tmp/buro-stage5a2-independent-typecheck.log`. SQLite databases and child processes are real temporary test fixtures. No model, remote endpoint, RTX host, original user repository, key value, external message, deployment or Git commit was used.

## Independent regressions added

`tests/stage5a2-review.test.ts` adds three passing actual-SQLite cases:

1. A run and research owner share the same domain ID and the same accounting operation ID, but retain separate account/operation rows. A foreign account cannot settle the other owner's generation or change counters/events. After legitimate settlement and reopen, one owner has complete known usage and the other retains its pending exposure. Event page input is captured before queuing; mutating the original cursor cannot change the requested page, and mutating returned event data cannot rewrite persisted history.
2. Returning an array containing `undefined` or a sparse array rejects instead of silently serializing a null slot. Account, generation and events staged earlier in that callback roll back. Reusing the failed command ID with a valid callback then succeeds, proving no successful receipt survived. Optional undefined object fields and negative zero inside an otherwise valid array are normalized consistently, and exact receipt replay does not invoke a callback.
3. A pending async event observer mutates its received owner/summary, waits indefinitely and later rejects. The committed transaction and exact receipt replay complete while that observer is still pending. Kernel close also completes; reopening shows the original owner, summary and one event. The late rejection remains isolated. Observer callback completion and caller mutation of returned data do not become transaction or persistence authority.

No new blocking implementation defect was found in these cases.

## Existing evidence independently rerun

The Core semantic port exercises the actual finite engine for account creation, admission, settlement and replay. Owner primary keys are unambiguous; additional result-preparation/application bindings remain immutable data, not a way to create another namespace. Explicit policy/account conflicts reject. The public callback has no raw SQL/row mutation port, and retained semantic methods close after callback success or failure. Public summaries declare recorded-operation coverage and known-subset usage rather than complete provider billing.

Adapter tests cover project-bound format metadata, private paths, void receipts, JSON result normalization, rejected async/thenable callbacks, getters/non-JSON values, applied poison, observer isolation, captured identity and queue-draining idempotent close. The root's JSON contract test proves partial usage with optional undefined fields and measured negative zero survives actual SQL storage, reopen and replay. Its foreign-database case rejects without installing authority tables into an unrelated database.

The process/atomicity suite uses actual SQLite connections and forked processes. Matching command/fingerprint contenders execute one callback and persist one accounting transition/event. Conflicting fingerprints admit one command and reject the other before its callback. SIGKILL fixtures stop a child after in-transaction writes or after awaited commit; reopen shows complete rollback or complete persistence, and retry leaves one total admission. This is transaction/effect-accounting evidence, not an exactly-once external provider/tool dispatch claim.

Malformed usage returns applied poison and an observed receipt that survive commit/reopen before an outer caller error. Public events omit private account/usage-operation/command identities, fingerprints, observation keys and raw malformed payloads. Unknown outcomes retain reservations and cannot be silently reconciled by an ordinary known observation. Saturated account revision tests retain distinct pending/unknown/observed operation states across reopen.

Paging tests preserve a fixed watermark while later writes remain available to a fresh page. Source/adapter point queries use the unique owner key and composite account/operation primary key. The 1K, 10K and 17,409-operation cases produce identical instrumentation traces with bounded returned/changed rows. Those counts are **not SQLite VM scanned-step measurements**, query-plan benchmarks or throughput evidence. The indexes and exact point-query predicates establish the intended query shape; the test instrumentation does not independently count internal page visits.

## Transaction and authority boundaries

`core/usage-authority.ts` is an actual semantic consumer of the finite engine. It validates owners and saved records, freezes account identity/policy through account creation, looks up only the specific requested operation and projects sanitized usage changes. The adapter owns private database rows; application callbacks receive only the semantic `usage` facade.

One `BEGIN IMMEDIATE` transaction contains the changed account, specific operation, public event rows and command receipt. The adapter rejects asynchronous/thenable callback results and closes transaction capability before result serialization or later continuations. A failed callback/result encoding rolls back the whole unit. Exact command replay returns its canonical saved result, including void, without running the callback or appending another event. Fingerprints remain an application-supplied immutable command identity contract, not a hash computed from callback code by this kernel.

Updates compare the complete previous account JSON, immutable owner binding and account ID. Specific operation updates additionally compare account/operation identity, kind, previous status and previous JSON. This closes the finite-engine saturation edge: when account revision cannot increase, operation-state CAS still prevents a repeat settlement from relying on an unchanged numeric revision alone. Account update preceding a failed operation update is inside the same rollback boundary.

An applied poison result is a value with an error, not an exception raised inside the open transaction. A future caller must commit that value and the canonical observed response before raising the error outside the transaction. Deliberately throwing from a callback still rolls back its writes; this kernel cannot make arbitrary application callback side effects transactional. Neither callbacks nor their JSON-safe results authorize HTTP, model, process, Git or filesystem effects.

Event observers receive detached public projections only after commit. Their synchronous throw, pending promise or later rejection cannot invalidate a saved receipt. Database queue close drains already admitted work and refuses new operations; observer promises are not owned transaction work. Event pages use a read transaction, captured cursors and an explicit watermark rather than a mutable full-history array.

## Privacy correction and limits

The architecture review found that a preexisting regular database file could be a hard link to another file, so chmod/open could affect that external alias. The parent added `nlink === 1` checks before chmod/open, on the opened database handle and for recognized SQLite companion files. The independent hard-link regression was included in this run and proves the external file's bytes and mode remain unchanged on rejection.

The directory is canonical/private (0700), database and WAL/SHM companions are private regular files (0600), and preexisting symlink ancestors/targets/companions reject. Opening binds an immutable project identity and format; public property mutation cannot retarget an opened authority. These are private storage and static alias protections, not a sandbox against hostile code running as the same user and actively replacing private directory entries, nor cryptographic tamper evidence for arbitrary database edits. Power-loss durability beyond SQLite's configured WAL/FULL behavior was not physically tested.

## Quality, simplicity and remaining adoption work

Core owns arithmetic/meaning, while SQLite owns indexed rows, atomic commit and replay. That is a useful reusable boundary. The semantic facade avoids duplicating finite accounting in SQL or exposing a general raw database port to callbacks. Canonical JSON handling is intentionally narrow data validation, not arbitrary object serialization. Existing private-file and lifecycle helpers should remain small; a generic database/plugin framework is unnecessary for this slice.

The new adapter is the only implementation consumer found for the new authority facade. Existing runtime scheduling, FileProjectStore, private sessions/routes, machine configuration and production budget paths are not wired to it. This is not an active JSON/SQL sidecar, a full ProjectAuthority migration, a default-none budget rollout or a live external effect journal.

Owners are registered kernel bindings; they are not yet foreign-key-validated against actual Run/research/preparation rows. Runtime adoption still needs canonical model/tool artifact storage, dispatch claims/owner leases, outcome reconciliation, real domain-event integration and crash tests at those actual effect boundaries. Historical accounting allowances remain evidence, not dispatch permission. This review neither required nor inferred those later mechanisms from the standalone kernel.

No blocking finding remained in the reviewed 5A2 scope after the final checks.
