# Stage 5A4: real Run admission, current state and journal

Date: 2026-11-22. **Read-only implementation proposal** against the working 5A3c tree. No production sources, user projects, model endpoints or credentials changed. Current production remains the sole File authority; the SQLite kernel is not a live execution sidecar. Finite policies and current repair/context limits remain unchanged until 5C.

Implementation checkpoint: 5A4a is committed as `a169551`, 5A4b1 as `de0e71f`. The latter migrates actual initial/continued execution activation and phases. 5A4b2 adds immutable observed workspace binding, its real prepare/restore consumers, cancellation retention and acquired-path cleanup, with independent File commit/open/replay proof. See [progress](../../docs/IMPLEMENTATION-PROGRESS-2026-11-21.md) and [latest validation](stage5a4b2-validation-2026-11-22.json). This does not complete 5A4b: plan, assignment, continuation, finish and runtime observations still need their actual consumers; 5A4c/5A4d and production SQL cutover remain pending. Workspace preparation still lacks durable pre-dispatch ownership and crash-orphan recovery. The proposal below is retained as the full target contract.

Following `33c3c96` (5A4b2), 5A4b3a migrates initial accepted plan/original assignments and the actual planning writer/named dispatch-grant reader. It captures complete context and actual coordinator role/resource, seals a real File read-only planner grant, and protects exact event replay/ancestry. [Latest validation](stage5a4b3a-validation-2026-11-22.json): 1311 tests plus browser/build gates. One initial plan per Run is implemented; compact-task refinements, continuation attempts, stop/finalization and session/effect authority remain later owners. SQL read-only handoff explicitly rejects until actual SQL session ownership exists. Continue from the [stopped-attempt/continuation proposal](stage5a4b3b-attempt-continuation-plan-2026-11-22.md), including the real stop predecessor and resume-during-cleanup race; do not fabricate SQL terminal/accepted Runs to skip those dependencies.

Following `1cc24d1`, 5A4b3b implements genuine nonaccepted stops and continuation attempts together, with immutable complete contexts, explicit inherited workspace/plan origins, exact public replay and local attempt ownership. Scheduler tests cover resume/cancel during predecessor cleanup and old cleanup failure; cancellation receipt replay cannot abort a newer job. File remains the sole production authority/ledger; standalone SQL v8 proofs hold scheduling and never synthesize a whole Run executor. [Latest validation](stage5a4b3b-validation-2026-11-22.json): 1368 tests, build/typecheck and 37 browser scenarios plus production smoke. The saved [attempt contract](stage5a4b3b-attempt-continuation-plan-2026-11-22.md) is implemented within its stated boundary. Next are current task refinements and durable runtime observations/indexed owner/dedup, then actual session/effect/accounting and acceptance/result/apply writers. Default-none and production SQL cutover remain gated.

## Decision: move the minimum 5B contracts forward

Implement typed current state, separate append/settle history and cursor reads **before** moving the execution writer to SQLite. This is the necessary part of 5B to avoid storing/hydrating a growing `Run` as authority. Full UI pagination can follow in a separate consumer slice; do not block the initial genuine queue writer on a complete inspector redesign, and do not claim full 5B completion merely because SQL can page events.

Do not create an `acceptedRun` test-write method to unblock Git application first. Acceptance depends on actual check/review/workspace evidence and pending-effect state. The next small writer should be the real queue/admission and cancellation use cases already called by `ExecutionService.start/cancel`. Accepted result reading and Git apply follow the real acceptance writer later.

## What the actual code requires

`core/execution.ts` has four direct document transaction sites: `start`, `resume`, generic `update`, `cancel`. The generic update callback is the real large surface: planning, worker dispatch, runtime observations, environment/check results, review, acceptance, failure and cancellation all mutate it. Replacing four textual calls is not a complete migration.

Current observations call `applyRuntimeEvent(run, ...)`, append agent messages and run events, find/update commands inside the whole Run, then write a `run.changed` event containing that Run. `observe` scans every project's snapshot to find `event.runId` and deduplicates through an in-memory lifetime `seen` set. The native child visibility path adds undeclared child agents, but it must continue to grant no assignment authority.

`completedTurn` saves `pendingTurn` before dispatch and retains monotonic reconciliation on unknown failure. Worker dispatch saves a starting agent/session grant before runtime start. Read-only planning acceptance atomically clears `threadId` and moves its planner session before the fresh writer starts. Acceptance verifies exact tree/check/reviewer/scope evidence before setting commit, execution head and goal status. These are semantic transactions to preserve, not arbitrary field patches.

Additional consumers currently obtain authority from `snapshot().runs`: `ManagedSessionAuthority` start/resume/workspace/budget-owner validation; `RuntimeRouter` frozen role/resource/operation/view admission; `ResultService` preparation and recovery; `ProjectApplication.apply`; worker-envelope/recovery/context helpers; effective-policy projection and plugin snapshot hooks. They must migrate before deleting the aggregate. Public file event delta packing currently excludes only events/agents/commands from scalar fields; it does not make attempts, delivery history or nested agent messages incremental.

## Exact field separation

| Existing Run data | New owner/current reference | Reason |
| --- | --- | --- |
| `id,key,goalId,parentRunId,title,status,phase,createdAt,updatedAt,completedAt,cancelRequested,delegation` | `RunCurrent` scalar row | Actual lifecycle facts; no history arrays |
| `summary,result,goalText,continuation.instructions` | Immutable complete text artifacts plus a labelled public excerpt; current references | Strings can be large; original criteria/task must never be truncated into authority |
| `workflow,executionPolicySnapshot,planningPolicy,timePolicy,repairEnvironment,checkIds,resources` | Immutable `RunAdmission`/attempt policy and selected-resource grant rows, current admission/attempt ID | Frozen identity and user policy, not mutable UI state |
| `contextMaterials` | Immutable material-grant reference rows for the admitted task/attempt | Removal from the active library cannot revoke historical authority; no library-sized JSON list in each update |
| `roleSnapshots,roleOrigins,roleResources` | Immutable role-version references and operation-specific role/resource grants | Retain content/provenance and pinned decisions, not latest team defaults |
| `roleAssignments,assignmentResources,workerTasks,workerReplan` | Per-assignment scope/task revisions and grant rows; current plan/assignment pointers | Maps accumulate across work; a replan is a new decision, not overwriting old evidence |
| `plan,planSavedAt` | Immutable accepted plan header and step rows; `RunCurrent.planId` | Current plan retrieval is separate from correction history |
| `threadId,coordinatorSession,planningSession` | Current coordinator/planner session IDs, referencing immutable session grants | A read-only planner cannot become the writer after restart |
| `agents,resultAgents` and each `Agent.messages[]` | Per-agent/session headers and indexed messages/events | Both agent count and nested messages can grow; latest role assignment is an indexed query |
| `events,commands` | Append-only timeline and command rows; full command output artifact references | Neither an array append nor an output tail is complete durable evidence |
| `attempts,deliveryHistory` | Immutable attempt and delivery-attempt rows | Resume appends history; it must not copy all prior attempts every time |
| `workspace,baseCommit,baseBranch,sourceHash,commit` | Workspace binding and accepted-revision references with scalar identity | Preserve original tree/base/branch; commit alone is not acceptance evidence |
| `changedFiles` | Revision-bound change-set manifest, per-file metadata and complete before/after artifacts | Current diff may contain many files and complete source content |
| `baseline,acceptance,review` | Check-set/review receipt rows and full output/finding artifacts; current IDs | Avoid growing/large check and finding payloads in lifecycle updates |
| `verificationView,verificationEvidence,scopeObservation` | Host-issued view/evidence/change-set records referenced by exact revision | Acceptance needs the same tree/check selection/fresh reviewer and actual additional paths |
| `pendingTurn,reconciliation` | Effect/journal authority with indexed unsettled state; bounded Run stop projection | Once the journal is active, do not create a second independently editable unresolved marker |
| `delivery,preview,operationContexts,operationResources` | Separate preparation/delivery/preview owners and frozen operation grants | A failed/unknown preparation must not unaccept completed coding work |
| `appliedAt,appliedBranch` | Application effect receipt and bounded applied-result projection | Git prepare/dispatch/settle remains its own owner |
| `managedBudget,effectivePolicy,stop,issue` | Bounded derived projection from actual usage, frozen grants and unsettled effects | Useful display state, never a replacement admission grant |

Do not define `RunCurrent = Omit<Run, 'events' | 'commands'>`: that retains most growing data. Nor should `getExecutionRun()` silently assemble all historical agents/attempts/messages for decision making. Query exact current assignment/attempt/grant and explicit evidence needed by the operation.

## Next bounded implementation: 5A4a real admission and cancellation

Extract a small `RunCommandService` actually used by `ExecutionService.start/cancel`, or equivalently move those two methods directly onto a required `.runs` facet. Keep post-commit scheduling in ExecutionService. The commands synchronously transact over the same project authority and indexed reads:

- load the named existing goal and current profile revision;
- reject indexed active project work and any older unresolved operation for that goal, including rows outside the visible page;
- ensure only missing coordinator/reviewer roles through narrow role reads/appends, preserving user roles/preferences;
- capture the exact complete goal/task, material grant, workflow, checks and resource/role decisions;
- insert a genuine queued Run and first attempt/current admission, link the goal to the Run, append the queued timeline item and public change, and store the canonical command result atomically;
- cancellation reads the named Run, atomically marks nonterminal work canceling, appends its timeline item and receipt, then the caller aborts the acquired live job after commit. A retry never creates another Run or cancel event.

The public command facade should expose semantic `admit`/`requestCancel`, plus exact `current(id)`, `activeRuns(page)` and `unresolvedForGoal(goalId)` reads. Do not add `putRun`, `Partial<Run>` or a generic mutable document callback. Adapter-only storage inserts/updates known scalar lifecycle and frozen grant rows; it cannot declare acceptance.

The initial SQL proof uses the **actual** Core admission/cancel service against a real goal/role/settings/material authority, with dispatch held at the scheduler boundary. It proves genuine queued Run persistence, goal linking, same-command replay, cancellation and reopen, not successful coding or accepted status. Production still runs the same commands through its sole File bridge until the rest of the executor is migrated. No SQL authority is dual-written alongside an active JSON project. Do not enable the full legacy executor against a SQL queue by fabricating a whole-Run snapshot.

Four dependencies need deliberate extraction in this first slice, not hidden fallbacks:

1. `WorkflowRoleResolver.ensureRole(doc)` currently scans `roleVersions`. Give its actual shared role-minting helper a narrow role lookup/append port; the File document wrapper may temporarily delegate, while new Run admission uses the existing entity transaction. Templates still choose content only.
2. `goalMaterials(doc, goal)` currently scans the material library. Capture references through indexed active-project/current selected-material reads or an adapter `captureMaterialGrant` insertion, without copying navigation history. Current finite 64-active policy remains, but page/grant structure must not make 64 a permanent storage ceiling.
3. `RuntimeSelection.forProject()` currently calls a whole snapshot for the profile override. Resolve a captured explicit profile/override through the same trusted installed resource catalog, and compare the expected project-profile revision inside admission. Machine resource snapshots are copied into the project; there is no cross-database spending/config transaction claim.
4. Current start also creates the legacy managed budget ledger. Preserve one accounting authority: the temporary File bridge retains its existing sole ledger until runtime/journal migration, while the standalone SQL Run records the same explicit finite policy and uses the new usage account only when its new dispatch path is adopted. Do not create a mirrored new usage account beside a live File ledger, or silently route old runtime writes into both. If the first slice cannot preserve that ownership clearly, keep the accounting initialization in the unmigrated File execution path and label the SQL admission proof as queue-only.

## Concrete records for the first writer

```ts
type RunCurrent = {
  id: string; goalId: string; revision: number;
  admissionId: string; attemptId: string;
  title: string; status: 'queued' | 'running' | 'canceling' | 'completed' | 'failed' | 'interrupted' | 'needs-attention';
  phase: 'queued' | 'preparing' | 'planning' | 'implementation' | 'checking' | 'review' | 'repair' | 'done';
  cancelRequested: boolean; createdAt: string; updatedAt: string; completedAt?: string;
};
type RunAttempt = {
  id: string; runId: string; admissionId: string; ordinal: number;
  reason: 'initial' | 'repair' | 'recheck'; createdAt: string; priorAttemptId?: string;
};
type RunTimelineEntry = {
  runId: string; sequence: number; at: string; type: string;
  assignmentId?: string; textExcerpt?: string; completeTextArtifactId?: string;
};
```

These are distinct current/journal entities, not an adapter serialization of Run. The first commands can create only an initial queued attempt and request cancellation; the wider status vocabulary does not create an acceptance-write API. `RunAdmission` is an immutable row linking the complete task artifact and captured profile/workflow/resource/material/role grants, with a known per-field schema. Later commands add workspace/evidence/session references as those actual consumers migrate. Excerpts are explicitly display-only; retrieval of the complete required task is mandatory before model work. No arbitrary `metadata: JSON` escape hatch stands in for the remaining growing fields.

## Storage/history contract to introduce with that writer

Use `run_current` (scalar lifecycle and references), immutable admission/attempt/task/grant tables, `run_timeline` and an indexed active-run/unresolved index, all in the existing authority database and command/event stream. A queue insertion links a real goal row. Retained/deleted goals can remain tombstones, as established by the entity layer; they must not break accepted parent/history references later.

A small read contract is sufficient now: `current(runId)`, `timeline({runId,after,limit,watermark?})`, `attempt(id)` and role/material/grant-by-ID reads actually consumed by admission/recovery. Later message/command/evidence pages share the same cursor rules. Cursors bind project, Run, filter and watermark; use keyset sequence, not offset. A page-size limit is not a lifetime execution cap.

A first read consumer can be the current Run list/agent timeline pane or its Core query used by the existing UI. Do not switch all UI state to a fabricated complete Run. The File adapter may temporarily retain the old public snapshot/event shape for existing UI consumers, explicitly as a read projection; new Core admission and future SQL runtime cannot use it as authority. Full client snapshot/replay/live pagination must land before deleting that public aggregate or enabling unrestricted histories.

## Following coherent slices

**5A4b executor state commands:** replace generic `update` callbacks and synchronous whole-Run `get` with specific current reads/writes for workspace preparation, phase, plan acceptance, worker assignment, attempt continuation, failure/finish and runtime observations. Migrate `runWorkerAssignments`, worker-recovery/envelope and runtime projection with them. Replace in-memory `seen` as the durable dedup authority with unique `(source session/runtime,eventId)` journal receipts; an unsuccessful transaction must still permit redelivery. Lookup Run owner by indexed binding, never a scan of every project snapshot.

**5A4c session/effect/accounting transaction:** actual native routes, managed headers, turn/scope grants, normalized generation response, usage operation/counters, whole proposed tool batch, worker-check and per-helper command receipts move together into the same authority. Preserve SDK host batch order/once gates and original acquired adapter lease for cleanup. Store complete private message/continuation/output artifacts separately from bounded active context. The new journal is the only unresolved-effect authority; generic failures cannot clear prior foreign pending rows. Known preflight rejection, observed invalid response and unknown dispatch stay distinct. Opaque native calls remain unknown usage, never zero or one invented provider request.

**5A4d real acceptance/results/apply:** write actual immutable view/check/fresh-review/scope evidence linked to one workspace revision, then an acceptance command atomically sets accepted commit, goal status and execution head after checking no cancellation/unknown effects. Only then expose a narrow `acceptedResult(id)` reader and move ResultService preparation and Git-apply prepare/dispatch/settle away from the document. Do not seed a fake accepted result in production APIs to move this slice earlier.

These are not a new DAG or scheduler. They are the current use cases with bounded persistence capabilities. Each slice gets real Core consumers and its own source-boundary review; do not expose every future method as an unused interface at 5A4a.

## Proof and deletion gates

First-slice tests must cover two concurrent admissions (one active winner under current semantics), goal edits/role pin edits while resolving admission, conflicting command reuse, older unresolved Runs beyond the first page, complete original task/material grants, queue/cancel/reopen, failed commit publishing nothing, and no runtime/provider/check effect merely from a page/read. Query instrumentation must show work independent of historical Run/event count. Test current queued rows rather than raw test-only accepted Run inserts.

Before full SQL execution adoption, run synthetic real managed/Pi and native-adapter workflows on that authority with crash boundaries at session start, turn intent, observed response/usage commit, all-action batch commit, each command receipt, context rotation and workspace checkpoint/acceptance. No provider re-call after a retained response; no unknown effect auto-replay after process death. Keep finite policies through this work.

Delete the old aggregate and activate production SQL only when: every execution/router/session/result/apply/research grant consumer can run with `snapshot()` and generic document `transact()` unavailable; no SQL column contains a whole growing Run/ManagedSession/history map; public clients page complete history with a tested replay/live handoff; active model context remains bounded while all private history is retrievable; retained material/task/evidence references survive library removal; and command receipts, usage, effects, state and public events roll back/commit together. The temporary File facets and old JSON authoritative writers then leave the active composition, not a permanent fallback. 5C default-none/hidden-stop removal remains gated on those properties, not on the existence of a SQLite file.
