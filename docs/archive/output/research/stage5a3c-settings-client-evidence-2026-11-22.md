# 5A3c — settings use cases, protocol and client evidence

Date: 2026-11-22. Synthetic temporary File and SQLite authorities only. No models, endpoints, RTX, original repositories or credentials were used.

Eight new tests in `tests/project-settings-services.test.ts` pass. Both adapters are exercised through the actual `ProjectApplication` configure, research-apply, info and verification methods. The supplied stores throw on legacy snapshot, document transaction and receipt access. Tests cover a committed save followed by failed export, canonical receipt replay after a newer save and reopen, export and policy rebuilt from the current authoritative profile, revision/fingerprint conflicts, user command/context preservation while applying research, and captured verification revision with zero repeated workspace/check calls on replay after reopen. Workspace/check ports are deterministic fakes: this proves application dispatch and receipt semantics, not real process isolation or model quality.

Configured events carry only `researchAcknowledgement` with the actual proposal ID and reviewed/applied revisions. The client merges those fields only into matching research, retains its frozen role/resource/history fields, preserves an earlier applied revision when a manual acknowledgement omits it, and leaves newer/absent research untouched. Exact sequence replay is inert. The protocol rejects the removed full-research configured payload; the bounded proposal schema rejects history, role snapshots and model-resource authority.

The SQL research seed helper is restricted to this suite's marked, canonical temporary directory and database. It seeds only the bounded proposal and separate acknowledgement row because the future research writer has not been ported. File fixtures seed an explicitly synthetic, correctly recorded research role/resource snapshot through the existing sole document writer. Neither fixture grants or fabricates accepted code evidence.

All 21 existing SQLite `open` call fixtures now supply required explicit Project metadata, including the child-process crash/concurrency worker. Actual entity/material integration fixtures reuse their complete Project objects. The migrated 80-test SQL/entity/material suite passed, retaining real process crash/reopen, conflicting requests, SQL rollback and the 17,409-operation indexed-lookup checks. No legacy `projectId` alias was introduced.

Validation:

- `node --test tests/project-settings-services.test.ts` — 8/8 pass; `/private/tmp/buro-stage5a3c-settings-services.log`.
- Migrated SQLite/stage5a2/stage5a3a/stage5a3b/entity/material suite — 80/80 pass; `/private/tmp/buro-stage5a3c-sql-migration.log`.
- Server TypeScript check, changed protocol/client/test formatting and `git diff --check` pass.

This slice does not adopt SQLite in production, move run/research/session writers, journal external check dispatch or make Git/export and storage one atomic operation. Existing profile limits and runtime quotas are unchanged. The File bridge remains the single production authority. Independent proposal-replacement race review and the full repository gates belong to the parent stage report.
