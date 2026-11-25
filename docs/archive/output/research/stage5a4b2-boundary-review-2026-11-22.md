# Stage 5A4b2 independent boundary and client review

Date: 2026-11-22. Reviewed working changes after `de0e71f`: observed prepared-workspace ownership, narrow named read, continuation restore and public replay. This is a bounded implementation review, not first-release approval or full SQL execution evidence.

## Result

No additional blocking defect found in the reviewed boundary. The architecture reviewer identified a File integrity gap when the entire immutable binding map was removed, or a legacy callback supplied a workspace without a binding. The parent added the reverse projection-to-binding existence guard. I inspected that guard and independently ran the architecture regression cases after the correction; all passed.

Core binds an observed workspace to the exact Run/admission/initial-attempt identity. A matching retry returns the original binding without advancing revision or duplicating history; conflicting path/base observations reject. Binding an observed result during cancellation retains ownership without changing the stop request or dispatching further work. The reader validates identity from the same authority rather than treating legacy projection fields as the grant. Continuation restores the retained path/base and rejects a changed returned identity before planning/model/check work. Acquired-path cleanup remains local to the actual returned workspace even when persistence fails.

SQLite format v6 adds separate immutable workspace rows with foreign keys and update/delete triggers, rather than a whole Run column. Its insertion, scalar CAS, guard index, timeline, public event and command result share the existing transaction. Named reads query only current and workspace by Run ID and return detached records. Missing required workspace tables reject on reopen before an empty table is recreated. No SQL executor snapshot, production factory switch, accounting sidecar or old-user-state migration is introduced.

Public wire and authority validators agree on the exact Run/admission/attempt/time linkage, preparing phase and running/canceling status consistency. The binding event has a fixed observed-history entry and allowlisted presentation fields. It cannot declare acceptance. Client replay keeps existing messages, command/check evidence and original source branch while projecting path/base and the existing cancellation. File event expansion incorporates the binding before applying later compacted legacy Run deltas, so history is not appended twice and workspace identity is not lost.

## Independent checks

Added `tests/stage5a4b2-boundary-review.test.ts` with three cases: invalid/foreign/private workspace packet matrix checked by both validators; client cancellation/evidence/duplicate replay; and mixed workspace-bound plus packed Run-delta expansion. The first reviewer replay fixture omitted mandatory Goal fields; that synthetic fixture was corrected before the passing run. No production change was required by these cases.

Executed `node --test tests/stage5a4b2-boundary-review.test.ts tests/run-workspace-contract.test.ts`: **20/20 passed**, no skips.

After the parent File integrity correction, executed `node --test tests/stage5a4b2-boundary-review.test.ts tests/stage5a4b2-architecture-review.test.ts tests/run-workspace-contract.test.ts tests/run-execution-state-contract.test.ts tests/run-timeline-contract.test.ts`: **43/43 passed**, no skips. This includes the three architecture regressions for callback bypass, deleted map on reopen and exact live/replay/reopen mixed history. Counts overlap each other and parent validation; do not add them to the full-suite count.

`npm run typecheck`, `git diff --check` and formatting of the added reviewer test passed.

## Limits retained

This slice preserves observed prepare identity, not a durable pre-dispatch workspace-operation receipt, process lease or unknown filesystem-effect recovery protocol. File still persists its growing document and execution still has remaining aggregate consumers. Continuation attempt references have not been migrated into a new journal. Full session/effect/accounting transactions, private artifacts, paged complete public history, real acceptance/results/apply ownership, SQL production adoption and default-none policy remain subsequent work. Existing finite policies are unchanged. No model endpoint, RTX machine, original user project or `output/ux/` was used or changed.
