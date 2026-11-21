# Stage 3B1 independent host-seam architecture and outcome review

Reviewed against committed baseline `9339110` and the frozen 3B1 implementation on 2026-11-22. Final disposition: **clear within this private Buro host extraction and its existing sole execution loop**. There is no SDK scheduler switch or generic public AgentBackend in this substep.

The reviewer changed no production source. Verification used synthetic providers, private temporary repositories/session files and local sandbox checks; no live model, RTX host, external delivery or original user project was used.

## Independent verification

The final independent integration run passed **138/138 tests** across `managed-host-effects`, `managed-session-authority`, `managed-context-boundaries`, `managed-runtime`, `managed-resume`, `managed-verification-views`, `managed-segments`, `managed-worker-checks`, `run-budget-runtime`, `request-policy`, `run-reconciliation` and `boundaries`. This includes real FileManagedSessions persistence and the local sandbox-exec checks, run with the permission needed for those subprocesses. Server TypeScript compilation and `git diff --check` passed. The focused count overlaps the parent's complete test suite and must not be added to it.

The context cancellation regression deliberately uses a permissive deferred session store. It holds a detached context save while an interrupt updates the old cached session, then permits adoption. This isolates the runtime's cancellation latch rather than relying on FileManagedSessions transition validation to hide a lost cancellation. The final checkpoint remains interrupted/cancel-requested, its observed generation stays completed, and no final model request or completion event follows.

## Architectural responsibilities

- `managed-session-authority.ts` derives start/resume grants, frozen source-view bindings, planned/protected scope, available tools, owning-run identity and reconciliation checks. It returns detached session revisions; the runtime owns persistence and cache adoption.
- `managed-host-effects.ts` owns generation reservation/intent/response/usage ordering, full-batch admission, action intents, canonical broker dispatch, durable receipts and failure settlement.
- `managed-coding-context.ts` owns request projection, worker checks, segment handoffs, context archives and final serialization decisions. It uses the host's committed model response and receipts rather than a scheduler's detached view.
- `managed-runtime.ts` still owns the only request/tool loop, active-turn exclusion, cancellation, timers, subscriptions and lifecycle cleanup. Private `ManagedTurnState`/`ManagedTurnHost` and options contain Buro services intentionally; they are not exported as supposedly portable SDK contracts.

This separates real production logic without adding a second scheduler, SDK transcript store, request retry layer or alternate effect authority. The portable provider boundary from 3A remains below these Buro policies.

## Findings resolved during the extraction

### Failure cleanup cannot settle another turn's pending work

A direct reproduction initially showed that `failManagedTurn` could mark an older pending generation `TURN_NOT_DISPATCHED` and complete an older pending tool while handling a new helper turn's preflight error. Existing runtime entry checks prevented that call pattern in the sole loop, but the newly separated helper must preserve the boundary itself.

Cleanup now settles only the exact current generation request and current-turn undispatched actions. Foreign generation/action/check markers remain unresolved and retain their concrete operation identity, even when this helper has dispatched no effect. Real-file regressions verify that reopening preserves those markers and that the error cannot be branded as a safe known rejection.

The correction also avoids the opposite false classification: if this turn's intent is known not to have been dispatched, cleanup settles it locally before deciding whether unresolved work remains. Failure of both save and load alone does not invent an unknown external effect for a confirmed zero-dispatch operation. That regression also passed.

### Context must consume canonical evidence after all receipts

The original extracted context function accepted a detached response parameter. Although the current loop held that copy privately, a future driver could mutate it to replace final text or claim completion while the saved tool batch remained pending.

The parameter was removed. Context processing now reads the committed `session.generation.response`, requires the current generation/batch identity, refuses missing/in-flight/incomplete batches, and runs reconciliation checks before checks, handoff or completion. Independent regressions mutate provider references, returned response text/tool lists and returned action IDs; neither canonical calls nor the final result changes. Pending, partially receipted and in-flight batches cannot advance context.

### Receipt order and action identity belong to the host

The host retains a separate active-batch copy of action IDs, the next action index and an in-flight marker. Only the next saved pending action from the current batch can execute once. The index advances after its receipt commit, not merely after the broker returns. A concurrent/reversed/replayed action request, another generation before complete receipts, or reuse of a generation request ID fails before the next effect/reservation.

The held-receipt regression proves that a second action and a following generation do not start while the first result is waiting for durable persistence. The returned action-ID array is detached from host batch authority.

### External views cannot mutate canonical calls, scope or receipts

Prepared provider packets, normalized responses, stored assistant messages, action calls, broker scope inputs and returned tool results are separate copies. Available-tool lookup also receives a detached scope. Mutating a provider request view, a scheduler response view, a broker call/scope or a broker result cannot rewrite the journaled instruction, authority, call or receipt. The mutation regression uses the actual file store and confirms the saved canonical values.

## Ordering and lifecycle found intact

Generation intent is saved before provider dispatch. The complete normalized response/continuation is saved before usage observation, and usage failure stops before tool dispatch without discarding that response. Entire-batch name/policy/ID/allowance validation and all tool intents precede the first tool effect. An action receipt is saved before the next effect. A permanently lost post-effect receipt remains unresolved across reopening; public continuation does not replay it.

Context archives, worker-check feedback and replacement request views become active only after their allowed durable transition. Failed rollover persistence does not activate a fresh window or issue its request. The original task, frozen scope, private continuation, cumulative session/turn/run accounting and check evidence remain present. Explicit resume still rejects unknown work, changed source-view grants and invalid strict-scope expansion.

The runtime preserves an observed cancellation before and after awaited replacement-session persistence and cache adoption. Tool dispatch, new generation and context transitions check the owning cancellation/view state. Fresh review/source isolation, strict/advisory tool authority and stopped-session recovery remain covered by the integration run.

## Explicit requirements for the following SDK bridge

The active-batch guard is not a complete public scheduler state machine. The current private caller invokes context processing exactly once after every batch and increments the request round itself. Before exposing neutral SDK callbacks, the bridge must preserve that sequence: consume each canonical response once, always run required coding checks/context handling before the next generation, and never use a repeated context call to promote an intermediate completion note into final JSON.

If an SDK invokes tool callbacks concurrently, rejecting the second callback is insufficient cleanup by itself. The bridge must retain and await the first in-flight broker operation/receipt before fatal turn settlement, rather than racing cleanup against an abandoned promise. SDK validation/coercion, message events and tool events must not replace canonical arguments, full-batch admission, host receipts or observed outcomes.

These are requirements for 3B2's actual generic driver contract, not claims that an SDK is already integrated. Current limits, SQLite work, contribution-based workflow composition, package distribution, operational-preparation receipts and concurrent goal scheduling remain separate stages. No live-model speed or coding-quality claim follows from this refactor.
