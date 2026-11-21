# Stage 3B2 independent SDK and durable host recovery review

Reviewed on 2026-11-22 against `6ca56b8` plus the current SDK-switch working tree. Disposition: **clear within the actual Pi scheduling switch and retained Buro host authority**. Pi agent-core/pi-ai are pinned to 1.6.0. The real production managed-runtime factory injects PiAgentLoopRunner; the managed runtime no longer contains the per-generation or per-action scheduling loop. Its remaining outer loop resumes host-confirmed context windows.

## Independent validation

**165/165** tests passed across the neutral loop contract, actual Pi runner, ManagedLoopHost, composed SDK recovery, managed runtime, provider recovery, context/host effects, explicit resume, segments, worker checks, budgets, request policy, reconciliation and architecture boundaries. Repository typecheck and `git diff --check` passed. Formatting of the new composed test file passed. Focused counts overlap the owner's final complete suite and must not be added to it.

Local receipts: `/private/tmp/buro-stage3b2-independent-tests.log` and `/private/tmp/buro-stage3b2-independent-typecheck.log`. They are temporary review aids rather than application state.

## Composed recovery proof added during review

The earlier permanently-lost-receipt seam test called generation/action helpers directly and only used the runtime to test reopening. That was useful host evidence but did not prove that the actual SDK would stop after its tool callback failed. `tests/sdk-managed-recovery.test.ts` adds three independent composed regressions using real PiAgentLoopRunner, ManagedAgentRuntime, the Buro DeepSeek transport, injected SSE responses, FileManagedSessions, FileProjectStore and a real append to an isolated temporary effect log. The broker is an explicit fixture tool, so these tests establish effect/receipt ordering rather than general repository permission enforcement.

- A response proposes two tools. The first appends one line, then every attempt to persist its receipt fails with the same original host Error. The actual SDK stops after that callback: the second tool and a second HTTP generation never run. The parent signal remains un-aborted; the runtime reports failure rather than a fabricated user interruption. The thrown ACTION_RECONCILIATION_REQUIRED retains the original receipt error and the saved first action ID. A fresh file reader observes both pending intents and the complete private model response; a fresh runtime refuses both resume and turn before HTTP or another effect. The file contains exactly the first line.
- In the second case, persistence is held after the first file effect while the parent cancels. The runner does not settle before that admitted callback is released. Its late host receipt error still wins as ACTION_RECONCILIATION_REQUIRED with the original cause; no message or turn is accepted as completed. Because this case really cancels the parent, its interruption status is legitimate, but the unknown effect is not downgraded to a plain AbortError. Reopening again cannot replay it.
- An ordinary broker result with `isError: true` is model feedback rather than a fatal SDK exception. Its receipt is durably completed, the next HTTP request receives the actual tool ID/content and the exact canonical private reasoning continuation, and the model can finish. Missing model usage remains missing; SDK placeholder zeros do not become observed usage. The parent stays active and no ambient SDK request occurs.

The fixture traps ambient fetch and injects the only transport implementation. All three cases report zero ambient requests. Public runtime events contain neither the synthetic API key nor private continuation.

## Existing protections exercised through the actual SDK

The Pi tests import the installed package rather than a local loop imitation. The normal run exceeds twenty generations, checks sequential effects and traps the SDK default provider path plus ambient networking. Host failure tests cover prepare/generate/execute/advance identity preservation, draining of in-flight callbacks, parent cancellation, unknown-error precedence, duplicate call IDs, sanitized internal scheduler faults and durable host yields. This proves absence of an SDK-imposed twenty-turn stop in the exercised path, not removal of the existing host quotas.

ManagedLoopHost uses private phase/prepared/batch state. A scheduler receives copies and opaque IDs; it cannot inject replacement tool arguments, edit scope, skip host context processing, consume a result twice or dispatch in a different order. Canonical generation and tool receipts remain in the host. The host advances round/accounting only after its own checks/context transition; a yielded window receives a fresh scheduling projection from the same durable logical turn. Existing 16K planning, worker feedback, segmented context, scope, immutable-review and provider-outcome tests now run with the real Pi runner.

Pi's validation schema is a disposable scheduling declaration; original provider definitions and arguments remain host-owned and are validated/dispatched by the host broker. Internal SDK message/usage/cost fields never replace private checkpoints or observed model usage. The runner supplies its own stream function and no credential/model resolver. Private continuation stays in the canonical host request view, while SDK projections and SDK events are not used as model receipts or goal acceptance.

The runner's child controller stops SDK scheduling after a fatal host callback. It does not abort the supplied parent. Fatal host errors are retained outside Pi's normal tool-error feedback and rethrown after admitted callbacks drain. Only the host's completion decision plus the runtime's final checkpoint permits a successful result.

## Boundaries retained

[Private-project evaluation details removed.]

Existing aggregate/turn/session budgets remain in force. SQLite authority, default-none quotas, contribution-based workflows, distributable package exports, operational preparation-attempt receipts and isolated concurrent goals remain later work. The SDK's disposable projection still exists within a host context window; this review is not an unbounded-run memory/backpressure benchmark.

No live model endpoint, offline RTX host, original user repository, real credential, external message, delivery action or Git commit was accessed by this reviewer. Synthetic SDK/effect tests provide no live-model quality or performance comparison.
