# Independent review: equal agent backends

[Private-project evaluation details removed.]

## Selected principle

Codex is one selectable agent backend, alongside a managed backend or an optional external harness. No backend owns Buro orchestration by virtue of its identity. The same host workflow assigns coordinator, writer and critic roles, runs trusted checks, verifies scope/evidence and accepts a revision independently of the selected backend.

Equal eligibility does not mean identical implementation capabilities. A ModelProvider produces model responses; an AgentBackend manages an agent session and its effects. Keep these separate. ManagedBackend uses the model/tool loop and a ModelProvider internally. Codex app-server and an external harness implement the backend boundary directly; do not force them into fake one-completion providers.

Subsequent user clarification: planned task paths are advisory by default within the working copy, with strict enforcement explicitly selectable. Capability admission checks that effective mode, not a mandatory strict-path requirement. Host/private-data boundaries, read-only criticism, exact accepted revision identity and unknown-effect reconciliation remain independent requirements.

## Existing source couplings to remove

| Source | Current behavior | Target |
| --- | --- | --- |
| `protocol/resources.ts:85–93` | Reserves `codex` and admits one fixed native definition, versus configurable managed IDs | Multiple explicit backend configurations with ordinary identities; backend-specific configuration remains adapter-owned |
| `protocol/resources.ts:127–130` | Setup accepts only managed definitions | Configure all supported backend types through the same application catalog; UI capabilities may differ honestly |
| `adapters/files/resource-configuration.ts:81–98` | Codex is the bootstrap profile and default for all three roles | User-selected or transparently proposed available backend; no mandatory Codex coordinator/reviewer or silent fallback |
| `adapters/resources/runtime-resources.ts:130–178` | Composition branches on Codex versus managed; Codex model/options are service-level and its public resource has no model field | Branching belongs in adapter construction, not role logic; save each backend's effective immutable identity and available model selection |
| `core/execution.ts:339–344`, `:862`; `protocol/schema.ts:516–517` | Planning policy depends on `coordinator.client === 'managed'` | Host planning policy depends on required capabilities and explicit strategy, not a brand/client label |
| `core/execution.ts:168–176` | Prepared check isolation is required when any selected resource is managed | Host-owned check isolation policy applies consistently across backends; do not weaken checks for native clients |
| `core/execution.ts:345–362` | Aggregate usage ledger is created only for managed resources | Always retain backend operation/coverage receipts; record opaque native usage as unknown, not zero or fabricated exact counts |
| `core/runtime-router.ts:198–225` | Special pre-router Codex restore path | Remove at the clean contract cutover; new backend sessions all recover through the same host identity/reconciliation rules |
| `core/ports.ts:60–95` | AgentRuntime is common but includes project/run/workspace/assignment domain data and optional untyped capabilities | Extract a domain-neutral AgentBackend; retain a Buro application wrapper and explicit capabilities |

A configured user preference for Codex is not an architectural privilege. A default that appears automatically because no other backend was configured must remain visible and replaceable; it cannot bypass eligibility, data policy or validation. Do not preserve pre-release singleton/legacy behavior merely for compatibility.

## Authority differences must remain visible

`adapters/codex/runtime.ts:140–146` explicitly rejects tools-free turns. Its workspace-write sandbox (`:188–197`) is broader than ManagedBackend's assignment ToolBroker, and its start signature does not consume the router's assignment path restrictions. A frozen planning brief or a prompt asking for restricted writes does not implement an enforced tool policy.

`adapters/environments/executors.ts:264–266` treats `options.agent` as a trusted controller and bypasses the generic process launch confinement. That assumption cannot be extended to a new harness simply because it implements AgentBackend. Each adapter must have an explicit, tested confinement owner; the host must refuse an operation whose required read-only/path/command/network policy the backend cannot enforce. Final changed-file rejection remains necessary evidence validation, but is not a substitute for preventing unauthorized effects.

Represent capabilities at their actual granularity: host-mediated tools, backend-owned tools, tools-free operation, enforced read-only/path scope, structured result support, incremental output, cancellation acknowledgement versus confirmed termination, durable resume, continuation, usage dimensions/coverage and reconciliation. Do not advertise one generic `supportsTools` or `supportsCancel` flag as sufficient. Capabilities belong to a pinned backend configuration/version and environment; protocol support is not proof that the currently launched process enforces it.

Backend eligibility can differ for a particular role. If a strategy requires a tools-free planning call, an incapable backend is rejected for that strategy or an explicitly selected alternative strategy is used. It is not globally barred from coordinator duties because of its name, nor silently given broader authority. A critic needs fresh read-only context regardless of model/client. Any change of backend/model/data destination is a visible host decision respecting user pins and policy.

## Session and journal contract

The host issues opaque authority and durable operation IDs. A backend must never mint broader authority, silently pick another backend, or decide that its own success implies Buro acceptance. The AgentBackend contract should normalize lifecycle/outcome semantics without pretending that every native internal action is host-journaled.

For host-controlled effects, committed intent precedes dispatch and the journal records observed results or unknown outcomes. For backend-owned effects, record the enclosing dispatch plus declared visibility/control coverage; exact internal tool/model receipts may be unavailable. Unknown outcome is not failure with permission to retry. Acknowledging interrupt, closing a stream and confirming a process stopped are separate facts.

Buro's generic journal adapter participates in the same authoritative SQLite transaction as run state, incremental usage, events and command receipts. A backend adapter must not create an independent authoritative session/usage database and later synchronize summaries. Private native continuation may use protected artifacts referenced transactionally; restoration must preserve effective provider/model/endpoint/data-policy identity. The new-contract recovery guarantee applies equally to every backend that claims it; unsupported durable resume must be explicit and eligibility checked.

No exact whole-run request/token/cost cap can be promised for opaque internal API traffic. Optional caps are supported only for their declared controllable dimensions. Off-by-default aggregate quotas do not remove permission, per-request integrity or unknown-effect safeguards.

## Extraction and acceptance gates

Keep backend contracts domain-neutral; ManagedBackend's execution loop and provider adapters can be reused independently. Codex and optional harness adapters use the same public AgentBackend contract, with adapter-specific dependencies and explicit exports. Buro retains team planning, repository tools, worktrees, checks, review, integration and acceptance for every backend. Avoid a separate privileged Codex coordination path or a harness importing Buro's domain to become usable.

A fourth `@buro/agent-adapters` package is justified by the explicit requirement to share native/harness clients with a second host. Keep `agent-runtime` focused on the managed loop and `model-providers` on model API transports. Adapter subpaths such as Codex and an optional mini-SWE process bridge should depend on neutral contracts, not Buro or each other. Platform-specific Node/process support can be explicit; optional Python dependencies must not be installed, loaded or launched by importing another adapter. Hosts supply or explicitly configure executable, transport, credentials and confinement. An adapter must not discover Buro projects or silently read application-global configuration. Verify packed exports and dependency isolation; the current source cannot simply be moved unchanged.

Required tests before activation:

- Run the same fake host workflow with interchangeable capable backends; no coordinator/writer/critic decision branches on backend name or `client` label.
- Verify every role accepts any capability-compatible configured backend and respects fixed user pins, local-only policy and saved immutable identity.
- Reject missing capabilities actually required by the effective assignment policy before dispatch; strict planned-path enforcement is opt-in. Prove host/read-only and any configured strict scope with an adversarial backend, not model promises.
- Verify trusted check isolation does not depend on managed/native identity and no generic `agent` flag grants arbitrary harnesses trusted-controller authority.
- Exercise streaming, interrupt acknowledgement, confirmed cancellation, cooperative yield, crash recovery, duplicate/conflicting receipts and unknown internal effects according to declared capabilities.
- Show native/opaque usage as unknown with coverage; do not pass a managed-only cap as a whole-system guarantee.
- Pack/install an independent consumer with fake backends/providers outside source aliases; enforce package dependency rules and no Buro domain imports.

These are target gates. The source still contains the distinctions listed above; equality is not implemented by renaming AgentRuntime or moving its existing file into a package.
