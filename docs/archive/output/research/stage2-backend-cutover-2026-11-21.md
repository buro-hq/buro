# Stage 2: backend and provider contract cutover

Date: 2026-11-21. Read-only source inspection of the active stage-1B tree above `fd50e27`; no production edits, model calls, network access or tests were performed by this task. This is an implementation design, not a claim that the new contracts already exist. The native immutable-read investigation belongs to the sibling verification task and remains a separate acceptance gate.

## Selected boundary

`AgentRuntime` in `core/ports.ts` is currently a **Buro session service**, not a domain-neutral agent contract: it accepts `projectId`, `runId`, `ownerRunId`, repository paths, role assignments and a Buro `RuntimePurpose`. `RuntimeRouter` is correctly application-owned because it resolves those values against saved project/run state. Renaming that interface to `AgentBackend`, or moving it unchanged into a package, would export the coupling rather than remove it.

Use three actual boundaries:

1. **AgentBackend**: neutral session/turn/operation lifecycle, normalized output and explicit authority reference; implemented by a managed agent loop and external harness adapters.
2. **ModelProvider**: lower-level normalized model transport consumed by the managed loop. Codex app-server remains an AgentBackend because it owns an internal agent/tool/session lifecycle; pretending it is one raw model response loses that lifecycle.
3. **Buro session binding service**: resolves Project/Run/role/configuration/effective policy into host-issued authority, freezes dispatch identity, selects the eligible backend, adds Buro identifiers to events and enforces acceptance/reconciliation. Keep `RuntimeRouter` and Buro workflow here.

Neutral types may begin under `agent/contracts/` while built independent packages remain stage 6. They must be consumed by the real production boundary immediately, with no unused parallel interface or compatibility alias. Add that directory to server typechecking and boundary checks. Moving the genuinely neutral `ModelMessage`, `ModelToolCall`, `ToolDefinition`, `ModelUsage`, request/result and ModelProvider types out of `core/model-ports.ts` is a small real first extraction. Keep repository `ToolScope`, Buro `ManagedSession`, segment evidence and worker-step-check state outside it.

## Minimal usable contract

Names can follow the implementation, but these distinctions are required:

```ts
type AuthorityRef = { id: string; revision: string };
type BackendSessionStart = {
  sessionId: string;
  instructions: string;
  authority: AuthorityRef;
};
type BackendTurnInput = {
  operationId: string;
  text: string;
  responseSchema?: unknown;
  toolPolicy: 'normal' | 'none';
  signal: AbortSignal;
};
```

The reference is opaque to the model. A host binding resolves it to launch/tool/context grants; the model cannot create one by returning a role or path. Pass an explicit identity for every dispatched turn; do not invent a new operation on reconnect. Session recovery retains authority revision and provider/backend configuration identity. A missing/changed authority rejects before another effect, rather than applying current project defaults to an old session.

Neutral backend events identify `sessionId`, and every turn/tool/message event identifies its `operationId`/`turnId` as applicable. They contain normalized text/tool/usage/lifecycle data, not Project/Run, native wire objects or private provider continuation. Buro's binding translates them to existing domain activity. Incremental text is required for the reusable target; current `onProgress()` and `message.completed` do not implement it. Introducing event types alone is not completion: provider parsers/backend adapters must emit actual deltas and cancellation must settle the underlying operation.

Keep durable journal admission/intent/dispatch/result ports host-owned. Do not introduce a second session ledger as part of the contract move. An unknown generation/tool/cancellation remains distinct from a known rejected or completed request; a shared error contract should carry that distinction without importing Buro `DomainError`. Error normalization in the Buro binding can retain user-facing codes. Current `observedTurnFailure` branding and owning-run reconciliation must not be discarded by a generic `catch -> failed` wrapper.

[Private-project evaluation details removed.]

## Capabilities: trusted facts, then contextual requirements

Expose a small versioned capability descriptor from each **registered backend instance**, copied into the frozen resource decision along with its revision. The host validates actual environment grants at assignment/start/turn boundaries. RuntimeResource metadata received from a caller is not evidence that a backend can enforce a policy; it must match the trusted registry descriptor/configuration revision.

Required distinctions:

| Capability | Meaning and gate |
| --- | --- |
| Structured completion | Backend can produce an observed formal response; schema rejection and observed malformed JSON remain separate recoverable outcomes. |
| Tools-free turn | No tool dispatch can occur for that turn, including a model attempting a tool anyway. Native current `toolPolicy='none'` rejects; do not declare this true because it supports JSON. |
| Read-only session / immutable-view review | Read-only means write prevention; immutable-view review additionally requires constrained reads to the host-issued source view and explicit environment inputs. A frozen cwd and a generic native `readOnly` sandbox are insufficient. Make the contextual isolation result explicit. |
| Repository write confinement | Tools or verified sandbox confine effects to the owning worktree/allowed service outputs; another backend does not acquire arbitrary host shell access because its interface is shared. |
| Strict planned-scope prevention | The opt-in checkbox promises to forbid edits outside planned paths. Post-hoc diff rejection does not provide prevention. A backend lacking an enforceable broker/sandbox must reject strict assignment before dispatch or use verified host enforcement. Advisory scope does not require this capability. |
| Tool ownership / host feedback hook | Distinguish a host-owned tool loop from backend-owned tools. Worker-step checks currently use host-loop hooks; the contract should require that hook, not `client==='managed'`. A native backend can remain eligible for ordinary implementation without claiming those hooks. |
| Usage coverage | Per-operation observed, partial or unknown; absence is not zero. Descriptor reports available observations, actual result reports coverage. Native current adapter lacks complete usage publication. Do not promise a hard token cap for an unobservable route. |
| Resume and cancellation settlement | Describe whether the backend supports original-session resume and reports cancellation outcomes. Do not promise that every remote abort is confirmed; individual outcomes can still be unknown and require reconciliation. |

Avoid a single `safe:true`/`managed:true` capability. Equally avoid dozens of flags predicting unimplemented features. Separate static mechanics from host/environment validation: an adapter can support named sandbox profiles yet this host/version/view may not satisfy them. Freeze the validated capability/environment revision with the grant; a changed executable or sandbox profile cannot silently reuse the old claim.

The existing `CapabilityProbeService` proves one model tool call and structured response, not filesystem isolation, coding quality, durable recovery or cancellation. Retain that diagnostic as provider/model mechanics. Do not use a successful `diagnostic_echo` to turn every security capability on.

## Exact current branches to replace

| Source | Current coupling | Clean replacement |
| --- | --- | --- |
| `protocol/resources.ts` | Native definition is literal ID `codex`; managed forbids that ID. Resource client enum also drives orchestration. | Arbitrary unique configured instance ID for either adapter kind. Keep adapter kind as composition/display metadata, never as authority. Stage 4 later replaces closed factory/parser unions with trusted contributions. |
| `adapters/codex/runtime.ts`, `plugins/codex.ts`, `adapters/resources/runtime-resources.ts` | `CodexRuntime.id` is constant; construction reuses one global native options record. | Required instance ID and explicit per-instance launch/model configuration resolved by host composition. Two configured native clients must coexist and route equal native thread IDs independently. Include actual relevant launch/capability revision in configuration identity. |
| `core/runtime-router.ts::resumeSession` | Missing saved route can manufacture a historical direct Codex route by singleton name. | Remove this prerelease compatibility branch. Every resume requires its durable original route/authority/configuration. Missing route -> typed unavailable/archive guidance, never silent new backend. |
| `core/execution.ts` queued run/planning + `protocol/schema.ts`, `adapters/files/project-planning-policy.ts` | `client==='managed'` chooses/validates bounded planning. | Freeze a planning strategy and its capability revision: tools-free structured decision where supported, or explicit read-only inspection planning if supported. Schema/store validation checks requirements, not brand. |
| `core/execution.ts` coordinator start | The legacy planner opens a writable coordinator session and relies on “do not edit” prompt text. | Read-only inspection planning needs an actual read-only binding, followed by a separately authorized implementation session. Do not rename legacy to inspection while retaining writable planning. Managed tools-free planning may use the same session only if per-turn authority is persisted and enforced. |
| `core/execution.ts` run ledger creation | Ledger starts only if a selected resource is managed. | Use backend accounting coverage and journal participation. Preserve honest native unknown coverage. Stage 5 owns no-quota activation and the single accounting authority; do not bypass those existing gates piecemeal here. |
| `adapters/environments/project-environments.ts` | Any managed resource toggles private-data isolation. | Resolve required environment authority from all actual session requirements, independent of brand; reject unmet requirements before launch. Native controller authentication and model-tool filesystem authority are different grants. |
| `adapters/checks/worker-step-checks.ts` | Worker feedback hard-requires managed client. | Require the host-loop feedback/owned-tool-grant capability plus matching frozen role/session/resource/environment. Do not remove identity checks merely to support another adapter. |
| `core/services.ts::RoleService.save`, `src/.../TeamPanel.tsx` | Coordinator/reviewer preferences forbidden while worker preferences work. | One role/assignment resolver over eligible role pools; Auto/Prefer/Fixed for all roles. Fixed cannot silently fall back; any user model/data restriction remains binding. |
| `src/.../ModelTeamSetupForm.tsx`, `ExecutionResources.tsx` | Labels collapse all native instances to “Codex”; setup/probe lists filter by managed client. | Label by configured instance/model. Role eligibility uses service capabilities/actions. Raw-model inventory/probe can stay provider-specific where that is the actual operation. |

Factory `if (runtime.client === 'codex')` at the composition boundary is not itself an orchestration privilege. It is acceptable until stage-4 contributions replace it. Conversely, changing only this factory while leaving client checks in execution/schema is not parity.

The default single Codex profile is product seed data, not a necessary backend contract. Stage 4 owns empty startup/discovery. Stage 2 must already prove a managed-only catalog works without a Codex executable or reserved instance name; do not re-add default Codex inside a supposedly generic constructor.

## Implementation batches and ownership

**2A — real neutral types and trusted capability decisions.** Own `agent/contracts/*`, `core/ports.ts`, `core/model-ports.ts`, `core/runtimes.ts`, capability validation helper and their import cutover. Move neutral provider types into active imports; introduce the Buro session binding interface explicitly. Managed/native classes advertise truthful registered capabilities; resolve contextual requirements without trusting public resource flags. Add capabilities to public resource projection/snapshot validation and immutable decisions. Keep existing quota semantics unchanged for now.

**2B — equal configured instances and routing.** Own resource schemas/configuration/factory, native instance identity/plugin and RuntimeRouter/route persistence. Remove reserved ID and historical route synthesis. Do not claim arbitrary plugin registration until stage 4. Persist capability/authority revisions with routes; validate before creation so a known unsupported capability does not leave a falsely unknown external-start record. After dispatch, preserve the existing unknown-start gate.

**2C — workflow/policy cutover.** Parent owns `core/execution.ts` integration, shared planning policy/store/schema consistency and the Buro authority resolver. Scope implementation owner covers the end-to-end [scope map](stage2-scope-cutover-2026-11-21.md). Worker assignment/feedback owner switches capability gates and common role resolution. UI owner renders service-resolved effective rules/reasons and real opt-in strict control. Neutral contract ownership must coordinate with scope changes to avoid two competing authority shapes.

**2D — independent review and parity regressions.** Review all client/name predicates after integration; allowed residuals are adapter construction, provider-specific configuration and labels. Validate native immutable review with the actual installed protocol/sandbox or report typed unsupported before assignment. Preserve 1A/1B unknown-effect, exact accepted-tree and verification-view regressions. Only then commit the stage; stage 3 replaces the managed execution spine behind the same active contract rather than layering a second loop.

This staging is an implementation sequence, not permission to ship 2A unused interfaces. If the neutral backend cannot yet be wired without the stage-3 host-binding/loop changes, keep the explicit application port and implement the production-used capability/resource/policy slice first. Report that as a bounded substep; do not advertise a reusable AgentBackend package based on a type declaration alone.

## Test/fixture impact and acceptance

A source scan of top-level `tests/*.test.ts` found references in 25 files to AgentRuntime, 22 to ModelProvider, 23 to RuntimeResource/literal managed/native resources, 11 to CodexRuntime/native configuration and 4 to planning policy identifiers. The union is **50 files**, with overlap; this is change-planning evidence, not 50 failed tests or a requirement to rewrite all of them. `core/ports.ts` is imported by 39 top-level test files for many unrelated ports, so avoid a mechanical all-import migration. Shared capability/resource factories should state actual behavior rather than inserting universal `true` flags into every fixture.

Focused existing areas: `runtime-contracts`, `runtime-router`, `model-selection-routing`, `assignment-resources`, `resource-configuration`, `resource-setup-*`, `planning-runtime-gate`, `project-planning-policy`, `execution-planning`, `step-check-isolation`, `worker-step-checks`, `managed-check-dispatch`, `project-environments`, `codex-interruption`, `managed-resume`, `run-reconciliation` and `boundaries` tests.

Required non-mirroring scenarios:

- Same capable backend implementation registered under two arbitrary IDs, including an ID named `codex` for a managed instance; route/session IDs do not collide and all resource decisions remain exact.
- Two native adapter instances share a fake wire thread ID but have different configured models/capability revisions; submit/resume/events stay with their owner. No singleton native fallback is available.
- Host with only managed backends never starts/queries a Codex executable and can complete the supported goal lifecycle.
- A capable backend with a nonstandard brand uses tools-free planning. An incapable backend with the string `managed` does not. A denied tool is rejected before broker dispatch and durable operation identity survives the rejection.
- Read-only inspection planning cannot write source. Implementation receives a new explicit grant, not a mutated read-only permission or prompt-only exception.
- Unsupported strict scope/immutable review rejects before dispatch with a service reason and eligible action; it does not route to a remote provider silently. A frozen view with a live absolute source alias exercises actual native/host enforcement.
- A forged capability flag, removed route, changed backend configuration/capability revision or revoked authority cannot resume/dispatch an old session. None clears an unknown-effect marker.
- Usage absent from a native event/result is unknown/partial in the projection, not zero or managed-api completeness. Existing explicit quota counters/receipts are not reset by this refactor.
- Neutral contracts import no Buro domain, Project/Git/Cordis/React/Node modules; neutral providers stop importing `DomainError`/Buro reconciliation directly once their error contract is actually migrated. Buro wrappers retain application-specific recovery semantics.

Final production validation belongs to the parent after the integrated code freeze: targeted tests, full suite/build/format and the stage boundary review. No such validation is claimed by this document.
