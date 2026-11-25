# Next bounded orchestration slice

Agreed after the live evaluation on 20 November 2026. Compact tasks, request policy, one known-failure refinement, a durable aggregate managed-API run budget, managed-worker context segments and a sole-worker check-backed feedback loop are implemented. Persistent data grants, multi-worker check ownership and Java candidate confinement remain proposals. Native-client API accounting and a whole-workflow deadline remain separate contracts. See [implementation status](IMPLEMENTATION.md), [evaluation evidence](EVALUATION.md), [runtime contracts](RUNTIME-CONTRACTS.md) and [the reviewed execution plan](EXECUTION-PLAN-2026-11-20.md).

## Immediate priority

Make a strong coordinator and small local worker complete short, independently verified assignments. DeepSeek passed the synthetic direct route; Qwen3 4B exhausted output in a mixed worker turn and context in an all-local coordinator route. More installed models or a passing tool probe alone do not resolve these failures.

Start on synthetic repositories. Give a worker one bounded edit, explicit inputs, expected output and a request/token/tool/time budget. Keep a stable task envelope separate from intermediate commentary. Return only a compact outcome plus evidence references. Measure accepted changes, observed usage and failures against the current single-model reference before expanding to source-derived cases.

Core owns bounded replanning, permission checks, shared budgets, durable dispatch and acceptance. Cordis plugins supply policies/adapters through ports; they do not start a second workflow engine.

## Extension boundaries

| Concern                         | Existing boundary                                          | Proposed extension                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model protocol and context view | `ModelProvider`, `contextMessages`                         | Provider token estimates and explicit bounded request views. Preserve unresolved tool calls, required continuation and final results. Raw durable history remains available.                                                   |
| Worker/model choice             | `RuntimeSelection`, runtime registry                       | Task-specific capability evidence, compact assignment proposals and a reasoned choice within the saved resource pool.                                                                                                          |
| Recovery                        | Core workflow and managed action journal                   | One bounded replan after a classified known failure; all attempts consume the same run budget. Unknown tool/generation outcomes require reconciliation rather than automatic replay.                                           |
| Data disclosure                 | Resource profile currently distinguishes local-only/hybrid | Proposed `DataAuthorizationPort`: a versioned user grant names project/data scope, recipient, purpose and run scope. Validate before dispatch and before adding source/material context. Credentials do not supply this grant. |
| Project verification            | `CheckPort`, environment executors                         | Stack-specific check adapters and pinned toolchains with verified confinement. Java remains unavailable until its candidate boundary is established.                                                                           |

The evaluation runner's separate source-transfer opt-in is a narrow harness guard. A persistent domain/UI authorization model is future work; do not present the flag as that implementation. A coordinator or plugin cannot authorize disclosure on the user's behalf.

## Small first implementation

1. Version a compact assignment envelope with bounded file inputs, required evidence and expected result. Validate it in core before dispatch; persist the selected runtime and reason first.
2. Prepare requests from that envelope and actual remaining budget. A provider estimate can improve planning, while the final guard stays conservative. Avoid increasing local context automatically on the 16 GB host.
3. Classify incomplete output, context exhaustion, unavailable checks and quality rejection separately. Permit one explicitly budgeted new assignment when the previous outcome is known; preserve unknown outcomes for reconciliation. No silent cloud fallback or overlapping replacement workers.
4. Verify with deterministic tests for budgets, saved selection, restart, cancellation and no replay, then repeat the bounded mixed synthetic goal. Acceptance requires real edits, independent service checks and fresh review.

Connection readiness, tool/JSON mechanics and successful performance as coordinator/coder/reviewer are separate observations. Evidence is scoped to model, adapter revision, configuration, hardware and task class. A single successful goal is not a general quality score.

[Private-project evaluation details removed.]

## Short work segments inside one agent

[Private-project evaluation details removed.]

Use one logical worker/session identity and stable Router `B → M` mapping. Managed model APIs are stateless, so a fresh conversation window can be a new segment within the same managed session. Preserve its role/model/scope, cumulative request count and complete action journal. Keep earlier messages and required provider continuation in private archived segments; do not expose private reasoning in a handoff.

The pure `WorkSegmentPolicy` is supplied through resource/Cordis composition. Its initial worker policy closes after three tool rounds or conservative context pressure, with at most four windows over the session lifetime. Core validates transitions against the original workspace baseline, retains the same model/assignment and cumulative budgets, and builds a handoff from frozen instructions/task plus bounded actual tool receipts. The model's next-task proposal remains untrusted. A typical next feedback path is a small edit, trusted check, then a fresh focused segment for a specific failure. Avoid imposing a fixed number of steps when the work is already complete.

Core builds each handoff from frozen objective/criteria, the proposed next task, a verified current diff hash, completed action receipts and references to actual check evidence. Model summaries alone prove none of these facts. An action with `pending` or unknown outcome, cancellation, failed scope inspection or failed persistence prohibits automatic rollover. Required tool-result/continuation chains must finish before a conversation window is retired.

Two implementation gates:

1. Add a durable shared production-run ledger and segment protocol. Coordinator, workers, refinements and review share request/output/tool/time ceilings. Reserve enough for mandatory final verification/review before coding consumes it. Do not reset `session.requests`; conservatively reserve before HTTP and retain unknown usage. Smaller per-step output caps improve allocation without increasing the total ceiling.
2. Add managed conversation windows with an atomic archive/handoff checkpoint before the next HTTP request. Separate step completion from logical agent completion in runtime events and UI projection. Start with managed providers; native-client session rotation requires a distinct capability/contract and remains unsupported initially.

Deterministic checks must cover stable routing/identity, criteria and scope preservation, no replay after unknown outcomes or restart, cumulative budgets, reserved review capacity, failed checkpoint preventing dispatch and step events not completing the logical worker. Compare identical synthetic and source cases under identical total ceilings; more short sessions can increase input overhead and request count.

Current evidence: 412 default tests pass. A DeepSeek synthetic route with a two-round diagnostic policy completed one rotation, service checks and fresh review in 16 requests. A mixed DeepSeek/Mac-Qwen Instruct trial rotated once but the worker claimed absent edit permissions despite receiving `edit_file`; it made no edit and was not accepted. One-round experiments hit the window cap while repeating initial reads. This motivates verified feedback next, not larger budgets or a claimed small-model quality improvement. The RTX machine was not contacted during these tests.

The subsequent check loop passes 465 default tests. Buro runs the frozen registered checks on a sole managed worker's terminal work response, persists intent/results privately and can create up to two core-owned feedback windows inside the same four-window/session/turn/run ceilings. Invalidated, unavailable and unknown checks never become ordinary repair evidence. The shared check dispatcher requires prepared private isolation for worker checks and managed baseline/final verification, including optional managed resources in a native-default pool. DeepSeek again reached acceptance/fresh review in 17 requests; Mac Qwen consumed two actual failed-check feedback steps and stopped without an accepted edit. These bounded trials do not establish small-model quality improvement. Public check-state presentation remains a separate UI follow-up.
