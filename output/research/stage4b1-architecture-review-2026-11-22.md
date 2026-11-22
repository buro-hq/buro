# Stage 4B1 independent architecture and boundary review

Date: 2026-11-22. Baseline: `60c3959`; reviewed the uncommitted 4B1 implementation, then reread the final catalog/template, provider-acquisition and runtime-owner drain fixes. This review covers trusted resource contributions and their configuration, not the later tool/context/check/analysis contribution layers.

## Decision

Bounded clear after the fixes below. No remaining blocking regression found in the reviewed implementation. The code now executes configured third-party provider/backend registrations through actual Cordis/resource/router composition. It does not create another orchestrator, replace the durable host effect owner or infer authority from a provider's name.

## Findings resolved during review

P1 — provider disposal could race the backend that still depended on it. In the initial composition, `resources.dispose()` skipped transferred runtimes and independently disposed their providers while the child runtime plugin was still draining. An actual Cordis probe produced `backend-dispose-start → provider-disposed → backend-disposed` with backend cleanup held on a deferred promise.

The final `plugins/runtime.ts` exposes the same idempotent owning drain through `onReady({drain})`. `plugins/resources.ts` captures that callback and awaits it before disposing probes/providers, including through the error path. It does not read a child-provided service from the parent during cleanup: that intermediate approach introduced a Cordis dependency/unload stall and was removed. The new independent tests hold backend disposal, verify that the provider stays alive throughout the hold, then verify one provider cleanup after backend settlement both with successful and throwing backend cleanup.

P2 — model-template callbacks received the live active connection object. `resources.models` could therefore mutate its active baseline through an innocent template implementation, changing restart detection after identities/providers had already been captured. The original template output also retained callback-owned configuration aliases. The final catalog wrapper copies/parses/freezes the connection, captures provider metadata, validates and copies the returned backend configuration, admits declared dependencies and recomputes locality from those dependencies. Template mutation, retained-result mutation, invalid configuration and dependency-retargeting regressions pass.

P2 — the provider metadata snapshot's `describeModel` closure still read the original callback-owned `value.local`. A retained metadata object could change later model-locality results while the public frozen `local` field stayed unchanged. The final wrapper captures the locality scalar and copies/validates each model result. The retained-metadata regression passes.

P2 — a second distinct `ProviderInstance` wrapper sharing an already admitted provider object was rejected before its cleanup had been tracked. The final resource owner records each acquired wrapper immediately after its factory returns, independently of successful connection admission. The independent alias regression confirms that both distinct wrappers close even when one cleanup throws, while the original admission error survives. Identical wrapper identity is deduplicated for disposal.

## Architecture, authority and simplicity

`ResourceContributionCatalog` has separate provider and backend registrations, duplicate detection and explicit startup sealing. IDs select installed callbacks; serialized configuration cannot register imports, executable callbacks or capabilities. The generic JSON envelopes are separate from first-party semantic schemas. Configuration load/save checks every configured backend dependency, every selected role/pool runtime and local-only locality. Semantic normalization and copied configuration precede queued persistence; command receipts remain the authoritative idempotency result.

Factory inputs contain only their declared provider dependencies. Provider identity/locality, backend identity, capability schema and declared method availability are checked against the actual constructed instances. Capabilities are frozen before projection. A trusted callback is still trusted code: method existence and a declared read-only capability are not sandbox verification of an arbitrary implementation.

Runtime identity includes contribution revisions, normalized instance configuration, dependency identities/revisions, actual capability descriptors and factory-supplied host-policy identity. Shared capacity keys use the minimum declared capacity across aliases. Changing saved connections does not retarget current providers: new selection/discovery/probes are blocked pending restart, frozen routes retain their previous identity, and changed identities reject historical resume.

The generic composer no longer branches on Ollama/DeepSeek model names or a native/managed client label. Model support/locality belongs to provider registrations; even a cloud-named synthetic provider is accepted according to its own trusted metadata, while Ollama's known cloud-backed models remain rejected by its registration/provider. The managed factory imports the actual Pi runner lazily and retains Buro's existing sessions, budgets, request policy, broker, segment evidence and checks. Environment preparation uses `hostToolLifecycle`, not the managed brand.

The existing runtime catalog owns backend disposal. Resource composition owns provider/probe disposal and explicitly transfers backend ownership. Router/session drain precedes backend disposal; backend/probe settlement precedes provider disposal. Successfully returned objects are tracked even when admission fails. A factory that allocates and then throws before returning still owns its internal rollback; no outer owner can dispose an object it was never given.

The UI gets provider/backend descriptors, templates, model-listing support and probe bindings from the server. Built-in editor IDs only select convenient installed forms; a generic JSON editor and the service's semantic parser handle other contributions. The CLI uses generic configuration envelopes. Descriptors and model templates are presentation/configuration data, never agent grants. The third-provider/backend browser proof is integration-owner evidence; this reviewer read its script/source but did not independently rerun a browser.

The extraction is appropriately narrow: the catalog normalizes trusted declarations, the resource composer creates owned instances and projections, and existing routing/execution services retain authority. Repeated semantic parsing favors a clear boundary over a second cached policy/dispatch engine. No new model-directed plugin lifecycle, replacement orchestrator or redundant effect journal was added.

## Independent validation

Focused run: **68/68 passed** across contribution contracts/integration, file configuration, setup semantics, native instance isolation, role routing, runtime routing, runtime-plugin lifecycle and the first two independent drain regressions. After adding the acquired-wrapper case, `tests/stage4b1-architecture-review.test.ts` passed **3/3**.

Broader run: **77/77 passed** across backend admission, provider outcome/recovery contracts, actual SDK recovery, connection trust/lifecycle, setup runtime/transport, resource goal workflows, service role routing and all three independent review regressions. These sets overlap; they are not 148 distinct tests. The runs cover 143 distinct test cases at the reviewed state.

The broader proof includes temporary HTTP-backed Ollama/DeepSeek/mixed coding goals, complete/partial/lost streams, no edits before a validated tool terminal, unknown-outcome restart blocking, cancellation/capacity release, actual SDK receipt failure, frozen operational roles and no fallback on missing credentials. HTTP endpoints and repositories were isolated test fixtures. No live models, RTX, real provider endpoints, secret material or existing user repositories were used.

`npm run typecheck` passed for portable contracts/providers, UI and server; `git diff --check` passed. This reviewer changed only this report and the new independent regression test file. The production fixes were made by their owners.

## Explicit limits and remaining work

This is trusted, sealed service-process composition, not isolation of hostile plugins or safe hot replacement. New callbacks must be deterministic for their declared revisions. Registration replacement/removal requires a restart; factories remain responsible for rollback before returning an instance.

The persistence module still supplies first-party default configuration through `defaultResources()`. A custom-only host with `builtins:false` works with explicitly provisioned custom settings, as the integration proof does. A fresh empty custom-only service still needs composition-supplied defaults instead of those first-party defaults; no zero-configuration provider-independent bootstrap is claimed here. Injecting that initial configuration is a small future packaging seam.

Built-in polished UI editors remain ordinary installed conveniences. This is not a generic form generator from arbitrary JSON Schema, nor published reusable-package distribution. Native/local sandbox mechanics remain their actual declared capability limits.

Cross-client machine-resource invalidation, operation-aware catalog rows for custom delivery roles, operational read-only preparation's separate unknown-outcome receipt, generated role/check/context/analysis contributions and the user-facing limits/budget redesign remain tracked separately. The remaining first-party defaults do not disappear merely because provider/backend envelopes are open.
