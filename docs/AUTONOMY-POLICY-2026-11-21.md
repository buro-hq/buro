# Autonomy, visible policy and recoverable stops

Date: 2026-11-21. Status: selected policy, partly implemented as recorded below. The user wants maximum useful automation with an easy way to intervene, no default aggregate budget, equal backend adapters and optional strict task scope. This document supersedes default-strict planned-path assumptions in earlier design notes.

Implementation update, 2026-11-22: the WorkScope slice is implemented: advisory planned paths by default, optional strict managed writes, revision-bound observations and preserved scope across context changes. Aggregate quotas and the broader resolved-policy/stop-action contract remain target work. [Actual implementation progress and validation](IMPLEMENTATION-PROGRESS-2026-11-21.md).

## Selected default

A goal runs autonomously through implementation, trusted checks, fresh review and repair. Buro can select a permitted model, reuse or create role assignments and change the active context view without asking the user for every routine step. User-approved model/data/tool policy remains the boundary; a model cannot expand that policy by proposing a role.

There is no default lifetime request/token/time/repair/session quota. Usage remains observable. Planned files are **advisory by default within the run's working copy**: a necessary additional edit is recorded and reviewed, rather than automatically rejected. The user can enable **“Forbid changes outside the selected scope”**. Store the actual scope mode, paths, policy revision and origin with the run; do not merely relabel the current mandatory allowedPaths field.

The checkbox controls planned task scope. It does not turn a worker into an unrestricted host process, grant another model endpoint or make a reviewer writable. Buro must still know which actual revision was checked, reviewed and saved. This is relevant even in a fully permissive working-copy scope: accepting different bytes is a correctness failure, not an autonomy feature.

## Overrestriction inventory and treatment

These are layered examples from the [79-group inventory](../output/research/buro-constraints-inventory-2026-11-21.json) and the full audit; not every rule is a defect to delete.

| Current behavior and source | Effect on autonomy | Selected treatment |
| --- | --- | --- |
| Run64 requests; turn24; session256; `protocol/run-budget.ts`, `protocol/resources.ts` | A goal can stop before its critic despite useful progress | No aggregate cap by default; explicit finite policy only; show actual and unknown usage separately |
| Four worker windows, three tool rounds, two check feedbacks; `core/work-segments.ts`, `core/managed-worker-checks.ts` | Context management becomes a lifetime failure | Bounded active views and cooperative continuation; no hidden lifetime window/repair quota |
| Planner has two attempts, but malformed JSON can fail after one; `core/execution.ts:260`, `:966` | Recoverable output formatting becomes a terminal goal failure | Typed format recovery; change context/format/strategy within policy; observed output is not an unknown external effect |
| Mandatory planned path enforcement; `core/execution.ts:118`, `core/execution-ports.ts`, `adapters/tools/repository-tools.ts` | A useful adjacent edit is forbidden | Advisory task scope by default, strict opt-in; display additional changed files and their reason |
| A project with `src/` defaults to allowing only `src/`; discovery reads a small Node script list; `adapters/files/project-manager.ts:185`, `:205` | Tests, package configuration and other ecosystems need manual correction before useful work | Project-analysis/check-recipe contributions; suggested task paths are advisory, generated checks are validated by the service rather than self-accepted by a worker |
| Team max2, serial dispatch; `protocol/execution.ts:31`, `core/worker-assignments.ts:48` | Model cannot create the specialists it needs; UI calls task count concurrency | Incremental validated tasks/roles; inference capacity and writer ownership are separate queues |
| Coordinator and critic models fixed by profile; worker-only role preferences; `core/services.ts:101`, `src/components/organisms/TeamPanel.tsx:23` | An arbitrary role catalog distinction limits routing | One role/assignment selection policy for any eligible backend; explicit user Auto/Prefer/Fixed remains honored |
| Client-name planning/check branches; `core/execution.ts:168`, `:339`, `protocol/schema.ts:516` | Changing backend changes host workflow semantics | Common AgentBackend and capability-based requirements; no Codex privilege or false capability parity |
| Mandatory coordinator planning/integration and repair; `core/execution.ts:865`, `:1290`, `:1420` | Extra calls and loss of original writer state, even for small work | Replaceable Buro workflow; writer/check/critic/same-writer repair, decomposition when useful |
| One nonterminal run per project; `core/execution.ts:299`, `:406` | An idle or model-waiting run blocks unrelated goals | Independent run worktrees, per-endpoint inference queue and serialized application to source branch |
| Project-wide configuration/apply busy guards; `adapters/files/project-manager.ts:473`, `:664` | User cannot prepare future configuration while another goal waits | Revisioned configuration for future assignments; active runs keep frozen versions. Protect only the actual resource/branch conflict |
| Saved connection edits require restart; `adapters/resources/runtime-resources.ts:245`, `:350` | New goal may be blocked by a settings edit | Show active and pending revisions; allow deliberate new connections/revisions without silently changing an owned session. Live hot reload is optional |
| UI repair requires nonempty clarification; `src/components/organisms/RunRecoveryPanel.tsx:215` | Human must invent text even when the failure is already known | Continue known recoverable work without mandatory prose; optional clarification is a separate input |
| Reads reject entire files >256000bytes; search/diff lack complete paging; `adapters/tools/repository-tools.ts` | Agent cannot discover/edit required code despite available model capacity | Range/streamed reads, paged search and diff, hash-fenced edit formats and typed move/delete operations |
| Managed commands only use registered check recipes; `core/managed-runtime.ts:151`, repository tool definitions | Exploratory verification may be inexpressible while another backend has a shell | Separate trusted acceptance checks from sandboxed exploratory tools; host-issued execution authority, common capabilities and observable actions |
| Byte estimate cannot be replaced by an injected request policy; `core/request-policy.ts:65` | A nominal16K/32K model can be stopped conservatively much earlier | Trusted provider-projected footprint contract; distinguish estimate from measured token count and rotate context before a genuine capacity failure |
| Idle timeout, command schema15min, UI overwrites check timeouts; `protocol/domain.ts:61`, `protocol/projects.ts:8`, `src/components/organisms/ProjectProfileForm.tsx:43` | Healthy inference/check/setup can be mislabeled as a stopped goal | Visible operation-health settings; know queued/loading/streaming/running states, explicit deadlines and cancellation settlement |
| Timed-out client request is forgotten and a retry gets a new ID; `clients/socket-client.ts:164` | UI can say failed while work continues, or suggest a new mutation | Durable command status using the original ID; reconnect/reconcile before retrying an uncertain command |

Do not substitute unlimited blind retry for these restrictions. Repeated identical failures should cause a different evidence-based context/tool/strategy decision or an honest blocker. A planner's format error, a model's context limit, a known failed test and an unknown tool outcome need different recovery paths.

## Transparent interaction

Show one compact effective-policy summary for a goal. For example:

```text
Models       Auto · local-only
Team         Coordinator selects roles as needed
Files        Additional files allowed · strict scope off
Usage limit  Not set
```

These are examples of values, not new hardcoded defaults for model/data preferences. Expand a row to see where its value came from (machine/project/goal/user change), its effective revision, coverage and whether it can change for this run or only future work. Show a user setting only if it changes actual service behavior.

The service must produce this summary. UI, CLI and a future MCP adapter consume the same effective policy and available actions; none infers rules from backend names or locally reconstructs inheritance.

During work, distinguish **working**, **waiting for capacity**, **rebuilding context**, **paused by a user rule**, **needs input**, **reconciling an action** and **finished**. A queue wait or context rotation is not a failed goal. Do not show every internal model phase as something the user must approve.

Every blocking explanation contains:

- What prevented the next operation and which existing work remains saved.
- Whether it was a user choice, physical capacity, unavailable capability, failed check or uncertain operation result.
- The effective rule/value and origin where relevant.
- Whether Buro will recover automatically, and the small set of valid user actions.

Examples of user text: “Waiting for the local model; work is saved”, “Your request limit has been reached; raise or remove it to continue”, “This backend cannot provide read-only review; choose an eligible reviewer”, and “The command's result is unknown; checking its status before continuing”. Prefer an inline explanation with an action over a generic error modal.

Detailed evidence belongs in an expandable activity feed: actual backend/model, role, operation ID, selected strategy, rule change and check result. Do not expose private provider continuation, secrets or raw reasoning through a transparency feature.

## Service contract and tests

Introduce one resolved run-policy projection and typed stop/wait records. At minimum they bind category, rule/condition, policy revision/origin where applicable, operation identity, saved progress, automatic-recovery state and valid continuation actions. This is a new contract, not another UI-only error mapping.

Quota changes preserve counters and receipts. Scope-mode changes are explicit revisioned commands, with effective permission checked before the next effect. They never retroactively authorize a previous action or erase its recorded violation. Narrowing scope while a worker is active requires cancellation/settlement or a defined boundary before conflicting dispatch. A restart/reconnect does not create a fresh allowance. Queues preserve job identity. An unknown operation is reconciled or explicitly contained before conflicting work is dispatched; changing a backend is not reconciliation.

Acceptance gates:

1. Default advisory scope permits and reports a legitimate adjacent edit; strict mode prevents/rejects it according to the declared tool capability. Checks/review/commit refer to identical actual bytes in both modes.
2. No-quota work crosses former turn/session/window/repair/storage counters; a configured quota pauses before the next effect, and an explicit change continues without resetting history.
3. Every user-visible disabled action or pause has a service-provided reason; healthy endpoint waiting and context rotation recover without invented user clarification.
4. Same role/data/authority rules apply across capable managed/native backends. Unsupported capabilities reject before dispatch, with a viable selection action rather than a silent permission expansion.
5. Retrying an uncertain command preserves its original command identity and reconciles its durable result. Transport timeout alone never implies the effect failed.
6. New future configuration does not rewrite an active assignment. Strict constraints on actual source-branch application remain independent of whether planning scope is advisory.

See [the selected execution design](EXECUTION-DESIGN-DECISION-2026-11-21.md) and [reusable packages](REUSABLE-AGENT-PACKAGES-2026-11-21.md). No production behavior or UI control was changed by this document.
