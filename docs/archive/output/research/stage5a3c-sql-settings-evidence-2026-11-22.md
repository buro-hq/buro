# Stage 5A3c SQL project settings evidence

Date: 2026-11-22. The standalone project SQL kernel now consumes Core's settings facade. `.settings` provides bounded profile/verification/proposal/active-run reads, a shared receipt reader and synchronous configuration/verification transactions. The combined callback exposes `{usage, entities, materials, settings}` under one database transaction, command receipt namespace and validated public event sequence. No production SQL factory switch or JSON/SQL dual-write is introduced.

Open now requires an explicit `project: Project`; the old `projectId` option is removed. Project metadata is validated/copied before asynchronous storage preparation. A new authority captures its optional profile once; reopening checks the immutable ID/root/managed/data-directory binding and retains the saved name/profile. A supplied newer/equal bootstrap profile cannot overwrite saved settings, and a profile-less authority does not adopt a later bootstrap profile. Detached project getters and nonconfigurable facet properties protect the captured binding.

Fresh standalone format v4 stores project metadata alongside its identity. Current profile and verification rows are separate bounded records. The research table stores only the bounded proposal body plus a separate acknowledgement, with no production proposal writer added in this slice. Acknowledgement changes only that JSON field after semantic comparison and CAS against the original body/ack bytes. No full research history, runtime grant or transcript is loaded for settings changes. The active-run query uses the partial index for queued/running/canceling statuses rather than a visible Run page or whole history.

Profile updates and acknowledgement/event writes use existing sticky storage failure handling. Verification retains its actual captured profile revision; an older check result is not relabeled as proof for newer settings. Configuration events use the bounded acknowledgement field through the shared validator. Existing finite execution/profile policies remain unchanged.

Focused command: `node --test tests/sqlite-project-settings.test.ts`.

Result: **7 passed, zero failures/skips**, log `/private/tmp/buro-stage5a3c-sql-settings.log`. Cases cover authoritative reopen and option mutation, immutable binding rejection, profile-less reopen, profile CAS/old receipt replay, stale verification revision, combined entity/usage/settings rollback and exact event sequence, expired/async transaction capabilities, and valid revision-zero bootstrap configuring to revision one. The latter caught and corrected a SQL constraint mismatch: profile revision zero is valid in the shared Core schema.

Server typecheck, formatter and diff checks passed. Cross-adapter application/research acknowledgement/active-run facts, old SQL fixture migration, full-suite tests and independent reviews belong to the root and other stage agents; this receipt claims only the focused results above. SQL process dispatch journaling, complete artifacts, default-none quotas and full ProjectAuthority migration remain later work.

No model, network endpoint, credential, RTX machine, original user repository or Git metadata was accessed. Existing user state was not migrated.
