# Stage 5A4b1 independent boundary and client review

Date: 2026-11-22. Reviewed working changes from `a169551`, including the parent correction that routes `run.lifecycle-changed` through the standalone authority's Run validator. No release readiness or full SQL executor signoff is implied.

## Findings

No blocking boundary defect found within activation and phase commands. Core owns the semantic transitions; adapters receive a validated scalar current CAS and an explicit timeline append. There is no public arbitrary Run replacement, terminal-result command, fabricated accepted SQL Run, full SQL Run hydration or production SQL switch. File remains the sole active authority and its existing growing document/history/accounting ownership remains explicit.

SQLite compares complete prior scalar lifecycle identity/content, updates its real guard index and appends phase/event/receipt within the existing transaction. Physical timeline failure invalidates the transaction even when caught by a callback. File uses the same commit queue, appends the phase exactly once and retains the existing queue/cancel projection behavior. Transaction capabilities and observer publication continue to use the reviewed common facade/kernel: capabilities close before result processing, receipt replay skips the callback and publication follows commit.

Public lifecycle events carry current lifecycle and one optional matching phase entry plus allowlisted File presentation data. Both wire and standalone authority validation reject terminal/cancelled lifecycle claims, mismatched Run/time/phase entries and undeclared private fields. The Socket client preserves displayed messages, command outputs, plans and check evidence. Its project sequence gate ignores duplicate/foreign events and detects gaps before appending a phase. A missing or wrong-goal Run projection rejects instead of manufacturing state. The activation event can describe running/queued phase, but cannot assert acceptance or a completed goal.

## Independent evidence

Added `tests/stage5a4b1-boundary-review.test.ts` with three independent cases covering the wire/authority validation matrix, replay/evidence preservation and missing/mismatched projections. An initial reviewer test fixture omitted existing event envelope fields; the fixture was corrected before the passing run. No production correction was required by these cases.

Executed `node --test tests/stage5a4b1-boundary-review.test.ts tests/run-execution-state-contract.test.ts tests/run-timeline-contract.test.ts tests/project-run-services.test.ts`: **29/29 passed**, no skips. This includes the new three reviewer cases, eighteen actual lifecycle cases, two timeline cases and six queue/service cases; counts overlap parent validation and must not be added to its full-suite count.

The lifecycle cases exercise actual Core narrow consumers on File and SQL after genuine queue admission, hold external scheduling and reject snapshot/document callbacks. They cover competing activation, canonical receipt retry after cancellation/reopen, cancellation races, physical and outer rollback, invalid terminal phases, an actual File executor terminal result, and cancellation committed while activation returns with zero external dispatch. These are synthetic isolated authorities, not SQL coding execution.

Independently confirmed the prior 5A4a missing-Run timeline correction: cursor validation precedes current existence lookup, missing Runs reject before timeline row reads, failed read transactions retain no receipt, and reopen preserves the empty state on both adapters. Foreign cursors reject as invalid first.

`npm run typecheck`, `git diff --check` and Prettier on the new reviewer test passed.

## Remaining boundaries

Activation/phase writes do not provide cross-process executor ownership or an atomic external dispatch lease. Reads after awaited commits narrow cancellation races but cannot replace the later session/effect journal. Workspace bindings, plans/assignments, continuation attempt history, finish/acceptance, runtime dedup, private artifacts, complete public history paging and SQL production adoption remain future slices. File still performs whole-document persistence; scalar SQL reads and keyset timeline support are not a File scalability or throughput result. Existing finite policies remain unchanged. No model endpoint, RTX machine, original user repository or `output/ux/` was used or changed.
