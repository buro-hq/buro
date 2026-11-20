# Execution plan after repository review

Requested by the user: complete the review, save the plan, then use five agents to implement it. Baseline and findings are in [REVIEW-2026-11-20.md](REVIEW-2026-11-20.md). Each stage ends with tests, architecture review, a separate local commit and a short report; continue within the approved scope.

## Stage 1 — durable managed-run budget

Address R1, R2 and the storage boundary in R7 first. This is the foundation for work segments.

### Contract

- One authoritative ledger per project/run, shared by Buro-managed coordinator, workers, replacement attempts, derived environment sessions and fresh reviewer. Model API calls and managed tool calls are covered; native Codex provider requests are explicitly outside this initial metering capability.
- Keep full reservations/operation receipts private in `ProjectDocument`, committed through the existing `ProjectStore.transact` and writer lease. Export only a bounded `Run.managedBudget` summary and frozen numeric policy. No parallel private-file counter or process-global mutable budget authority.
- Version limits for aggregate generation requests, conservatively reserved output tokens and managed tool calls. Protect a fixed subset of each for review. Freeze policy for an attempt; resume/replacement/default changes cannot reset or expand it.
- Add an optional advanced project profile policy; new managed runs use a documented default. Legacy runs attach with explicit prior-usage-unknown coverage, never claim reconstructed lifetime usage. Native-only runs retain current behavior.
- Reserve atomically before provider/tool dispatch. Smaller output caps may fit remaining unprotected allowance; keep a usable minimum and existing per-session/context limits. No refunds, retries or provider fallback based on low/missing usage.
- Record only observed numeric usage. Provider output above its reservation poisons the ledger and stops further work after the evidence is durably saved. Missing responses remain conservatively charged/unknown.
- Persist the budget observation before dispatching tools from the response. Persistence failure prevents the next external effect.
- Classify review from the service-owned immutable purpose/read-only session, not model output. Project/run identity must match the saved scope; unknown owning runs fail closed.
- Stop with a typed resource/budget outcome; keep scope, acceptance and recovery rules unchanged.

Initial defaults to validate in implementation: 64 managed generation requests, 131,072 reserved output tokens, 256 managed tool calls; protect 8 requests, 16,384 output tokens and 32 tool calls for review. These are guardrails, not model-specific quality claims or monetary accounting. Per-request output remains bounded by the runtime and request policy. An overall workflow wall-time limit is Stage 2 work, not implied by this ledger.

### Five-agent ownership

Four concurrency slots include the primary agent, so execute five delegated tasks in two waves:

1. **Budget contracts and pure rules:** protocol schemas/types, core port and pure reservation/usage rules; atomicity-independent tests.
2. **Transactional persistence:** adapter over the project transaction, private ledger validation, compact public summaries, restart/idempotency/concurrency tests. Wait for the contract before mutation integration.
3. **Managed integration:** private purpose/checkpoint fields, request/tool gates, resource factory/Cordis wiring and owned-run classification. Preserve unknown-action and existing resume contracts.
4. **Workflow and verification:** initialize frozen budgets with new runs, retain them on continuation, typed outcomes; cross-role/repair/restart integration tests with fake providers. No live costs.
5. **Independent architecture/recovery review:** inspect all final changes for ordering, spoofing, counter reset, private-data leakage, review-reserve bypass and native compatibility. Fix findings before commit.

[Private-project evaluation details removed.]

### Acceptance

Meaningful deterministic checks: two workers and coordinator cannot collectively exceed a cap; review remains possible after work allowance is spent; output caps shrink without raising context; replacement/resume/reopen retain all charges; duplicate operations are idempotent and conflicts fail; unknown usage remains charged; malformed/over-reservation usage stops later effects; a failed transaction/checkpoint dispatches no subsequent request/tool; derived environment uses its owner budget; transport round-trips summaries without private receipts; native routes are not falsely metered.

Run relevant focused suites, then full `npm test`, production build, formatting/boundary checks and the affected browser resource/project scenarios. Live provider calls are not required to establish ledger correctness and remain separately bounded/authorized.

## Stage 2 — work-segment protocol and lifecycle

Address R3/R14. Keep one logical agent and stable `B → M` routing. Introduce step events distinct from logical completion, a cumulative request/action journal and a core-validated segment handoff. Archive previous messages/private continuation atomically before using a fresh window; never split pending tool-result chains or unknown actions. Add deadline semantics without resetting on context rotation. Managed providers first; native rotation requires a separate contract.

The handoff is built from frozen objective/criteria, next bounded task, verified workspace/diff identity and actual action/check evidence. A model summary is a proposal, not proof. A pure `WorkSegmentPolicy` is injected through Cordis; core owns budgets, permissions, persistence and acceptance.

## Stage 3 — short check-backed work loop

Address R4/R11. A small patch can request a registered service-owned check, then receive a fresh focused step containing actual failure evidence. Reuse existing `CheckPort` rather than exposing oracle source or letting workers redefine checks. Invalidate evidence when its workspace fingerprint changes. Final acceptance still requires independent checks and a fresh reviewer. Distinguish not-run/unavailable/failed/passed in UI.

## Stage 4 — measured real-case quality

[Private-project evaluation details removed.]

## Stage 5 — scheduling, connection lifecycle and product UI

Dynamic specialists/task graph, queued/concurrent runs with one writer per workspace, durable operator questions, versioned disclosure grants, RTX connection/reconnect lifecycle, then agreed dense goals/material hierarchy/office-feed/agent details on real service data. Extract workflow responsibilities in small reviewed increments. SQLite, pagination and retention follow bounded read-model design, with migration/replay evidence.

## Stage log

- Review baseline: 302 tests, build/typecheck, formatting, 9 oracle checks and six browser scripts passed. Review/plan saved before delegated implementation.
- Stage 1 implemented with five delegated tasks. 342 default tests and production build pass; resource/project/localization browser checks pass. Atomic reservation/state tests cover restart, duplicate operations, protected review allowance, frozen policy, rejected ledger removal/rewrites, unknown accounting, persistence failures and late overage. Private purpose and bounded typed budget outcomes are retained across transport/recovery. No paid/live model calls were made for this stage.
- Stage 1 boundaries: accounting covers managed model APIs/managed tools, not hidden native-client API traffic or monetary billing. Legacy activation records earlier usage as unknown. Public budget updates currently reuse full `run.changed` events; bounded delta/read models remain later work. Already granted/in-flight effects are not a global cancellable lease.
- Stage 2 is next: safe managed segments and lifecycle semantics; automatic rotation remains disabled until its archive/handoff contract is implemented.
