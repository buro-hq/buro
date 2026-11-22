# Stage 5A3c independent architecture and boundary review

Date: 2026-11-22. Baseline `b4fbf11`. Final review after the settings/identity sources, connect input capture, verification stop admission and explicit base-branch initialization were frozen.

## Decision

Bounded clear. No remaining blocking finding in this migration. Actual ProjectApplication settings use cases now consume required project identity and settings ports, with the current profile, bounded research proposal, acknowledgement and verification participating in their composition's one authority. The registry identity path no longer needs whole snapshots. The live application remains on FileStore; the isolated SQL composition does not constitute production cutover or a new external-dispatch authority.

## Findings resolved

P2 — queued `connect` closed over caller-owned input, unlike the other migrated queued settings commands. Reusing/mutating that input could change the eventual root/name/profile. Returned project objects could also alias the in-memory connection catalog receipt. Connect now captures its input at entry and returns detached project values on all three success paths. The independent actual-File regression holds the application queue, mutates the input and returned/replayed values, and verifies that the original project and receipt remain unchanged.

P2 — verification checked the stop flag before asynchronous preflight, then could create a new controller and workspace after disposal had already aborted the existing controllers. The final check immediately before controller creation/registration rejects late admission with `STOPPING`, with no await between that check and registration. The independent held-active-run-read regression confirms zero workspace/check calls, no saved verification and no command receipt when disposal occurs at that boundary. Already admitted serialized settings writes retain their ordinary drain behavior.

P2 — automatic missing-base-branch initialization was routed through the new generic configure operation, which also marks ready research as reviewed. Reopening could therefore record a user acknowledgement without a user decision. The final narrow `initializeBaseBranch` operation only fills an absent branch using profile CAS and emits its profile/policy change. It does not read or acknowledge research or depend on current active-work state, preserving the old internal normalization behavior. An actual FileStore proof retains a valid ready research role/resource grant and confirms that both reviewed/applied markers remain absent after open.

## Identity, bootstrap and export authority

ProjectStore exposes captured metadata and required settings. File and SQL adapters return detached identity values and prevent retargeting the authority's project binding. Reopen verifies ID, root, managed status and data directory; changing the export's name or a same/newer bootstrap profile does not replace saved service metadata/settings. A profile-less isolated kernel remains unconfigured rather than adopting a later bootstrap suggestion.

Registry admission/listing uses only `store.project`, closing the previous material-import identity dependency on snapshot projection. The converted open/info/configure/applyResearch/verify paths validate the requested project and settings facet binding before use. There is no snapshot/document fallback in those paths. The old accepted-result Git application workflow remains on its existing guarded document/effect path; this review does not claim every ProjectApplication operation has migrated.

Open reads the authoritative profile, performs only the narrow branch initialization if necessary, and installs the policy derived from the saved profile. Project JSON is an export/bootstrap proposal, not a second runtime settings authority. Equal or higher proposal revisions cannot silently override saved settings. Explicit configuration commits first; export failure does not erase its receipt. On retry the original canonical receipt is returned while the current saved profile is installed/exported, so replay cannot restore an older configuration over a newer service profile.

## Research proposal and user acknowledgement

Settings read only selected bounded proposal fields. The projection avoids transcript/events, frozen role/resource grants and context-material history; the pure negative proof verifies that getters for those excluded fields are not read. Application merges preserve user-maintained checks, defaults and scope rather than replacing them with discovered commands.

Research application checks its captured source HEAD, then the semantic transaction compares the live ready proposal body as well as the profile revision. The independent SQL regression replaces a ready proposal with a different body under the same ID while HEAD is awaited. The stale attempt changes no profile, acknowledgement, event, receipt or export. The same command can then retry against the replacement proposal and commit once. This verifies an awaited-boundary race, not an atomic lock on Git or an immutable dirty worktree snapshot.

Manual user configuration deliberately acknowledges the current ready proposal at the new profile revision; explicit research application also records its applied revision. Acknowledgement-only changes do not relabel the proposal's original source/profile provenance. Automatic branch initialization uses the separate no-ack operation described above.

Configured events carry only the bounded acknowledgement, profile and derived policy. The strict protocol rejects the old full-research configured payload. A connected client applies acknowledgement fields only to matching research identity and preserves its existing evidence, resources and history; it cannot replace a newer or absent research record with an old configured event.

## Transactions, reads and verification scope

SQL settings, entities, materials and usage share the existing transaction, command receipts and union event sequence. Profile updates use the original row and revision; proposal acknowledgement compares its original bounded body/acknowledgement row. A caught physical acknowledgement failure rolls back the earlier profile update and all other staged facets. Current records are singleton/point reads; active-work lookup uses its partial index rather than a paged history window.

The SQL bootstrap accepts valid revision zero consistently with Core. Existing rows remain authoritative; missing schema/identity/summary admission does not infer a fresh project or reset its state. Fresh v4 schema and required project bootstrap are an intentional unreleased API break, not an old-format alias/migration layer. File settings use the shared document-facet lifecycle/receipt rules and retain all existing commit-time frozen-run, role, research and unresolved-effect guards.

Verification freezes the selected checks and profile used for its isolated workspace. Its saved `profileRevision` remains the checked revision when configuration changes during the check; it does not become a claim about the new profile or accepted goal code. Current UI source labels the checked profile revision and the latest check. Replaying a durable verification receipt does not prepare/run checks again. In-flight duplicate suppression is local to the application instance; verification is not yet backed by a cross-process/crash-safe dispatch lease or complete environment-effect journal. That integration remains a separate stage.

## Independent validation

Final frozen-source run: **53/53 passed** across the four new architecture regressions, Core/File/SQL settings, actual cross-adapter services, bounded client/protocol events, earlier application/storage ownership tests and the independent acknowledgement-failure/held-verification tests. Full typecheck, `git diff --check` and review-file formatting passed.

An earlier 40-test run had four obsolete fake-store failures from missing newly required project metadata; the owner migrated those fixtures while preserving duplicate-ownership and cleanup assertions, and all passed in the final run. Parent complete-suite/build/browser results are separate owner evidence rather than part of these counts.

Only `tests/stage5a3c-architecture-review.test.ts` and this report were added by this reviewer. Production fixes were made by their owners. Tests used temporary File/SQLite state and synthetic repository/workspace/check ports, including a fixture-only bounded SQL proposal writer. No paid/real models, RTX, credentials, original user projects or Git commits were used.

## Remaining boundaries

Full SQL Run/research transcript/resource admission, immutable model packets, effect dispatch claims and production project-store activation remain incomplete. A saved settings/profile/verification/acknowledgement row is not accepted code or a new permission to repeat an external effect. Existing finite profile/budget/material bounds and default policy have not been removed by this migration. Previously recorded artifact-directory power-loss durability and orphan-blob cleanup work also remain. Frozen role/resource/material grants, unknown-effect reconciliation, independent review and final executable checks retain their existing owners.
