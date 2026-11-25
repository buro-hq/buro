# Stage 4C3a independent architecture and boundary review

Date: 2026-11-22. Baseline `b7a5c70`. Final review after the workflow/role source-owner freeze and the last matched-research route correction. This replaces the earlier preliminary note.

## Decision

Bounded clear. No remaining blocking finding in the reviewed 4C3a scope. Empty bootstrap, actual on-demand role creation, startup replacement, captured role/version history and actual operation/resource admission are now connected through production services. Full integration-suite/build/browser evidence remains the corresponding owner's evidence, not a claim that this reviewer ran every project test.

## Findings resolved

P2 — `createWorkflowRoleResolver` retained the caller-owned `options.templates` lookup after selecting its workflow. Replacing that property could retarget later role creation despite startup sealing. The resolver now captures the catalog itself. The independent regression first reproduced changed instructions, then confirmed original content/provenance after the fix.

P2 — a saved route matching admitted research could omit both its role decision and original role grant. The router's old condition checked for a missing grant only when a decision was present, so this malformed initial route could resume a compatible profile runtime instead of the admitted user's pin. The independent second regression uses real `FileRuntimeRoutes` and `RuntimeRouter`: the admitted role is pinned to one backend, while a ready route names another and omits both grant fields. It originally resumed; the corrected condition now rejects `INVALID_ASSIGNMENT` before any backend resume. Unmatched standalone generic research remains supported.

Integration review also identified missing live projection for newly created research/result roles and incomplete captured provenance checks. The final atomic events include the new role versions; the client updates roles and invalidates derived policy/catalog data even without a run busy-state transition. Project history, run snapshots and research grants now have explicit guards, as described below.

## Bootstrap, content and operation authority

The raw filesystem store and project application no longer seed default/operational roles. Fresh project connection and reopen preserve an empty team until an actual operation requires a role. The explicit demonstration module may still seed its own fixture through first-party templates; ordinary startup does not load it. Production modules do not import the test role fixtures.

Template/workflow registration is typed and startup sealed. Templates supply validated content and revision, without a role ID override, model preference, capabilities or executor hooks. A workflow selector receives copied/frozen service-operation data and returns only a template ID. Host operation binding determines the required role ID; resource resolution uses the actual operation requirements. Kind/title/backend branding does not add authority.

Execution, research and result services require an injected workflow resolver. The composition resolves selected startup catalogs instead of importing a Core default-role array. Explicit catalogs replace individual default categories. Independent actual Cordis proofs use a custom-only workflow/template, custom PDF loader and custom-only tool broker; their callbacks affect real admitted roles/imports through the same existing bounded ports.

Missing required reviewer content rolls the initial transaction back rather than accepting without fresh review. Template/workflow selection cannot remove final checks/review or choose an executor. Existing user roles take precedence over templates, retaining instructions and model preferences; a missing template is not consulted when the required role already exists.

## Versions, provenance and continuation

Roles record user/workflow/coordinator provenance. User saves explicitly construct user-authored next versions and preserve template/workflow ancestry where applicable; a caller cannot forge coordinator/workflow authorship through extra fields. New coordinator-created specialists receive the host's saved workflow identity, not a model-authored provenance field.

Validated new specialists are persisted and published with the accepted plan before worker dispatch. That makes them reusable planned team roles, not a claim that their code or a goal has already passed acceptance. Later user version two is future-only: an active run keeps captured version one and can finish without overwriting the new user version or losing its reviewed evidence.

Project role history is an immutable ordered prefix with unique IDs/versions and sequential appended versions. Retained run snapshots cannot change their content/provenance; currently granted snapshots must remain uniquely present. Unreferenced planning-roster replacement is intentionally permitted rather than freezing every historical intermediate roster forever. Research retains its exact recorded role version and validated operation-specific resource decision, independently of later current-role edits.

Every new run saves its workflow identity. Later team materialization uses that saved identity, so replacing the startup workflow does not silently relabel an old run's new workers. There is no blanket current-workflow revision ban on continuing an already authorized run. A saved run lacking the required identity cannot acquire today's workflow implicitly when it needs new planning.

Research routes retain their original role and resource pool in a private `roleGrant`, so a previous research session can resume after the latest research record is replaced without reading today's role pin or pool. Route storage serializes writes and prevents retargeting its resource/requirements/operation/grant or an already bound external thread. Adapter admission revalidates actual capabilities, frozen resource identity and the original role decision. Matching admitted research cannot fall back when that grant is missing.

Result operations keep their separate operation contexts/decisions instead of overwriting accepted workflow grants. Immutable review views, scope grants, pending/unknown effect reconciliation, actual check execution and the sole host action journal remain their previous owners.

## Live UI and evidence

New coding/research/result roles are included in the transaction's event projection. Research and completed-result preparation do not rely on an unrelated later run event or reconnect to populate the team. The compact team UI describes provenance and uses actual recorded thread/session identity.

The public snapshot schema now retains `resultAgents.session`. Session details select the recorded role version from frozen evidence, including version one after a user edits version two; absent evidence is shown as absent rather than replaced with the newest role. The session roundtrip/unit proof was independently run. Browser proofs for live planned workers and immediate preview-role navigation were supplied by the UI owner and were not independently rerun by this reviewer.

## Independent validation

Final focused run: **18/18 passed** across the two independent architecture regressions, workflow contracts/history/result preparation, actual custom-workflow Cordis/WebSocket behavior, startup replacements, exact session-version projection and old research continuation. The second architecture test is the explicit missing-both-grant-fields negative boundary, with zero backend resumes after the correction.

Earlier independent bootstrap/storage/application run: **16/16 passed**, including empty raw-store initialization/reopen and actual catalog replacement. `npm run typecheck` and `git diff --check` passed after the final routing fix. Parent full-suite/build and UI-owner browser runs are separate validation and are not included in these counts.

Only the independent regression file and this report were edited by this reviewer. Production fixes were made by their owners. No paid/real models, RTX, credential material, existing user repositories or Git commits were accessed or modified.

## Explicit limits and simplicity

This workflow contribution chooses role content for the existing service operations; it is not an arbitrary executable workflow/DAG engine and cannot replace acceptance. Templates initialize missing roles; they do not silently upgrade or overwrite existing project roles when a template changes. Registration replacement is startup composition, not hot unloading under active sessions.

These are trusted in-process callbacks, not isolation of hostile installed code. Reusable package publishing, transactional storage cutover, broader default budget/limit changes, concurrent-goal scheduling, operational preparation receipts and complete per-helper composite-command evidence remain separate stages. Required provenance is an unreleased schema change; no old-format compatibility or inferred authorship is claimed.
