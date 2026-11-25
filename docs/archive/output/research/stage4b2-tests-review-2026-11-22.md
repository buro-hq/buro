# Stage 4B2 independent operation and invalidation review

Reviewed on 2026-11-22 against `a7f3838` plus the current operation-catalog and cross-client resource-invalidation working tree. Disposition: **clear within this stage's routing, captured-operation history and connected-client invalidation scope**, after fixing the captured-authority finding below. No production files were edited by this reviewer.

## Independent evidence

**77/77 tests passed** in an independent combined run covering the new review tests, the architecture review's actual reconnect case, operation catalogs/integration, configuration events, resource invalidation, projection refresh, service-role routing, runtime routing, registered resource integration, project operations, transport, autonomy and architecture boundaries. Repository `npm run typecheck` passed. These focused counts overlap the owner's final suite and are not additive or a claim that this reviewer ran the entire suite.

An independent `node scripts/check-live-resource-controls.cjs` run passed with actual Chromium/React, WebSocket commands and two synthetic projects. The proof reports live defaults, discarded held catalog responses, custom delivery operations, visible operation eligibility, preserved global role preference, live save and preserved project sequences. Reported model generations: **0**; external network requests: **0**; page errors: **0**. Screenshot: `artifacts/operation-role-controls.png` (generated ignored QA output). Registered fixture resources exercise the real UI/service wiring without contacting a provider.

Local receipts are `/private/tmp/buro-stage4b2-independent-tests.log`, `/private/tmp/buro-stage4b2-independent-new.log`, `/private/tmp/buro-stage4b2-independent-typecheck.log` and `/private/tmp/buro-stage4b2-independent-ui.log`.

## Independent regressions added

`tests/stage4b2-review.test.ts` adds four passing cases using actual `FileProjectStore`, private control-state bytes and mutation receipts, `FileRuntimeRoutes`, `RuntimeRouter` and `ResultService`:

1. The same custom role can have an accepted coding assignment on a writer and a distinct delivery-operation grant on an inspection-capable resource. The operation grant is persisted before backend start; the backend receives the operation ID and frozen role instructions. The accepted worker assignment remains unchanged.
2. A second inspection resource is independently eligible under an Auto role, and an explicit coordinator proposal selecting it passes normal role-resource validation. Attempting to replace an already captured operation grant with that otherwise valid proposal rejects with `OPERATION_CONTEXT_CHANGED`. Neither state bytes, snapshot, successful mutation receipt nor backend-start count changes.
3. Rewriting the captured role's instructions, model or runtime preference, removing or duplicating its referenced snapshot, or erasing its saved grant rejects with the same error. Failed mutations preserve both the durable control-state bytes and the original in-memory snapshot and leave no successful receipt.
4. An explanation-only change remains allowed. Repeating preparation still dispatches the original inspection resource and does not reopen selection or overwrite the coding assignment.

These tests use a synthetic accepted run and fixture backend. They prove durable store/router/service authority behavior; they do not prove a real deployment, provider generation or live-model quality.

## Finding resolved during review

The first transition validator froze the operation context but only revalidated the replacement resource decision's present eligibility. With an Auto role and two suitable resources, a later valid coordinator proposal could therefore replace the original operation grant. The role snapshot referenced by that grant could also be edited without changing its version.

The owner corrected `core/operation-transitions.ts` to preserve the decision's resource, role version, preference and source, and the referenced role snapshot's ID, version, instructions, preference and model. Exactly one referenced snapshot must remain. Explanation text can change without changing authority. The independent regressions above prove the meaningful valid-alternative case, rather than merely supplying an invalid fixed preference that would already fail ordinary validation.

The architecture reviewer separately found and fixed reconnect deduplication: a hash seen before disconnect must not suppress a later real change back to that hash after a missed intermediate configuration. Their actual localhost reconnect regression was included in this independent run.

## Boundary and test-strength assessment

The service-authored operation catalog supplies requirements and role binding to both resource-choice projection and actual dispatch. A role's descriptive kind does not alone grant or deny execution authority; the operation's requirements and frozen resource capabilities do. Delivery-operation grants are separate from accepted coding assignments. Saved operation contexts preserve historical dispatch identity when project configuration changes, while newly captured contexts must match an actual configured service entrypoint. Model proposals remain inputs to initial permitted selection, not authority to rewrite captured history.

Machine resource changes use serialized persisted mutations and a strict, credential-free invalidation variant. Independent tests cover persistence before publication, equality-based deduplication rather than lexical hash ordering, observer failures, distinct queued mutations, no event from failed writes or receipt replay, held projection replacement and reconnect refresh. Resource changes do not become fabricated domain changes or overwrite per-project event sequences. A client epoch/generation and current-selection checks prevent old asynchronous catalog/projection responses from becoming current state. Existing UI proof exercises these guards through the real client and browser.

Connected notification plus reconnect snapshot refresh is the implemented contract. This is not a durable client-acknowledged machine event log or a promise that disconnected clients replay every resource-change event. Captured operation metadata also does not add a durable effect/receipt protocol for operational preparation whose remote outcome becomes unknown; that remains a separate lifecycle concern.

## Simplicity and remaining work

Centralizing the actual built-in service operations removes duplicated UI capability guesses and keeps routing and choice explanations aligned. The separate operation-grant namespace is justified by the shared-role case and avoids repurposing accepted worker grants. Another catalog abstraction or policy authority is unnecessary for this stage. A small naming improvement would be to label fresh review as reviewing changes rather than reviewing accepted changes, since review precedes acceptance.

The catalog currently centralizes Buro's configured built-in service operations; it is not yet a complete contributed workflow/tool/check/role system or a dynamic plugin installer. Connected empty-team onboarding, independently consumed package distribution, SQLite authority, default-none quotas, operational preparation receipts and concurrent-goal scheduling are not completed by this review. Existing execution budgets and connection/backend constraints were not removed here.

No real model endpoint, offline RTX host, original user repository, credential value, external message, deployment or Git commit was accessed by this reviewer.
