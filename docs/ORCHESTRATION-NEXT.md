# Next bounded orchestration slice

Proposed after the live evaluation on 20 November 2026. This is a plan, not delivered behavior. See [evaluation evidence](EVALUATION.md), [runtime contracts](RUNTIME-CONTRACTS.md) and [architecture](../ARCHITECTURE.md).

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