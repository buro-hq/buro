# Stage 5A3a independent architecture and boundary review

Date: 2026-11-22. Baseline `a51dbee`. Final bounded review of frozen Core/entity/SQL sources and the active FileStore bridge, including the final foreign-entity-facet guard delta.

## Decision

Bounded clear. No blocking finding in this slice. Actual GoalService and RoleService now consume required semantic entity ports rather than reading a whole project snapshot or writing a mutable document. The active FileStore bridge and the isolated SQLite facet use the same Core rules, with one existing storage authority per composition.

The SQLite project-kernel cutover is not complete. Full Run storage, real Run/entity admission, dispatch claims, model packets and production SQL adoption remain future work. No default budget-policy change is established here.

## Final boundary correction

P2 — an injected registry store could expose an entity facet belonging to a different project. Unlike goal creation, goal update/delete and role save do not carry a project ID down to the final row write, so the metadata mismatch could mutate the foreign project. The final Core helper captures the facet and verifies its `projectId` against the requested project before any of the four service transactions. There is no document fallback. The four final independent review tests passed against real File and SQL authorities, proving zero foreign writes/receipts and whitelisting of user fields/provenance. This delta was independently read and rerun after the earlier clear; no further source change was needed.

## Service and entity rules

`ProjectStore.entities` is required; the converted services have no optional snapshot/transact fallback. Their command callback is the authority for IDs/timestamps, so a receipt replay does not generate new values. User role saves explicitly create user provenance while preserving generated lineage and omitted runtime preference. Supplied kind, model or provenance data does not create resource grants or relax execution acceptance.

The shared Core facade validates new goal and role rows and binds goal project identity. A created goal must be draft, revision one and without a run binding. Edits use the captured revision, prevent running-goal mutation, preserve omitted material selection and validate explicit material/parent changes. Goal deletion rejects current running state or any actual busy preview/delivery associated with the goal. An older busy result is not lost behind a latest-runs page boundary.

Parent references require the stored completed status and saved commit, rather than existence of a run ID alone. Known immutable material references remain attachable after library deactivation. These are reference facts, not a newly fabricated code-acceptance decision. The SQL run/material indexes currently have read capabilities only; tests explicitly seed their reference facts without claiming production writers or full accepted Run rows.

Roles append only the expected next version and keep historical instructions, model preferences and provenance addressable. SQL stores immutable version rows with a separate CAS head; updates/deletes of old version rows are blocked by triggers. The File bridge retains the existing role-history transition guards at commit. Neither facet silently overwrites older versions or edits captured live run grants.

## Atomicity and failures

SQL entities and usage share one open transaction, command-receipt namespace and ordered union event stream. Entity events are not filtered out of usage pagination, so advancing its cursor does not skip hidden sequence holes. Row JSON and indexed goal/role identity/revision/version are validated together. Goal replacement/delete use the original complete row plus revision; role head movement compares its previous version.

Physical write failure is sticky for the whole SQL transaction, even when the callback catches the exception. A failed role-head insert cannot leave a version row, unrelated goal, usage admission, event or successful command receipt behind. Core validation errors remain ordinary callback errors; they do not pretend to be physical storage failure or external-effect uncertainty.

The File entity bridge batches zero or multiple entity changes into one existing atomic file replacement. It uses the existing private receipts and event sequence rather than creating a sidecar authority or dual-writing SQL. Every successful batch preserves the existing run-budget, planning, operational context, research, role snapshot, result-application and reconciliation transition guards. The older one-change `transact` method delegates to the same commit path for callers not migrated yet.

Deleted goal IDs remain reserved: SQL uses a tombstone row and the File bridge a private tombstone list retained on reopen. The independent new regression covers both authorities: after delete/reopen, a batch stages another goal and catches a reused-ID storage conflict. The entire batch still rolls back, the deleted ID stays absent, the staged goal does not survive reopen and the same command can retry successfully. A later exact command replay returns that retry receipt without rerunning its callback.

## Callback lifetime, events and representation

Both entity facades close transaction capabilities after success/failure and reject asynchronous callbacks. Read facades do not grant mutation. Returned rows/results are detached, and shared canonical JSON preserves optional object values and measured zero without accepting invalid arrays/getters as transaction results. SQL and File use the same small result codec rather than separate normalization rules.

File events receive one sequence per actual change, with one persistence operation for the batch. Receipt-only commands can have zero events. Reentrant subscribers replay the already committed batch and receive each sequence once through their own delivered cursor. Run-delta packing remains on the existing event-log path; the independent legacy history/reopen tests passed after the commit-path change.

The File bridge remains a temporary whole-document implementation with collection scans and full file/history persistence. It does not gain SQLite's indexed scaling merely by exposing a narrow interface. SQL goal/role/reference queries are bounded indexed point/EXISTS operations; the callbacks do not expose an arbitrary SQL executor or reference-index writer.

## Independent validation

**109/109 tests passed** across four disjoint focused runs:

- 23 entity/business tests, including the new File and SQL tombstone/caught-write/reopen regressions, actual services through both authorities, busy-result history, immutable role versions, combined usage/entity atomicity and a caught physical role-head fault.
- 52 existing FileStore/application tests covering historical event replay/delta persistence, frozen budgets/planning/roles, unresolved effects, store factories and application ownership/cleanup.
- 30 prior SQL/Core authority regressions covering two-process command races, process termination before/after commit, saturated-revision settlement, unknown/poison reopen, exact replay, private files, public projections, watermark paging and 17,409 stored operations.
- 4 final foreign-facet and user-field/provenance regressions after the last Core project-identity guard.

Full typecheck, `git diff --check` and independent-file formatting passed before the final small guard; the guard received the focused four-test rerun and source review above. The parent's final full-suite/build/typecheck are separate owner evidence. Only `tests/stage5a3a-architecture-review.test.ts` and this report were added by this reviewer. No production sources, real models, RTX, secrets, original repositories or Git commits were modified.

## Explicit integration limits

The SQL format is the new unreleased v2 union schema, without an old-format reader or dual-history migration claim. Existing production stores continue to use their sole FileStore authority; the isolated SQL facet is exercised through real Core services in controlled compositions. Full project snapshots, Run/material writers and foreign-key admission must move under the eventual single SQL project authority before production cutover. Existing model routing, frozen role/resource decisions, unknown-effect reconciliation, fresh review and final checks retain their current owners. A goal row, versioned role or usage receipt is not accepted code or a new permission to dispatch an external effect.
