# Execution refactor implementation progress

Authorized sequence: [full project review](PROJECT-ARCHITECTURE-REVIEW-2026-11-21.md), [autonomy policy](AUTONOMY-POLICY-2026-11-21.md), [package boundaries](REUSABLE-AGENT-PACKAGES-2026-11-21.md). The user authorized all stages, five collaborating agents, architecture/code/boundary review, tests, a separate commit and brief report after each stage, then continuation without asking for confirmation.

Baseline: `601f26e`. Existing untracked `output/ux/` is preserved. Original user repositories and the offline RTX host are outside implementation/evaluation writes. Model evaluation uses local Ollama and DeepSeek only when required, with approved synthetic/frozen inputs and no secret logging.

## Stage 1 — revision integrity and recovery

Status: substeps **1A and 1B complete**, independent architecture/code/boundary review clear within their stated scope. Stage 2 follows.

Implemented working-tree changes:

- WorkspaceRevision captures an immutable Git tree, HEAD, semantic index and changes from the captured blobs. Acceptance binds check/review/checkpoint to that revision. Checkpoint commits the captured tree rather than staging later working-copy bytes; HEAD CAS uses no-deref to avoid source-branch redirection.
- Owning-run pending turns and required reconciliation survive restart/replacement. Required markers cannot be silently cleared or changed through another project transaction. Known HTTP rejection and confirmed cancellation remain distinct from an unknown response/effect.
- All managed roles privately journal generation intent and normalized response/continuation. Backend errors expose typed unknown outcomes. Native completion and assistant text must be correlated with the actual turn.
- Result application persists intent and a unique dispatch grant before Git. Same-command recovery at the exact target branch/commit settles its receipt; an unobserved dispatched effect is not repeated.
- Observed malformed planning JSON enters the existing format-correction path. Transport/admission/persistence failures do not become format retries. Repair preserves successful workers when the goal is unchanged.

Five agents worked in waves: apply recovery, runtime reconciliation, immutable workspace revisions, independent architecture/code review, independent host/test-contract review. Parent owns orchestration integration, regressions, full validation and commits.

Validation: final full suite **638/638 passed**, build/typecheck and formatting passed. Five agent roles contributed implementation and independent review in waves. Focused counts overlap the full suite and are not summed. [Bounded review and remaining VerificationView contract](../output/research/stage1-verification-view-review-2026-11-21.md).

Known deliberate substep-1A boundaries: before/after equality cannot exclude transient source mutation during a check; immutable verification input is still required for1B. Also, a crash after creating an owned Git checkpoint but before durable Run finalization is conservative/reconciliation-required. No automatic checkpoint recovery is claimed. Existing quota/scope defaults are unchanged until their complete later contract cutover.

### Substep 1B — immutable verification input

Status: complete. Final full suite **682/682 passed**, with no skips; build/typecheck, formatting and desktop/mobile production smoke passed. Five agent roles contributed implementation, independent review and the next contract/scope preparation in waves. [Validation receipt](../output/research/stage1b-validation-2026-11-21.json).

The workspace adapter materializes the captured Git tree and its baseline into an independent read-only input, with its own shallow Git metadata and no live repository pointer. Checks write only into explicitly declared output directories; the fresh reviewer receives that same source view and read-only check outputs. Core retains the view/tree/check/reviewer identity before checkpointing the exact captured tree. Managed sessions reject replaced or revoked view grants before further generation/tool work.

Real Darwin sandbox regressions exercise source writes, restore-after-write, rename/chmod/link attempts, live-source reads, writable outputs and prepared toolchains. Trusted Node checks no longer receive their original script directory as a filesystem grant. Their registered entrypoint bytes are pinned before model dispatch, so copying a candidate checker into the view cannot silently adopt an always-pass replacement; arbitrary imported test dependencies are a separate trust boundary. Native review uses an acknowledged named permission profile on start and every turn, never legacy `readOnly` as an equivalent fallback. [Independent review](../output/research/stage1b-review-2026-11-21.md), [installed-client offline permission proof and limits](../output/research/native-verification-policy-probe-2026-11-21.json).

Current boundaries: Linux execution and Docker verification support require separate evidence/implementation. Prepared dependencies are read-only environment inputs, not a claimed immutable dependency snapshot. Live monorepo dependency aliases and submodules reject explicitly. Normal lifecycle cleanup is implemented; complete descendant-process leases and crash-orphan cleanup are not claimed. Existing quota and strict planned-path behavior remain unchanged until stage 2/5 cutover.

Stage 2 preparation is recorded in the [scope map](../output/research/stage2-scope-cutover-2026-11-21.md) and [backend contract map](../output/research/stage2-backend-cutover-2026-11-21.md). These are implementation plans, not implemented behavior or published reusable packages.

## Stage 2 — common capabilities and autonomy

### Substep 2A — capability admission and configured backend instances

Status: complete. Final full suite **707/707 passed**, with no skips; build/typecheck, formatting and desktop/mobile production smoke passed. Five agent roles contributed implementation, independent admission tests and architecture/code/boundary review in waves. [Validation receipt](../output/research/stage2a-validation-2026-11-22.json).

Portable ModelProvider/message/tool/usage contracts now live in `agent/contracts`, are used by production consumers, and compile separately without ambient Node types. Repository ToolScope, Buro sessions and provider transport errors remain application-owned. This is a real type boundary, not a finished neutral AgentBackend loop or distributable SDK.

Registered backends provide explicit immutable capability descriptors. Resources and routes freeze their revision and operation requirements; the router validates those against the actual registered implementation before dispatch. Known preflight failure remains distinct from an unknown error after backend dispatch. Worker feedback requires host-tool lifecycle capability rather than a client label. Native instances have arbitrary IDs and individual model/reasoning settings; managed instances may use the ID `codex`. The historical direct-Codex resume fallback is removed.

Original runtime/thread leases preserve stop and idempotent cleanup after view/configuration revocation. Released sessions need explicit resume. [Independent review](../output/research/stage2a-review-2026-11-22.md).

The new execution record format requires capability and route-admission metadata. Prototype records are intentionally not silently upgraded or resumed; archive old execution state before the operational cutover. Validation uses fresh synthetic state. Advisory scope, read-only planning strategy, common role routing, default-none quotas, plugin contributions, durable SQLite authority and packaged AgentBackend remain subsequent work.

## Remaining authorized stages

2. Common AgentBackend/ModelProvider/capability contracts and effective visible autonomy policy; advisory planned paths with explicit strict mode; remove client-name privileges.
3. A pinned TS SDK contract spike: pi-ai/pi-agent-core first, AI SDK transport fallback/control, optional mini backend. Confirm actual package availability and behavior before adoption; use one loop and one host effect authority.
4. Contribution-based Cordis composition, project services/store factory and empty production startup; demo fixtures remain explicit.
5. One transactional SQLite authority, incremental accounting, complete private artifacts and paged context/history; clean pre-release cutover and default-none quotas only after every hidden lifetime stop is removed.
6. Same-writer repair, fresh criticism, complete revision-bound review packets and independently consumable packages proved by a second host.
7. Incremental teams, isolated concurrent runs/capacity queues, accurate attempts/sessions and MCP over the same application API; controlled quality comparisons.

Each stage records actual test/review results and a commit before continuing. Documentation-only research is not evidence that later target behavior is implemented.
