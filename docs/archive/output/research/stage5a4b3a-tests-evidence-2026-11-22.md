# 5A4b3a independent accepted-plan and assignment test evidence

Date: 2026-11-22. Working continuation of `33c3c96`. Scope: the first accepted planning decision, immutable original worker grants and their actual command/read consumers. This is not continuation migration or complete SQL execution adoption.

## Real authority consumers

`tests/run-plan-contract.test.ts` creates actual materials, a goal and a user worker role, admits a genuine Run through `ExecutionService.start`, activates it, binds its prepared workspace and enters planning. File and SQLite both invoke actual `ExecutionService.acceptPlan` with legacy snapshot/document mutation methods that throw. No SQL whole-Run execution snapshot or accepted-result fixture is used.

Named plan/assignment reads retain exact admitted task text, original complete criteria, material metadata references, check selection, policy/scope, workflow, resource pool, role version/instructions and selected resource/path/task decisions. Library removal and later role versions cannot rewrite that retained decision; reopen preserves it. A stale user-role version rejects before any write. Context comparison rejects altered task/material/scope input. A second command cannot replace the first initial plan (`PLAN_EXISTS`), while command receipt replay remains canonical after cancellation and reopen.

The nondefault-coordinator regression saves a real user coordinator role through `RoleService` with a fixed pin before actual admission. Both File and SQLite select another eligible frozen-pool runtime whose ID, configuration revision, model and capability revision differ from the profile default. Named planning input, accepted plan context and reopen retain the exact selected coordinator role/decision and planning policy instead of reinterpreting the profile default as the selected backend. The initial regression reproduced the previous `INVALID_PLANNING_POLICY`; it passes after the Core/storage correction.

Cancellation and an unresolved operation prevent plan acceptance. The SQL unknown-effect test seeds only the indexed unresolved fact through a guarded synthetic fixture, since the SQL effect journal is deliberately not implemented here; it is not claimed as real SQL journal execution. SQL readonly admission rejects `PLANNING_HANDOFF_UNAVAILABLE` before writes rather than inventing planner-session authority.

## Actual File planning and dispatch boundaries

The File tests run real `execute`/`planAndImplement` with synthetic runtime starts and observed planning replies. Verification/model transport and final accepted-result work are explicitly held at their existing boundaries. They verify a real readonly planner is retained and its writer slot cleared before a distinct writable session starts; no fake accepted coding result is produced.

An additional actual readonly planning workflow uses that nondefault fixed coordinator and retains its selected runtime, configuration and model in the complete planner-session grant across the planner-to-writer handoff.

A task change during the model turn rejects the captured stale context without another model correction turn. Failure committing an already observed valid plan creates no `plan.rejected`, retained plan, fresh writer or worker dispatch. A separate race holds the successful plan-command response after commit, commits cancellation and then releases the response: the durable planner handoff remains cleared, no writable writer/worker/next turn/result acceptance starts, and execution records interruption.

The actual File dispatcher reads the named accepted assignment after later team/library edits and uses the retained original role/resource/path grant and staged material reference. `tests/worker-envelope.test.ts` now supplies its required explicit immutable fixture grant, with no production fallback. A new awaited-grant cancellation regression proves the helper saves no dispatch intent, reads no workspace and starts no runtime after cancellation arrives during the grant read.

## Atomicity and indexed reads

The physical rollback test creates a new worker role in the same acceptance transaction, then fails File replacement or a SQLite `plan.saved` timeline insertion after earlier role/plan/assignment/head changes. The SQL callback deliberately catches that physical failure. Sticky failure still rolls back every row/projection/event/receipt. The same command succeeds after reopen when the fault is removed; later canonical replay cannot re-run its callback.

A guarded fixture adds 1,024 noncurrent immutable plan/assignment row copies behind a genuine accepted plan while leaving the current head unchanged. After reopen, the named current-plan/assignment query trace, returned row counts and returned objects match the pre-fixture probe exactly. SQLite `EXPLAIN QUERY PLAN` uses indexed SEARCH operations for head/header and head/assignment lookup. These are inert historical-row fixtures and indexed query-shape evidence, not a production replan writer, throughput benchmark, VM-scan measurement or SQL full-executor claim.

Raw SQL helpers require a synthetic directory prefix, canonical database path and explicit marker. All fixtures use new temporary source directories. No model endpoint, RTX host, original user project or `output/ux/` path is accessed.

## Validation and boundaries

Command: `node --test tests/run-plan-contract.test.ts tests/worker-envelope.test.ts`.

Current independent result: **39/39 passed**, no skips: 22 new planning contract cases and 17 worker-envelope cases (including the new awaited-grant cancellation case). This final focused run includes the complete planner-session grant and selected-coordinator amendments. Test/fixture formatting and `git diff --check` pass. Counts overlap the parent's full suite and must not be summed with it; final integrated/browser gates remain with the parent.

Current task refinement/edited-goal envelopes, continuation attempts, managed/native session and effect journals, production SQL activation, default-none policies, complete paged histories and live-model quality remain outside this test claim. The full synthetic production/browser parity gate belongs to the parent's integrated validation.
