# Stage 3A independent provider and host recovery test review

[Private-project evaluation details removed.]

## Evidence

- **48/48** focused tests passed across portable provider streaming, ProviderFailure identity/outcomes, the standalone compiled consumer, host reconciliation and architecture boundaries. The standalone consumer compiles copies of the actual contract/provider sources with `types: []`, deletes the TypeScript sources, runs the emitted JavaScript with an empty PATH and no inherited credentials/Codex configuration, and completes both provider protocols through injected fetch. It rejects ambient networking. This is a compiled-consumer proof, not an npm pack/install/exports or second application proof.
- **20/20** existing model, provider-edge and durable provider-recovery tests passed independently. The recovery tests use FileManagedSessions/FileRuntimeRoutes, actual repository edit tooling on temporary fixture files, a fresh runtime/store instance and injected protocol responses. They retain exactly one completed edit and its private continuation across a known rejection, block replay after an incomplete follow-up, and release queued/active endpoint capacity on cancellation. No real endpoint is contacted.
- Added **2/2** independent composed host regressions in `tests/provider-outcome-recovery.test.ts`, both passing. These fill the gap between adapter-only outcome assertions and generic in-memory host error classification by checking actual private checkpoint bytes through a fresh FileManagedSessions instance.
- `npm run typecheck` passed, including separately compiled `agent/contracts` and `agent/providers` with no ambient Node types. `git diff --check` and formatting of the added test file passed.

Focused counts overlap the owner's final full suite and must not be added to it. Local receipts: `/private/tmp/buro-stage3a-independent-focused.log`, `/private/tmp/buro-stage3a-independent-recovery.log`, `/private/tmp/buro-stage3a-independent-host-outcomes.log` and `/private/tmp/buro-stage3a-independent-typecheck.log`. They are validation logs rather than application state.

## Two outcome boundaries proved through the host

### Failed discovery is not a dispatched generation

An injected Ollama `/api/show` returns HTTP 503. Its individual transport outcome is unknown, but the Buro adapter knows that `/api/chat` was never called. The real ManagedAgentRuntime therefore persists a completed generation attempt with the public rejection code and no assistant response or tool actions. Reopening the private session does not perform networking. Explicit resume also does not dispatch a request; only a later explicit turn performs the required work and structured-final generations. The test confirms the exact metadata/chat request sequence and zero tool execution.

This is a generation-reconciliation statement. It does not change the existing request reservation/accounting policy or claim that all failed preflights have zero charged reservations; quota/accounting cutover remains a later stage.

### A known-looking streamed error stays unknown

An injected DeepSeek stream yields visible text, private reasoning and a complete-looking tool-call frame, followed by a stream error reported as `MODEL_REQUEST_REJECTED`. The adapter preserves the explicit unknown outcome despite that code appearing in the host's legacy known-rejection set. The real ManagedAgentRuntime throws GENERATION_RECONCILIATION_REQUIRED and persists generation outcome `unknown`, without an observed complete response, assistant message or tool dispatch intent.

A fresh FileManagedSessions/runtime instance reads the same checkpoint and rejects both resume and another turn before any further fetch. The provisional delta has a request/turn identity but is excluded from durable project events, never becomes message.completed, and carries neither private reasoning, provider error body nor synthetic credentials. Request count remains one and tool calls remain zero.

## Contract and test-strength assessment

The provider implementations perform actual NDJSON/SSE parsing and request construction rather than delegating to Buro. Separate compile and source-import checks establish the no-Buro/no-Node dependency boundary. Buro adapters retain configuration identity, endpoint/data-trust policy, credential callbacks, preflight and application exception translation. ProviderFailure requires a real direct instance with immutable explicit outcome fields; similarly named errors or model-supplied objects do not grant known-rejection authority. Host outcome branding gives explicit unknown observations precedence over exception codes and earlier generic settled markers.

Streaming tests reconstruct split UTF-8/text/tool fragments, reject invalid or missing terminals, keep absent usage unknown, retain incomplete finish reasons, isolate synchronous and asynchronous observer failures, cancel readers and distinguish queued/pre-dispatch cancellation from active unknown requests. A wire response.completed event is explicitly an observed protocol terminal, including `length`/`failed`; it is not a successful goal or permission to dispatch tools. Actual host response journaling remains the acceptance boundary.

The new message.delta event is transient at the runtime observation port. This review does not claim that WebSocket project history or the current UI delivers token streaming, or that provisional deltas constitute durable receipts. The final normalized message and private continuation continue to be saved through the existing host journal before tool work.

## Deliberate remaining work

The extraction preserves the existing Buro loop, aggregate quotas, private journal format and recovery ownership. It does not introduce the neutral AgentBackend loop, select/adopt Pi as the one execution spine, package exports/installability, plugin contribution discovery, SQLite authority, complete operational preparation-attempt recovery or concurrent-goal scheduling. Existing operational read-only preparation unknown outcomes retain the separately documented 2C limitation. No original user repository, secret, live provider, offline RTX machine, external message, commit or delivery operation was accessed by this reviewer.
