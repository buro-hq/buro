# Qwen planning diagnosis and bounded role guidance

Date: 2026-11-22. Baseline: `85ade5b`. The parent authorized the initial read-only diagnosis and then the minimal role-guidance/diagnostic correction with real plan-command regressions. This agent made no live model, RTX or provider requests and did not access original projects or `output/ux/`.

## Exact observed failures

The retained synthetic Ollama trial is `current-synthetic-trials/ollama-buro-capability-selected.json`. Its private checkpoint and File authority are still available under that trial's recorded temporary fixture. The first returned team selects **roleId `worker`, action `reuse`**. The authoritative catalog contains only `coordinator` and `reviewer`. The new worker therefore needs `action=create` with its complete reusable role definition. The service's rejection is correct; mapping the title or the word worker into an existing role would weaken authority.

The old `resolveTeam` error in `core/execution-ports.ts` said only “The selected role is not in the catalog.” It omitted the offending ID and how to distinguish creation from reuse. `planningTurn` listed the catalog and said reuse roles/new roles reusable, but did not explicitly associate the action with membership. This is a model semantic error with an actionable prompt/diagnostic gap, not a connection failure or worker-tool failure. No accepted plan, worker, edit, reviewer or commit exists in this trial.

The second request really was sent with **maxOutputTokens=789**, not the pilot's nominal 2048. Its provider terminal was `length`, returning exactly 789 output tokens. The managed session is configured for 16,384 context and 2,048 output. `prepareManagedRequest` in `core/request-policy.ts:23–55` estimates UTF-8 serialized bytes plus message overhead, then reserves the smaller of the configured cap and context headroom. Reconstructing the request from its actual retained messages and current schema reproduces both allocations exactly:

| Request      | Conservative input estimate | Output cap | Provider-reported input/output |
| ------------ | --------------------------- | ---------- | ------------------------------ |
| Initial plan | 7,764                       | 2,048      | 1,258 / 1,069                  |
| Correction   | 15,595                      | 789        | 2,813 / 789                    |

The estimate is deliberately an upper estimate rather than measured tokenizer usage. This is not an exhausted 24-request pilot or 64-request Run allowance: only four pilot generations, including two diagnostics, and two Run generations were used; the Run budget remains open. The real history growth is a 5,373-byte first assistant plan plus the correction request. `core/managed-runtime.ts:236–251` appends the 1,617-byte JSON schema to each tools-free user message, while the active request separately carries the schema. Both user turns therefore retain textual copies in history.

As a **numerical counterfactual only**, removing the two host-appended prompt-schema suffixes while retaining the separate current schema and all other content lowers the estimate to 11,683 and allows the unchanged 2,048 cap. This is not a production dedup patch. Ollama can receive a full schema in `format`, while DeepSeek requests only JSON-object mode and needs schema guidance in messages (`agent/providers/ollama.ts:177`, `agent/providers/deepseek.ts:117`). A provider-neutral regex deleting arbitrary user content would be unsafe; typed host-owned context/schema provenance or a separately audited tokenizer/context contract is required. Do not divide the byte estimate by an arbitrary token factor or reset/remove prior evidence.

The [sanitized receipt](qwen-planning-diagnosis-2026-11-22.json) retains counts, the exact first role/action and allocations, without raw prompts, private continuation, credentials or the complete generated plan.

## Minimal correction implemented

Only the authorized clarification was changed:

- `core/planning-policy.ts` now explicitly lists existing nonreserved worker IDs for `action="reuse"`; otherwise it instructs `action="create"` with a complete reusable role. All existing scope, fixed runtime, input-bound and service-role restrictions remain.
- `core/execution-ports.ts` names the missing roleId and directs the planner to an existing worker roleId in `Brief.roles` or creation with complete fields. It still rejects the same invalid reuse; no role ID is silently reinterpreted and no missing role is minted before acceptance.

The actual `acceptRunPlan` reader intentionally retrieves only the named roles in the proposed team (`core/project-run-plans.ts:223–232`). Its catalog is not the entire project catalog. The rejection therefore **does not claim to enumerate all reusable project IDs** or add a history/cross-catalog SQL scan solely for diagnostics. The initial prompt has the supplied catalog and can provide that membership hint; the semantic writer retains its narrow authority.

`capability-planning-v1` remains unchanged deliberately: it describes frozen backend mechanics/resource bindings, which did not change. The clarification changes neither strategy nor grants, schema or authority rules. Exact dispatched prompt text is already retained in private session messages. No old prompt strategy, schema fallback or compatibility branch was introduced, and historical records are not invalidated merely to change wording.

**This patch does not fix the 789-token context squeeze or prove Qwen now works.** If the same old 5,373-byte invalid plan were repeated verbatim, the final compact prompt/error add six estimated bytes and the correction cap would be 783 (versus 789 originally). The new team guidance is 177 bytes versus 212 originally; the more precise rejection is 80 bytes including the Error prefix. An earlier verbose draft reduced the cap to 582 and was compacted before final gates. The first request still has the full 2,048 cap. The intended benefit is correct first-plan action selection and precise feedback; live evidence must establish whether that helps. No estimator, schema-history projection, model setting, context size, global quota, worker refinement allowance or history was changed. Testing a stronger installed 9B and a separately declared larger context remains a distinct experiment, not evidence from this patch.

## Regression and validation

Three new cases were first run against old production source and failed as expected: one prompt-membership case and actual File/SQLite rejection-message cases. Log: `/private/tmp/buro-qwen-role-guidance-before.log`.

The corrected tests prove that reserved coordinator/preview IDs are excluded from the reuse list while the complete original catalog/goal/scope remain in the brief. On both authorities the **actual** admitted/begun/bound/planning Run rejects missing `worker` reuse without plan, assignment, current-state, public-event or effect changes. Changing only the proposal action to create then accepts the role and preserves original task/criteria/path/resource grants through reopen. Snapshot and generic document APIs are disabled at this plan boundary. These are real semantic command tests, not fabricated accepted or failed rows, and they make no model request.

Executed `node --test tests/boundaries.test.ts tests/planning-policy.test.ts tests/run-plan-contract.test.ts tests/execution-planning.test.ts tests/request-policy.test.ts`: **64/64 passed**, zero failures/skips, 5741.68325 ms. Log: `/private/tmp/buro-qwen-role-guidance-final.log`. An earlier after-fix set without boundary tests passed 61/61. Changed-file formatting and `git diff --check` passed. Counts overlap the parent's later full suite and must not be summed. No repository commit was made by this agent.
