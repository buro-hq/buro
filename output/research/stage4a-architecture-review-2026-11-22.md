# Stage 4A independent architecture review

Date: 2026-11-22. Reviewed the working tree after `a33f112`, including the final `daemon/application.ts`, explicit demo bootstrap, direct Core application wiring, factory identity guard and socket projection selection guards. This is a bounded review of 4A, not acceptance of the later contribution registries.

## Decision

No remaining blocking regression found in the reviewed 4A changes. The extraction makes project use cases independent of filesystem stores and lets the actual production composition start without an invented project. The original execution, immutable acceptance and unresolved-effect recovery owners remain in place.

## Finding resolved during review

P1 — a newly injectable project store factory could return another project's store. `ProjectApplication.open` originally trusted `stores.open` and could register a different ID/root while constructing the requested project's connection receipt and policy. This could route later work to the wrong root.

The final `core/project-application.ts` compares the returned snapshot's `id`, `root`, `managed` and `dataDirectory` with the admitted project before any application transaction, local repository initialization or registry ownership transfer. A mismatch fails with `PROJECT_STORAGE_MISMATCH` and closes the unregistered store. The four mismatch cases in `tests/project-application.test.ts` pass independently. This finding is resolved, not a remaining blocker.

## Boundaries checked

- `core/project-application.ts` owns admission, connection/configuration/verification/apply receipts and application sequencing. Repository facts/Git/files, catalog persistence, storage construction, clock and IDs enter through explicit ports. Neither it nor `core/project-registry.ts` imports Node, Cordis or adapters. The filesystem compatibility facade is now composition around the Core service; Cordis exposes `ProjectApplication` directly and accepts injected repository/catalog implementations.
- `ProjectStoreRegistry` owns only successfully admitted stores. Duplicate admission does not transfer the rejected store's ownership. Closing refuses new ownership and drains every existing store despite synchronous or asynchronous disposal failures. `FileProjectStoreFactory` captures caller inputs and explicitly supplies an empty role list when none is supplied; storage addresses are opaque to the application.
- `createHost()` defaults to an empty project catalog. `createBuroApplication()` uses empty bootstrap projects, trusted check fixtures and policies by default, and restores explicitly linked repositories through the project application. The two demonstration projects/check recipes are in a dynamically imported, opt-in module with separate `demo/demo-*` storage addresses. “Empty by default” does not mean forgetting previously connected projects.
- Partial host startup closes previously opened stores. Late application startup failure disposes the host as well. Independently exercised a malformed temporary linked catalog after two fake demo stores were admitted: the original catalog parse error survived, both stores closed even when the first close threw synchronously, and the same isolated service directory reopened empty afterward. No transport call occurred.
- `service.info` is a closed RPC with validated service metadata and project-independent capabilities. UI and CLI discover the service before selecting a real project. Global resource/filesystem/connect operations work without a selected project. Explicit missing project selection is surfaced; stale remembered selection can recover to an available project. Replay requires an explicit mode instead of silently replacing a failed live service.
- Socket project selection waits for subscription/replay acknowledgement. Selection generations guard stale projection success and failure, including A → B → A. Existing exact mutation IDs, replay sequencing and project identity checks remain active. The real host/loopback transport tests cover the snapshot/subscription gap and reconnect/lost-response behavior.

## Independent validation

`node --test tests/project-application.test.ts tests/project-store-factory.test.ts tests/application-startup.test.ts`: **17/17 passed**.

`node --test tests/stage4a-review.test.ts tests/service-bootstrap.test.ts tests/projection-refresh.test.ts tests/transport.test.ts tests/projects.test.ts tests/recovery.test.ts`: **47/47 passed**, with isolated temporary repositories and loopback WebSockets. This includes actual acceptance/check/repair recovery regressions, not only port-shape tests.

`npm run typecheck`: passed across portable contracts/providers, UI and server. `git diff --check`: passed. A separate actual-application late-startup-failure probe passed, as described above. The first probe used macOS's `/var` alias and correctly hit the existing private-storage symlink rejection; the final probe used `fs.realpath` and reached the intended catalog failure.

No live models, remote endpoints, RTX, credential material, existing project state or original project source were used. Tests configured fake transport/credential callbacks where application resource composition was exercised. No production sources were edited by this reviewer. The browser bootstrap script was read but not independently run in this review; parent/integration UI checks are separate evidence.

## Explicit remaining work and limits

The connected-project application still selects the built-in coordinator/reviewer and inserts operational roles. Repository inspection still supplies built-in profile/check heuristics. These are the previously agreed 4C contribution extraction, not completed plugin registration or fully generated team behavior. The raw filesystem store also retains fixture defaults; the production factory explicitly overrides them.

Resource configuration, provider/backend construction and parts of the UI still contain first-party provider/client unions and names. Service discovery does not resolve those extension barriers; they belong to 4B. Cross-client machine-resource invalidation and operation-aware role eligibility remain the separately documented followups in `stage4-contributions-plan-2026-11-22.md`.

The default executable still invokes the pre-existing metadata-directory migration when no explicit data directory is configured. The new application composition no longer opens the old prototype project automatically; this review does not claim removal of all legacy directory migration code or inspect/migrate any existing user directory.

The new repository/catalog/store ports are trusted in-process implementations, not hostile-plugin isolation. Startup sealing, contribution lifecycle, arbitrary provider editors, operation-specific catalogs and reusable package publishing are not supplied by 4A. No change here grants models direct registry mutation, bypasses selected runtime capabilities or replaces durable effect/acceptance authority.
