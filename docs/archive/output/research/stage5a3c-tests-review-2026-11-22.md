# Stage 5A3c independent tests and code review

Reviewed on 2026-11-22 against `stage5a3c-contracts-plan-2026-11-22.md`. No remaining blocker found in the bounded settings slice. This review changed only its own test file and this report.

## Independent evidence

Added `tests/stage5a3c-review.test.ts`, **4/4 passed**, using actual File/SQLite authorities and `ProjectApplication`. The injected registry stores deliberately throw on whole-document snapshot, legacy transaction and legacy receipt access.

- Both adapters: hold an actual verification while another command saves a newer profile. The running check retains revision one and its original context; its completed result remains revision one while current settings remain revision two. Duplicate in-flight requests perform one workspace preparation/check; conflicting fingerprints reject. Completed replay bypasses invalid check selection and repository inspection, adds no event and performs no new check.
- SQLite: after two successful configurations, seed a newer bounded proposal and a genuinely busy `canceling` Run index row. Replay with an invalid candidate and missing research ID still returns the exact old receipt, exports/installs the current profile and does not change proposal acknowledgement or events. A fresh command remains blocked by the actual busy guard and gets no receipt.
- SQLite: an injected trigger fails the acknowledgement write after the profile update. Even when the transaction callback catches that error and returns success, the shared owner rejects and rolls back profile, proposal, public event and receipt. Removing the trigger permits one successful retry under the same command identity.

The SQL proposal/Run index fixtures are explicit temporary-row seeding. They do not imply production SQL research/Run writers exist.

Final focused command covered the independent file, settings use cases, Core contract, File/SQL adapter cases, project application and architecture regressions: **38/38 passed, no skips**. Log: `/private/tmp/buro-stage5a3c-e-review.log`. Server typecheck, owned-file Prettier check and `git diff --check` passed after the final stop-admission fix.

## Source and test assessment

The shared settings transaction keeps profile CAS, bounded proposal identity comparison and acknowledgement policy in Core; both adapters provide row/document effects under their existing single command owner. SQL mutation failures remain sticky across caught exceptions. Its profile revision constraint accepts valid zero-revision bootstrap; reopen validates immutable project binding and preserves authoritative name/profile. Detached metadata and registry identity access avoid history-sized snapshots. Adapter tests additionally cover input capture, profile-less reopen, synchronous/expired capabilities and shared settings/entity/usage rollback.

Receipt reads precede new research/HEAD/busy admission. Retrying a committed configuration repairs the export from current authoritative settings while retaining the old command result. Export failure is reported rather than rolling back an already committed receipt. A verification keeps the revision it actually checked. The stopped-service admission recheck after awaited preflight prevents late workspace/check dispatch; the architecture regression passed in the final focused run.

Configured events now reject the removed full-research payload. Matching-ID acknowledgement merge preserves existing research history and grants; absent/newer research is not replaced. Cross-adapter use-case/protocol tests exercise those actual parsers and reducers. Same-ID proposal replacement during awaited HEAD fails transaction CAS before a profile/event/receipt change. Queued connection input and returned metadata aliases are covered by the architecture suite.

No additional abstraction is needed for this slice: one shared policy transaction and thin File/SQL bindings are understandable. Keep explicit receipt-first branches; replacing them with admission-first validation would change retry behavior. Legacy result-apply document methods remain deliberate and outside this migration.

## Limits

This is not a production SQL factory switch or complete ProjectAuthority/Run/artifact migration. Repository discovery still depends on readable exported metadata; missing/malformed metadata availability is not repaired here. SQL commit, Git state and filesystem export are not one atomic operation, and exports have no durable effect journal. Verification replay protects completed receipts, not a crash between process dispatch and receipt commit; no exactly-once external dispatch claim is made. Default quotas, model quality and live-provider performance are unchanged.

No model calls, network endpoints, RTX machine, secrets or original user repositories were used. Parent-owned full-suite/build/browser receipts are separate from this independent focused result.

## Final post-review correction

The architecture reviewer subsequently found that opening a saved profile without `baseBranch` used manual `configure`, which incorrectly acknowledged ready research as reviewed. Inspected the final correction: `ProjectApplication.open` now calls shared `initializeBaseBranch`; that operation CAS-checks the current profile, copies its existing fields, fills only the absent branch and advances its revision/event. It neither reads/acknowledges research nor treats internal normalization as a user settings action. An already present branch stays unchanged; stale revisions and revision overflow reject.

Independently reran all **5/5 Core settings tests** and the exact actual File/application automatic-base-branch regression **1/1**, all passed. The latter includes a properly admitted ready research record and confirms both review/application acknowledgements remain absent after open. This replaces the earlier signoff for that late source delta; no remaining blocker found. No production or test changes were needed in this follow-up. The parent's final 1197-test/full-build/browser receipts remain parent-owned evidence.
