# Stage 3B2 independent SDK and host-authority review

Reviewed on 2026-11-22 against committed baseline `6ca56b8` plus the frozen 3B2 implementation. Final disposition: **clear within the actual Pi scheduler integration and its Buro host boundary**. This substep adopts the SDK scheduler for managed sessions; it does not complete distributable packages, SQLite authority, default-none quotas or concurrent goal orchestration.

This reviewer changed no production source. Tests used the installed pinned SDK, synthetic providers, in-memory HTTP streams and private temporary session files/repositories. No live model endpoint, RTX host, original user project or external delivery was used by this review.

## Evidence

The final independent integration run passed **192/192 tests** spanning the actual Pi runner, neutral contracts, ManagedLoopHost, managed effects/authority/context/runtime, explicit continuation, source views, segment rotation, worker checks, request/run accounting, reconciliation, 16K planning correction and provider recovery. The three additional `sdk-managed-recovery` tests also passed. These focused results overlap the parent's full suite and must not be added to its final count. `npm run typecheck` and `git diff --check` passed.

The SDK is pinned to `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` **1.6.0** in the manifest and lockfile. The parent reports installation from the existing cache with offline/ignore-scripts options; this reviewer performed no installation. Review included the installed `runAgentLoop`, request preparation, sequential tool execution, swallowed tool-error behavior, stream finalization and event-stream implementations.

A separate cold-import probe ran in a fresh child process with an empty PATH, no inherited provider credentials, blocked ambient fetch/http/https requests and a credential-environment read observer. Dynamically importing the real adapter and completing one fake host cycle produced **zero ambient network calls**, **zero credential-environment reads** and exactly **one host generation**. The SDK unit suite also poisons its default stream function and ambient fetch; the explicit host stream remains the only generation route.

## One scheduler, one effect authority

The old managed-runtime request-round and action-dispatch loops were removed. Managed runtime now owns the logical turn lifecycle and a context-window pump; **Pi's awaited `runAgentLoop` owns request/tool scheduling**. The outer pump resumes only after a host-owned durable context yield and verifies actual host progress/result. It is not a second request/tool scheduler or fallback implementation.

`ManagedRuntimeOptions.loopRunner` is required and validated. Production managed-runtime construction and the synthetic coding fixtures inject the actual Pi runner; no absent-runner fallback preserves the former loop. Composition lazily imports the adapter on the managed-runtime path. Native Codex remains its separate capability-admitted backend and does not acquire fabricated host-tool/usage properties from this integration.

The neutral contracts import neither Pi nor Buro. A detached request exposes scheduling metadata, message/tool views and opaque IDs. `generate` receives only a request ID; `execute` receives only saved batch/action IDs. The scheduler cannot replace the canonical provider packet, tool arguments, scope, budgets or receipt. Pi types remain inside the concrete adapter.

## Host phases close the previous seam requirements

ManagedLoopHost keeps its state, stores and policy behind JavaScript private fields. Its phase/busy/closed gates require prepare → generate → all tools → advance exactly once. Wrong IDs, concurrent callbacks, skipped context handling, replayed advance and further work after failure close the bridge before another admitted operation.

The bridge retains the prepared packet privately and returns clones. Generation and action dispatch still use the existing host effect service. Context advancement still reads the committed generation/receipts. Only host context advancement can increment the logical round or confirm the final text; `AgentLoopResult` alone cannot declare coding acceptance. The final text/model comes from the host-confirmed result, never an SDK message or synthetic completion.

The earlier 3B1 requirements for once-only response/context sequencing are therefore addressed by the concrete bridge. Replaying advance cannot append another final-serialization instruction, and starting another SDK window cannot reset turn/session/run counters or replay a saved action.

## Fatal errors, cancellation and receipts

Pi normally turns thrown tool errors into model-visible feedback and may otherwise continue. The adapter therefore retains the original host failure separately, aborts only its own child controller, prevents later callbacks, ends the SDK window and rethrows that same host error after draining in-flight host promises. An SDK error message or tool event is never used to infer the original action outcome.

Parent cancellation propagates to the child scheduler and prevents new callbacks. A host callback already executing remains awaited through its receipt or failure. A late unresolved host outcome takes precedence over ordinary cancellation. Internal scheduler stopping never aborts the supplied parent signal. The actual file-effect/receipt-loss regressions prove one first effect, no second action/request, no false completion, retained private continuation and rejection of replay after reopening FileManagedSessions, both with and without a racing parent abort.

Ordinary broker results with `isError: true` remain canonical model feedback. They can produce a subsequent explicit host generation and repair; they are not incorrectly promoted into a fatal unknown effect. Conversely, receipt persistence failure cannot become such ordinary feedback merely because Pi catches tool exceptions internally.

Unexpected SDK/projection failures become the fixed neutral `AgentLoopFailure`. The Buro boundary translates only that direct internal failure into its sanitized DomainError, retaining a non-public cause. Host failures are not wrapped or reclassified by inspecting nested causes or SDK text. The host's existing failure settlement still distinguishes confirmed non-dispatch, observed response, unresolved generation/action/check and failed durable receipt.

## SDK validation and batch coherence

The real provider receives the host's real tool schemas. Pi receives internal permissive `{}` declarations and sequential execution settings. Its validation/coercion therefore cannot replace saved arguments: actual dispatch ignores Pi arguments and resolves only the host action ID. The regression retains a string argument despite an integer schema in the provider view and proves that host arguments remain unchanged.

The first adapter version checked duplicate IDs but could let Pi execute a valid first action before encountering an unadvertised second tool in a malformed generic-host batch. This was corrected before freeze: the whole returned batch is checked for advertised names, nonempty/unique identities and executable finish/action coherence before exposing any tool projection to Pi. The invalid-second-tool regression proves zero host effects.

Opaque request and batch IDs deliberately need not share a namespace. Executable actions require a tool finish, and a tool finish requires admitted actions. Length/failed responses cannot carry executable actions. An action-free incomplete result can remain observable to an independent host, which alone decides whether to continue; the generic scheduler does not invent a coding-acceptance policy or an automatic transport retry. Buro's coding host continues to reject incomplete responses before returning a batch.

## Canonical data, usage and memory

SDK messages, tool results and usage/cost placeholders are disposable projections. The SDK requires numeric fields, so its internal projection uses zero values; these never flow back into ModelCompletion, private journals, accounting or UI policy. Actual usage stays with the host's normalized provider response. Missing usage remains absent/unknown, including after a successful SDK-driven turn.

Private provider continuation/reasoning is retained in the canonical host checkpoint and actual subsequent provider request, but omitted from the SDK scheduling projection and public runtime events. Real text streaming remains owned by the neutral provider/host observation path rather than being fabricated from SDK events.

Pi's `newMessages` accumulates within a scheduler window even when request context is replaced. For continuation, the adapter ends a window after the host commits actual segment/check-feedback compaction, clears the disposable SDK accumulator and starts the following window from a fresh host preparation. Final host-confirmed completion also ends the current window. The host's original task, complete private archives, cumulative counters and settled receipts survive. This bounds the extra SDK transcript to a window; it is **not** a claim of bounded total application memory or durable-history paging. Existing nonsegmented host history and configured lifetime/request limits still exist.

## Remaining limits

No SDK model catalog, credential resolver, SDK HTTP transport, global default stream or SDK retry mechanism is enabled. Adding SDK dependencies does bring their transitive packages into the lockfile; this integration does not claim they are independent of the installed SDK at runtime or that a reusable npm package has already shipped.

The four-package distribution/second full application host, contribution composition, one SQLite authority, durable operational-preparation attempts, default-none quotas, isolated concurrent goals and MCP still require their planned stages. Complete descendant-process/crash cleanup and external-delivery crash deduplication are not newly proven here. Controlled live-model comparisons are still needed for speed and coding-quality conclusions; synthetic scheduler correctness is not evidence that a particular model's output quality improved.
