# Stage 5A4b2 independent architecture/code review

Date: 2026-11-22. Reviewed the working changes after `de0e71f` against the saved Run/journal plan. Scope: immutable observed prepared-workspace binding, actual executor persistence and restore consumers, cancellation retention, acquired-resource cleanup, File/SQLite storage and public/replay projection. This is a bounded persistence slice, not full executor or SQL production adoption.

## Finding and correction

The parent identified a potential File OPEN hole: removing the entire workspace-binding map could leave an admitted Run's legacy workspace/base projection readable without its immutable owner record. The reviewer independently reproduced that case and an additional COMMIT bypass: a legacy document callback could set workspace/base on a genuinely admitted Run before any binding existed. Both regressions initially failed with a missing expected rejection.

The parent corrected admitted-Run validation to require a named binding whenever either projected workspace or base is present. The existing binding validator then compares exact path/base and Run/admission/attempt identity on COMMIT and OPEN. Reviewer-owned regressions now reject both bypasses without publishing state. Seeded nonadmitted legacy fixtures remain outside this narrow authority contract; no user-state migration or prototype compatibility is claimed.

No further blocking finding remains within the reviewed scope. The correction belongs to the parent; the three tests in `tests/stage5a4b2-architecture-review.test.ts` belong to this independent review.

## Architecture and behavior

The semantic bind command records only the exact path/base observed from trusted preparation, together with existing Run/admission/initial-attempt identities. It does not manufacture accepted commits, evidence, model grants or a dispatch lease. Matching retries return the original immutable binding; conflicting observed identities reject. Actual initial execution persists this observation before downstream planning. Continuation reads the named binding and checks the path/base returned by restore against it before later environment/model work.

A preparation that returns after cancellation can still retain its observed workspace while preserving canceling state. The executor then observes cancellation and settles as interrupted. This is ownership retention, not authorization to continue canceled work. The acquired workspace path is retained locally before bind persistence and after restore, so `finally` can release the actual acquired environment even when binding and later failure persistence both fail. A foreign restore result cannot silently replace the saved binding.

File remains the sole production authority and preserves its existing ledger. Binding, scalar revision, timeline, public change and command receipt share the existing commit queue. SQLite adds explicit immutable workspace columns and foreign references to its existing authority, with a new fresh-format version and required-table validation. It adds no whole-Run blob, dual writing or SQL executor hydration. The initial-attempt association is not a migrated continuation history.

Public workspace projection uses the shared bounded merge helper. Event reconstruction incorporates workspace observations before subsequent legacy deltas. The independent mixed-history regression uses actual admission, a legacy checkpoint, the real semantic bind command, a later packed legacy delta, live replay and store reopen; canonical JSON event and snapshot meanings remain equal, including retained path/base and timeline evidence.

## Independent validation

Focused tests passed **43/43**, no skips: three new architecture regressions, 17 workspace contracts, 18 execution-state contracts, two prior lifecycle architecture regressions and three existing event-storage regressions. The set covers both adapters' named reads, retry/conflict behavior, cancellation, rollback/reopen and missing SQLite workspace-table rejection, plus actual File preparation/restore/cleanup paths. It also verifies that binding commands/readers work with aggregate access disabled; the full executor remains deliberately File-owned.

Typecheck, reviewer-test formatting and `git diff --check` passed. Parent-owned full-suite/browser gates are separate evidence and are not counted here. No actual provider, RTX endpoint or original user repository was accessed; `output/ux/` was preserved.

## Limits retained

Preparation/restore still lacks a durable pre-dispatch effect owner. A crash after external preparation but before binding is not claimed recovered by this change. Local `finally` cleanup is not crash-orphan cleanup or a descendant-process lease. Unknown model/tool effects remain governed by the existing reconciliation mechanisms, with full effect/session/accounting journals pending. Workspace identity does not prove the later immutable verification/check/reviewer/acceptance chain; those grants remain separately enforced. Plans, assignments, continuation attempts, runtime observations, final result writers, complete artifacts/history and default-none policy cutover remain later work.
