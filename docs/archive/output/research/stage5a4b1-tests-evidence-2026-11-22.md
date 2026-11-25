# 5A4b1 independent execution-state contract evidence

Date: 2026-11-22. Reviewed against the working continuation of `a169551`. This evidence concerns activation and phase commands, not full SQL execution adoption.

## Prior 5A4a missing-Run timeline correction

Independently reviewed `createRunTransaction.timeline` and both adapter query facades. The shared command validates the cursor, reads the named current Run, and rejects a missing Run before the storage timeline reader executes. A valid empty page therefore cannot fabricate Run existence. Invalid foreign cursors still fail before the current lookup.

The strengthened cross-adapter test checks direct queries, the transaction-bound reader, a valid zero-watermark cursor, a foreign cursor, reopen, absence of a failed-command receipt, and absence of published events. SQLite query instrumentation confirms no `run.timeline.*` query occurs for the missing Run. Both tests pass.

## New lifecycle tests

`tests/run-execution-state-contract.test.ts` creates real goals and admissions through `GoalService` and `ExecutionService.start`, with scheduling held. No accepted-Run fixture or SQL whole-Run snapshot is used. Actual `ExecutionService.beginExecution` and `phase` consumers run with legacy snapshot and document transaction methods that throw.

The same File and standalone SQLite scenarios cover activation and phase persistence, two competing activation commands, cancellation before activation, overlapping phase/cancel requests, canonical receipt replay after later cancellation and reopen, conflicting command fingerprints, outer transaction rollback, and rejection of queued/terminal phase fabrication. The phase/cancel test distinguishes a committed phase receipt from a later post-await cancellation rejection; persisted timeline evidence determines what actually committed.

Physical persistence faults are separate from outer callback exceptions. The File case fails atomic file replacement. The SQLite case installs a guarded temporary trigger that fails phase timeline insertion after the current row changes, with the error caught inside the callback. Both cases assert unchanged current/history/events, no command receipt, correct reopen, and successful retry under the same command identity after the fault is removed.

Two additional File tests call the actual existing executor termination path. A settled failed Run cannot be reactivated or advanced by a delayed command. Cancellation committed while the activation transaction response is deliberately held prevents workspace preparation, model/runtime and check dispatch; actual execution saves an interrupted result. Legacy document access is enabled only for these deliberately unmigrated executor paths.

All fixtures live in newly created marked temporary directories. Physical SQL fault helpers verify the directory prefix, real path and explicit marker before opening the temporary authority. External effect stubs count calls and fail immediately if invoked. No model endpoint, RTX host, original project or `output/ux/` path is touched.

## Validation status

Final focused command: `node --test tests/run-timeline-contract.test.ts tests/project-runs.test.ts tests/project-run-services.test.ts tests/run-execution-state-contract.test.ts`. Result: **31/31 passed**, no skips. This includes 18 new lifecycle cases, the two strengthened timeline cases, and 11 existing Core/actual-service cases. Counts overlap any parent full-suite result and must not be summed with it.

The first independent SQL run exposed an integration omission: `validateProjectAuthorityChange` routed `run.lifecycle-changed` to the entity validator. The parent corrected that event branch; the final focused run above passed on both adapters, including the caught physical SQL write failure and reopen/retry proof. Test and fixture formatting passed Prettier.

These tests do not claim SQL session/turn/effect persistence, dispatch owner leases, active-context paging, continuation attempt migration, default-none limits, complete public history pagination, or live-model quality.
