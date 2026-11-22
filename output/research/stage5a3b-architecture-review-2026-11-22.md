# Stage 5A3b independent architecture and boundary review

Date: 2026-11-22. Baseline `36f2643`. Final review after the material sources, callback capture and public-revision corrections were frozen.

## Decision

Bounded clear. No remaining blocking finding in the reviewed material migration. Actual import/remove operations consume required material facets; canonical metadata, goal reference facts, counts, events and receipts use the composition's one storage authority. The active application remains on FileStore. SQLite is an isolated kernel composition, not a sidecar written beside live JSON or a completed production cutover.

## Findings resolved

P2 — the extracted document-facet helper retained dynamic lookups of caller-owned host callbacks. A frozen material facet could keep project ID `p` while a later replacement of `host.transaction` or `host.read` redirected writes, reads or receipt lookup elsewhere. The helper now captures both callbacks, and the material receipt method captures its own read callback. The independent two-FileStore regression verifies that replacing the original host object's callbacks cannot retarget the constructed facet. The ordinary FileStore constructor's host object was already private; this correction restores the exported helper's capture boundary rather than claiming an exposed end-user exploit.

P2 — FileStore counted one public revision per command, while client event projection counted one per event. Newly supported zero/N-change transactions could therefore produce a different connected snapshot revision from the authoritative snapshot. Public revision now advances by the number of visible changes, while receipt-only commands leave public revision unchanged. Existing single-event commands retain their behavior. The independent regression compares complete FileStore/client snapshots after an ordinary attach, zero-event duplicate attach and multi-event remove/reactivate batch.

The final SQL initialization also rejects missing required authority tables or a missing existing material counter row, rather than recreating a zero summary for an existing library. Counter initialization occurs only with fresh authority metadata. The controlled missing-counter regression was independently run after this correction.

## Identity, reactivation and batch semantics

The Core material facade validates metadata shape, content-hash/path pairing and required prepared-loader/representation data. Identity consists of scope, name, raw hash and loader ID/revision. A new extractor revision creates a separate identity. Equal identity with changed immutable payload, extraction hash or representation fails rather than rewriting content under an existing reference.

Repeated inputs resolve to the committed canonical ID and original creation metadata. An inactive match is reactivated on that same ID; an already active match is a receipt-only result. Repeated entries within one batch consume one canonical slot and produce one actual change. Every identity, conflict and current library bound is resolved before the first row write. Results reflect the transaction's committed identities, including a concurrent winning import or removal, rather than a stale pre-preparation snapshot.

Removal deactivates metadata without deleting immutable material existence. Existing goals and captured runs keep their known references. New goals can reference an inactive known material; library activity does not silently erase historical context. None of this grants an agent access to unrelated source paths or replaces the existing captured-material staging and hash checks.

## One authority and callback lifetime

SQL material rows, existence references and incremental counts are written in the same transaction as entity/usage changes, the ordered union event stream and the shared command receipt. A caught physical reference insert failure remains sticky and rolls back the entire transaction, including earlier rows/counts/events. Metadata JSON is checked against indexed identity/scope/activity. Point identity queries and incremental counts avoid a library-history scan on each SQL admission.

The File material and entity facets share a small temporary document-facet helper for lifecycle, canonical result handling and sticky write failure. They still commit through the sole existing FileStore queue and atomic file replacement. No metadata sidecar or second receipt/event authority was added. The File implementation still scans its document and rewrites its history; a narrow interface alone does not supply SQLite scaling.

Transaction/query capabilities expire on completion or failure; asynchronous callbacks cannot retain storage authority after rollback. A saved void receipt is distinguished from absence through a wrapper, so it cannot authorize a new import by appearing uncached. Fingerprint conflicts fail before callback/preparation. Actual importer project binding is checked before receipt lookup, registry projection, loader selection or blob publication. Two independent real File/SQL negative tests confirm that a foreign facet cannot mutate foreign metadata, add receipts or create copied files.

## Bytes, events and explicit durability scope

Source reading and loader work occur before the metadata transaction. Loaders retain their copied-byte-only inputs; no new filesystem executor or provider callback is granted through Core material metadata. Import inputs are captured before queueing. New blobs are written completely into private temporary files, synced, then linked into their content-addressed destination without replacing an existing blob. Existing destinations are hash verified. Temporary files are removed; successful preparation followed by a metadata rollback can leave an unreferenced complete blob, without a registered material or execution grant.

This proves atomic complete-byte visibility under the tested process/concurrency cases. Directory entries are not synced before metadata commit, so full power-loss persistence of a newly published blob path is not established. The existing active FileStore rename path has the same separate directory-durability limitation. Full authority/artifact activation must address path durability before a production SQL cutover; this slice does not claim that guarantee or filesystem/database distributed atomicity.

Material reactivation events update the existing connected-client row by ID. They do not append duplicate rows or replace frozen historical run context. Zero/N-change public revisions now agree with event replay, and the existing event-delta/history reopen tests pass after the shared commit-path correction.

## Independent validation

Final frozen-source run: **61/61 passed**, covering the four new independent architecture regressions, Core material semantics, actual File/SQL importer services, concurrent changed-source receipt replay, canonical reactivation, physical partial-write rollback, missing-counter reopen rejection, live client projection, real copied PDF/DOCX extraction, prior entity/business transactions and historical event replay. Earlier overlapping runs passed 53 and 57 cases; these are not additional distinct tests.

Full typecheck passed after the callback-capture correction; the final revision arithmetic line received the complete 61-test rerun. `git diff --check` and review-file formatting passed. Parent final full-suite/build/typecheck and actual browser evidence are separate owner validation.

Only `tests/stage5a3b-architecture-review.test.ts` and this report were added by this reviewer. Production corrections were made by the owner. Tests used temporary files/state and synthetic model/backend fixtures. No paid/real models, RTX, secrets, original repositories or Git commits were used.

## Remaining limits

The importer no longer directly consumes store snapshots/document transactions/ambiguous receipts. It still obtains project root metadata through `registry.list()`, whose current production implementation projects underlying snapshots. A narrow project identity/settings port remains future work; this is not a global snapshot-free architecture claim.

Existing material limits remain: 1,000 library rows, 64 active project materials, 64 files/48 MiB per import, 8 MiB per source and the existing nesting/extraction bounds. Their explicit/default-none policy cutover has not happened and is not claimed by this migration. SQL uses the fresh unreleased v3 schema with no old-format adoption or automatic counter reset. Full Run/material-blob authority, artifact cleanup/durability, model packets, dispatch claims and production SQL activation remain separate stages. Frozen resource/role/material grants, unknown-effect reconciliation and final review/check acceptance retain their current owners.
