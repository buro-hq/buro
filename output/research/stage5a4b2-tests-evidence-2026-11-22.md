# 5A4b2 independent workspace-binding test evidence

Date: 2026-11-22. Working continuation of `de0e71f`. Scope: genuine prepared workspace ownership and the actual initial/restore consumers; not full SQLite execution adoption.

## Actual consumers and retained identity

`tests/run-workspace-contract.test.ts` creates each goal and queued Run through actual `GoalService` and `ExecutionService.start`. Scheduling is held. Both File and SQLite tests call actual Core activation, phase and workspace-binding helpers with legacy snapshot/document mutation methods that throw. No accepted Run or successful execution is manufactured.

The immutable binding retains Run/admission/initial-attempt identity, exact observed path/base commit and original creation time. Detached read mutation cannot change authority. Identical later observations keep the original binding and publish no extra event; conflicting path/base observations reject. Reopen preserves the record. Named reads use only `run.current` and `run.workspace` point-query instrumentation, with at most one returned row per query, and reject an unknown Run. This is a bounded query-shape proof, not a VM-scan or throughput benchmark.

Actual File `execute` uses a synthetic preparation adapter and stops at the real downstream planning boundary. The test verifies binding has committed before planning receives the workspace, original source branch remains the selected base input, source root differs from isolated workspace path, and no accepted commit/model/check is produced. The original workspace/base binding is also retained after actual resume receives a different path/base from restore; no alternate identity is adopted or passed into planning, and cleanup releases the actual returned handle path.

## Cancellation and acquired-resource cleanup

Cancellation before execution causes no prepare call, binding or release. Cancellation committed while the preparation result is held still permits retention of the observed preparation: the test captures the committed binding with current status `canceling` and cancellation set, before the binder returns. Execution then records interruption without planning, model or check dispatch. Cancellation while the committed binding response is held behaves similarly.

Cleanup receives exactly the observed prepared path. A separate actual-executor test makes preparation succeed and then fails both binding persistence and the subsequent failure-result persistence. The acquired workspace is still released even though no durable binding exists. This proves live acquired-handle cleanup, not crash-orphan recovery or durable dispatch ownership.

## Atomicity and corruption

The cross-adapter fault cases fail File atomic replacement or a late SQLite `workspace.prepared` timeline insert after the workspace row/current writes. The SQLite callback catches that physical failure; sticky transaction failure still rolls back the binding, current state, public event and command receipt. Reopen finds no partial binding, and retry under the same command identity succeeds once the fault is removed. Later cancellation/reopen and receipt replay do not execute the callback again.

An explicitly marked temporary SQLite fixture drops the required `run_workspaces` table after close. Reopen fails with `USAGE_AUTHORITY_FORMAT`, and an independent schema read confirms the missing table was not recreated. Raw SQL helpers are restricted by a synthetic directory prefix, canonical path and marker file, and cannot target arbitrary databases.

## Validation

Command: `node --test tests/run-workspace-contract.test.ts tests/run-execution-state-contract.test.ts tests/run-timeline-contract.test.ts`.

Result: **37/37 passed**, no skips: 17 new workspace tests, 18 preceding lifecycle cases and two preceding timeline cases. Counts overlap any parent full-suite result and must not be summed with it. New tests/fixtures pass Prettier.

All source roots, authorities and adapter paths are newly created temporary fixtures. Original user projects, model endpoints, RTX and `output/ux/` remain untouched. Session/turn/effect journals, continuation-attempt migration, SQL full executor activation, public history paging, default-none limits and live-model quality remain outside this test claim.
