# Independent challenge of the next Run slice

Date: 2026-11-22. Baseline: `233bcc8`. Read-only production/test review of the proposed 5A4b3c current-task/refinement slice. No production or test source changed; no live model, native process, RTX, original project or `output/ux/` access. This report is a contract recommendation, not an implementation checkpoint or approval of reduced beta scope.

## Finding: task revisions alone would leave an incomplete consumer

The next slice is coherent only if it moves the actual minimum worker invocation/outcome producer needed by refinement and successful-worker selection. Saving an immutable task revision while retaining `run.agents` as its admission authority would merely split one use case across two independently editable owners.

The dependency is concrete. `workerFailureForReplan` selects the last agent and mutable task, then compares the role/version, observed known failure, envelope task, original paths and scope (`core/worker-recovery.ts:19–58`). `pendingWorkerRoles` scans retained agents backwards (`:82–93`). The actual worker producer writes starting intent before start (`core/worker-assignments.ts:132–152`), binds the returned thread (`:192–202`), records result after scope inspection and event flush (`:210–233`), and permits the known-failure marker only after flush and client release settle (`:242–286`). A SQL test inserting an eligible failure row directly would skip precisely those safety conditions.

Original assignment task is not current task authority. `buildWorkerEnvelope` uses `run.workerTasks` (`core/worker-envelope.ts:148–152`), and refinement narrows only the objective/input set while preserving result and every criterion (`core/worker-recovery.ts:64–79`). Replacing it with immutable `assignment.task` would revive old objectives. Continuations already explicitly choose `original` versus sticky `full-goal` task mode (`core/project-run-attempts.ts:531–537`); a missing mutable task map must not become the new authority for that decision.

## Finding: complete SQL runtime proof has a real session dependency

`RuntimeRouter.prepareStart` reads a whole project snapshot and owning Run (`core/runtime-router.ts:391–392`). Worker admission requires the saved starting agent/session and its frozen role/resource/path decision (`:471–523`). Managed start likewise reads the snapshot and owning Run (`core/managed-session-authority.ts:41–73`). `ExecutionService.completedTurn` persists/settles its pending turn through generic Run updates (`core/execution.ts:430–484`). Current SQL authority cannot run these unchanged consumers without a fabricated Run aggregate.

Consequently, “prove a real routed managed/native SQL worker before migrating its session readers” is a dependency cycle. Do not resolve it by a `getExecutionRun()` assembler, fake known-failure rows, a second usage ledger, or an in-memory-only worker intent that bypasses actual admission. Full routed SQL execution belongs after the required session/effect authority readers and writers are present.

This does not prevent a bounded worker/task slice before full 5A4c. Actual Core worker orchestration can run against narrow task/invocation authority and controlled runtime/turn/workspace ports. The controlled adapter returns observed responses/errors; the production Core producer must perform intent, scope verification, flush/release checks and semantic settlement. This is stronger than direct outcome seeding, but it proves only that actual worker/task use case, not RuntimeRouter/ManagedRuntime SQL adoption, cross-process dispatch or crash-safe external effects.

## Minimum coherent 5A4b3c recommendation

1. Add immutable current-task revisions and an indexed task head linked to the current attempt, original assignment/plan and complete task mode. A bounded execution-input reader supplies the actual envelope builder. Original role/resource/path/check grants retain their existing owners.
2. Give the actual worker invocation producer semantic intent/start/observed-outcome and eligibility writes. Bind each local invocation to exact attempt, task revision, assignment, session and observed thread. Read latest relevant outcome by named head rather than scanning every agent. Preserve the known-failure restriction to a returned typed turn failure, independently verified allowed workspace changes, settled event flush and successful client release. Start failure and unsettled release never authorize refinement.
3. Move actual `runWorkerAssignments` writes and `workerFailureForReplan`/`pendingWorkerRoles` consumers to those commands/readers. The File adapter may maintain the existing public agent presentation from the same commit, guarded against generic callback bypass. The SQL proof exercises the same producer against controlled effect ports with whole-Run reads/writes unavailable. A `Partial<Run>` command or a task interface with no real producer is not completion.
4. Move refinement request/save/completion to semantic commands. Compare current attempt, lifecycle, task revision and exact eligible outcome on each transition. Consume the existing one-refinement allowance before asking the coordinator. Preserve this existing policy for the slice; removing the limit remains part of the later audited default-none change.
5. Preserve canonical receipt replay before latest-state validation. A late response cannot replace a later task head or write into a stopped/canceling attempt. Matching attempt ID alone is insufficient: a stop can occur within that same attempt during awaited workspace/coordinator/release work (`core/execution.ts:1637–1659`). This review identifies a required new contract, not a reproduced same-attempt production race.

Invocation outcome/eligibility records are local observed facts. They must not become a second independently mutable reconciliation or accounting journal. Existing unresolved goal/Run guards continue to block admission; unknown effects never create known-failure eligibility. Durable native/managed effect ownership, complete response/tool-batch/usage transactions and external cleanup recovery remain the following session/effect slice.

If the planned stage explicitly requires the real production RuntimeRouter and ManagedRuntime on SQL, reorder the required narrow session/start/turn grant writers and readers ahead of that proof. Do not claim that a controlled Core producer test meets that stronger gate. The parent should choose and state one of these evidence boundaries before implementation; the bounded worker/task producer boundary above is the recommended next stage.

## Exit proofs for that boundary

- Genuine goal/queue/begin/bind/accepted-plan commands establish authority, then the actual Core worker producer records observed known failure, settled release, refinement and fresh worker completion. No raw insertion of success/known-failure or fabricated complete Run.
- File and SQL both preserve original criteria/result, exact input subset and grants; successful siblings remain reusable only for the authorized current task/goal. Changed goal and reverting old text cannot resurrect an invalid compact task.
- Starting intent is durable before runtime start; failed intent dispatches nothing. Typed start failure, unknown turn, scope violation, failed flush/release and failed outcome commit never qualify for replacement. Failed admission leaves no receipt/event.
- Races cover stop/cancel within the same attempt, new continuation during an old awaited response, two requests/saves, stale task head/outcome/session and receipt replay after later revisions/reopen. Each path either returns its original canonical result or rejects without effects.
- Physical File and late SQL faults, including caught mutation failures, roll back task/invocation head, immutable records, public history, events and receipt together. File COMMIT/OPEN cannot bypass new authority with legacy field edits.
- Named current task/outcome query and returned-row traces remain fixed after genuine older invocations/revisions. Current dispatch/recovery decision making must work with whole-history hydration unavailable. Full File public history may remain a labelled temporary projection until its own cutover.
- Existing complete execution/recovery and browser scenarios remain green. End-of-stage independent architecture/boundary review checks actual consumers and explicitly retained session/effect boundaries.

## Validation

Ran `node --test tests/worker-envelope.test.ts tests/worker-storage.test.ts`: **21/21 passed**, zero skipped, duration 270.194958 ms. Temporary log: `/private/tmp/buro-preflight-next-slice-tests.log`. These existing tests cover current envelope/refinement/storage behavior, not the proposed named SQL task/invocation authority. Source review adds no claim of a newly reproduced production defect. Parent's fresh focused 100-test gate and prior full 1368-test baseline are separate evidence; counts overlap and must not be summed.
