# Cordis composition and modularity audit

Date: 2026-11-21. Scope: source review of `core/`, `protocol/`, `plugins/`, adapters and daemon composition, with existing architecture/lifecycle tests inspected. No production code, models, network endpoints, credentials, RTX or external user repositories were accessed. The parent owns the fresh full test run; this report does not claim those tests passed in this audit.

## Verdict

Buro has a useful modular-monolith foundation and real Cordis lifecycle integration. Core does not import Cordis, Node, React or concrete adapters; application services receive ports. Plugins register services and handlers with scoped cleanup. This is more than a directory convention. Preserve these boundaries and one workflow owner.

However, **adapter interfaces are more extensible than production composition**. The daemon fixes the application topology; the resources factory and public schemas enumerate concrete providers/clients; project construction fixes file storage. Cordis currently manages feature wiring and disposal, but is not yet the provider/backend contribution mechanism. Reusable packages are still a target: the neutral-looking interfaces retain Buro domain shapes.

No P0 defect was established in this bounded review. P1 below means a substantial obstacle to the user's selected flexible/reusable architecture, not necessarily an exploitable bug or a failure of today's supported routes.

## What already works and should stay

| Mechanism | Source evidence | Assessment |
| --- | --- | --- |
| Cordis confined to composition | [plugins/host.ts:1](../../plugins/host.ts), [plugins/execution.ts:1](../../plugins/execution.ts); core/protocol imports inspected | Correct dependency direction. Pure policies need not depend on a plugin framework. |
| Explicit service dependency readiness | [executionPlugin:26](../../plugins/execution.ts), [projectOperationsPlugin:11](../../plugins/project-operations.ts) | `inject` declares required host services rather than global singletons. Explicit option ports are also valid injection. |
| Scoped command registration and cleanup | [host.ts:113](../../plugins/host.ts), [command-bus.ts:9](../../core/command-bus.ts) | Disposal removes only the registering handler; duplicates fail. |
| Generic runtime catalog and cleanup | [runtimePlugin:37](../../plugins/runtime.ts), [RuntimeCatalog:9](../../core/runtimes.ts) | It already accepts arbitrary AgentRuntime instances; missing routes never silently fall back. Disposal closes selection and attempts every adapter, aggregating failures. |
| Startup failure cleanup | [host.ts:62](../../plugins/host.ts), [host.ts:151](../../plugins/host.ts), [daemon/main.ts:89](../../daemon/main.ts) | Partial stores and the host are explicitly disposed on failed initialization. |
| Execution shutdown owns in-flight work | [ExecutionService.dispose:1517](../../core/execution.ts) | Abort jobs, await their completion and event queue, then unsubscribe. Do not replace this with a detached plugin event. |
| Lifecycle evidence in tests | [core.test.ts:144](../../tests/core.test.ts), [runtime-contracts.test.ts:164](../../tests/runtime-contracts.test.ts), [runtime-contracts.test.ts:186](../../tests/runtime-contracts.test.ts) | Tests cover handler withdrawal/reload, failure-tolerant catalog cleanup and a host with non-Codex runtimes. These are inspected tests, not newly executed results. |

## Findings

### CM01 — P1: production provider/backend creation is a closed switch

Evidence: [runtime-resources.ts:111](../../adapters/resources/runtime-resources.ts) types the provider map as OllamaProvider or DeepSeekProvider and constructs one through a conditional at line121. Runtime construction branches on `client === 'codex'` at line133 and otherwise instantiates ManagedAgentRuntime. [resourcesPlugin:39](../../plugins/resources.ts) always calls this concrete factory. [protocol/resources.ts:17](../../protocol/resources.ts) enumerates connection kinds and [line91](../../protocol/resources.ts) enumerates client definitions.

Consequence: an AgentRuntime fake can be plugged into `runtimePlugin`, but adding a real third provider/backend to normal resource setup requires edits to central factory/schema/configuration code. The generic catalog does not by itself make production integrations plugin contributions. The issue is extensibility and parity, not a reason to wrap Codex as a fake single model request.

Correction: define trusted backend/provider contribution registries, with factories, capability descriptions and validated configuration contributed at the host boundary. Keep native client transport and managed ModelProvider distinct beneath a common AgentBackend. First-party schemas may remain explicit modules, but central execution must not switch on concrete client names. Scope/data policy/cancellation/accounting coverage remain enforced by host contracts; a contribution cannot grant itself authority.

Tests: register a third fake provider and third backend via contributions without importing them in execution; exercise the shared setup/selection path, duplicate IDs, unavailable dependencies, disposal and capability rejection. A Codex-absent composition must work; multiple named native configurations must not require the singleton reserved ID.

### CM02 — P1: host and project connection hard-wire file persistence

Evidence: [host.ts:28](../../plugins/host.ts) exposes FileProjectRegistry; the private storage plugin opens FileProjectStore directly at lines58–70. `createHost()` always loads that plugin at [line145](../../plugins/host.ts). [ProjectManager:97](../../adapters/files/project-manager.ts) and its constructor at line108 require the concrete registry; connection opens FileProjectStore at line306 and adds it at line337.

Consequence: the core ProjectStore port exists, but replacing file storage with the selected SQLite authority requires altering the host/project-connection implementation, not merely supplying another store plugin. FileProjectRegistry itself already holds generic ProjectStore objects, so its name/type coupling should not be mistaken for all storage being inherently file-specific.

Correction: expose a small mutable registry/ownership port and a project-store factory/open port. Compose the new authoritative SQLite implementation through a storage plugin; project creation should request a store through that port. Preserve one ACID owner for run state, usage, event sequence and command receipts. The user permits a clean unreleased-product cutover: no old format/resume adapter is required.

Tests: compose the same application against in-memory and SQLite store factories, including connect/open/close and failed startup. Test transaction/recovery semantics, not only structural type substitution. Avoid a new SQLite ledger beside an authoritative JSON run document.

### CM03 — P1: production startup always installs repository-specific PoC data/policy

Evidence: [daemon/main.ts:24](../../daemon/main.ts) always creates `codex-panel` and `goal-poc` projects rooted at the Buro source repository. Lines34–55 install session-list/select check scripts, `experiments/goals/` write scope, worker/repair counts and a policy map keyed by those demo IDs.

Consequence: daemon composition mixes product bootstrapping with its own demonstration/evaluation fixture. A generic installation retains special IDs, paths, roles and checks unrelated to the user's linked projects. This makes the application harder to reason about even though later linked-project configuration is supported.

Correction: production startup opens the application catalog and configured project definitions. Move these PoC seeds and scripts to an explicit development/demo fixture. Empty onboarding is a valid application state; it must not require a seeded code task.

Tests: boot an empty application against a temporary data directory with no Buro-source project, no `goal-poc`/`codex-panel` IDs and no PoC check registration. A separate explicit demo startup should reproduce the fixture when requested.

### CM04 — P1: an application service is located and constructed as a concrete file adapter

Evidence: [project-management.ts:3](../../plugins/project-management.ts) imports ProjectManager and policyView from `adapters/files/project-manager.ts`; [lines27–35](../../plugins/project-management.ts) construct and restore it. That class combines repository discovery/paths, linked-project catalog I/O, store creation, policies, configuration, verification and applying accepted results ([project-manager.ts:96](../../adapters/files/project-manager.ts)).

Consequence: the directory boundary looks compliant because plugins may import adapters, but application use cases and platform details cannot be independently reused or replaced. A storage or repository adapter swap reaches into project-management behavior. This is a responsibility boundary problem, not merely the size of the file.

Correction: retain project connect/configure/verify/apply as Buro application services receiving repository-inspection, catalog/store, workspace and checks ports. Keep filesystem/Git implementations in adapters. Cordis should compose the service, not turn an adapter class into the domain owner.

Tests: application behavior with fake ports; file/Git contract tests separately; reconnect/configure/apply parity with unchanged acceptance and safety boundaries.

### CM05 — P2: process-local completion notification leaves a delivery-preparation gap

Evidence: accepted run state is committed at [execution.ts:1460](../../core/execution.ts), then the optional callback is invoked at line1490. [executionPlugin:35](../../plugins/execution.ts) turns it into a Cordis `run/completed` notification. [projectOperationsPlugin:46](../../plugins/project-operations.ts) starts `results.deliver()` without a durable pending intent. [ResultService.recover:472](../../core/results.ts) reconciles already existing pending/running delivery or preview records; it does not find every completed run that missed initial preparation.

Consequence: a crash after acceptance commit but before the callback can omit automatic delivery preparation. Accepted code remains accepted and manual delivery remains possible; this is not evidence of lost implementation acceptance. Cordis events cannot close this durability gap.

Correction: persist the readiness/preparation intent with the accepted transition, or deterministically reconcile completed runs missing that state. Use an outbox/receipt under the same transaction authority. Keep external PR/deployment effects separately authorized and reconciled; do not blindly replay them from a notification.

Tests: crash after accepted commit before notification; reopen and prepare exactly once; duplicate notifications and interrupted external effects must not produce duplicate delivery.

### CM06 — P2: neutral-looking core APIs still couple reusable infrastructure to Buro

Evidence: [ports.ts:18](../../core/ports.ts) combines ProjectDocument and runtime contracts; AgentRuntime.start at line62 requires project/run/repository assignment concepts. [CommandBus:2](../../core/command-bus.ts) imports the closed ClientCommand union from the application's transport schema. ProjectResearchService directly uses global UUID/time at [lines35–37](../../core/project-research.ts); ResultService does likewise in its application transitions.

[Private-project evaluation details removed.]

Correction: extract neutral AgentBackend/ModelProvider/events/errors/tool/journal contracts and keep application command DTOs in Buro. A reusable bus can be generically typed if needed, but an open arbitrary RPC surface is not required. Inject clocks/IDs into application services as in GoalService. Keep code review/acceptance and Cordis composition outside the generic runtime.

Tests: pack/install the new packages into an independent consumer without Buro source aliases; validate declared exports, incremental output, authority and cancellation. Use fake clocks/IDs for durable application transitions.

### CM07 — P2: architecture tests enforce layer direction but not modular dependency contracts

Evidence: [boundaries.test.ts:19](../../tests/boundaries.test.ts) extracts imports with a regular expression and at lines22–35 bans a short list of platform/framework imports and backend imports from clients. It does not validate a package dependency DAG, application-domain leakage in generic APIs, contribution registration or per-feature service dependencies. Bare Node builtin module names are not part of its current deny pattern; no such current core import was found in this review.

Consequence: the current code passes a useful layer guard while remaining unpackageable and centrally wired. Future cycles or hidden package imports can pass those checks. This is a test coverage gap, not a demonstrated present import violation.

Correction: retain the existing test, then add resolved import/export checks against the selected package graph and public API consumer tests. Prefer TypeScript AST/resolution over extending an ever-growing regex. Boundary checks cannot replace lifecycle and permission tests.

Tests: negative fixtures for forbidden transitive imports, cycles, barrel reexports and package exports; independent built-artifact consumer with no repository aliases.

### CM08 — P2: lifecycle exists for whole features, not independently replaceable active backend contributions

Evidence: [RuntimeCatalog:9](../../core/runtimes.ts) registers entries and [line33](../../core/runtimes.ts) disposes the entire catalog; there is no per-entry drain/unregister. [runtimePlugin:54](../../plugins/runtime.ts) registers an initial list and exposes the registry through one Cordis service. [resourcesPlugin:45](../../plugins/resources.ts) owns that whole plugin. Configuration edits intentionally require service restart in the resource factory.

Consequence: Cordis unloading a feature has real cleanup, but replacing one active backend is not yet an independently managed contribution lifecycle. Current restart-required semantics are a valid conservative policy; this is not a requirement to implement hot reload now or a proven leak.

Correction: document the supported lifecycle honestly. When per-backend replacement is needed, stop new selection, drain/cancel owned sessions, preserve their identity/unknown effects and withdraw the contribution only after observation. Do not depend on live plugin reload for correctness. Keep scheduler ownership in Buro rather than delegate it to Cordis notifications.

Tests: dependency withdrawal while a backend has an active turn/tool, one broken adapter cleanup, unchanged unrelated services and no rerouting to another endpoint. Existing whole-catalog cleanup tests are a useful starting point, not complete coverage of this case.

## Recommended order

1. Keep the current modular monolith and Cordis host; do not migrate frameworks to solve these findings.
2. Define the clean neutral contracts and four-package dependency graph; remove concrete-client workflow privileges and reserved IDs through capability-based selection.
3. Replace closed backend/provider creation with trusted contributed factories; isolate optional Codex/mini harness processes from generic managed-loop code and dependencies.
4. Separate project application services from file/Git adapters and inject the new store factory; activate one authoritative SQLite store with paged private artifacts.
5. Remove unconditional PoC seeding from production startup and add the empty-application composition test.
6. Close the durable completion/preparation gap and strengthen boundary/lifecycle tests. Per-backend hot reload is optional later work.

This audit recommends source changes but implements none. Source references were checked against files read in this task. No compatibility obligation for old prototype execution state is introduced.
