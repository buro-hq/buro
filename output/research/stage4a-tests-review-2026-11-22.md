# Stage 4A independent application, startup and transport review

Reviewed on 2026-11-22 against `a33f112` plus the current application/store/startup extraction. Disposition: **clear within the reviewed Stage 4A boundary**, after the startup fallback and obsolete projection-read fixes below. Full contribution discovery and generated team composition remain later work.

## Independent evidence

**62/62** tests passed across the new independent review tests, ProjectApplication, project store factory/registry, production application startup, service bootstrap, project workflows, projection refresh, WebSocket transport, core and architecture boundaries. Repository typecheck, `git diff --check` and formatting of the added test file passed. These focused counts overlap the owner's complete suite and are not additive.

An independent `node scripts/check-service-bootstrap.cjs` run passed with actual React/Vite/Chromium and local WebSocket transport. It verifies an empty connected service, first-project UI flow, explicit missing-project error, recovery from a stale stored selection, failed discovery without automatic replay, successful reconnect and explicitly requested replay mode. The script reports **0 model requests, 0 page errors**, and produces `artifacts/service-empty.png` as ignored QA output. Its connect/research catalog is a synthetic command fixture; production connect/restore is exercised separately by the real application test on a temporary Git repository, not by a claim that the browser performed real model research.

Local receipts: `/private/tmp/buro-stage4a-independent-tests.log`, `/private/tmp/buro-stage4a-independent-new.log`, `/private/tmp/buro-stage4a-independent-typecheck.log` and `/private/tmp/buro-stage4a-independent-ui.log`.

## Findings resolved during review

### Failed service discovery must not silently switch data sources

The initial ProjectProvider still created ReplayProjectClient with the old local draft project when its first service connection failed without an explicit project query. An empty live service correctly showed onboarding, but a connection error could still produce a different workspace/data source automatically. The UI owner removed this fallback. Failed discovery now retains the service mode, absent project snapshot and actual connection error. Offline drafts remain available through an explicit action or `source=replay`; they are not presented as live service state. The independent browser rerun exercised this failure and recovery path.

### A stale project read must not close or replace a new selection

A held policy refresh for project A could fail after the same socket selected B. Its catch path closed the shared socket based only on socket identity. Returning to A could also make an older successful A response appear current by project ID alone, despite a newer selection/history.

The client owner bound projection reads to socket, project and selection revision. Successful adoption, close-on-failure and refresh coalescing now respect that ownership. Independent tests hold an actual service response, select B, then release the old A error and verify the socket remains open, B remains selected and a read RPC still succeeds without reconnecting. A second test selects A→B→A, creates a newer A goal while B is selected, and releases the old successful A snapshot. The newer goal and sequence survive; the old read cannot roll history back or force a reconnect.

## Added ownership/startup tests

`tests/stage4a-review.test.ts` adds five passing regressions through the real Cordis host:

- Opening the second injected store fails while closing the first throws synchronously. The first receives exactly one cleanup attempt and the original admission Error remains the failure; cleanup cannot mask it.
- A duplicate store ID is discovered by actual registry construction after both stores opened. Both receive cleanup attempts, including when the first close throws.
- Injected non-file stores with opaque memory/repository addresses serve real service.info/project.snapshot commands without hidden file-store mutation or seeded goals/roles/runs. Disposal transfers cleanup to the registry and repeated host disposal does not close the stores again.
- The two stale selection/read regressions above use real file stores, real service commands and actual WebSocket delivery, rather than directly replacing private client fields or awaiting a private refresh promise.

The cleanup tests prove attempted/drained ownership and preserved primary errors. They do not claim that a resource was physically released after its close method rejected. Failed cleanup is not automatically retried, and registry shutdown remains closed/idempotent. This review does not add process-crash orphan cleanup or a new storage recovery policy.

## Boundary assessment

ProjectApplication depends on explicit repository/catalog/store/registry/environment ports. It does not import filesystem, process, Cordis, UI or file-adapter classes. The default file factory implements the opaque storage address boundary, while ProjectStoreRegistry owns accepted stores independent of storage type. Existing tests preserve profile/connection receipts, export retry, verification admission and source-result application behavior through the extraction. A foreign store is rejected and closed before workflow mutation or registration.

Production composition has an independently callable application factory. Ordinary startup has no seeded project; demo project/check/policy fixtures are reached only through the explicit demo path and use separate addresses. Service discovery and model setup work before project selection. CLI service-level commands do not invent a default project, while project commands require an explicit or unambiguous real selection. Current connected-project workflow role templates still exist; empty production startup and an empty generic file-factory team do not mean that automatic/generated role contributions are complete.

The service-only SocketProjectClient state remains distinct from a selected project snapshot. Selection waits for the snapshot and then subscribes from its exact sequence, so events committed in the gap replay through the ordinary protocol. Existing transport regressions still cover duplicate/gapped/foreign events, mutation receipt replay, reconnect catch-up and large context uploads. This review does not constitute exhaustive arbitrary disconnect, subscription or multi-client machine-configuration synchronization coverage.

## Deliberate remaining work

Contribution-based workflows/backends/tools, role-template contributions, complete empty connected-team bootstrap, independent package installation, SQLite authority, default-none quotas, operational preparation-attempt receipts and concurrent goal scheduling remain later stages. Explicit replay is a local draft feature; no fake execution result or implicit data-source substitution is claimed.

No original user repository, real model endpoint, offline RTX host, credential, external message, deployment or Git commit was accessed by this reviewer. Temporary fixture Git repositories and local browser/service ports were used only for authorized validation.
