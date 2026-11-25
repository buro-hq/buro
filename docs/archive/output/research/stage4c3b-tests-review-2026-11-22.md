# Stage 4C3b independent empty-resource and first-selection review

Date: 2026-11-22. Baseline `2d8c03b` plus the empty-resource configuration, scoped selection and setup UI working tree. **Clear within the reviewed empty service/factory, persisted setup, explicit selection, reconnect and capability-admission scope.** This reviewer added a new test file and this report, with no production edits or commit. The parent owns final repository gates; the UI owner owns browser verification.

## Independent evidence

**60/60 tests passed** across this review's new regressions, empty resource configuration/runtime, actual production application startup, setup runtime lifecycle, cross-client invalidation, persisted resource events, runtime plugin cleanup, historical runtime routes and architecture boundaries. Full `npm run typecheck`, `git diff --check` and formatting of this review's files passed. This is a focused count, not a full repository-suite claim; overlapping owner runs are not additive.

Local receipts: `/private/tmp/buro-stage4c3b-independent-new.log`, `/private/tmp/buro-stage4c3b-independent-tests.log` and `/private/tmp/buro-stage4c3b-independent-typecheck.log`. Tests use temporary local state/repositories, synthetic registered adapters, actual loopback WebSockets and bounded CLI subprocesses. No real model endpoint, offline RTX host, original user repository, key value, external message, deployment or Git commit was used. This reviewer did not independently run the browser flow or measure live-model quality.

## Independent regressions added

`tests/stage4c3b-review.test.ts` adds two passing cases:

1. Actual `resourcesPlugin` composition starts with a custom-only installed backend descriptor, no configured runtime and null default. A service-only client and a project client see no execution grant. Saving the first profile publishes one real resource invalidation but creates no backend and leaves the default null. Early use fails; replaying the setup receipt does not fabricate another mutation. The test disposes the actual host/server, opens a fresh host on the same port and lets both existing production socket clients reconnect automatically. Both client resource generations advance. The configured backend is now created, but both catalogs still show no selected profile. Reusing the previously failed selection command ID succeeds only after explicit selection, proving failure did not become an execution-enabling cached receipt.

   The custom backend deliberately uses the ID `codex` and its runtime the ID `ollama`, while declaring structured turns without read-only or immutable-review mechanics. After selection, coordination is eligible, research/review remain ineligible, and an actual routed research start rejects before backend `start`. There are zero model turns, zero backend starts and zero project-domain sequence changes. Names and installed descriptors cannot create capabilities.

2. With null machine default and an unavailable explicit project override, the global catalog reports `RESOURCE_PROFILE_REQUIRED` while the project catalog reports the safe public `RESOURCE_PROFILE_UNAVAILABLE`, without echoing the private-detail sentinel from the override. Selected resources are absent and choices empty. An actually unknown project rejects as `PROJECT_NOT_FOUND`; it is not disguised as the setup state. A later valid service catalog read remains usable and no factory/session/inference occurs.

These cases exercise the actual persistence, factory, bus, server and reconnect path; the result is not inferred from a serialized registration list or UI labels. The only created backend is a registered fixture instance after restart, not a first-party native process or model endpoint.

## Existing tests independently rerun

Fresh file configuration persists and restores `{defaultProfile: null, connections: [], runtimes: [], profiles: []}` with private file permissions and no contribution required. Schema and semantic validation still reject missing dependencies, invalid selected IDs, invalid pools and local-only policy violations; null is absence of selection rather than permission to save invalid nonempty configuration. Atomic setup receipts and optimistic revisions survive reopen without silently selecting the first profile.

Actual fresh production composition works without projects/models through service RPC and CLI. Installed provider/backend descriptors remain discoverable; runtime instances, active resources, connections, profiles and probe bindings are empty. Explicitly empty custom catalogs require no built-in registration. An empty routed runtime registry works without a default; JavaScript callers of an unrouted runtime service must supply an explicit default. Existing cleanup tests retain backend/provider ownership and idempotent disposal.

First profile save remains pending until restart. Restart activates definitions but does not assign the machine default. Explicit profile use requires active dependencies, and a project with an already explicit valid override can select that profile while the machine default stays null. Current connection edits make dependent choices ineligible and reject new work until restart rather than retargeting the active instance.

Queued mutation and cache tests prove lifecycle checks occur after earlier acknowledged writes and before cached selection/probe receipts can be replayed. An old receipt cannot restore a previous default, make a pending runtime probe-ready or bypass an edited dependency. Persisted semantic changes publish invalidation only after successful writes; callback faults, rejected writes and receipt-only retries do not invent domain changes. Reconnect clears stale revision equality state and reloads current settings even when intervening events were missed.

Historical route tests still select their saved runtime/resource identity across later default changes and restart. Configuration mismatch rejects before dispatch rather than migrating an old native session. Scope, owned stop/release, unresolved start/result handling and immutable review-view cleanup retain their existing gates.

## Source and client boundary assessment

`null` is an explicit machine-default state, not an alias for the first registered runtime, built-in Codex, an installed descriptor or a saved profile. `ResourceSelection.forMachine` and `forProject` share resolution. A project override is an explicit scoped choice; it does not mutate the global default. Resolved resource snapshots detach runtime metadata from mutable configuration. Selection returns either an admitted profile or a typed failure before work starts.

The factory still validates and creates only saved configured instances. An empty configuration loops over none. Runtime composition supplies the real router over an empty registry and no implicit standalone default; the plugin's explicit-default branch is retained only for intentionally unrouted use. Installed catalogs provide parsers/editors/factories, not execution instances or model permissions.

The public catalog can describe global or scoped setup before a project/model exists. Known selection failures are converted to a small safe `selectionIssue`; unexpected errors and unknown projects still reject. `selected` remains absent when no grant exists, `defaultProfile` may be null and operation choices come from the actual server-authored service operations. Pending dependencies can remain visible as selected historical metadata with every affected choice ineligible; the runtime selection wrapper separately rejects new dispatch.

The reviewed UI readiness helper requires both a selected snapshot and an eligible server-authored operation row. It tolerates missing/null catalogs and does not inspect provider/model names. Existing socket resource generations, current-selection guards and the resource-catalog hook prevent stale asynchronous results from becoming current after invalidation/reconnect. The new actual-client regression proves the null/default and epoch transition; the UI owner's browser flow is separate evidence for presentation and action gating.

## Simplicity and limits

Removing fabricated configured defaults is a concrete simplification: absence is represented directly, and startup no longer needs a fake runtime just to make service-level setup possible. One shared selection resolver and the existing catalog DTO are sufficient; no placeholder adapter, synthetic project, second configuration store or implicit auto-selection path is needed.

Saving configuration, activating definitions at restart and choosing a profile are distinct states. Their persistence and explicit effects remain reviewable, and none implies a generated code result or successful diagnostic. Existing saved nonempty configuration remains honored; this change is not a reset of user settings or migration that erases prior explicit selections.

Trusted installed plugins remain in-process code. Capability metadata is admitted against actual methods, but these contracts are not a sandbox for malicious plugin implementations. No dynamic package installation, complete arbitrary workflow graph or live model compatibility guarantee is established here. SQLite authority, independently consumed package distribution, default-none execution budgets, operational unknown-effect receipts and concurrent-goal scheduling remain separate work. Existing connection/runtime/profile counts and execution/read bounds remain present.

No blocking finding remained in this reviewed scope after the independent checks.
