# Stage 5A4a independent tests and boundary review

Reviewed on 2026-11-22. No remaining blocker found in the queue admission, cancellation and timeline slice. Changes owned by this reviewer: `tests/stage5a4a-review.test.ts` and this report only.

## Independent tests

Added **5 actual SQLite regressions**, all passed:

- Trigger failures on timeline insertion and public event insertion occur after missing roles, admission, first attempt, current Run/index and goal link have been written. A callback deliberately catches the error and returns success. Sticky storage ownership still rejects and rolls back every new row, role, goal change, event and command receipt. Removing each fault permits a successful retry with the same command.
- A cancellation index update fails after the scalar current row changes. Catching that error cannot retain cancellation, its timeline item or receipt. Retry succeeds, and `canceling` remains active; a request to stop is not proof of termination.
- An old unresolved guard fact behind **17,409 newer failed facts** blocks actual `ExecutionService.start` with `RUN_RECONCILIATION_REQUIRED`. No whole snapshot/legacy transaction is available, and no new role, Run, goal link, event, receipt or scheduling effect appears. Clearing that explicitly seeded fact permits genuine queue admission with the scheduler held.
- A genuine queued Run with **17,410 timeline entries** supports a late keyset page and fixed watermark after a new cancellation entry arrives. Frozen pages return only their original history. SQL query observations return eight rows for a seven-entry page and three for its tail; no public event-history query supplies the timeline. `EXPLAIN QUERY PLAN` confirms indexed range search without a temporary sort. These observations count returned rows and query shape, not SQLite VM scan steps, throughput or dispatch performance.

Historical facts and additional timeline entries are written only through a guarded, marked temporary fixture database. They do not fabricate production accepted Run aggregates or imply an operational SQL writer exists.

Final focused command included Core Run tests, SQL Run tests, actual cross-adapter ExecutionService/client cases, independent tests and architecture tests: **24/24 passed, no skips**. Log: `/private/tmp/buro-stage5a4a-e-final-review.log`. Server typecheck, owned-file Prettier and `git diff --check` passed. The focused result includes the final derived-policy comparison and File immutable admission/attempt guards.

## Source and test assessment

Core performs goal/profile/resource/workflow/material/role preflight before its first mutation. A saved profile is compared with the entire derived execution policy; merely embedding the correct profile cannot conceal relaxed top-level checks or scope. The architecture regression exercises that case. Existing user roles and fixed preferences remain captured rather than rewritten; complete task and selected inactive material content remain available to the admission packet.

SQL provides scalar current rows, immutable admission/first-attempt records and append-only timeline rows under the same goal/role/event/receipt transaction. Current references have deferred foreign keys; append-only triggers protect captured rows. Active and unresolved checks use guard indexes, independently of any UI history page. The shared owner closes capabilities, rejects asynchronous callbacks and retains physical write failures even when a callback catches them. Read transactions and copied cursor input bind a page to project, Run and watermark.

The File bridge remains over the sole existing document authority and managed budget ledger. Its current projection reads existing executor scalar facts; its timeline slices existing events. The new common commit guard protects saved admissions, first attempts and identity links from legacy callbacks, while allowing actual executor progress. Architecture tests cover malicious rewrites/removal, reopen and subsequent legitimate progress/cancellation. This is not evidence that File history itself has become indexed storage.

Actual ExecutionService start/cancel uses the narrow facade with whole-document methods trapped in cross-adapter tests. Its held scheduler prevents a SQL queue test from invoking an unmigrated executor. Public admission/cancel parsers and reducers preserve displayed agent/command history and do not synthesize checks, independent review or acceptance evidence.

The shared semantic transaction plus thin storage bindings are understandable. A second admission policy or parallel budget owner would add conflicting authority; none is needed here. Keep the explicit scope boundary around queue/cancel until genuine execution writers and dispatch journaling are migrated.

## Limits

No production SQL factory/runtime cutover, SQL process dispatch journal, complete artifact storage, operational reconciliation writer or genuine accepted-result writer is claimed. The File executor and its legacy scalar/history bridge remain. Stop requests remain active until genuine termination is recorded. Current finite accounting/default limits are unchanged; no default-none policy activation or live-model quality/speed conclusion follows from these tests.

No models, network endpoints, RTX machine, secrets or original user projects were used. Full-suite/build/browser validation and commit are parent-owned receipts, separate from this focused review.

## Post-freeze check

After the root/A final source freeze, inspected the added File OPEN self-validation as well as common COMMIT validation. Saved admissions/attempts must remain canonically unchanged, all map keys and head/admission/attempt/legacy-Run references must bind, and orphan private packets reject. The full derived-policy comparison uses the saved profile; an explicitly injected policy remains usable when no saved profile exists, preserving the existing trusted host port.

Independently reran Core Run tests plus the latest architecture file: **8/8 passed**, including real File and SQL relaxed-policy rejection, private packet immutability across legacy writes/reopen, and legitimate executor progress/cancellation. The additional SQL policy case landed after the earlier 24-case receipt. No remaining blocker found for the frozen source.
