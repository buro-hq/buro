# Stage 5A3b independent material-port and immutable-publication review

Date: 2026-11-22. Scope: required material facet, actual importer migration, standalone SQL material rows and the shared sole-authority File bridge. **Clear within this material metadata/import/publication and client projection scope**, after the captured-host and public revision corrections below. This reviewer added tests and this report only, with no production edits or commit. The parent owns final repository/build/browser receipts.

## Independent evidence

The initial combined material/importer/facet regression run passed **68/68** tests. It covered new Core/SQL/File material cases, cross-adapter importer races, existing context storage/loaders, shared entity facets, historical events and frozen research inputs. That run preceded the final public revision correction and is not presented as a final whole-stage suite.

After that correction and the architecture review's final freeze, an independent **34/34** targeted run passed: complete File/client snapshot equality for zero/N events, File material/entity batches, actual cross-adapter business cases, production socket projection/transport and historical event deltas. Full `npm run typecheck` was rerun and passed on this final source state. `git diff --check` and formatting of this review's files passed. Runs overlap and are not additive. This reviewer did not run the repository-wide full suite or a browser.

Local receipts: `/private/tmp/buro-stage5a3b-independent-new.log`, `/private/tmp/buro-stage5a3b-independent-tests.log`, `/private/tmp/buro-stage5a3b-independent-architecture.log`, `/private/tmp/buro-stage5a3b-independent-final-revision.log` and `/private/tmp/buro-stage5a3b-independent-typecheck.log`. Tests use actual temporary File/SQLite authorities, controlled local importers/loaders and immutable copied bytes. No live model, RTX host, user repository, credential value, external message, deployment or Git commit was used.

## Independent regressions added

`tests/stage5a3b-review.test.ts` adds four passing cases, covering both adapters:

1. A loader with the same ID/revision returns different extracted text for unchanged original bytes. The existing canonical material is inactive; a proposed batch first prepares a fresh material and then the conflicting extraction. Admission rejects before either metadata change commits: the old record remains inactive, its original extraction is unchanged, the fresh row does not exist, and there is no event or successful receipt. Returning the original extraction allows the same failed command to retry, attaches the fresh row and reactivates the original canonical ID/time. Reopen preserves both committed metadata and the retry receipt.
2. A real blob file handle is held after writing only half its content to a private temporary file. While held, the content-addressed final path is absent, metadata count is zero and no material receipt/event exists. Releasing the write lets the normal file sync and atomic publication finish before metadata admission. Final bytes match the declared hash, mode is 0600, the completed file has one link and no temporary file remains. This proves complete-byte visibility ordering, not power-loss durability.

The tests assert actual copied/extracted bytes and persisted metadata rather than inferring immutable content from a hash label alone. SQL row counting in this private fixture is only a negative assertion that a failed batch did not partially attach metadata; it is not a new production scan or benchmark API.

## Findings resolved during review

The architecture reviewer found that the exported File facet helper looked up caller-owned host callbacks later. Replacing those callbacks could retarget the supposedly captured material facet's write/read/receipt authority. The parent captures the original transaction/read callbacks in the shared helper and the original read/project identity in material receipt lookup. The independent architecture regression was rerun here: a facet created for one actual File store continues using it after the caller replaces the host callbacks with another store's callbacks.

The architecture reviewer then reproduced a real public revision divergence. File commits incremented `revision` once per command, while the production client increments it once per event. A receipt-only duplicate attach generated no event but advanced the server revision; a multi-event transaction advanced the client twice and server once. The parent changed the File public revision increment to the number of emitted changes. Receipt-only commits now leave the public revision alone, and N-event batches advance it N times. Existing goal/profile CAS uses its own explicit revisions and was not weakened. The final independent 34-case run includes full snapshot equality after zero-event duplicate attachment and multi-event remove/reactivate, plus real socket/transport and historical-delta regressions.

No remaining blocking finding was identified in this reviewed scope.

## Material semantics and authority

Stable metadata identity includes scope, name, raw content hash and loader ID/revision. Original and extracted hashes must match their exact stored blob basenames, and extracted path/hash appear together. Prepared attachment records require active state, representation and loader provenance. Original and extracted bytes are prepared by the file adapter; the metadata facade does not claim to verify arbitrary external bytes by itself.

Deduplication resolves to the real canonical record, not a new candidate ID. Only ID, creation time and active state may differ when comparing a duplicate candidate with immutable payload metadata. An inactive match reactivates its original record/time; an active match returns it without a new event. A different extractor revision is a new logical identity. Project and goal scopes stay distinct even when physical bytes are shared.

The entire batch resolves identities, ID reuse, immutable metadata conflicts and finite library bounds before its first metadata write. Repeated inputs consume only their real canonical slots. Reactivation counts against active-project capacity without adding another total row. Existing limits of 1,000 library records and 64 active project materials remain explicit and unchanged; this is not default-none policy adoption.

Removal deactivates metadata rather than deleting an immutable material reference. Existing goal and captured research/run references retain the original ID and bytes. Historical receipt replay returns the historical result without silently reactivating a currently inactive material. A separate new import may reactivate that canonical record and emits the canonical ID, allowing the client to update its existing row rather than append a duplicate.

## Importer, races and filesystem boundary

The actual `ContextMaterials` importer now uses the required material facet for command receipts, attachment and removal. It does not read a whole project snapshot or mutate document arrays directly. The requested project must match the facet before receipt lookup, source-root projection, loader callbacks or blob publication. The architecture regression verifies this with actual foreign File and SQL facets and zero pre-I/O counters.

Import input is detached before queuing. Loaders receive copied bytes, and prepared original/extracted data is published before metadata admission. Concurrent importer instances converge on one canonical row. The existing actual races independently rerun here cover a material removed while another import is held and identical command IDs preparing different source versions: the committed winning receipt governs the returned metadata, not the losing caller's stale prepared candidate. A retry can replay after the source is deleted without rereading it.

Receipt lookup distinguishes absent from a saved void result. The importer rejects a found non-import-shaped receipt before preparing input; fingerprint conflicts use the authority's shared command namespace. Deferred preparation never supplies permission to overwrite a canonical extraction or bypass current finite counts when metadata finally commits.

Blob preparation writes a private unique temporary file, syncs the completed contents, publishes via an exclusive content-addressed link and removes the temporary name. An existing target is accepted only after regular-file/symlink/hash checks. No reader sees this process's partially written content at the final address. Preparation can leave complete unreferenced blobs if metadata later fails or another request wins; those files are not metadata references or execution grants.

The directory entry itself is not fsynced in this slice. There is no claimed power-loss guarantee spanning file publication and a metadata commit, no filesystem/SQLite two-phase commit and no complete artifact/orphan GC design. Those limits are explicit; atomic complete-byte visibility and process-level metadata rollback must not be described as stronger durability evidence.

## SQL/File transactions and lifecycle

The fresh standalone SQL format is v3. Material metadata, unique identity index, retained existence reference, incremental total/active-project counts, public events and command receipt are written in one existing authority transaction. Reopen does not silently reset a missing count summary. Count and metadata replacement compare previous values; a caught physical reference/count/event failure remains sticky and rolls back earlier usage/entity/material writes and the receipt.

The SQL `{usage, entities, materials}` facets use one sequence and receipt namespace. File entity/material facets share one small callback-lifetime/canonical-result helper over their sole existing document authority. There is no independently committing File material database or live JSON/SQL dual write. Async/thenable callbacks reject; retained transaction/query capabilities cannot write after completion. Read results and command outcomes remain detached, with canonical JSON/void replay.

File persistence failure leaves metadata, events and receipt unchanged. Existing transition validators still protect frozen roles/resources, research, result application, budgets and unknown effects when the common commit path runs. The final client correction preserves complete public snapshot parity for zero/N material events. Existing loader/image/reference-only semantics and frozen research material grants were independently rerun; this migration does not invent image interpretation or broaden a historical agent's material grant.

## Quality and remaining migration work

The Core material facade owns identity/admission rules; adapters own indexed or document rows; the importer owns byte preparation. That split avoids duplicate stale-library decisions in the importer and lets both adapters enforce the same race outcome. The shared File facet helper removes repeated callback/receipt machinery while preserving captured ownership. No extra material store, generic plugin framework or competing authority is needed.

Production File stores still own the remaining project state. The SQL material facet is exercised through actual services in controlled compositions, but the full Run/session/artifact runtime cutover is not complete. Read-only existence references are not code-acceptance evidence. Whole-project SQL adoption, dispatch claims, canonical model/tool artifacts, default-none budgets, package distribution and stronger byte durability/GC remain separate work. Trusted in-process adapters and correctly derived command fingerprints are still part of the contract; this review does not claim malicious-plugin isolation or protection against arbitrary same-user private-file rewrites.
