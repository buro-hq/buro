# Stage 2C independent architecture, code and boundary review

Reviewed on 2026-11-22 against committed baseline `f7ad286` plus the current working-tree 2C changes. Final disposition: **clear within the reviewed 2C scope**, with the operational preparation follow-up explicitly retained below. This is a bounded source and synthetic-contract review, not a live-model evaluation or approval of later SDK/storage/concurrency stages. No provider endpoint, offline RTX host, original user project, Git mutation or external delivery was invoked by this reviewer.

## Scope and evidence

Inspected planning-policy selection/binding, `ExecutionService` queue/plan acceptance/writer handoff/continuation, shared role resolution, `RuntimeRouter` admission and cleanup, operational `ResultService.prepare`, capability descriptors, persistence schemas and service autonomy projections. UI/browser refresh is being checked separately by the UI and host-contract reviewers.

Independent focused execution: **41/41** tests passed in `role-routing`, `service-role-routing`, `planning-policy`, `project-planning-policy`, `autonomy-policy` and `boundaries`; a further **8/8** `planning-runtime-gate` tests passed. These focused counts are included in, and must not be added to, the parent's final full-suite count. `git diff --check` passed at review time. After the continuation fixes, an independent final recheck of `execution-planning`, `autonomy-policy`, `service-role-routing`, `planning-runtime-gate` and `boundaries` passed **34/34**. This recheck overlaps the earlier focused sets; counts are not summed.

The native inspection test uses a fake app-server and verifies actual `thread/start` read-only configuration and subsequent read-only/network-disabled turn fields. It does not prove a live native model's built-in tool execution or general host-read confinement.

## Findings and dispositions

### P2: application continuation must distinguish backend thread resume

Initially, both service projection contexts unconditionally advertised continuation while the router facade always exposed `resume()`. A selected backend with `resumeSessions: false` therefore offered a repair action that necessarily failed at backend admission.

The owner changed `continueRun` and planning recovery to consult the frozen selected coordinator's actual `resumeSessions` capability. A nonresumable backend now starts a new session in the saved workspace, preserving the accepted plan, full goal, user clarification, materials and worker results rather than calling an unsupported thread-resume operation. Unknown-outcome admission still runs before this fallback. The source-level finding is addressed. The final independent recheck passed the regression that declares a nonresumable backend despite a facade resume method, repairs in a new session without replaying planning, transfers the complete task and plan, and obtains a fresh independent review.

### P2: replacement writer must retain frozen coordinator instructions

At the initial review point, `continueRun` constructed generic continuation instructions but omitted the frozen coordinator role's reusable instructions. With the new fresh-session fallback, a nonresumable backend had no prior thread history from which to retain those instructions. The owner was notified with the concrete location and suggested regression: declare `resumeSessions: false`, save a custom coordinator instruction, stop a planned run, then repair and assert a new session ID, zero backend resume calls and preservation of that instruction plus the complete task/plan. The owner corrected this by prefixing continuation instructions with the frozen coordinator RoleSnapshot instructions. The final independent recheck passed the dedicated regression: the new writer receives those saved instructions, has a different session/thread identity, retains the accepted plan and full goal, makes zero backend resume calls, and completes fresh review. This finding is resolved.

### Follow-up boundary: unknown read-only operational preparation

This is pre-existing operational lifecycle behavior, not a new code-acceptance regression. `ResultService.prepare` calls `runtime.turn` directly. On `UnresolvedEffectError`, it marks its result agent failed and releases the session, but does not retain an owning operational-preparation unknown-outcome marker. A later user request can start a new read-only preparation session. The completed implementation Run cannot simply reuse the current Run reconciliation field: its schema correctly forbids a completed implementation with an unsettled implementation effect.

The offline [reproduction](stage2c-operational-unknown-repro-2026-11-22.mjs) was executed successfully. Two explicit preparation attempts produced two fake unknown generations and two releases, with **zero external delivery calls**; the delivery remained failed and the implementation Run had no reconciliation marker. It uses only in-memory state and a fake runtime. No actual provider or file effects are involved.

This boundary is not a 2C release blocker for frozen routing and policy projection: operational preparation is read-only, and delivery does not run until a valid ready result is observed. It does prevent claiming universal owning-run unknown-outcome handling for every operational role. The neutral execution/SQLite authority work should introduce a separate durable preparation-attempt receipt, distinguish safely contained abandoned read-only requests from unresolved effects, and expose the actual retry decision and accounting. Managed private generation journaling is not the same as an owning preparation retry policy. This review does not validate external delivery effect deduplication after a delivery-process crash.

## Boundaries found intact

- Role choices are limited to the frozen authorized profile union. Local-only policy rejects remote resources; selecting a role cannot create a new connection. Fixed unavailable/ineligible pins fail, while Auto/Prefer alternatives are selected by actual operation requirements and recorded with their source.
- Worker proposals are capability-checked before plan acceptance, including strict write prevention. Role kind and a recognizable client/runtime name do not grant authority.
- Coordinator and reviewer role versions/choices are saved before dispatch. Operational role definitions and choices are captured inside the owning project transaction before session creation. Later catalog edits do not silently reroute an accepted assignment.
- Durable service routes retain role identity and the selected resource decision. New dispatch revalidates the decision, frozen role, configured identity, descriptor and operation requirements. Human explanation text is not execution authority. Cleanup and interrupt retain the original process-local lease instead of acquiring a new resource grant.
- Tools-free planning sends explicit per-turn tool authority, enforced by the managed runtime before provider/tool work. Read-only inspection instead creates a real read-only backend session. It does not falsely claim that all tools are disabled.
- Acceptance of an inspection plan durably clears the planner thread from the writer slot before writable session creation. A stop in that gap resumes from the saved accepted plan without reusing a read-only planner as a writer. Unknown start/turn outcomes retain their existing reconciliation boundary.
- A stopped older run cannot bypass another unresolved run of the same goal through repair or a new run. The service checks this before creating an attempt/session; UI action projection also removes conflicting actions without fabricating an owning reconciliation marker. Dedicated service and pure-projection regressions passed in the final recheck.
- Planning policy binds the selected coordinator's resource/configuration/capability revision, including when that choice differs from the profile default. Policy history is not silently rewritten on reopen or continuation.
- Effective policy is produced by service code, prefers actual saved role decisions, retains finite current managed limits and unknown usage, and includes the explicitly authorized dependency-repair scope. It does not claim that default quotas have already been removed.

## Deliberate remaining work

The neutral AgentBackend loop, production SDK adoption, contribution-based workflow composition, independent package installation, SQLite authority, default-none quotas, descendant process/crash cleanup and concurrent goal scheduling are not completed by 2C. Current built-in service role IDs/templates remain Buro workflow implementation, awaiting the contribution stage. Advisory planning and native read-only inspection are not evidence of general native host-read confinement. No claims about Ollama/DeepSeek coding quality or speed follow from these synthetic checks.

Post-commit contribution follow-up: a delivery environment can name a custom `profile.delivery.environments[].roleId`. Actual preparation dispatch supplies `purpose: delivery`, requires structured/read-only mechanics and validates the saved resource decision, so a mistaken catalog choice fails closed. The current role-choice catalog maps built-in service IDs; a custom role may therefore be presented with worker eligibility even though delivery requires different mechanics. A single role may also be used in both contexts. Stage 4 should expose operation-aware role choices through workflow contributions instead of claiming that one ID-based eligibility row describes every use. This is a catalog clarity limitation, not authority to execute an unsupported delivery session.
