# Stage 4B1 independent resource contribution and settings review

Reviewed on 2026-11-22 against `60c3959` plus the current generic resource contribution working tree. Disposition: **clear within the provider/backend registration, configuration and lifecycle scope**, after the conservative template-locality correction below. This does not complete workflow/tool/role contributions or independently installed packages.

## Independent evidence

**105/105** tests passed across the independent review/architecture cases, resource contribution unit/integration tests, runtime plugin lifecycle, file resource configuration, connection/setup admission and transport, configured native instances, backend contracts/admission and architecture boundaries. Repository typecheck, `git diff --check` and formatting of the added test file passed. These focused counts overlap the owner's final suite and are not additive.

An independent `node scripts/check-contribution-settings.cjs` run passed with real Cordis resources, WebSocket commands, React/Vite/Chromium and the CLI. A synthetic third provider and third backend appear in their generic editors, the server-produced model template is used to construct settings, changed connections show a restart requirement, the current default is preserved, and each provider/backend is disposed once. Reported model generations: **0**; network requests: **0**; page errors: **0**. Screenshot: `artifacts/contribution-settings.png` (generated ignored QA output). The test uses registered fake factories rather than a real model/provider endpoint.

Local receipts are `/private/tmp/buro-stage4b1-independent-tests.log`, `/private/tmp/buro-stage4b1-independent-new.log`, `/private/tmp/buro-stage4b1-independent-typecheck.log` and `/private/tmp/buro-stage4b1-independent-ui.log`.

## Independent regressions added

`tests/stage4b1-review.test.ts` adds four passing cases:

1. Real Cordis registration uses a third-party provider whose ID is `codex`, a third-party backend whose ID is `ollama`, and a backend instance named `codex`, with built-ins disabled. A read-only request still rejects before dispatch when the registered implementation does not provide read-only sessions. A supported request uses exactly that declared backend. No first-party client is launched, model generation or network occurs. The returned model suggestion remains explicitly nonlocal, its input connection is frozen, and mutating the consumer's suggestion cannot rewrite active configuration bytes.
2. A third-party model template with semantically invalid backend configuration fails with INVALID_RESOURCE_CONFIGURATION, without exposing its synthetic private sentinel, changing configuration bytes or dispatching execution.
3. A factory returns locality inconsistent with its registered dependency/metadata. Startup rejects with INVALID_RUNTIME_INSTANCE and drains the already acquired backend and provider once, even when backend cleanup itself fails. The original admission failure remains authoritative.
4. Malformed contribution IDs, labels, revisions, editor IDs and non-JSON default configuration reject before a registration or factory effect. The sealed descriptor list remains empty after each rejected registration.

The architecture reviewer separately added the duplicate underlying-provider/distinct-wrapper cleanup case and held backend-drain ordering cases. They were included in this independent 105-test run rather than duplicated in another test file.

## Finding resolved during review

The new model-template wrapper initially validated the contribution's `local` flag but returned only the computed backend/dependency locality. A template explicitly marked nonlocal could therefore be promoted to local when its backend's general description was local. The owner changed the projection to require the template's conservative flag as well as backend/dependency locality. The new actual-host regression proves that false remains false. This prevents an extension's conservative discovery result from being broadened by the host; saved configuration and actual backend admission remain separately validated.

## Boundary and test-strength assessment

Open RPC configuration envelopes accept JSON data and registered contribution IDs; they do not deserialize factories or executable callbacks. A sealed catalog owns the trusted parser/metadata/factory registrations. Semantic parsing occurs during file load and every mutation, not only in a browser form. Existing regressions reject unknown contributions, invalid unused backends, missing dependencies, remote alternatives in local-only pools and invalid built-in limits without replacing persisted bytes or creating a successful receipt.

Descriptors/configuration handoffs are detached; callbacks and active model/locality metadata are captured. Model templates are parsed again against their registered backend, can reference only their selected supplied connection, cannot mutate that active connection and are returned as independent suggestions. New configuration remains pending restart instead of silently retargeting an active provider or saved run. Provider/backend/contribution revisions enter configured identity; the existing real-route regression rejects historical resume after a contribution revision changes, without selecting a fallback.

Provider instances and backend instances have separate ownership. Dependency maps expose only declared dependencies; capacity aliases share the conservative gate. The runtime plugin owns accepted backends, while resources own provider wrappers and diagnostics. Disposal drains routed sessions and backends before providers; the lifecycle callback is captured during admission, so teardown does not depend on looking up an already removed child Cordis service. Held-drain tests verify providers stay alive until backend disposal settles, including failure. Distinct rejected provider wrappers are tracked for cleanup, and duplicate ownership cannot cause a second disposal of one accepted backend.

These tests establish callback/configuration/lifecycle contracts for trusted installed code. They do not sandbox arbitrary malicious plugin code or prove that a plugin author's declared revision changes whenever its closure/global state changes. Backend capabilities and actual methods are still admitted separately; recognizable names grant no execution authority.

## Simplification and remaining work

The substantive simplification is already present: model/provider-specific construction and model discovery now live in registered contributions, while generic resource commands and editors consume their public descriptors. Additional refactoring of the large resource composition module should follow demonstrated needs; extracting settings mutation/catalog listing from factory admission would be a reasonable next split without adding another permission or lifecycle authority. Backend descriptor/template callbacks could also be collected once per model-list request instead of cloning every descriptor for each row; no correctness change is required for this bounded stage.

First-party defaults and their polished editors remain explicit Buro composition. Generic fallback JSON editors enable other installed registrations; this is not a dynamic plugin installer or a complete schema-generated form engine. Workflow/tool/check/role contributions, empty connected-team bootstrap, published package exports, SQLite authority, default-none quotas, operational preparation receipts and concurrent-goal scheduling remain later work. Existing backend/connection count constraints and execution budgets were not removed by this change.

No real model endpoint, offline RTX host, original user repository, credential value, external message, deployment or Git commit was accessed by this reviewer. These synthetic registration/settings tests provide no live-model quality or speed evidence.
