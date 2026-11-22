# Stage 4: trusted contributions

Status: inspected after 3B2 (`a33f112`); 4A empty service and project application/store extraction are in progress. This document is a proposal, not a claim that these registries already exist. No live model or external endpoint was used.

## Current extension barriers

`protocol/resources.ts` closes connection kinds to Ollama/DeepSeek, runtime definitions to Codex/managed, and `RuntimeResource.client` to the same backend pair. `adapters/files/resource-configuration.ts` embeds managed-runtime references and Ollama-only locality rules. `adapters/resources/runtime-resources.ts` constructs concrete provider unions and branches on backend names; it also derives raw-model diagnostics from those branches.

`core/runtimes.ts` already accepts arbitrary `RegisteredRuntime` objects and validates/fixes actual capabilities. It owns backend disposal. Routing and role eligibility already use capabilities; they do not need another orchestrator.

The UI remains specifically two-provider: `ApiConnectionForm`, `ModelTeamSetupForm`, and `ExecutionResources` construct managed definitions, infer locality from Ollama settings, and label everything else DeepSeek/Codex. `adapters/environments/project-environments.ts` still has a managed-client check. These must change for an honest third-party extension claim.

## 4B1: a real resource contribution catalog

Add an application-level `core/resource-contributions.ts` with distinct provider and backend registrations. They share duplicate detection, startup sealing, and lifecycle ownership; their authority-specific APIs remain separate. These types are not reusable agent contracts because backend construction uses Buro application ports.

A provider contribution has a stable ID/revision, a strict configuration parser, normalized public metadata, credential readiness, a stable shared-capacity key, and an instance factory. An instance supplies a `ModelProvider`, optional model listing, and optional disposal. Secret values stay in the private credential resolver; public settings contain references only.

A backend contribution parses its own configuration, declares provider dependencies for reference validation, and constructs a `RegisteredRuntime`. Its normalized runtime resource and optional raw-provider probe binding are returned explicitly. Capabilities come from the actual constructed backend and pass existing `RuntimeCatalog` validation, never from a model proposal or caller-supplied capability object.

Configuration envelopes become connections `{id, provider, config}` and runtimes `{id, backend, config}`. Protocol schemas validate the JSON envelope; the sealed installed registry parses all semantic configuration on load and save. Unknown contribution IDs fail with an actionable configuration error. No old format compatibility is required before release.

The composition owns instance identity and revision hashing: contribution revision, parsed canonical configuration, dependency identities/revisions, capabilities, and applicable host policy revisions all participate. Provider aliases targeting the same capacity key still share the existing minimum-capacity gate. Connection edits never retarget a running instance, frozen session, or accepted grant.

Move first-party registrations to `adapters/resources/contributions/{ollama,deepseek,managed,codex}.ts`. The managed backend retains the actual injected Pi runner and Buro host services. `runtime-resources.ts` composes registered factories, selection, pending/restart state, and explicit diagnostics bindings without a provider/backend-name switch. `resourcesPlugin` supplies the registry after trusted startup plugins have registered and before settings are loaded.

Seal the factory catalog at startup. Registration, replacement, or removal afterward requires service restart. This avoids leases/hot unloading while durable sessions still refer to old factories. On partial startup failure, close every constructed object exactly once; the runtime catalog disposes backend instances, while resource composition disposes provider/probe instances. Cordis callbacks are installed application code, not code loaded through RPC, JSON, model output, or repository metadata.

Change `RuntimeResource.client` to an open `backendId` string. Replace remaining client-name orchestration with actual mechanics, including environment preparation and diagnostics eligibility. Preserve data locality as normalized trusted adapter metadata rather than a native/managed distinction.

### Acceptance

Register a third synthetic provider and a third backend through real Cordis composition. Load their settings, select a profile, resolve roles, dispatch a turn, interrupt/release/dispose, and reopen frozen history without Codex-specific branches. Check malformed, unknown, duplicate, and late registrations; locality enforcement; missing/overclaimed capabilities; changed contribution revisions on resume; unchanged unknown-operation gates; partial startup cleanup; and diagnostics with and without an explicit probe binding. No model calls are necessary for this proof.

## 4B2: usable configuration and consistent operation projections

Keep polished first-party forms as optional installed editors, but drive labels, credential readiness, supported model listing, diagnostics, and setup actions from server-authored descriptors. Provide a bounded advanced configuration editor plus server validation for contributions without a specialized editor. Do not present the current two-option selector as arbitrary-provider configuration.

`ModelTeamSetupForm` consumes a server-authored runtime template and normalized locality preview instead of constructing `client: managed` or independently reimplementing provider trust rules. CLI validates the generic envelope and lets the service perform contribution-specific validation. Local-only copy must describe trusted locality, not ban native backends by branding.

Fix operation choices at their actual source: `ResultService` already uses configured `profile.delivery.environments[].roleId`, but `roleResourceContext` recognizes only three built-in delivery IDs. Add a service-authored operation catalog derived from real host entry points and configured delivery role bindings. Key role choices by operation ID and role ID because one role can serve multiple purposes. Share this source with resource choices and effective-policy projection. Model descriptions and role kinds cannot grant capabilities.

After persisted machine-resource mutations, publish an application event `{topic: resources, revision, appliesTo}`. `plugins/resources.ts` emits it, `daemon/websocket.ts` broadcasts a sanitized invalidation independently of project event sequences, and `clients/socket-client.ts` refreshes the selected project projection. Surface its revision to `useResourceCatalog` too. The existing initiating-command-only invalidation leaves other clients stale. Hash revisions are unordered: deduplicate equality and use request generations or a service epoch for ordering, never lexical hash comparison. Reconnect always reloads current service state. A replayed receipt without a changed revision need not publish another change.

Verify two clients on different projects, stale refresh responses, reconnect, and unchanged frozen run/resource identities.

## 4C: additional typed, active contributions

Do not claim a full plugin system from the resource catalog alone. Add each category with a production builtin moved behind it and a real synthetic third contribution; avoid empty generic registries.

Tools: extend `ToolBroker`/`RepositoryTools` using unique tool names, strict argument parsers, scoped definitions, and execution of the original saved call. Existing host generation remains the only whole-batch admission/intents/effect authority. New tools cannot restore commands in strict/read-only/immutable sessions or create their own action receipts.

Context: resolve authorized sources into bounded content, provenance, and revision, then freeze into existing run materials. `ContextMaterials` remains responsible for imported bytes, secret exclusions, symlinks, extraction, and staging. Model output cannot select arbitrary loaders or widen source access. No silent mutable context source should replace frozen evidence during a resumed run.

Analysis: extract prompt building, output parsing, and proposal normalization from `ProjectResearchService` through trusted analysis contributions. Keep source-head/profile-revision checks and proposal application in the application service. Manifest-specific analyzers and check recipes return validated data and evidence, not direct document mutations or RPC callbacks.

Check recipes: produce `ProjectCommand` and `EnvironmentRecipe` proposals. Existing schema validation, selected prepared executor, durable receipts, and immutable final acceptance checks remain authoritative. A returned command string is not authority to execute it. Keep `ProjectChecks.run` as the final check entry point.

`EnvironmentConfig.provider` is still a native/docker union. Executor contributions are a separate extension seam; recipe contributions alone do not make environment execution open. Address it explicitly when adding another executor rather than hiding the closed boundary.

## Explicit limits of this plan

Trusted plugins run in the service process; this is modular composition, not sandboxing hostile plugin code. Startup sealing is intentional; safe dynamic leases are unnecessary for the first release. Public RPC stays closed and accepts data only. No plugin can replace unknown-operation reconciliation, final acceptance, scope enforcement, immutable review, or the single durable effect authority through a model-selected callback.
