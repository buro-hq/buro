# Agent subsystem architecture and correctness audit

Date: 2026-11-21. Scope: orchestration, runtime, routing, worker checks, context and segmentation. Source audit plus three controlled local reproducers; no model/API/RTX calls and no user project changes. Root owns the separate full-suite run. Severity distinguishes present defects from selected but unimplemented design work.

## Verdict

The architectural foundation is useful: the host owns workflow and acceptance, adapters own effects, resources are frozen per run, workers have saved scopes, fresh reviewer sessions are read-only, and managed tool intents are journaled. Core has no direct Cordis, filesystem or provider SDK imports. There is no reason to replace Cordis or adopt a new orchestration framework to address the findings below.

Two present P1 correctness gaps should be fixed before extraction or the storage migration: final acceptance does not bind checks/review/commit to one verified revision, and explicit repair can bypass an unresolved previous worker by opening a replacement session. Backend capability/authority parity is another activation gate. The proposed four-package design addresses actual couplings, but those packages are targets, not boundaries already achieved by the source.

## A1 — P1: accepted commit can differ from the verified change snapshot

Evidence: `core/execution.ts:118–187` captures changes and scope before running registered checks, then returns the earlier snapshot. `:1255–1259` stores it as acceptance evidence; `:1366–1367` asks the reviewer to inspect current files; `:1404–1413` accepts using the earlier scope/check result. `:1451` checkpoints without an expected source fingerprint. `adapters/files/git-workspaces.ts:364–375` recomputes current changes and stages them rather than checking equality with the accepted revision.

**Observed with a real temporary Git workspace:** a fake registered-check callback wrote `README.md` outside the allowed `src/` scope during the final check. The run became `completed`, `scopePreserved` remained true, reported changed files contained only `src/code.mjs`, and the accepted commit included `README.md`. This does not require a malicious model or an arbitrary shell tool; a legitimate formatter, test or background process can mutate the workspace.

User clarification after this repro: planned task paths should be advisory by default, with strict scope enabled explicitly. An adjacent-file edit alone is therefore not a default product failure. The P1 is the mismatch between recorded verification/change evidence and committed bytes; that invariant remains necessary in either scope mode. In strict mode, the reproduced missed scope violation is an additional consequence. This report does not require default-strict planned paths.

Minimal direction: give final scope, checks and review a common immutable source/manifest identity. Compare workspace identity before and after checks; freeze the reviewed revision or invalidate approvals on any change. Checkpoint must take an expected identity and fail closed if current files/index/HEAD differ. Stop owned writers and validate registered checks' mutation behavior. Avoid a weak final reread that still leaves a gap between validation and Git staging.

Tests: checks modifying an allowed file and a protected/out-of-scope file; a late edit during review; index/HEAD change; cancellation during finalization. None may produce a completed run for bytes that were not checked and reviewed. An unchanged verified revision should still accept once.

## A2 — P1: explicit repair can replace an unresolved worker without reconciliation

Evidence: `core/execution.ts:387–411` validates budget/status/workspace for continuation but not previous effects. `:549–598` restores the coordinator and calls `dispatchWorkers` with all saved roles. `core/worker-assignments.ts:48–126` opens new worker sessions. `core/managed-runtime.ts:885–900` blocks unknown effects only when that same managed checkpoint is loaded. The unresolved previous worker is not reopened by this continuation path. The stricter `workerFailureForReplan` gate (`core/worker-recovery.ts:7–49`) protects automatic refinement, not the separate user repair path.

**Observed at the host/backend port:** a fake backend retained an unresolved-effect flag and rejected its first worker with `ACTION_RECONCILIATION_REQUIRED`. The run stopped. Explicit repair then created a second worker while the flag remained unresolved, and the run completed. This proves that the host gate is absent. It does not claim to reproduce an actual remote effect being executed twice by Ollama, DeepSeek or Codex.

Minimal direction: persist reconciliation requirements at the owning run/effect journal boundary, not solely inside a replaceable session. Before any repair/replan/replacement, resolve or explicitly contain unknown effects; a generic “continue” is not evidence that the previous operation stopped. Represent known completed, known failed and unknown outcomes separately. Preserve earlier receipts when changing sessions/backends. Redispatch only pending work; current repair also restarts already successful saved roles.

Tests: unresolved worker generation/tool/check survives stop/restart, explicit repair, changed backend and new session ID; no new conflicting effect before reconciliation. Known settled failure may repair normally. A completed specialist is not rerun merely because another role needs repair.

## A3 — P1 activation gate: backend identity substitutes for capability and isolation policy

Evidence: `protocol/resources.ts:85–93` reserves a singleton Codex ID, `:127–130` configures managed runtimes only, and `adapters/files/resource-configuration.ts:81–98` defaults every role to Codex. `core/execution.ts:339–344`, `:862` and `protocol/schema.ts:516–517` select planning behavior by client kind. `core/execution.ts:168–176` requires prepared check isolation depending on whether any selected resource is managed. `adapters/checks/worker-step-checks.ts:110–118` separately admits only managed resources.

The more serious authority difference is concrete: `adapters/codex/runtime.ts:140–146` cannot guarantee tools-free turns; its start implementation does not consume assignment path restrictions; its workspace-write sandbox (`:188–197`) is broader than the managed assignment broker. `adapters/environments/executors.ts:264–266` treats an agent process as a trusted controller and bypasses generic launch confinement. A prompt and post-hoc scope check do not enforce assignment authority.

This is a present asymmetric trust boundary, not a claim of a demonstrated Codex escape. Do not generalize the trusted-controller boolean to mini-SWE-agent or another harness. Implement neutral AgentBackend capabilities and explicit verified confinement ownership; reject assignments a backend cannot execute under the effective policy. Planned paths are advisory by default; actual working-copy/private-data/read-only boundaries and any explicitly strict scope must still be enforced honestly. Check isolation is a host policy for every backend. Any capable backend may fill any role; no client identity gets privileged coordination, broader authority or false accounting/cancellation guarantees.

Tests: same role/lifecycle/authority matrix across capable backends, multiple configured native instances, a Codex-absent host, tools-free refusal before dispatch, adversarial out-of-scope tool request, and check isolation independent of client name. See `backend-parity-review-2026-11-21.md` for the complete parity audit.

## A4 — P2: malformed JSON bypasses the planning correction path

Evidence: `core/execution.ts:260` parses backend text with `JSON.parse`. In planning, `:966–979` awaits this call before entering the candidate-validation `try` at `:978`. Therefore invalid JSON fails the whole run; only an already decoded but invalid plan gets correction. Envelope and review decoding similarly have no typed format-recovery decision.

**Observed:** a fake backend returned malformed planning JSON. The run failed after one planning call with zero `plan.rejected` events. The nominal two-attempt planning loop did not provide recovery.

Minimal direction: keep received text/usage as an observed result and route JSON/schema validation through one typed response-validation policy. A safely scoped serialization correction is different from repeating implementation or an unknown effect. Use progress/recovery/user policy for stopping; do not fix this by adding another arbitrary hidden two-retry lifetime allowance.

Tests: malformed JSON, valid JSON with invalid schema, truncated response, wrong tool policy and unknown transport outcome. Recover only the safely recoverable format case; never repeat an unknown effect to obtain prettier output.

## A5 — P2 target gap: coordination and repair are hardwired rather than replaceable strategies

Evidence: `core/execution.ts:865–1088` always creates a coordinator planning session, performs planning and then asks that coordinator to integrate, including when workers have already completed. `:1290–1302` and `:1420–1435` return check/review repairs to the coordinator. `core/worker-assignments.ts:48` executes specialists serially and releases each session at `:215–216`; the original executor is no longer available for the selected same-writer repair loop. `core/execution-ports.ts:95–168` hardcodes reserved roles and nonoverlapping ownership; plan steps are display/assignment input, not an executed dependency graph.

Impact: every goal pays for mandatory planning/integration, writer context is discarded before repair, and extensions require edits inside ExecutionService. This is consistent with current source and tested behavior (`tests/execution.test.ts:581` explicitly expects coordinator repair), but differs from the selected product target. It is not an import-boundary violation by itself.

Minimal direction: keep a small Buro host state machine with injectable workflow decisions. First strategy: scoped writer → trusted checks → fresh critic → same writer repair. Coordinator plans/decomposes when useful. Separate session creation count from inference capacity and writer ownership. Preserve current one-writer safety until isolated integration is implemented; do not introduce parallel shared-worktree writes to make the team appear more dynamic.

Tests: simple task avoids unnecessary model phases, specialist repairs retain its state, changed revision forces fresh criticism, coordinator cannot self-accept, sequential dependencies may revisit a file only under explicit ownership rules.

## A6 — P2 target gap: context policies expose hooks but still contain terminal assumptions

Evidence: `core/request-policy.ts:23–28` measures serialized UTF-8 bytes plus message overhead. `:65–84` recomputes that estimate and forbids an injected policy from replacing it. `core/managed-runtime.ts:438–451` uses raw messages for segment pressure; `:474–486` later uses provider projection for actual request preparation. `core/work-segments.ts:36–49` fixes three tool rounds, four segments and 60% pressure; `:80–95` carries only six historical receipts with 512-character excerpts. `core/managed-worker-checks.ts:101`, `:153–161` fixes two feedback steps and fails at the segment ceiling.

Impact: customization cannot supply a trusted provider-specific footprint today; raw and projected pressure can disagree; ordinary continuation can fail because it crossed a prototype counter. Original criteria survive through the frozen anchor, which is good, but earlier evidence is archived privately without a generic retrieval/context-view contract.

Minimal direction: one provider-projected request-view identity, explicit exact/estimated/unknown footprint and immutable retrievable history. A context view is a bounded projection, not a destructive journal rewrite. Scheduler yield is durable continuation, not goal failure. Remove aggregate default terminal counters only with the end-to-end admission/storage/recovery cutover; actual request capacity and permissions remain enforced. No “infinite large number” workaround.

Tests: provider projection differs materially from raw history; many context windows/check-feedback rounds; repeated errors with no useful progress; operation IDs across yield; required old evidence remains retrievable without exposing private continuation.

## A7 — P2 contract gap: generation recovery state depends on segmentation

Evidence: `core/managed-runtime.ts:520–521`, `:538` and `:625` create/update a generation receipt only when `session.workSegments` exists. `:885–900` can check an unknown generation only when that optional field was written. Coordination, review and tools-free sessions do not enter segmented-worker initialization (`:367–397`). Run usage reservations are separate from full response/continuation checkpointing.

Impact: new generic recovery cannot truthfully be described as one invariant across all roles merely because segmented workers have a pending-generation marker. This audit did not reproduce a native request replay or lost provider continuation in this path; this is a source-confirmed persistence asymmetry requiring contract/crash tests.

Minimal direction: durable request intent and observed response/continuation identity for every backend session that claims recovery, independent of context segmentation. Unknown generation/usage and unknown tool effects remain distinct. Commit host operation receipts and checkpoint references under the authoritative store boundary; preserve opaque continuation privately.

Tests: crash before request, after provider response but before session save, after usage settlement and before response publication for coordinator, critic and writer; restart must neither invent a completed response nor blindly redispatch an unknown request.

## A8 — P2: evidence completeness promises exceed retained evidence

Evidence: `core/agent-context.ts:3`, `:23–26` and `core/worker-envelope.ts:13` promise full logs remain in the run. `core/runtime-projection.ts:86` retains only the final 30,000 characters of command output. `core/agent-context.ts:30–35` gives a reviewer only path/character counts; `core/execution.ts:1366` delegates actual source discovery to reviewer tools instead of supplying a complete verified packet. Existing tool discovery/diff caps can make rediscovery incomplete, as documented in the constraint inventory.

Impact: a model may search for evidence that was never retained, and review completeness is not represented as a typed fact. The private model checkpoint may contain some tool output, but is not a complete protected check-log artifact with a safe retrieval contract.

Minimal direction: stream full logs to protected artifacts first; bounded model/UI excerpts carry stable references, revision identity and completeness. Build a verified review packet or typed missing-context response. A clipped source/diff cannot masquerade as a complete review. Historical diagnostic content is data, not new instructions or permissions.

Tests: failure appears only in the middle of a long log, long-line/large-file retrieval, more than one discovery page, missing evidence artifact, and reviewer explicitly requesting omitted context.

## Package and extension assessment

The updated four-package target is coherent: neutral contracts include AgentBackend and ModelProvider; managed runtime implements one backend using a provider; model API transports and native/external agent adapters are separate. Codex is an equal adapter, not a special coordinator or fake ModelProvider. Optional mini-SWE integration remains a measured adapter experiment, not a foundation dependency. No adapter gets implicit trusted-controller privileges.

Current `core/model-ports.ts:26–68` combines generic model primitives and Buro ToolScope; `core/managed-runtime.ts:100–175` derives project/run/material/command authority itself. These must be separated through host-issued context/tool/journal ports before extraction. Buro should retain projects, teams, coding workflow, worktree rules, checks and acceptance. Context/editing/workflow policies need explicit registration contracts; adding arbitrary plugin callbacks inside transaction/effect code would weaken the existing boundary.

`core/workflow.ts:23` is a separate pure acceptance evaluator used in tests, whereas production uses `core/services.ts:122` plus procedural gates in ExecutionService. It is not currently an executable plugin/workflow engine. Avoid advertising generic phase composition from the presence of this file. Converge on one explicit production acceptance policy when extracting workflow decisions, with invariant tests independent of any backend.

`tests/boundaries.test.ts:23–42` usefully prevents direct platform/adapter imports from Core and client-to-backend imports. It does not yet prove package API portability, transitive graph constraints, packed exports or backend capability equivalence. Add focused package-boundary tests and an installed independent consumer; no new framework is required.

## Reproducer and validation

Run `node --test output/research/agent-audit-repro-2026-11-21.ts`. The script records the reviewed Git HEAD and SHA256 of source/fixture files in its header. It adapts the existing recovery fixture, uses fake model/check ports with disposable real Git workspaces, and cleans those workspaces afterward. It does not access live models or original repositories.

Observed run: three assertions passed in about 1.7 seconds. **Passing means each vulnerable behavior was reproduced, not that correctness checks passed.** Outputs: accepted commit included unreported out-of-scope README; replacement worker started while the fake backend retained unknown-effect state; malformed JSON failed after one planning call and no correction event. Root may rerun independently. After fixes, convert these cases into proper regression tests asserting rejection/reconciliation/recovery instead.

No production files or existing tests were modified. This report and the independent audit reproducer are new research artifacts. Full-suite results belong to the root review and are not inferred from these three cases.

## Minimal order

1. Fix revision-bound acceptance/checkpointing and owner-run reconciliation gates; add regressions before moving files or changing persistence.
2. Introduce neutral backend capability/authority contracts and remove client-kind security/role branches; keep unsupported assignments blocked.
3. Extract coherent host workflow/validation decisions and recover format errors safely; retain same-writer state for repair.
4. Perform the clean transactional storage/accounting/context cutover and then activate default-none quotas end to end.
5. Extract/install the four packages against independent consumers and compare workflow quality with matched compute. Package moves alone are not progress on the P1 defects.
