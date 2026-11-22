# Next Run slice: stopped attempts and continuation

Date: 2026-11-22. Implemented contract checkpoint following `1cc24d1` (5A4b3a). Genuine nonaccepted stop/continuation persistence and local attempt scheduling are implemented and reviewed within the boundary below; production SQL activation and release readiness remain pending. File remains the sole production authority; finite limits and the existing ledger are unchanged. [Validation](stage5a4b3b-validation-2026-11-22.json), [architecture review](stage5a4b3b-architecture-review-2026-11-22.md), [boundary review](stage5a4b3b-boundary-review-2026-11-22.md), [contract evidence](stage5a4b3b-tests-evidence-2026-11-22.md). The following text preserves the implementation contract; it is not a claim that later runtime/session/effect owners have migrated.

## Coherent writer boundary

Continuation needs a genuine stopped predecessor. Do not seed a terminal SQL Run or expose an accepted-result test writer. Move actual nonaccepted `ExecutionService.finish` and `resume` together, with a real queue/begin/bind/stop/continue proof. A stop command permits only failed/interrupted/needs-attention; completion and acceptance remain owned by the later real evidence writer. Stop text, issue/error, current state, goal status/link, timeline, public change and command receipt share one transaction. Existing unresolved effects remain unresolved and require attention; generic failure cannot clear them.

The alternative stop-only bridge would need its own immutable stop IDs/current head and a durable legacy continuation command token: current File resume does not yet change the initial attempt ID. A per-initial-attempt unique stop row would break repeated repair/recheck failures. Prefer the actual attempt migration over adding that temporary token solely to make a smaller commit.

## Attempt and context authority

Generalize `RunAttempt` with ordinal, reason and priorAttemptId. A continuation captures an immutable complete context: current goal revision/title/body/criteria, full task text, selected and retained project materials, policy/checks, actual role/resource decisions, workflow/planning/time policy and complete clarification. Current points at the new attempt; admission remains the original ancestry. Do not append another full Run or hydrate prior attempts to decide the next one.

Use explicit workspaceOriginAttemptId and inheritedPlanId/planOriginAttemptId references. Current workspace/plan/assignment readers presently compare their origin attempt with current.attemptId; that equality must be replaced by validation of the new attempt's explicit authorized references. Preserve original immutable records. Changed goals disable inherited compact-task authority and dispatch the complete new goal; unchanged-goal repair retains successful workers. Current refinement still has its explicitly recorded legacy owner until its own task revision writer migrates.

Resume checks the command receipt before current goal/profile/HEAD/busy validation. Otherwise the same successful command can fail or reapply newer configuration on retry. The transaction validates the exact current stopped attempt, latest requested goal/profile revisions, indexed active work and unresolved operations, then appends the new attempt/context, updates current/goal, emits events and stores its canonical result. The actual caller schedules only after commit. File uses its sole existing ledger for budget admission; SQL queue-only proofs invent no usage account or provider observation.

## Execution ownership and scheduling

Actual execution captures its attempt identity before work; a delayed stop/finalization must not settle a later continuation. Compare that identity on every attempt-sensitive semantic transition.

There is an existing scheduling race: nonaccepted finish can commit before the old job releases sessions/environment. Resume then saves queued work while `jobs.has(runId)` makes schedule return; the old promise finally deletes the job without scheduling the saved continuation. After cleanup, schedule a genuinely newer queued attempt by identity. Never auto-retry the same attempt after an unknown external outcome or a failed persistence boundary. Cancellation, service closing and preserved reconciliation still block dispatch.

## Required proofs

Use actual commands on File and SQL, with the SQL scheduler held and aggregate access unavailable. Cover complete original and updated context/grants, immutable initial workspace/plan origins, repeated stop/repair/recheck with monotonic distinct attempts, changed-goal task invalidation, successful-worker retention, foreign origins, canonical replay after later edits/reopen, conflicting command IDs, role/profile/goal races, caught physical write rollback and no failed-command receipt/event. Include older unresolved work beyond a history page and named current-attempt reads independent of total history.

Real File execution must exercise cancellation/stop, restart, revised goal/profile, restore identity and the resume-during-old-cleanup race. A stale original job cannot finish the queued/running new attempt, old cleanup must complete before its dispatch, and no unknown model/tool effect may be repeated. This is not an external dispatch lease or complete session/effect journal; those remain 5A4c gates.
