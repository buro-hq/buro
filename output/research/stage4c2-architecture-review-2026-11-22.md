# Stage 4C2 independent architecture and boundary review

Date: 2026-11-22. Baseline `e98b597`. Reviewed context loaders/imports, hash-verified analysis material reading, project-analysis contributions, check-recipe discovery, research lifecycle/provenance and frozen research model/material grants. Reread the final source-owner changes and independently ran the final integration tests below.

## Decision

Bounded clear. No remaining blocking regression found in this stage. The new contributions supply bounded content or proposals. Existing services still own authorization, filesystem access, resource selection, sessions, command execution, profile application and final acceptance.

## Findings resolved during integration

P1 — research disposal originally missed an admitted command whose store receipt had not returned. Controllers/jobs were registered only after `store.transact`, so disposal could finish and a fresh research job could then start. The final service tracks admission/controller ownership before asynchronous admission completes, aborts and waits for admissions during disposal, and marks an already committed but cancelled admission interrupted without starting a model. The independent real-FileStore held-receipt regression passes.

P2 — a session acquired after cancellation could still receive a new model turn. The final service checks cancellation after acquiring the late session and around subsequent persistence/turn/completion boundaries; `finally` releases the acquired session. The independent deferred-start regression proves no turn and exactly one release. The final cleanup unsubscribes from runtime events and drains the final event-write chain before releasing the session, preventing late queued history writes from escaping service ownership.

P2 — a second, different request admitted after an awaited HEAD could overwrite a ready research job whose session release was still pending. The initial busy check happened too early. The final admission transaction also checks the current job slot; a ready proposal does not imply finished session cleanup. The independent deferred-HEAD/held-release regression proves that the second request is rejected and disposal still waits for the original job. Concurrent retries of the same command instead reuse the winning persisted research ID and schedule only one job.

P2 — project material selection was initially taken from an earlier snapshot across asynchronous admission. It is now captured from the current document in the same transaction that saves research provenance/receipt. Later imports do not expand the grant, and later library deactivation does not erase the already admitted selection.

P1 — integration review also identified that changing the machine default while admission awaited HEAD could retarget an already initiated research request. The final required selection port captures/validates the resource snapshot before that await, saves it with the research, and the router uses the matching admitted resources instead of a current-default fallback. Managed material grants use the saved research selection, including on continuation/reopen. The independent actual Router/Pi/Managed/FileSessions proof confirms both model and material stability.

P2 — repository inspection originally published recipe facts under a HEAD read before asynchronous discovery, without checking it again. A commit during discovery could give the proposal misleading revision provenance. `FileProjectRepository.inspect` now rechecks HEAD immediately before publishing `RepositoryInfo` and rejects with `REPOSITORY_CHANGED` if it changed. The controlled temporary-Git commit regression passes.

## Context and input authority

Context-loader registration is typed, startup-only and sealed. Matching is explicit: multiple primary matches fail rather than silently choosing registration order; text is a fallback. Metadata/callback identities are captured. Each matcher/loader receives its own copy of already authorized bytes plus a display name, not a source path, filesystem reader, executor, provider or mutable project state. Mutating one callback's byte array cannot alter another callback's input or the host's original hash.

The host still rejects excluded/private imports, owns size/count bounds, reads authorized source bytes, hashes/stores immutable originals and extracted text, writes command receipts and stages frozen run material. A loader supplies validated text/reference output only. PDF/DOCX extraction receives a private temporary copy of those bytes and cleans it up. Extraction failure honestly preserves a reference-only original. Built-in images remain references; text-only analysis does not claim to have inspected image pixels.

Authorized analysis material reading resolves exact saved references, rejects aliases/symlinks/corrupt bytes, verifies original and extracted hashes and supplies only content/provenance to the analyzer. A saved research selection remains usable after library deactivation, while later imports are excluded. Staging an old run or replaying an old import receipt never invokes an upgraded loader or silently changes its text. Required research material/resource snapshots and analyzer/source/profile identity cannot be rewritten through a successful store transaction.

## Analysis and recipe boundaries

`ProjectAnalysisCatalog` captures installed analysis identity and callbacks, freezes/copies validated input and normalizes returned request/proposal data. Analysis callbacks receive project identity, admitted source/profile data and authorized material content, without a root/resolver/runtime port. Prompt/schema construction and response normalization moved into the real registered built-in. The application retains the read-only session, chosen backend, lifecycle, receipt and profile-application authority. Arbitrary fields cannot add permissions, delivery execution or new runtime grants. Duplicate component/check IDs are rejected.

Research records persist analyzer ID/revision, source HEAD, profile revision, selected resources and exact material references. Captured profile/material inputs are independent of later caller mutations. Existing source/profile stale-apply checks and additive/manual-preserving profile application remain in the application service; an analyzer returns suggestions rather than executing or directly applying them. Recovery marks historical pending research interrupted without rebinding it to today's analyzer.

`CheckRecipeCatalog` moves the actual Node discovery heuristic behind a trusted recipe registration. A recipe declares exact bounded relative inputs; the adapter performs the reads. Callbacks receive only their own frozen facts, text hashes and HEAD, without filesystem, provider or execution ports. Private/generated traversal and symlinks are excluded; generated-directory presence is metadata only. Text reads are bounded through a file handle. Recipe outputs pass shared command/environment schemas, aggregate bounds and explicit conflict detection. Provider/callback-authored provenance is not accepted as evidence: the host supplies discovery source metadata.

Saved manual profiles win and skip discovery callbacks. Recipe suggestions do not run package scripts, setup, checks, environments or workspaces during inspection. A package-manager string cannot become an arbitrary shell-command prefix. Actual selected checks/environment preparation still use the existing execution services and receipts after settings are explicitly admitted.

Cordis installs built-ins before trusted `createHost.configure`, then seals the three catalogs before feature services use them. Core contracts/callbacks contain data and proposal logic; filesystem/document processes stay in adapters and service wiring stays in plugins. No model/RPC path registers executable code. There is no second orchestrator, analysis runtime or acceptance engine.

## Independent validation

Final focused run: **38/38 passed** across context loaders/material imports, project analysis, check recipes, the three independent lifecycle regressions and the independent actual frozen-grant proof. It includes real copied PDF/DOCX extraction, third-format/analysis/recipe Cordis integration, stale HEAD rejection, same-command concurrency, atomic material admission, private session reopen, provenance-rewrite denial and corrupt-blob rejection before any model request.

Broader run: **67/67 passed** across production empty startup/restore, project connection/configuration/stale apply, read-only research/environment routing, multi-model coding workflows, PR/deploy/preview/redeploy fixtures, protected scope continuation, unknown effects and immutable review views. Model APIs were local synthetic fixtures; original repositories and real providers were not used.

`npm run typecheck` and `git diff --check` passed. This reviewer changed only `tests/stage4c2-architecture-review.test.ts` and this report. Production fixes and other regression tests were made by their owners. No live models, RTX, credentials, existing user repositories or external deliveries were used.

## Simplicity and remaining limits

The catalogs are separate because their authorities differ: loaders transform authorized bytes, analyses build/parse a proposed research exchange, and recipes transform declared manifest facts. They reuse the existing import/application/runtime/check owners. A small admission set plus one project job slot handles the actual asynchronous lifecycle boundaries; it is not another workflow engine.

These are trusted in-process plugins, not isolation of arbitrary installed JavaScript or a hot replacement system. Callback closure/global state remains the author's revision responsibility. Current import, manifest, proposal and prompt-excerpt bounds remain explicit; this stage does not claim to remove run budgets or all limits.

HEAD validation and captured manifest hashes are evidence of observed input, not an immutable snapshot of every dirty worktree file during research. A fully persisted analysis request/response artifact and broader authority storage remain later work; the selected resource/material provenance is now durable and is not deferred.

Discovery responses expose recipe provenance, while admitted/manual command settings remain user-owned and are not automatically rewritten when a recipe changes. This stage does not yet publish reusable packages or implement role bootstrap, arbitrary workflow/executor contributions, operational preparation's separate unknown-outcome receipt or complete composite-command timeline evidence.
