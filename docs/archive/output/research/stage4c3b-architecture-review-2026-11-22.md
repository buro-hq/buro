# Stage 4C3b independent architecture and boundary review

Date: 2026-11-22. Baseline `2d8c03b`. Reviewed server sources after their owner freeze and the final UI source freeze. Browser-script debugging and the parent full-suite gates are separate owner evidence.

## Decision

Bounded clear. No blocking architecture or authority finding remains in the reviewed empty-resource bootstrap and first-setup scope. A fresh production composition exposes available contributions without configuring or choosing an execution resource. A custom-only empty composition no longer depends on preprovisioned first-party resource IDs.

## Configuration and authority

`defaultResources()` contains null default, empty connections, runtimes and profiles. The persisted schema permits that deliberate state while retaining semantic validation of any configured entries: missing backend/provider dependencies, invalid profile references and locality conflicts do not become acceptable because the default is null.

Installed provider/backend descriptors are catalog metadata, not configured instances or execution grants. Empty startup constructs no configured provider/backend, does not start Codex, and performs no model or discovery request. Production global RPC and CLI remain usable without projects or resources.

Saving the first connection/model/profile records configuration without selecting a profile. Newly configured resources remain pending until restart; after restart they are active but still unselected. A separate explicit `useProfile` selects the active machine default. An explicit project override can authorize its active profile while the machine default remains null. There is no first-profile or first-backend fallback.

`ResourceSelection.forMachine` and `forProject` share the same validation. Project lookup precedes selection, preserving unknown-project errors. Owned historical runs and routes continue to use their frozen resource identities; the absence or change of today's default cannot migrate an old session to a different backend. Pending connection changes block new work through the existing execution selector and mark catalog options ineligible until restart.

## Runtime ownership and errors

A routed runtime service may own an empty registry without an implicit default. An unrouted service still requires an explicit valid default, including a JavaScript caller bypassing TypeScript. There is no lookup of registry entry zero. Existing disposal ownership remains routed sessions, backend registry and unregistered tail before providers; admission failures and repeated disposal retain their tested cleanup behavior.

Resource discovery converts only a small known set of selection failures into public `selectionIssue` data with fixed safe messages. It does not swallow arbitrary storage errors, unknown DomainErrors or `PROJECT_NOT_FOUND`. Two independent negative regressions exercise those distinctions against actual resource construction and the project registry/error boundary.

## UI and bounded followup

The first-setup UI separates connection/backend selection, model/profile saving, pending activation and explicit profile selection. Model names can be entered before discovery so a fresh setup need not activate a connection solely to discover a model and then restart again. Server contribution descriptors and validation remain authoritative for custom contributions. Repository connection remains possible without automatically starting research; research and goal actions use scoped server resource eligibility.

The operation readiness helper currently means that a selected profile has at least one eligible option for the operation. It does not fully resolve an existing project role's fixed model pin. A project whose role is pinned outside the selected pool can therefore show a ready action and then receive the correct service rejection. This is a bounded existing-project UX followup, not an execution bypass or a blocker for an empty project with no pinned roles. The appropriate refinement is separate server-authored effective-operation readiness using the actual resolver; editable choices should remain available for changing the pin.

Explicit discovery/probe actions are independent diagnostics and may make a model request without selecting a work profile. The corrected empty-state copy refers to enabling goals and research, rather than promising that every explicit diagnostic action is disabled. No extra diagnostic restriction was introduced.

## Independent validation

Final targeted run: **60/60 passed** across empty configuration/runtime, first-setup runtime/transport, connection changes, runtime lifecycle, historical routing, production application startup and the two independent error-boundary regressions. The separate actual Cordis/WebSocket review file then passed **2/2**: automatic client reconnect across restart, no backend before pending activation, no implicit selection after activation, explicit selection, capability truth despite backend labels, unknown-project errors and safe unavailable-profile projection.

An earlier overlapping contribution/configuration/lifecycle set passed **38/38**. These are overlapping validation runs, not 100 distinct cases. `npm run typecheck` and `git diff --check` passed. The UI owner's browser scenarios and the parent's final full-suite/build are not included in the independently executed counts.

Only `tests/stage4c3b-architecture-review.test.ts` and this report were added by this reviewer. Production sources were not edited. Tests used temporary state and localhost with synthetic backends; no real model endpoints, RTX, credentials, original repositories or Git mutations were used.

## Scope and simplicity

This stage removes implicit resource authority and connects a deliberate first setup to the existing resource system. It does not introduce a second router, role resolver, action journal or acceptance path. It does not change quota/budget policy, automatically clear user preferences, infer old formats or add compatibility aliases. Existing trusted contribution boundaries, captured historical authority, final checks/review and pending/unknown effect handling remain their existing owners. Broader effective-role readiness and the previously recorded preparation/composite-command evidence work remain separate followups.
