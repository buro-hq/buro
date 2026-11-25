# Stage 5A4b1 independent architecture/code review

Date: 2026-11-22. Reviewed the working changes against `a169551`, the saved Run/journal plan and implementation progress. This review covers semantic execution activation and phase changes, their actual Core consumers, File/SQLite storage, public lifecycle events and mixed history replay. It does not approve production SQL execution adoption or first-release readiness.

## Finding and correction

The initial change had a history reconstruction defect: File event expansion ignored the new lifecycle event, while the next legacy Run delta was packed against state that already included that lifecycle update. A client replaying persisted history could therefore lose the phase, update time and phase timeline entry after a later `run.changed`, despite live clients seeing the correct committed state.

The reviewer independently reproduced the defect in `tests/stage5a4b1-architecture-review.test.ts`. The first isolated compression/replay regression failed with the missing phase and timeline evidence. The parent corrected `expandEvent` to maintain its private reconstruction map through admission, cancellation and lifecycle events using the shared read projection helpers. The reviewer examined this correction and verified both the compression boundary and actual File store live/replay/reopen equality through a full checkpoint, lifecycle update and later persisted delta. The production correction belongs to the parent; the two regression tests belong to this independent review.

No further blocking finding remains within the reviewed slice.

## Contract assessment

`beginExecution` and `advancePhase` are closed semantic operations on the required Run facet, consumed by the existing initial/continued executor and phase helper. They require the appropriate current lifecycle, reject cancellation and unresolved goal operations, and validate the next scalar revision before storage writes. A phase change cannot activate queued work or manufacture a terminal/accepted result. Repair can return through relevant phases without introducing a new scheduler or a false strictly linear phase graph.

The File adapter retains its sole document authority and existing accounting ledger. It appends actual phase entries while preserving worker/check/command evidence, refreshes presentation from that same authority, and publishes only after commit. SQLite uses the existing scalar current row, scoped guard index, separate timeline and shared event/receipt transaction. Its strengthened CAS compares all previous scalar fields. No growing Run blob, generic public patch callback, SQL legacy executor hydration or second accounting owner was introduced.

The post-activation checks prevent the tested committed-cancellation-before-result-delivery race from reaching workspace preparation. The phase helper likewise checks narrow current state after its awaited transaction. These checks are not a dispatch lease: cancellation can still occur after the final read and external dispatch boundaries remain owned by the existing executor/runtime. Cross-process execution ownership, durable dispatch effects and unknown outcomes are subsequent journal work. Existing reconciliation authority is checked, not replaced or cleared.

The public lifecycle projection retains existing histories and adds the committed phase item. Persisted replay now updates the same reconstruction state before later legacy deltas. The `.runs` command composition can emit activation plus phase in one transaction; it cannot expose legacy `run.changed` mutation through its transaction capability. Full public paged history remains pending.

## Independent validation

The focused command passed **25/25 tests**, no skips: the two new architecture regressions, 18 execution-state contracts, two cross-adapter timeline contracts and three existing event-storage regressions. These include actual narrow consumers with legacy snapshot/transaction access disabled, competing activations, cancellation, canonical receipt replay/reopen, outer and physical write rollback, terminal-result protection and committed cancellation while activation returns.

`npm run typecheck`, formatting of the reviewer-owned test file and `git diff --check` passed. Full-suite and browser results belong to the parent's integrated validation and are not claimed here. No real model, native process, RTX endpoint or original user project was accessed; `output/ux/` was preserved.

## Remaining gates

Workspace/plan/assignment/continuation/failure/acceptance writers still use the existing aggregate where recorded in the plan. Runtime observation deduplication, indexed Run owner lookup, session/effect/accounting journals, complete private artifacts, bounded active context and complete public history remain subsequent slices. The initial-attempt reference is not a migrated continuation journal. Finite policies remain unchanged. This slice is an incremental persistence cutover, not evidence that default-none execution or first release is complete.
