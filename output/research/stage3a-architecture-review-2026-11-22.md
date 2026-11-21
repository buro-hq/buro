# Stage 3A independent transport, outcome and boundary review

Reviewed on 2026-11-22 against `02aa411` plus the stage 3A working-tree changes. Final disposition: **clear within the portable-provider and host-outcome boundary reviewed here**. This does not approve an SDK scheduler switch, complete package distribution, default-none quotas or later storage/concurrency stages.

This reviewer changed no production source. All requests used injected fake fetch functions and in-memory response streams. No real provider endpoint, RTX host, native client, original user project or external delivery was accessed.

## Evidence

An independent combined run passed **58/58** focused tests in `provider-package-consumer`, `portable-provider-contract`, `provider-failure-contract`, `provider-edge-cases`, `model-providers`, `run-reconciliation` and `boundaries`. The final run used the production sources after the provider owner froze them. The standalone `agent/providers/tsconfig.json` compilation passed with ES2022/DOM and `types: []`. These tests overlap the parent's full suite and are not additional to its final count.

The consumer test compiles copied contracts/providers in a temporary directory, removes every TypeScript source there, and imports only the resulting JavaScript entry point in a separate process. That consumer has an empty PATH, no inherited provider key or Codex configuration, and an ambient fetch function that fails if called. Both actual transports execute through the injected fetch; no Buro/Cordis/React/Node implementation import is available in the provider artifact. This proves an independently compilable and executable transport boundary, not a published npm package or a second complete application host.

Additional independent probes verified:

- An asynchronous progress/event observer initially produced four unhandled rejections on an otherwise successful fake DeepSeek response. After correction, the identical probe completed with `finish: stop` and **zero** unhandled observer rejections.
- A credential callback exception is replaced by a sanitized, explicit `not-dispatched` failure in the neutral provider. The Buro bridge preserves the known preflight outcome without exposing the callback's private error text.
- Circular tool arguments fail with `MODEL_INVALID_REQUEST` / `not-dispatched` in both neutral transports, with **zero fetch calls**. The probe tests actual serialized tool arguments; DeepSeek intentionally requests JSON output without sending the supplied JSON schema verbatim.

## Findings resolved during review

### Observer payloads must not alter canonical accounting

The initial usage event referenced the same object returned in `completion.usage`. A callback could rewrite token counts before Buro saved the normalized response and ledger observation. The transports now give observers cloned event payloads. An adversarial observer regression changes its usage object while the returned canonical usage remains the actual reported values. An observer is not an authority for usage, completion or tool execution.

### Observer failures must not determine request outcome

The initial heartbeat helper threw an unknown transport failure if its callback threw. The initial event helper caught only synchronous exceptions, allowing rejected observer promises to escape as unhandled rejections. Both progress and event delivery now use a shared best-effort helper that catches synchronous errors and attaches a rejection handler without awaiting observer work. This preserves request pacing and terminal semantics while preventing telemetry errors from causing a false unknown result or crashing the consumer.

### Failed Ollama terminals must not become executable tool results

The inherited mapping selected `finish: tools` whenever reconstructed calls existed, even if `done_reason` was unknown or failed. The mapping now recognizes normal stop/tool output separately from length or failed terminals. Complete-looking calls cannot promote an unknown/failed reason into a successful tool-bearing response. The dedicated regression passed. The host remains responsible for refusing tool effects for incomplete/failed responses and validating the full batch before dispatch.

### Preflight must remain distinct from dispatched generation

Endpoint parsing and injected-fetch validation occur before the fetch error boundary. Credential retrieval and request serialization produce sanitized known preflight failures. A failed Ollama `/api/show` operation can itself have an unknown HTTP outcome, but Buro records that `/api/chat` was never dispatched. Its wrapper explicitly translates the discovery failure at that generation boundary. This does not retag an already dispatched generation as safe to repeat.

DeepSeek's configured options are copied with the canonical endpoint instead of retaining the caller's mutable options object. Existing Buro protocol hashes, thinking settings and endpoint trust remain application-owned rather than being inferred or reimplemented by the portable transport.

## Architecture and outcome boundaries found intact

- `agent/providers` imports only its own modules and `agent/contracts`; standalone compilation has no ambient Node types. Real request formatting, NDJSON/SSE parsing, tool reconstruction and provider-specific context projection moved into that boundary. The Buro adapters retain configured identity, endpoint/data trust, ambient application fetch selection and application error translation.
- Portable transports require an explicitly injected fetch implementation and accept only explicit credentials/configuration. They do not discover credentials, launch clients, select another provider, add network fallback, or acquire an application tool/workspace authority.
- `ProviderFailure` requires a stable code and explicit outcome. Code/outcome fields cannot be rewritten. Response-shaped objects, similarly named errors and nested causes do not become trusted outcomes through structural matching.
- The Buro bridge translates only direct neutral transport failures. Its private WeakMap outcome observation takes precedence over generic exception codes and the older observed-failure brand. Once marked unknown, an error cannot be downgraded to rejected/not-dispatched by later generic observation.
- Pre-abort and cancellation while waiting for endpoint capacity are not dispatched. Selected negative HTTP statuses produce explicit rejected outcomes. Connection loss, cancellation after dispatch, a failed reader, invalid UTF-8, lost terminal markers and malformed tool arguments remain unknown. Streamed provider error data remains unknown even when its public code resembles an HTTP preflight rejection. No automatic retry or fallback was introduced.
- Text deltas are actual received content fragments, not accumulated answers or timer notifications. Private thinking/reasoning and tool argument fragments are absent from the public event union. Usage is emitted only when reported; absent/invalid counts do not become measured zero. `response.completed` reports the observed normalized wire terminal, including length/failed output, and never implies goal acceptance.
- Provider observation events cannot dispatch tools. Buro still persists the full normalized response/continuation before usage settlement and host batch admission. Provisional text forwarded as `RuntimeEvent.message.delta` is excluded from durable Run event projection; the complete response and existing journal remain the authority.
- The standalone consumer and source-boundary checks exercise the actual exported implementations. This is more than relocating duplicate interface declarations while leaving production on the old implementations.

## Scope limits and next-stage requirements

The neutral AgentBackend scheduler, pinned SDK integration, host effect-authority extraction, distributable package manifests, a complete second application host, SQLite authority and default-none quotas are still later work. Existing aggregate/per-session/per-turn/request-response bounds have not been removed by this transport extraction. No live Ollama/DeepSeek quality or speed result follows from these synthetic checks.

The stage 2C operational-preparation unknown-outcome receipt limitation remains explicit in the [previous review](stage2c-architecture-review-2026-11-22.md). Its custom delivery-role catalog follow-up is assigned to operation-aware workflow contributions in stage 4. Neither issue is solved by adding neutral transport events.

Before switching the request/tool loop to an SDK scheduler, preserve Buro's whole-batch admission, durable intents and receipts, fatal journal boundaries, immutable review inputs, unknown-outcome no-replay rules, cancellation, context rotation and actual usage coverage. A stream terminal or SDK tool event must never substitute for those host records.
