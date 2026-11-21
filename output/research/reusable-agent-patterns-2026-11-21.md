# Reusable agent patterns for Buro: implementation choices

Checked 2026-11-21. Six targeted primary pages were retrieved through Firecrawl; existing repository research and Buro interfaces were inspected locally. No model, RTX, secret or original-project access occurred. This document recommends patterns and bounded integration work; no third-party source code was copied and no production behavior was changed.

## Selected approach

Keep Cordis composition, `AgentRuntime`/`ModelProvider`, scoped `ToolBroker`, workspaces, durable effect/session records and service-owned verification. Make the workflow and context/editing strategy replaceable around those boundaries.

The nearest production strategy should be one writing executor, visible service checks, a fresh independent reviewer and repair by that same executor. Coordination/decomposition and independent test discovery are additional responsibilities when the task needs them. The coordinator can remain accountable for the goal without a separate expensive model call for every administrative phase. This preserves the intended quality loop for small models.

Ordinary goals should have no aggregate request/token/time/window quota unless the user configures one. Usage recording, physical model capacity and authorization are separate. None of the source systems' experimental iteration counts or cost guards should become a mandatory Buro product ceiling by copying their defaults.

## 1. Cognition: clean review and a communication bridge

Primary source: [Multi-Agents: What's Actually Working](https://cognition.ai/blog/multi-agents-working), 22 April 2026. Its practical patterns keep one writing actor and use other agents for review/advice. The article also reports that a weak primary model struggled to recognize when to ask a stronger adviser and what context to transmit. These are vendor observations, not a controlled Qwen benchmark.

**Reuse the mechanism:** create a new review context from the current candidate, then send concrete findings to the existing writing session. Do not send the author's long reasoning transcript as evidence. Buro's production `changeContext()` currently emits names and character counts; this should be replaced with verified code/diff context or explicit retrievable references. Production repair currently returns to the coordinator; the new research controller already demonstrates same-executor repair.

**Adapt rather than copy literally:** Cognition discusses a PR critic discovering issues without the original writer/spec context. Buro's acceptance reviewer still needs the frozen goal and constraints to distinguish a missing requirement from an unrelated improvement. Clean context should mean independence from the writer's reasoning, not ignorance of required behavior.

Findings should identify a file/revision, relevant criterion or defect, evidence/reproduction and expected behavior. A communication/triage step checks scope and unresolved requirements before another edit. A reviewer preference must not create an endless style rewrite cycle; genuine ambiguity should become a durable operator request. Approval must expire if the candidate changes.

**Buro mapping:** existing review sessions, check receipts and `WorkerEnvelope`/assignment data; a versioned review-evidence view; route repair to the original executor. No new framework is needed. Integration cost: medium because freshness, role/session identity and resume semantics need tests. Do not delegate escalation solely to a 4B worker; use observed failures and authorized capability routing too.

## 2. Aider: separate solution reasoning from edit serialization

Primary source: [Separating code reasoning and editing](https://aider.chat/2024/09/26/architect.html), 26 September 2024. Its architect describes a solution and an editor produces a supported edit format. The historical benchmark includes different same-model pairs and edit formats, but adds inference and does not establish equal-compute gains for our local models.

**Reuse the mechanism:** test an editing strategy in which the model receives exact relevant current code and proposes data for one concrete change. The service applies it. An optional stronger reasoner can supply the solution when the small editor needs it.

For small files/functions, a replacement containing a stable file ID, expected source hash and new content may be easier than emitting exact old/new strings or a large tool graph. For larger files, use scoped replacements or patches. Choose formats by measured model capability rather than force one global format. Full-file output can itself exceed output capacity; it is not a universal format.

**Buro mapping:** `ModelProvider` for proposal generation and the existing `ToolBroker` for validated application. Scope, protected paths, preimage identity, unique action IDs and durable unknown-effect handling remain service-owned. The model must not gain a raw host-write path merely because it returns a patch. Existing exact-match `edit_file` remains a comparison strategy.

Integration cost: low-to-medium for a research strategy, medium for production recovery and large-file support. Do not impose architect+editor as two required calls on every task. Compare direct edit, same-model two-stage edit and stronger-architect/small-editor only when that model/data route is authorized.

## 3. mini-SWE-agent: minimal action loop and inspectable trajectories

Primary source: [mini-SWE-agent documentation](https://mini-swe-agent.com/latest/), current v2 documentation. It describes a bash-only interface, independent subprocess actions and linear message history. Its small agent class excludes model, environment and product infrastructure.

**Reuse the mechanism:** an understandable action/result loop, explicit completed process results and a trajectory that can explain what the model actually saw. Buro already has much of the required action journaling and process/environment separation. A minimal external executor is a useful baseline to determine whether our additional context/protocol layers help or obstruct a model.

**Do not copy the permission model:** arbitrary bash would widen the managed broker's current command authority. A mini backend must run in an explicitly isolated environment with no credentials and declared capabilities, with Buro still evaluating its output. A backend's hidden model requests cannot be reported as fully metered managed requests.

Also do not make a complete linear history the only model view. It is useful for a baseline and debugging, but cannot remain the prompt forever on a small context window. Keep a full trajectory while projecting the active context separately.

Integration cost: low for an independent benchmark adapter, higher for production cancellation, recovery and authority parity. No advantage over Buro on the same model/tasks is established by the documentation.

## 4. Anthropic: durable session separate from active context and execution

Primary source: [Managed Agents architecture](https://www.anthropic.com/engineering/managed-agents), current 2026 article. It separates the session event log, replaceable agent loop and execution environments. It explicitly allows the loop to select historical event ranges instead of equating session storage with the model prompt. The architecture is hosted infrastructure evidence, not a small-model coding benchmark.

**Reuse the mechanism:** preserve the complete durable record, then build a versioned context view for each step. Buro already privately archives messages and provider continuation. The next layer should retrieve selected service-observed facts/tool receipts and current file chunks through permission checks rather than depend only on a short handoff.

A conceptual view contains frozen criteria and scope; current workspace/file revisions; relevant source/diff; observed failures; selected evidence references; and a completeness marker. It must identify historical observations as historical. A missing required input requests another view or narrower task, rather than silently dropping constraints or permanently failing because an archive count reached four.

Current `prepareManagedRequest()` validates the same conservative UTF-8-byte estimate even when a different request policy is injected. An actual token estimator therefore needs a trusted adapter/contract change, not merely another policy implementation or a guessed lower multiplier. Preserve opaque provider continuation where protocol correctness requires it. Do not expose private reasoning or credentials through a public history API.

Integration cost: medium. First improve review input and fact retrieval; then test context rotation at settled boundaries. Removing a model-assisted closing handshake requires explicit tests for unresolved tool-result chains, interrupted generations and provider continuation. Durable state and sandbox/private credentials should remain independent of context formatting.

## 5. OpenHands: optional backend and context-management reference

Primary source: [OpenHands Software Agent SDK overview](https://docs.openhands.dev/sdk), current documentation. It exposes Python/REST interfaces, predefined coding tools, remote execution and automatic context compression. The overview does not specify a condenser algorithm or prove that its summaries preserve our required facts.

**Reuse now:** its separation of agent behavior, environment and model, plus its context-management facilities as implementation references. Evaluate a pinned SDK version behind an `AgentRuntime` adapter or a small subprocess/REST boundary; do not introduce Python/SDK types into core.

**Integration gate:** map action IDs, lifecycle events, actual model settings, token-accounting coverage, cancellation and unknown outcomes. Verify sandbox permissions, protected paths and credential separation. Buro's checks/fresh review remain independent of the backend's own completion claim. Condensation must be tested on criteria retention, tool dependencies and stale code, not adopted because the overview advertises it.

Integration cost: medium-to-high; it is a later comparison/backend spike, not the first fix. The SDK overview states MIT licensing, but exact package versions and their license files must be checked before importing code or distributing a bundled backend. No source was imported here.

## 6. Agentless: localization, candidates and visible-check selection

Primary source: [official Agentless repository](https://github.com/OpenAutoCoder/Agentless), observed 2026-11-21. Its pipeline localizes an issue from files to symbols/edit locations, samples patches, and ranks surviving candidates using regression/reproduction tests. The README contains historical benchmark results, not an up-to-date matched comparison with Buro.

**Reuse the mechanism:** turn broad discovery into a concrete editing packet and evaluate multiple isolated candidate patches when useful. Add this as a fourth control: one executor spends comparable inference on self-debugging or separate candidates instead of role coordination.

Use only visible service checks for candidate selection. Hidden evaluation outcomes are measured after selection and must never choose the winner. Generated reproduction tests need validation; an LLM-provided expected answer is not truth. Candidates require separate workspaces and scope validation before integration.

Integration cost: medium. Existing worktree/check/evidence ports already cover much of the infrastructure. The repository advertises an MIT license link; verify its full license at a pinned revision before copying implementation. A method-level reimplementation from the published description is the initial recommendation.

## Implementation order and proof gates

1. Keep core and Cordis. Introduce optional aggregate quotas independently from accounting, including all hidden per-turn/session/repair/window counters; new unlimited mode must not be simulated with huge numbers. Preserve prior-run policy/counters and unknown effects.
2. Port complete verified review input and same-executor repair from the research flow. Prove a public-check-passing defect can be caught, repaired and freshly reviewed without granting extra rights.
3. Add versioned context views and accurate request-footprint reporting. Replace terminal context/window count failures with context selection or scoped continuation where outcomes are settled. Test recovery before removing handshakes.
4. Compare edit interfaces with the same model and initial facts. A small model's inability to use a complex protocol is a different failure from inability to produce the code.
5. Compare the quality loop, optional architect/editor, and compute-matched candidate/self-debug baselines on repeated real issues. Measure final accepted code/regressions, actual inference, elapsed time and interventions. Equal maximum allowances alone do not isolate role value.
6. Consider an OpenHands or mini executor adapter only after that comparison identifies a concrete missing capability or measured benefit.

The recommended stack is therefore Buro's existing durable/scoped foundation, a small replaceable execution strategy, verified context views, one writer with independent criticism, and optional model/editing backends. Scope/correctness checks remain mandatory; default resource quotas do not. This is a best-supported implementation choice for the current product and observed failures, not a claim that the architecture is globally optimal or that a same-model 4B team will necessarily succeed.

## Source and reuse boundary

Exactly six public pages were fetched; no repository clone or third-party code copy was performed. Cognition/Anthropic articles are architectural references, not reusable runtime packages. Aider/mini implementation licensing was not verified in this pass, so no vendoring recommendation is made. OpenHands/Agentless publish MIT statements/links on the retrieved pages; package-specific and pinned-revision license verification remains a gate before actual code adoption. Benchmarks cited by those pages are not silently promoted to our model/hardware/configuration.
