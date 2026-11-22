# Stage 4B2 independent architecture and boundary review

Date: 2026-11-22. Baseline `a7f3838`. Reviewed the resource-change producer, Cordis/WebSocket invalidation, client/UI epoch guards, operation catalog, saved operational decisions/contexts, runtime admission and filesystem transition guards. No live models, remote endpoints, RTX, secrets or user repositories were used.

## Decision

Bounded clear for the reviewed 4B2 production sources after the fixes below. No remaining blocking regression found. These changes preserve the existing broker/effect journal, accepted-source/check/reviewer authority and runtime identity checks. Notification metadata cannot grant execution authority.

## Findings and corrections

P2 — reconnect retained an obsolete equality-deduplication hash. A client could observe configuration A, miss B while disconnected, reload B on reconnect, then ignore a real B → A event because its last remembered event hash was still A. The final client clears its remembered hash at the new socket epoch, increments the local generation, rejects old-socket messages and reloads current state. The independent permanent regression `tests/stage4b2-architecture-review.test.ts` exercises precisely this sequence through actual loopback WebSockets and passes. Hash values are compared only for equality, never sorted to infer age.

P2 — implementation eligibility originally included reserved service roles. The catalog offered a coordinator/reviewer/operational role as an implementation worker even though `resolveTeam` rejected it. The final catalog and allocator share `isWorkerRoleId`; a custom builder used by a deployment still gets both real operation rows, while a coordinator configured for deployment gets coordination/delivery rows without a fictional worker context.

P2 — saved operation context lookup originally trusted the nested operation ID independently of its outer map key. That could alias one operation's grant into another operation lookup. The final run schema, `savedOperationContext` consumer helper and filesystem transition validation require exact key/ID identity; router, result preparation and policy projection consume that checked helper. Mismatch tests reject before route/backend effects.

P1 — the router's initial operation refactor removed the old explicit result-role requirement. A delivery start omitting `roleId` could skip saved-role decision validation and use a profile default. The final router requires explicit delivery role identity and the owning fixed operation's frozen role/resource grant, including owned coordination/review. Missing-grant regressions confirm no route persistence or backend start. This was identified by integration review and independently reproduced by the existing failing service-role test before correction.

P2 — later adversarial review showed that validating a replacement operational decision as currently eligible did not freeze its historical authority: another semantically valid proposal could replace an already captured automatic selection. The final transition guard compares the saved authority tuple `[resource, roleVersion, preference, source]` with its previous value, and freezes the uniquely referenced role snapshot's instructions/preference/model identity. Descriptive selection reasons can change without reopening authority. Context label/role/requirements identity is also immutable; current project role versions remain editable. Final regression evidence is recorded below.

## Boundary checks

Resource mutations are serialized by the application facade. It compares actual semantic configuration revisions before and after successful persistence, then emits a minimal `{topic, revision, appliesTo}` notification only for a real settings change. Receipt-only writes, old receipt replay, rejected edits and unchanged selection do not manufacture changes. Synchronous/async observer failure cannot invalidate a committed receipt.

`service.change` is separate from project-domain event sequences, reaches all connected clients including clients without a selected project, and has a closed schema excluding configuration/credentials. A change invalidates the current policy projection and resource catalog; it does not mutate a goal/run or move an existing resource route. Project event replay and exact mutation request IDs retain their previous owners.

The client uses local request/selection/socket generations to reject stale responses. A held older projection cannot publish its old effective policy after a later invalidation; snapshot selection/handshake retries when resource generation changes. Reconnect refreshes current state even when every intervening event was missed. The React catalog hook checks both its own request generation and the client's resource epoch before adopting data/errors. The UI formats server-authored eligibility and labels; it does not derive operation grants from role titles/kinds or backend branding.

The operation catalog describes actual service entry points: implementation, coordination, immutable review, read-only research/environment inspection and result preparation. The same requirements feed eligibility, role resolution and runtime admission. Result preview/PR/deployment prepare sessions are explicitly read-only; actual launch/push/deploy stays in the result service after accepted-result and readiness checks.

Operational decisions live under `run.operationResources[operationId][roleId]`, independently of the accepted coordinator/reviewer grants and worker assignments. Preparation saves its context, decision and exact role version atomically before runtime start. One role can therefore serve several purposes with different eligible automatic selections without overwriting its accepted workflow grant. A global user role preference still applies across its uses; the UI explains operation-specific unavailability rather than silently inventing a per-operation user preference.

Captured result contexts preserve operation labels, role binding and read-only requirements after deployment configuration is edited or removed. File storage validates initial/current context structure and frozen decision authority on load, and validates admissibility of newly added contexts plus immutability of existing ones on transactions. Runtime selection still checks actual backend capabilities, frozen profile membership, resource/configuration identity, role version, session scope and immutable review view. Saved metadata alone cannot widen backend mechanics.

The catalog remains a service-derived operation catalog, not another arbitrary executable plugin registry. It reuses existing routing and result services. The transition guard protects persisted history; it does not dispatch effects or replace model admission. Invalidation is an observer path, not a second state store or mutation protocol.

## Independent validation

Final focused authority/invalidation run: **50/50 passed** across operation catalog/integration, service role routing, role routing, autonomy projections, backend admission, configuration-change events, loopback transport and the new reconnect regression.

Migrated the existing review-view cleanup fixture to an actual frozen reviewer grant, as assigned by the integration owner. The test now uses a selected resource snapshot, reviewer version, resolved review operation and explicit role/operation IDs; all original interruption/release/late-event assertions remain unchanged. `tests/runtime-router.test.ts`: **14/14 passed**.

Broader integration run: **34/34 passed**, covering tools-free/read-only planning and crash continuation; actual temporary PR/deploy/preview/redeploy workflows; two-client resource setup transport and receipt replay; provider unknown-outcome recovery; actual SDK receipt failures; and the reconnect regression. These runs overlap in the reconnect test and are not an additive distinct-case total.

`npm run typecheck` and `git diff --check` passed. Source-owner browser/two-page checks are separate integration evidence; this reviewer did not independently run a browser. Apart from this report, this reviewer edited only the new reconnect regression and the specifically assigned existing runtime-router fixture.

The final valid-but-retargeted-decision guard was reread after its source-owner freeze. Independently executed `tests/stage4b2-review.test.ts` together with operation integration and router suites: **23/23 passed**, including **4/4** new real-FileStore adversarial cases. They prove accepted worker assignment preservation, rejection of an independently valid alternative grant without changing file bytes or writing a receipt, rejection of changed/deleted/duplicated role authority, and permitted explanation-only updates with the original runtime retained. The other 19 cases overlap the runs above.

## Explicit remaining limits

Notifications are transient, not a durable service-event log. Reconnect rehydrates current settings; local generations order client observations rather than assigning chronology to revision hashes. External manual file editing remains a restart/error path, not hot settings reload.

History immutability is enforced through supported store transactions and validated snapshots. This is not cryptographic tamper evidence against someone rewriting the entire private state outside the service, nor isolation of hostile in-process plugins.

Result operation contexts are frozen when the service first prepares that operation. They do not make arbitrary old project settings universally immutable or silently authorize disabled/removed external delivery. Restoring/changing a captured grant needs a deliberate future workflow; ordinary project edits must not retarget it behind the user's back.

The pre-existing read-only operational preparation unknown-outcome receipt gap is not resolved by saving an operation context: a failed preparation can still require its dedicated future owning receipt/reconciliation design. External delivery remains gated on verified readiness. No claim here changes real-provider quality, default budgets/limits, package publishing or the remaining 4C tool/context/analysis/check contributions.
