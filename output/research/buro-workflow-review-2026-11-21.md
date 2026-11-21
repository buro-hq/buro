# Buro: local architecture and workflow review

Date: 21 November 2026. Read-only implementation audit; no model, RTX, credential or original-project access. This note separates observed implementation facts from proposed changes. External research/competitor claims belong to the companion research notes.

## Decision

Keep the modular monolith, runtime/provider adapters and service-owned verification. Reconsider the amount of LLM orchestration required per task. Current evidence does not justify replacing Cordis, splitting the daemon into services, or introducing a second workflow engine.

The promising product hypothesis is that bounded implementation, independent tests/review and targeted repair improve small-model outcomes. The hypothesis is not that more named agents or more conversations improve code. Buro's agreed vision already states this correctly in [VISION.md](../../VISION.md).

## What is structurally sound

| Boundary | Current evidence | Recommendation |
| --- | --- | --- |
| Service owns acceptance | `core/execution.ts:1260` verifies actual workspace/checks; `:1405` combines worker completion, scope, tests and independent review | Preserve. A model's completion note or another model's approval alone must never accept code. |
| Model requests effects; broker executes them | `core/managed-runtime.ts:564` rejects unauthorized tool calls before effects; `adapters/tools/repository-tools.ts:95` omits write/command tools for read-only scopes | Preserve. Small-model simplification should narrow proposals, not relax authority. |
| One managed loop, separate transports | `core/model-ports.ts`, `core/ports.ts`, provider adapters and Cordis composition | Preserve. Framework/library swaps do not address the observed repeated-reading/role-reference failures. |
| Durable accounting and action provenance | `adapters/files/project-run-budgets.ts:33` mutates ledger/project state transactionally; private session transitions are validated before persistence | Preserve cumulative charges, unknown outcomes, frozen scope and old-run behavior. |
| Provider/data boundaries | Frozen model pool and role preferences; remote GPU is an HTTP model endpoint, not a repository execution host | Preserve local-only constraints and explicit allowed fallback routes. |
| Worktree/environment isolation | Actual tools and service checks run against prepared workspaces; private data paths are denied | Preserve. Execution quality depends on reliable tools as much as prompts. |

`core/execution.ts` is currently about 1,524 lines and `core/managed-runtime.ts` about 988. These are extraction candidates, not evidence for a distributed architecture. Extract stage policies/context assemblers behind existing ports while keeping one authoritative owner of run state.

## Current workflow costs and limitations

### The 170-second native result is a forced-team result

The [controlled comparison](../../docs/MODEL-COMPARISON-2026-11-21.md) explicitly requires a distinct worker. Pure Codex runs one completed native turn, whereas Buro runs planning, worker execution, coordinator integration, checks and fresh review. Thus 26 versus 170 seconds is not a clean estimate of unavoidable Buro overhead, nor a same-contract comparison of review quality. Both native arms use `high` effort, and native internal API request/output ceilings are not enforced by the managed ledger.

Production already permits an empty team. Nevertheless, `core/execution.ts:924` always asks for a structured plan, and `:1084` always runs a coordinator integration/implementation turn after dispatch. Removing a separate worker is therefore not the only possible simplification; the initial role-planning and unconditional integration stages also need ablation.

### The production reviewer has not already received the full code

`core/agent-context.ts:28` (`changeContext`) returns path and before/after character counts only. It does not return a diff or full file contents. The production review prompt in `core/execution.ts:1367` explicitly asks the fresh reviewer to inspect the actual diff and relevant source. Repeated review reads are partly a consequence of this input contract, not necessarily irrational model behavior.

[Private-project evaluation details removed.]

### Repair ownership currently loses the worker's useful context

Public-check and review failures are returned to the same **coordinator** in `core/execution.ts:1298` and `:1430`. The actual author may have been another worker. For a narrow owned change, returning concrete findings to that logical executor is a more direct repair path. The coordinator should intervene for changed requirements, dependency/scope conflicts, repeated lack of progress or reassignment.

This does not authorize replaying an unknown action, changing a fixed model, or expanding the author's scope. Known findings and safe task revisions should remain explicit service decisions.

### Context admission is deliberately stricter than actual token usage

`core/request-policy.ts:23` estimates input as serialized UTF-8 **bytes**, plus message overhead. `prepareManagedRequest` requires any injected request policy to retain that exact estimate. A `MODEL_CONTEXT_EXHAUSTED` result therefore proves rejection by Buro's conservative admission rule. It does not independently prove that Ollama physically used all 16K tokens.

Do not rank model capability from these admission failures. A future provider-aware size estimator would need a versioned, tested contract covering chat templates, tools, schemas and continuation; replacing the bound with an optimistic character/token ratio is not a safe fix.

### Context rotation itself has a generation cost

The current policy closes after three tool rounds or 60% conservative pressure, with four lifetime windows (`core/work-segments.ts:36`). Closure is an additional tools-free JSON response. A completed closure can then require another final envelope generation (`core/managed-runtime.ts:782`); Ollama's separate-turn mode also requires a final structured response. These charges are correctly retained, but the policy can spend scarce requests on protocol maintenance without producing a patch.

Treat this as an optimization target for observed progress and handoff packaging. Do not rotate more often by default or reset a request/segment budget on each rotation.

### Role administration burdens a small model

Production asks a planning model to choose/create reusable roles, paths, assignments, runtime IDs and matching step-owner references before implementation. New bounded versions improve tool authority, retry size and team cardinality. The local pilots still expose errors in the metadata protocol before coding begins.

Service-generated identity/reference handles and constrained proposals can retain dynamic specialization without requiring a 4B coding worker to invent and consistently repeat staff/graph IDs. This is a decision-protocol refinement, not a reason to move permissions into an LLM framework.

### The pilot has two budget authorities

The historical live runner adds an outer 24-generation envelope, including diagnostics, while the production run's durable default is 64 requests with a separate review reserve. The reviewer can be stopped by the outer limit despite the inner ledger appearing to retain room. Both guards fail safely, but budgeting the remaining workflow before dispatch would be clearer and more useful.

The new research adapter uses an aligned durable allowance for all roles. Reviewed variants reserve four requests, 8,192 output tokens and eight tools; baseline reserves zero. The global cap is the same, but the allocation of work versus review is intentionally different and must remain visible in reports.

## What the new experiment does and does not establish

The new `core/team-experiment.ts` is a research controller with three variants. It is not invoked by the production command API, has no production acceptance/commit port, and does not remove mandatory production review.

It already explores several concrete improvements:

- Exact initial source is supplied to the executor.
- Planner output is one bounded `WorkerTask`, rather than a staff roster with free role IDs.
- The same logical executor handles at most two shared check/review repairs.
- Each reviewed candidate gets a fresh read-only reviewer, with full verified files/changes/check facts and no browsing tools.
- Test-author proposals occur before implementation and contain bounded data inputs only; a trusted parent computes expected answers and evaluates the candidate in a confined child.
- Checks, revision fingerprints, cleanup, deadlines and model/budget accounting remain authoritative outside model output.

The test-author adapter currently knows the correct queue semantics. That makes generated expectations trustworthy **for this fixed research domain**. It is not a general solution for authoring correct tests for arbitrary repositories. General-project tests remain model proposals, and need their own provenance, isolation and quality controls; they cannot silently replace the protected project checks.

The one synthetic two-module queue case can establish working mechanics and expose defects. It cannot establish product-wide quality gains, robustness across repositories, or an optimal team size.

## Three workflow directions to evaluate

| Direction | Shape | Where it helps | Important limit |
| --- | --- | --- | --- |
| A. Bounded implementation/review/repair | One coherent task author, service checks, fresh critic, targeted repair in the author's logical session | Small local models doing a bounded code change | Still a team cycle. Production keeps independent review. A coordinator need not generate role metadata before every edit. |
| B. Test-led task graph | Coordinator defines typed task contracts/dependencies; tests challenge them; scoped authors execute; integrate only when necessary | Multi-module work or discovery that genuinely changes scope | Service validates graph edits and effects. Keep one writer initially; file nonoverlap alone is not semantic independence. |
| C. Bounded candidate search | Two or three isolated candidates or repair/resample attempts, selected using trusted visible checks, then independent review | A capable small model repeatedly stuck on one implementation trajectory | All attempts consume one global allowance. Keep hidden evaluation cases out of candidate selection. Same-model candidates can share the same errors. |

Recommendation: A is the next production strategy to prove; B should be selected when dependencies/discovery require it; C should remain an experiment until it beats repair at a matched allowance. None requires replacing the core/provider architecture. A small-model system should minimize each agent's cognitive task while retaining external verification and distinct review/test functions.

## Bounded refactoring sequence

1. Finish and measure the isolated three-variant experiment. Keep every failed/stopped candidate in the final oracle comparison.
2. Compare production automatic delegation with forced delegation on the same strong model and acceptance contract. Include a direct executor plus the same external checks/fresh review to separate review value from roster overhead.
3. Extract context assembly, review evidence and repair routing from `ExecutionService`; adopt successful experimental behavior behind a versioned frozen strategy. Preserve old runs. Respect actual runtime capabilities: the managed runtime can enforce a tools-free turn, whereas the current native Codex adapter explicitly cannot; a strategy must not pretend these guarantees are interchangeable.
4. Provide verified code/diff/check packets to the reviewer, with completeness and before/after fingerprint validation. Keep tools as an explicit bounded discovery branch when required evidence is unavailable.
5. Return owned findings to the author. Ask the coordinator to replan only when progress or ownership evidence justifies it.
6. Unify workflow admission with the durable run allowance. Count discovery, closure, serialization, tests and review; do not hide overhead by raising the outer limit.
7. Introduce a context-sizing adapter only after a matched false-rejection study. Do not change the estimator while simultaneously changing model/quantization and then attribute gains to orchestration.

Keep future scheduler/task DAG work separate from provider transports, SQLite migration and UI delivery. The current `PROJECT_BUSY` restriction (`core/execution.ts:299`) prevents concurrent runs; it is a later scheduling concern, not the cause of the present single-run quality/latency result.

## Measurement gates and open questions

- Does fresh review actually catch defects missed by the visible test set, and does the repair improve held-out correctness?
- Does a test author add novel coverage rather than restate the public cases? Track duplicates and incorrect proposed expectations in general-project work.
- How many attempts never edit a source file? Record first-edit latency, repeated identical reads and useful artifacts per request.
- Does coordinator decomposition improve success enough to repay planning/context cost on a 4B or 9B model?
- Does repair in the author session beat new candidate search at the same total token/request/wall budget?
- Compare acceptance rate, false reviewer approval/rejection, model-observed tokens, requests, time per accepted change and tail latency across repeated cases. Unknown native accounting remains unknown, not zero.
- Evaluate multiple bounded real-project defects, features and languages. Keep the frozen hidden oracle inaccessible to model feedback/selection. Passing unchanged baseline cases is not partial implementation success.
- Repeat the same weights/quantization/settings on Mac and RTX before making a hardware-speed claim; changing 4B to 9B changes the model question as well as the hardware question.

These are useful architecture experiments. The present evidence supports preserving the execution/evidence foundation and changing workflow policies incrementally; it does not support claiming that a full agent team is already optimal.

User policy clarification after this research pass: ordinary Buro goals should have no aggregate hard quota by default; hard request/token/time/session limits should be optional user settings. Retaining durable usage/effect accounting does not mean retaining mandatory default resource ceilings. The consolidated proposal and migration caveats are in [ARCHITECTURE-RESEARCH-2026-11-21.md](../../docs/ARCHITECTURE-RESEARCH-2026-11-21.md). Production defaults have not yet been changed.
