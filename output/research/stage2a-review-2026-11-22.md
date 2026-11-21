# Stage 2A architecture, code and boundary review

Date: 2026-11-22. Independent review of the final stage 2A working tree over `9cece38`, including the final router ownership fix. This reviewer made no production edits, ran no models or RTX checks, and did not rerun the full suite. The parent owns canonical validation and the commit.

## Verdict

**Clear for the bounded stage 2A slice:** explicit backend capabilities, equal configurable native instances, capability-based dispatch admission, and portable model-provider contracts. No remaining blocking finding was identified in the reviewed frozen source. This is not approval to describe the entire agent system, policy system or plugin SDK as neutral and complete.

## Architecture and authority

- `agent/contracts/model.ts` and `capabilities.ts` contain plain portable contracts without Buro domain, Node, Cordis, protocol-schema or adapter imports. Their separate no-ambient-Node TypeScript check and boundary test make this a useful extraction seam. They are not yet a separately packaged or published SDK.
- Protocol owns strict validation; core owns admission and registry behavior; adapters declare their actual mechanics. A backend client label, adapter method presence or persisted metadata does not grant a capability. The catalog parses and freezes an independent capability snapshot and binds execution methods to the original implementation.
- Saved resource capabilities must match the actual registered descriptor, including its revision. Routing also checks configured identity, configuration revision and the owning immutable review view where required. Assignment and worker-check selection compare canonical validated resources with the frozen pool instead of accepting an invented resource with a familiar ID.
- The managed backend declares `strictPlannedWrites: false`: its command tool does not enforce such a boundary. Native declares tools-free turns, host-managed tool lifecycle and reported usage unavailable. These limitations remain explicit rather than being inferred from a backend name.
- Native runtime IDs are configuration instances. Multiple native backends can have distinct models/reasoning configuration, persisted routes and configuration hashes. The native wire thread/turn identifiers are scoped by runtime instance, avoiding collisions between two processes using the same external identifier. A managed resource named `codex` does not become a native adapter.
- Known admission failures before dispatch are branded observed and do not create a start intent. A configuration change after the first saved start intent is persisted as rejected when no backend call occurred. Errors from an invoked backend retain unknown-outcome semantics, even if their error code resembles a preflight rejection. There is no compatibility fallback that silently dispatches an old unregistered Codex thread.

## Finding cleared before approval: cleanup reused execution admission

The initial router cleanup called `adapter(route)`. Closing a review view or changing configuration therefore revoked the cleanup path for an already owned backend session; even the second cleanup during disposal could fail after an otherwise normal completed review.

The final implementation keeps the original process-local runtime/thread lease. Stop and release address that original owner without selecting another backend or requiring a new review/execution grant. Successful concurrent release is idempotent, removes parent and child event mappings, and preserves the durable route. A historical or released route must explicitly resume before another turn or submit. Stop requires the original lease and cancellation capability; a historical record alone is not authority to interrupt a session.

The three new router regressions cover revoked review input, changed configured metadata, idempotent cleanup and dropped late events, and explicit resume after release. This reviewer read the final source and tests. The owner reports the final router/admission/native-instance/connection subset passing 31/31 and server typecheck passing; these are reported execution results, not reruns by this reviewer.

## Validation evidence and limits

The reviewed tests include explicit complete capability declarations, absent/stale/forged descriptors, mutation isolation of registry snapshots, arbitrary client labels, unsupported read-only admission without a durable intent, and unknown errors after actual dispatch. The configured-native factory tests instantiate actual adapters with fake local wire processes, verify per-instance settings and identity hashes, and exercise equal external IDs without model calls. The owner reported the earlier native/router/resource subset passing 50/50, including seven independent admission tests and four configured-factory tests. The parent runs final full-suite/build/format validation separately.

Capability descriptors are trusted implementation declarations, not physical proof that arbitrary third-party backend code enforces them. The previously documented verification sandbox and process-lifecycle qualifications remain in force. In particular, this stage does not prove all native model-driven tools, all platforms, arbitrary imported check dependencies, or complete descendant termination.

An unspecified native model is represented as unknown rather than exposing a guessed effective model. Its actual ambient CLI model configuration is not frozen by a public model string; users needing an explicit identity should configure it. This does not grant a missing capability or permit rerouting an existing session.

## Deliberately remaining work

- Replace the remaining Buro-shaped `AgentRuntime` loop with the intended neutral agent backend/session abstraction; continue removing planning decisions based on client brand.
- Implement the chosen autonomy policy: planned paths advisory by default, an optional strict scope setting, transparent user intervention, and deliberate handling of unknown external effects.
- Remove or make opt-in the remaining aggregate budget and hidden quota defaults; this capability extraction does not change them.
- Complete reusable package manifests, public entrypoints and plugin contribution boundaries. The contract source and compiler boundary are groundwork, not the finished distribution.
- Apply the same explicit capability requirements throughout the remaining planning, orchestration and UI flows; configuration onboarding and dynamic coordinator/team behavior are separate work.
- Archive existing prototype state before live cutover. Capability metadata and route requirements are now mandatory, and old records are intentionally rejected rather than silently upgraded. This is consistent with the pre-release decision, but requires an explicit operational cutover.

The stage improves equal adapter admission and composability without claiming the later product-policy and agent-loop work is already implemented.
