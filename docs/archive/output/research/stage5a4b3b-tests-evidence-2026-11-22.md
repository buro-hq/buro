# 5A4b3b independent stopped-attempt and continuation evidence

Date: 2026-11-22. Working continuation of `1cc24d1`. Scope: genuine nonaccepted stop commands, immutable continuation attempts, their named authority readers, and actual File execution ownership/scheduling. This does not claim full SQL execution or session/effect-journal adoption.

## Genuine command sequences on both authorities

`tests/run-attempt-contract.test.ts` creates actual goals/materials and a real user coordinator fixed to a nondefault eligible frozen runtime. It admits a Run, begins execution, binds a prepared workspace and accepts a genuine worker plan through the existing Core commands. Actual `ExecutionService.finish` and `resume` then execute with snapshot and generic document mutation methods that throw. File and SQLite therefore use the semantic authority facets, with scheduling held and no model/tool/check effects.

Repeated repair/recheck commands create distinct monotonically numbered attempts and exact predecessor links. Workspace, original accepted plan and assignment grants retain their original immutable attempt identity; the new context authorizes inheritance by explicit origins. Original task/criteria and complete clarification remain retrievable. Current-attempt reads retain exact control-role versions, selected coordinator decision, resource pool, workflow, policy/checks and material references. A current-profile continuation adopts the saved current profile while preserving the frozen role/resource pool, matching the existing resume contract.

Changed tasks disable old compact-task authority and retain the complete updated goal. A goal reverting to the original text cannot reactivate an older compact grant. A genuine first plan accepted on the changed continued task can authorize its own compact tasks for the following attempt. Actual File worker completion evidence survives unchanged-goal repair, and the existing pending-worker selector does not request the completed worker again.

## Ownership, races and rejection

Two actual competing resume commands authorize one successor. Stale predecessor/phase/stop tokens, stale goal/current-profile revisions and caller-supplied foreign origin fields reject without changing the new attempt. The stop command cannot manufacture completed/accepted status. An observed ordinary failure with a preserved unresolved operation becomes needs-attention; continuation still rejects and never replays an external effect.

Actual active work on another goal blocks continuation. A genuinely older stopped Run with an unresolved indexed fact also blocks a named newer stopped sibling of the same goal. Both Runs are admitted, prepared and stopped through actual commands. The SQLite test-only unknown marker changes only the existing indexed unresolved fact; it does not fabricate terminal/accepted Runs, usage accounts or an effect journal.

The File scheduling regression uses real `schedule`, `execute`, workspace preparation/restore and semantic stop/resume. Planning is held at a synthetic boundary, and the old runtime release waits after terminal state commits. Resume saves a genuinely new queued attempt while that old job is still registered. Explicit old-owner update/finish callbacks reject and leave current state unchanged. Only after old cleanup releases does the scheduler dispatch the new attempt exactly once. No new attempt is lost, no attempt is dispatched twice, and no model or checkpoint effect is invoked.

Two additional actual scheduler edges pass. If the newly queued attempt is canceled before old cleanup releases, that exact new attempt receives an interrupted stop after cleanup: it is not left active/canceling, its predecessor stop remains unchanged, and no new restore, planning, runtime, check or model dispatch occurs. If old environment cleanup throws after continuation has queued, the old job keeps its rejection available to lifecycle awaiters while its successor still dispatches once after cleanup; the detached scheduler creates no unhandled rejection.

## Atomicity, retry and indexed history

File replacement and late SQLite timeline insert faults occur after earlier stop or continuation row changes. The SQL callback deliberately catches the physical failure. Sticky failure still rolls back current state, immutable records, goal linkage, timeline/public events and command receipts. Reopen sees no partial attempt, and the same command can succeed after the fault is removed.

Canonical resume receipt replay occurs after a later attempt and reopen, before newer current-state validation; it neither appends another attempt nor republishes an event. Conflicting fingerprints reject. Named current-attempt query traces and returned row counts are identical before and after 64 genuine stop/continuation cycles. Both probes start after the second continuation, so the current and immediate predecessor each have stored continuation context. The first continuation instead derives its initial predecessor context from admission. The test retains exact query/row-trace equality after the bounded immediate-predecessor/lineage validation amendment; it does not relax the comparison to allow history-dependent work. This proves bounded indexed query shape independent of that retained history, not throughput or SQLite VM scan counts.

Raw SQL helpers require a synthetic directory prefix, canonical path and explicit fixture marker. Every source root, workspace and authority is a new temporary fixture. No original user project, live model, RTX host or `output/ux/` path is accessed.

## Validation

Command: `node --test tests/run-attempt-contract.test.ts`.

Result: **27/27 passed**, no skips. Owned test/fixture formatting and `git diff --check` pass. Counts overlap any parent's full-suite count and must not be summed with it. Parent integration/browser validation and independent architecture/boundary reviews remain separate gates.

The tests do not claim automatic recovery of unknown external effects, dispatch leases, SQL runtime/session execution, accepted-result evidence/application migration, full public/private history paging, default-none limits or live-model quality.
