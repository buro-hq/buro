# 4C3a team UI and real service/browser validation

Parent: `b7a5c70`. This is evidence for the team/UI slice, not the full-stage validation receipt.

The project team now has compact assignment cards, explicit user/workflow/coordinator provenance, larger Mantine actions and an honest empty-team explanation. Roles remain reusable definitions; each goal uses its own sessions. Editing an automatic role is described as taking priority for future work.

Session navigation includes result preparation. A card opens an actual recorded thread, and the inspector resolves its exact frozen role version. It does not substitute the latest edited role when evidence for an old session is missing. The public result-agent schema now preserves `AgentSession`; previously it silently stripped model selection and role-version evidence.

## Passed checks

- `node --test tests/team-session-view.test.ts tests/localization.test.ts tests/timing.test.ts`: 11/11, no skips. The new regression checks public snapshot round-trip, result-only role discovery and frozen v1 evidence after a current-role v2 edit.
- `scripts/check-projects.cjs`: 17 scenarios, zero page errors. A new connection has an empty team; the first goal creates coordinator/reviewer and a coordinator-authored specialist; the open client shows the specialist before reload. Real immutable service checks and a fresh reviewer block the first result. Continuing reuses the writer session, worktree and role versions; a fresh reviewer accepts the corrected result. Apply, settings, mobile widths, explicit project CLI selection and restart restore also pass.
- `scripts/check-project-setup.cjs`: 14 scenarios, zero page errors. Research creates only its needed coordinator. Preview and deployment create only their required roles. The result role appears in the open client immediately after preview and opens the actual preparation thread. Editing the role creates user-origin v2; the prior session still displays frozen v1. Cards fit 1024, 390 and 320 px widths, and the edit control has a measured hit target of at least 32 px height and 44 px width.
- Scoped Prettier checks and `git diff --check`: passed.

Browser logs: `/private/tmp/buro-stage4c3a-projects-browser-final.log` and `/private/tmp/buro-stage4c3a-setup-browser.log`. Screenshots were visually inspected: `artifacts/setup-on-demand-team.png`, `artifacts/setup-on-demand-team-mobile.png`; first-goal team: `artifacts/first-goal-team.png`.

The older first-goal browser harness needed explicit runtime selection, real environment executors and the current continuation/CLI UI. Its environment fixture now installs a declared synthetic dependency into the private worktree and checks local readiness. The original acceptance command still imports that dependency from the immutable verification view; no production isolation restriction was relaxed to pass the scenario.

All repositories and runtime replies in these checks were synthetic. Temporary projects were removed by their harnesses. No original user project, real model endpoint, RTX machine or credential was used. This evidence does not measure model quality or speed.
