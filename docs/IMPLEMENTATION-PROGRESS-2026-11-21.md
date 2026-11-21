# Execution refactor implementation progress

Authorized sequence: [full project review](PROJECT-ARCHITECTURE-REVIEW-2026-11-21.md), [autonomy policy](AUTONOMY-POLICY-2026-11-21.md), [package boundaries](REUSABLE-AGENT-PACKAGES-2026-11-21.md). The user authorized all stages, five collaborating agents, architecture/code/boundary review, tests, a separate commit and brief report after each stage, then continuation without asking for confirmation.

Baseline: `601f26e`. Existing untracked `output/ux/` is preserved. Original user repositories and the offline RTX host are outside implementation/evaluation writes. Model evaluation uses local Ollama and DeepSeek only when required, with approved synthetic/frozen inputs and no secret logging.

## Stage 1 — revision integrity and recovery

Status: substep **1A complete**, independent architecture/code/boundary review clear within its stated scope. Substep **1B follows**: immutable verification inputs, including transient A→B→A source changes.

Implemented working-tree changes:

- WorkspaceRevision captures an immutable Git tree, HEAD, semantic index and changes from the captured blobs. Acceptance binds check/review/checkpoint to that revision. Checkpoint commits the captured tree rather than staging later working-copy bytes; HEAD CAS uses no-deref to avoid source-branch redirection.
- Owning-run pending turns and required reconciliation survive restart/replacement. Required markers cannot be silently cleared or changed through another project transaction. Known HTTP rejection and confirmed cancellation remain distinct from an unknown response/effect.
- All managed roles privately journal generation intent and normalized response/continuation. Backend errors expose typed unknown outcomes. Native completion and assistant text must be correlated with the actual turn.
- Result application persists intent and a unique dispatch grant before Git. Same-command recovery at the exact target branch/commit settles its receipt; an unobserved dispatched effect is not repeated.
- Observed malformed planning JSON enters the existing format-correction path. Transport/admission/persistence failures do not become format retries. Repair preserves successful workers when the goal is unchanged.

Five agents worked in waves: apply recovery, runtime reconciliation, immutable workspace revisions, independent architecture/code review, independent host/test-contract review. Parent owns orchestration integration, regressions, full validation and commits.

Validation: final full suite **638/638 passed**, build/typecheck and formatting passed. Five agent roles contributed implementation and independent review in waves. Focused counts overlap the full suite and are not summed. [Bounded review and remaining VerificationView contract](../output/research/stage1-verification-view-review-2026-11-21.md).

Known deliberate substep-1A boundaries: before/after equality cannot exclude transient source mutation during a check; immutable verification input is still required for1B. Also, a crash after creating an owned Git checkpoint but before durable Run finalization is conservative/reconciliation-required. No automatic checkpoint recovery is claimed. Existing quota/scope defaults are unchanged until their complete later contract cutover.

## Remaining authorized stages

2. Common AgentBackend/ModelProvider/capability contracts and effective visible autonomy policy; advisory planned paths with explicit strict mode; remove client-name privileges.
3. A pinned TS SDK contract spike: pi-ai/pi-agent-core first, AI SDK transport fallback/control, optional mini backend. Confirm actual package availability and behavior before adoption; use one loop and one host effect authority.
4. Contribution-based Cordis composition, project services/store factory and empty production startup; demo fixtures remain explicit.
5. One transactional SQLite authority, incremental accounting, complete private artifacts and paged context/history; clean pre-release cutover and default-none quotas only after every hidden lifetime stop is removed.
6. Same-writer repair, fresh criticism, complete revision-bound review packets and independently consumable packages proved by a second host.
7. Incremental teams, isolated concurrent runs/capacity queues, accurate attempts/sessions and MCP over the same application API; controlled quality comparisons.

Each stage records actual test/review results and a commit before continuing. Documentation-only research is not evidence that later target behavior is implemented.
