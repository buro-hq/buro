# Selected execution design, quota policy and hidden-constraint migration

Date:2026-11-21. Status: **selected target and implementation plan; production code/defaults unchanged**. This extends [the architecture research](ARCHITECTURE-RESEARCH-2026-11-21.md) with a source-level constraint inventory and a concrete migration choice. Five delegated roles covered runtime limits, workflow/UI/data limits, external patterns, quota/storage migration and independent review.

## Chosen option

Retain Buro's modular monolith, Cordis composition, runtime/provider ports, scoped effects, workspaces and independent acceptance. Introduce three replaceable policies around that foundation: **workflow strategy, context view and editing format**. Default quality strategy: one scoped writing executor, service-owned checks, a fresh independent critic and repair by the original executor. The coordinator owns the goal and adds task decomposition, test discovery and specialists when they contribute. A separate model planning/integration call is not required for every administrative phase.

For ordinary new-format runs, **aggregate hard quotas are off by default**. They are enabled only by an explicit user policy. Remove hidden lifetime request/repair/window stops from every new execution path as part of the same activation gate. Preserve usage/effect records, actual model capacity, permission checks and recovery handling. A scheduler quantum may yield a session; it must not mark the goal failed or reset its operation sequence.

This is the best-supported choice for the current product and observed failures, not a proof of a globally optimal agent architecture. Same-model4B/9B superiority on repository tasks remains unproven. Changing a framework or adding a large recursive task graph first does not address our measured problems.

The user explicitly confirmed that this unreleased product does not need backward compatibility. Use a clean contract/storage cutover: no legacy runtime strategies, old checkpoint resume, dual schemas or inference of old quota intent. Extract reusable agent packages behind these clean contracts; keep Buro's repository and acceptance domain outside them. See [reusable package boundaries](REUSABLE-AGENT-PACKAGES-2026-11-21.md).

## What to reuse and how

| Reference | Adopted mechanism | Buro change | Avoid |
| --- | --- | --- | --- |
| [Cognition clean-context review](https://cognition.ai/blog/multi-agents-working) | Independent critic and communication back to the writer | Fresh read-only session gets frozen criteria, verified current source/diff and check evidence; concrete findings return to the original executor | Dropping requirements to make review clean; treating every stylistic suggestion as a defect; relying on a weak model alone to decide escalation |
| [Aider architect/editor](https://aider.chat/2024/09/26/architect.html) | Separate solution reasoning from edit serialization when useful | Model-specific editing strategy: hash-fenced file/function replacement, scoped patch or existing exact replacement; optional architect | Two mandatory calls on every task; one universal edit format; unrestricted writes outside ToolBroker |
| [Anthropic durable session/harness separation](https://www.anthropic.com/engineering/managed-agents) | Complete recoverable history independent of model prompt | Private immutable/paged history and a versioned context view with retrievable evidence refs and completeness | Sending all history forever; shortening away constraints; exposing private reasoning/credentials through a history tool |
| [mini-SWE-agent](https://mini-swe-agent.com/latest/) | Minimal action/result loop and traceability | An external/minimal executor baseline; make the exact action interface understandable to local models | Copying bash-only authority or assuming a tiny agent class replaces storage/sandbox/product infrastructure |
| [Agentless](https://github.com/OpenAutoCoder/Agentless) | Localization, candidate patches and visible-check selection | Prepare exact edit inputs; add compute-matched self-debug/candidate baseline | Using hidden evaluation tests to select a candidate; transplanting old leaderboard results to our hardware/models |
| [OpenHands SDK](https://docs.openhands.dev/sdk) | Ready execution/context/environment facilities | Later pinned backend spike behind AgentRuntime if it resolves a measured gap | Framework rewrite before comparing; assuming advertised compression preserves our required criteria/recovery semantics |

These are mechanism-level adaptations. No third-party runtime code was imported. Verify exact pinned licenses and capability/recovery contracts before adopting implementation code. The [reuse report](../output/research/reusable-agent-patterns-2026-11-21.md) describes costs, source caveats and tests.

## Concrete Buro problems and selected repairs

1. Production review sees file names and character counts through `changeContext()`, then has to rediscover actual code. Replace this with complete verified source/diff context or explicit chunk references. If context is incomplete, return a typed missing-context request; do not approve a clipped view. The research controller is an implementation reference, not yet the production path.
2. Production check/review repair goes back to the coordinator. Return concrete validated findings to the original executor, then check and freshly review the changed revision. Preserve the coordinator's responsibility for scope/dependencies and unresolved decisions.
3. The request estimator uses UTF-8 bytes plus overhead as an upper bound, not tokenization. Injecting a policy cannot change that estimate today. Introduce an explicit trusted footprint/estimation contract that measures the provider-projected packet, including tool/schema/template overhead. Exact counts, estimates and unknown measurements must remain distinct. Do not use a guessed lower multiplier.
4. Segment closing uses raw history pressure while real requests use a provider projection. Use one request-view identity for pressure and admission. Investigate service-generated continuation at fully settled boundaries to avoid extra closing/serialization calls; preserve unresolved tool chains, provider continuation and unknown-effect protection.
5. Old file/search/diff interfaces can block or hide needed input. Use bounded streaming/pages with versioned cursors and explicit completeness, not blanket removal of memory checks. Add typed, scoped delete/move operations rather than grant arbitrary shell commands.
6. Preserve full check/tool logs in private artifacts before taking model/UI excerpts. The current30K collector tail makes the promise of retained full logs inaccurate. A view limit is acceptable when the complete evidence is retrievable.

## Hidden constraints actually found

The [combined machine-readable inventory](../output/research/buro-constraints-inventory-2026-11-21.json) contains79 layered groups and185 validated source references across49 files. Groups can overlap at different layers; this is not a count of independent defects or every string-length field. Runtime/workflow subinventories and the independent review are retained under `output/research/`.

| Current rule | Actual effect | Selected treatment |
| --- | --- | --- |
| Run64generations /131072reserved output /256tools | Goal admission stops; review reserve leaves56work generations /114688output /224tools | Observation-only by default; explicit optional user caps |
| Turn24generations /64tools; session256generations | Separate stops even after run quota is removed | User-requested caps only; scheduling yield is resumable, not failure |
| Worker3tool rounds or60%byte pressure;4windows total | Repeated closing overhead and terminal window failure | Select context from observed state; no default lifetime window quota |
| Check feedback2; project repairs0..2/default2; planner2attempts; worker replan1 | Independent terminal counters in control flow and checkpoint validation | Progress/recovery policy; optional user stop rules; preserve every prior attempt |
| Private archive15 / maxSegments16; budget operations17408 | Stored state becomes invalid after another finite boundary | Versioned incremental/paged storage; no fixed total archive/operation ceiling |
| Team max2 throughout schema/profile/UI; dispatch is serial | Total logical role count is mislabeled as concurrency | Separate task/session creation from active writer/model capacity; incremental decisions and queues |
| One nonterminal run per project | PROJECT_BUSY rejects another isolated run | Queue/capacity admission; retain writer ownership per worktree and serialized root application |
| Default idle10min; profile turnTimeout is different; UI can regenerate command timeouts; command schema caps at15min | A configured number may not be the actual effective value; a legitimate long active check can hit an arbitrary ceiling | Single effective health policy with visible provenance; support long active operations and explicit deadlines; operation health is not a goal budget |
| Read/edit existing file at most256000bytes; read view120default/200max lines and16000chars | Even a small range of a larger file is rejected; long lines cannot be fully retrieved | Streaming/range reads and revision/hash-fenced editing |
| List/search only first300files/5000entries;50matches with500-char line views | Later relevant source/matches may be undiscoverable | Paged/indexed discovery with stable cursors |
| Replacement payload64000chars; diff24000chars /300tracked /100untracked paths | Some edits cannot be expressed; reviewer may see a clipped diff | Capability-selected edit formats and complete paged manifests/diffs |
| Verification after-file1MiB; before Git blob2MiB; evidence256changed paths/32MiBtotal | Legitimate changes can fail verification independent of model resources | Streaming evidence/diff artifacts and paged manifests, preserving content identity |
| Materials8MiB/file,48MiBbatch,64files; library1000includinginactive | Import/lifetime collection caps can block required materials | Chunked import, paged library and reference-aware retention; avoid conflicting transport limits |
| Incoming WebSocket12MiB; client observation timeouts; snapshots/history unpaged | Uploads may fail earlier; client can stop waiting while server continues; history can exhaust memory | Chunk/page transport, durable command status and lazy snapshot/history queries |
| No explicit delete/move tool | Certain normal source-edit tasks are unsupported | Typed scoped operations with source/target preconditions and durable receipts |

Keep symlink/private-file restrictions, scoped authority, registered checks, stale-evidence rejection, operation-ID conflicts and no blind replay of unknown actions. Nonoverlap remains a correctness guard for the current shared-workspace topology; sequential same-file tasks need explicit ownership/dependency rules before that guard changes. Endpoint/GPU capacity queues inference independently of logical team size. Native RPC/command cancellation escalation is not a product quota to delete.

## Quota policy and accounting

Use explicit configuration semantics:

```ts
type QuotaOverride =
  | { mode: 'inherit' }
  | { mode: 'none' }
  | { mode: 'bounded'; limits: ExplicitFiniteCaps };
```

The new root resolves to `none`. Missing override means inherit, while explicit `none` clears an inherited user preference. Resolve and snapshot the effective policy when a run starts. Do not interpret0, missing values or huge numbers as unlimited. A configured0 can mean no allowance, never infinity. Setting a running goal's quota is a distinct CAS/audited transition preserving all usage and operation receipts.

There are four separate contracts:

- **UsageAccounting:** monotonic historical receipts and observed/unknown usage. Always enabled.
- **OptionalQuotaPolicy:** user-chosen aggregate admission rules. Default off.
- **ProviderRequestLimits:** actual model/context/output and available memory. A request view may need selection/chunking.
- **Scheduler/health policies:** yield fairness, operation liveness and cancellation/reconciliation. They do not silently become another goal-wide quota.

Current reserved-output totals permanently sum requested upper bounds. They are not measured spend. New accounting should retain that history while computing quota exposure from observed use plus outstanding upper bounds. Release unused exposure only if usage for the configured dimension is actually known; missing/native/partial usage remains unknown and is not refunded from an assistant completion claim. Per-request protocol/accounting overrun remains an integrity issue even when aggregate quotas are disabled.

Native hidden API calls are not managed runtime turns. An exact whole-run request/token/currency cap cannot be promised for a native or mixed client without the necessary accounting/control capability. Show the supported enforcement scope; unknown cost is not zero.

Repeated identical errors or observations trigger a revised task, a new context view, an authorized strategy/model change or a real blocker. They do not consume a mandatory hidden two-attempt lifetime allowance. Confirmed command timeout/termination is an observed result that may support repair. Unknown effects remain unreplayed until reconciled.

## Storage and clean cutover

**Select one authoritative transactional SQLite ProjectStore for new-format state/admission**, behind the existing architectural ports. The operation receipt, incremental usage summary, public Run projection, event sequence and command receipt must commit together before dispatch. Do not create a separate usage database next to authoritative JSON summaries.

This is a focused store/accounting-contract migration. SQLite alone is not the fix: core currently walks the entire operations map repeatedly and the file store clones/rewrites it. New admission must decide from a summary and the specific prior operation receipt, then atomically commit the delta. Large private session/history/log artifacts use paged immutable references; bounded page size does not cap lifetime history. This removes quadratic growth and hidden17408/15 ceilings without widening authority.

Do not retain v1 readers, runtime strategies or old checkpoint restoration. Existing hashes/checkpoints bind old limit policies; this is evidence for an explicit format boundary, not a reason to maintain compatibility machinery. Old runtime state is not executable under the new engine. No automatic endpoint fallback or replay of old actions.

Keep previous prototype data in a protected read-only archive before an explicit cutover/reset; this design authorizes no deletion. Where useful, deliberately reimport project definitions, goals, materials and reviewed connection references, not runtime ledgers or implicit numeric defaults. Recreate explicit new settings rather than infer user intent from old generated fields. New runs start with new identities and default-none policy. Recovery, stable operation IDs and unknown-outcome reconciliation remain mandatory for all new-format work.

See the [migration design](../output/research/optional-quota-migration-2026-11-21.md) and [independent review](../output/research/limits-decision-review-2026-11-21.md) for transaction/recovery details.

## Rollout: one selected sequence

1. **Clean contracts and package boundaries:** separate quota/accounting/request-capacity/health; one supported execution schema; UI/CLI distinguish inherit, none and finite settings. Extract domain-neutral agent contracts/runtime/provider policies from Buro-specific repository and acceptance logic. Define a meaningful verified-progress signal without assuming every new diff is an improvement.
2. **Durable storage:** transactional project/usage/event receipts, paged private archives and full streamed logs. Create a new-format store, archive old prototype state before an explicit cutover, optionally reimport domain inputs and atomically activate. No live dual writing, old runtime ledger import or checkpoint compatibility layer.
3. **Activate no-quota workflow end-to-end:** remove terminal request/session/repair/window fallback, support cooperative continuation and queueing, preserve operation sequence and private continuation. Activate default-none only after all consumers pass—not a partially unlimited mode with another hidden stop.
4. **Production quality loop:** verified review packets, typed missing context, same-executor repairs and fresh review per revision. Add model-appropriate editing strategies and typed move/delete capabilities.
5. **Prove useful work:** compare minimal execution, writer/critic, coordinator/test discovery, and compute-matched self-debug/candidate selection across repeated held-out real issues. Hidden tests are post-selection only. RepeatRTX/Qwen9B only after the user reports the machine available.

Complete log retention and verified review packets can be implemented independently while the storage/runtime cutover is prepared. Do not activate new no-quota claims until their end-to-end gates pass.

## Acceptance gates for the migration

- No-quota work crosses former64run/24turn/256session/4window/15archive/17408operation boundaries without a quota failure. Scheduler yield preserves goal/session state and never resets or reuses generation/tool operation IDs.
- Explicit finite caps still reject before dispatch; all roles/repairs/closure/serialization count. User none overrides inheritance correctly; new configuration does not import old generated defaults.
- Observed settlement releases only known unused exposure; unknown usage/effects remain recorded. Duplicate and conflicting operations have deterministic idempotent outcomes.
- Crash injection around reservation, summary/event/receipt commit, publication, artifact manifests and policy changes produces one authoritative recovery result.
- Old checkpoints are rejected as unsupported and never replayed; old files remain untouched/read-only until an explicit cutover. New-format sessions recover with their original configuration identity; changed or removed endpoints never gain an automatic fallback.
- A second host can execute a fake-provider agent/tool session using only the reusable packages, without importing Buro's projects, Git, Cordis host or UI. Enforce the package dependency graph and test cancellation/streaming/unknown effects at public boundaries.
- Large files, >300discovery results, long diff/log output and >1000material histories remain accessible through bounded pages/artifact references; missing content cannot masquerade as complete review evidence.
- Fresh review detects a public-check-passing defect, repair uses the same executor, changed code invalidates approval, and final tests/scope/evidence remain mandatory.

This research applied no production default, model, GPU, user-source or runtime configuration change. Pure schema/decision probes and source-reference validation are the evidence for the audit; prior605test results are the implementation baseline, not newly run migration tests.
