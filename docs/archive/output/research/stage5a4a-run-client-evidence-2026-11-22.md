# 5A4a — actual admission/cancel and bounded client projection

Date: 2026-11-22. Six new integration cases in `tests/project-run-services.test.ts` pass against the actual `ExecutionService.start/cancel` and real File/SQLite facets. Every test uses a fresh temporary project. No model/provider call, RTX connection, user repository or secret was used.

The actual public scheduler method is held after commit. Runtime, workspace and check callbacks increment a counter and throw if called; all six cases end with zero effects. Store wrappers throw on legacy snapshot, document transaction and receipt access. This proves the migrated admission/cancellation use cases consume narrow project metadata, goal, settings and run facets; it does not pretend the rest of the executor has migrated to SQLite.

Both authorities persist a genuine queued run linked to a real goal. The saved admission retains the complete original body/criteria/task, exact profile, user coordinator instructions/model pin/provenance/version, workflow, selected grants and the inactive material explicitly attached to the goal. Inactive unselected library material is excluded. Removing a project material and editing the user role after admission leaves its original recorded task/grants unchanged. Cancellation persists canceling state before aborting the held job, and both command receipts replay after reopen with no duplicate Run or event. Fingerprint reuse rejects. Concurrent actual starts yield exactly one active winner; the losing goal remains draft/unlinked and its receipt is absent.

Run current records reject worker/history arrays; admissions reject an event-history field. The new public `run.admitted` event binds current/admission/attempt/goal/project identities and only represents initial queued work. `run.cancel-requested` carries current lifecycle only. A shared protocol-only read helper builds the temporary legacy UI Run from the immutable admission, with empty worker/command/plan history, one queued item and no invented acceptance result.

The event's optional closed `view` contains only existing managed-budget/effective-policy/stop/issue presentation DTOs. Tests explicitly use synthetic host-tool capability metadata in the projection scenario: the File event carries its actual sole legacy managed-ledger summary; the standalone SQL queue omits that view and does not invent an account or known-zero usage. Neither the view nor the helper can overwrite resource, role or session authority. The client applies cancellation scalar state and appends one stop item while retaining already displayed worker messages, commands and check data; exact global sequence replay is inert.

Timeline tests page the two real queue/cancel rows at limit one, retain the watermark and reject a foreign project cursor. SQLite instrumentation observes two indexed page statements returning at most limit+1 rows; no public event-history query is used by timeline reads. This is a bounded-read proof, not a throughput claim or the independent historical-size scalability test. Timeline DTOs also preserve the explicit known legacy thread/command/duration fields and allow omitted text; SQL's initial writer still writes queue/cancel only.

Validation:

- `node --test tests/project-run-services.test.ts` — 6/6 pass; `/private/tmp/buro-stage5a4a-run-services.log`.
- Core run semantic tests against the new protocol schemas — 4/4 pass; `/private/tmp/buro-stage5a4a-core-runs.log`.
- Changed protocol/client/test formatting and `git diff --check` pass. Parent owns final full TypeScript/build/test/browser gates and independent race/fault/architecture reviews.

No SQL production switch, growing whole-Run JSON writer, accepted-result writer, dispatch journal, new accounting authority, quota removal or default policy change is introduced by this client/test slice. The File adapter still owns the sole live legacy executor. SQL proof is queue/cancel/read only; execution and acceptance migration follow separately.
