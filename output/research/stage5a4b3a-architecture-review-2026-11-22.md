# Stage 5A4b3a independent architecture/code review

Date: 2026-11-22. Reviewed the working plan/assignment slice after `33c3c96`, against the saved Run/journal plan. Scope: actual planning acceptance, named original assignment reads for worker dispatch, immutable decisions and current plan pointer, File/SQLite storage, task/material/role context CAS and read-only planner handoff. Full executor/session/effect adoption and first-release readiness are outside this signoff.

## Findings and corrections

The parent raised the incomplete planner identity concern. The reviewer independently reproduced it through actual File admission/planning records: while retaining the same planner session/thread IDs, changing configuration revision, runtime, role version, selected model or parent session was invisible to planning-context CAS and acceptance succeeded. A same-ID sealed planning-session rewrite also survived COMMIT and OPEN. Seven independent leaf regressions initially failed.

The Core implementation agent corrected the handoff to retain and compare the bounded original session grant: ID, role/version, runtime, optional provider/model/configuration revision, selection and parent. File context capture, seal, retained planning-session validation and the public projection compare this exact grant. Observed `reportedModel` and completed result remain separate data, with a positive regression confirming they neither invalidate the handoff nor enter the immutable grant.

The parent then identified another accepted-record invariant: deleting the handoff from both saved plan and context made their equality check vacuously pass. The reviewer reproduced both plain deletion and deletion combined with restoring the read-only planner as coordinator/writer; OPEN initially accepted both. The parent corrected the shared accepted-plan schema to require read-only strategy if and only if a matching handoff exists, with exact session/grant ID and coordinator role. Both OPEN regressions now reject.

The reviewer also highlighted that an initial File context was labelled as admission authority while reading only the legacy projection. The implementation now compares initial task/material/policy/workflow/resource inputs to the immutable admission; a reviewer regression confirms that replacing the legacy task cannot substitute a new initial planning authority. Explicit legacy continuation retains its existing owner rather than pretending the initial task is its current context.

All these corrections were independently inspected and tested. Production fixes belong to the parent/implementation agent; `tests/stage5a4b3a-architecture-review.test.ts` belongs to this review. No further blocking finding remains within the reviewed slice.

Final coordinator amendment: planning context now retains the actual frozen coordinator role and selected resource decision. Core validates that decision against the saved pool and coordination operation, then compares planning capability policy to the selected resource rather than the profile's default coordinator. The read-only session grant is cross-linked to that actual role/version/runtime/provider/model/configuration/selection. File initial-context ancestry includes this decision; SQL stores and reconstructs its role/resource fields separately. The reviewer inspected these changes and adjusted the synthetic session fixture to derive its real admitted decision through `sessionResource`. A replacement grant can now reject as invalid authority before context CAS; parent-only changes still reject through CAS. No SQL session fact is fabricated.

## Architecture assessment

Core resolves and validates a plan against the exact captured planning context, current selected role versions, saved workflow/policy and installed resource snapshot before persisting. Cancellation, unresolved operations, missing workspace, existing plan and conflicting context reject before assignment authority is committed. Newly minted roles, immutable plan/assignment records, current scalar revision, timeline, public event and receipt share the authority transaction; late physical failure rolls them back together.

The actual planning path consumes the semantic command. Persistence/context/reconciliation failures propagate without a corrective model call; corrections remain limited to recognized proposal/role-catalog errors. Accepted read-only planning atomically clears the old writer thread/coordinator slot and retains its exact original grant before the executor creates a distinct writer. Cancellation after plan commit is checked before writer dispatch. This is not a cross-process dispatch lease.

Worker dispatch reads the named original accepted assignment and verifies role, scope and resource before persisting its existing session intent. Later task refinement, worker recovery and continuation still have their established legacy owners. Complete original task, materials, policy and assignment decisions remain retrievable from the immutable plan; this does not claim those later owners have migrated or that every dispatch decision is already independent of the Run aggregate.

File remains the sole production authority. Commit/open guards retain original decisions and reject missing or conflicting reverse projections; public event reconstruction incorporates accepted plans before later legacy deltas. SQLite stores separate plan headers, steps, material/check references, assignments, assignment paths and current pointer, without a whole growing Run or session JSON column. SQLite read-only handoff explicitly rejects because there is no real SQL session authority yet; tools-free semantic plan persistence is not full SQL runtime execution.

## Independent validation

The final focused set passed **52/52 tests**, no skips: reviewer-owned exact-grant/open/context regressions (13 Node-reported tests, including one parent with six subtests), 22 plan contracts and 17 worker-envelope/recovery tests. Coverage includes real nondefault coordinator fixed pins through File/SQL acceptance and actual File read-only planner-to-writer handoff, role/pin edits while planning, complete retained task/materials, named dispatch grants, cancellation around accepted plan delivery, failed commit with no corrective generation, missing SQL session authority, indexed current reads with noncurrent-row fixtures, rollback/reopen and the corrected handoff invariants.

Typecheck, reviewer-test formatting and `git diff --check` passed. Full-suite/browser results remain the parent's separate integrated gates. No provider request, native process, RTX access or original user-project mutation was performed by this reviewer; `output/ux/` remains untouched.

## Boundaries retained

This is one initial accepted plan per Run, not migrated continuation attempts or arbitrary replanning history. Current worker refinements/recovery, coordinator/worker session lifecycle, runtime observation deduplication, complete effect/accounting journals, private artifacts, result acceptance/apply ownership, public history pagination and default-none quotas remain subsequent work. The original File session owner still supplies the real planner fact. Point-query/returned-row evidence is not a VM-scan or throughput claim. Finite execution limits remain unchanged.
