# Buro: agent workflow and architecture research

Date: 2026-11-21. This is a design proposal after primary-source research and a local implementation audit. Production resource defaults are not changed by this document. The user requires **no default aggregate hard ceilings** in ordinary product runs; explicit user-configured limits remain possible. Experiment ceilings are separate.

## Decision

Keep Buro's model-independent execution foundation. Rework workflow, context delivery and resource-policy semantics before expanding the agent hierarchy. The nearest production candidate is **one writing executor, service-owned verification, an independent fresh reviewer, and repair by the original executor**. Add coordination, independent test discovery, decomposition and additional workers when their contribution is justified. This retains the quality-improvement goal for small models. It does not make a single coordinator the only actor or remove fresh review.

The multi-agent idea is established. Evidence supports execution feedback, independent checking and appropriately divided work; it does not establish a universal gain from running more role prompts or from a team of identical 4B models. We found no directly matched-compute demonstration of the proposed Qwen4B/9B team on real repository issues. This is an open empirical target, not a proven product claim.

## Existing approaches and what transfers

| Approach / primary source | What exists | Useful for Buro | Limit of the evidence |
| --- | --- | --- | --- |
| [Cognition: Multi-Agents: What's Actually Working](https://cognition.ai/blog/multi-agents-working), April2026 | One writing agent with separate review/advice; clean-context review loops; manager/child delegation | Independent reviewer and same-writer repair; distinguish a capable router from a weak worker deciding whether it needs help | Vendor-reported production observations, not a matched-budget Qwen benchmark. Their weak-primary Smart Friend experiment retained a quality ceiling despite speed/cost improvements |
| [Aider architect/editor](https://aider.chat/2024/09/26/architect.html),2024 | Reason about the change separately from producing its edit format, including same-model combinations | Compact assignment and an editing interface a small model can reliably use | Historical editing benchmark, extra inference, not equal-budget evidence for our local model |
| [AgentCoder](https://arxiv.org/html/2312.13010v3),2024version | Programmer, independent test designer and execution feedback | The closest precedent for our proposed quality loop | HumanEval/MBPP functions rather than repository maintenance; extra generation/iterations. Its generated tests are not perfectly correct |
| [Agentless](https://arxiv.org/html/2407.01489v1),2024 | Structured localization, candidate patches, executable filtering and ranking | Typed task/data flow and an alternative candidate-selection baseline | Historical SWE-bench/model settings; not proof it currently outranks Buro under identical conditions |
| [mini-SWE-agent](https://mini-swe-agent.com/latest/) | A compact linear coding-agent loop and reusable evaluation tooling | Minimal harness baseline; avoid mandatory organizational ceremony | A small core is not the complete infrastructure/product, and the harness still depends on model capability |
| [OpenHands SDK](https://docs.openhands.dev/sdk) | Reusable agent tooling, context management and execution environments | Potential execution adapter or external comparison backend | Framework features/leaderboard statements are not a controlled comparison against our workflow |
| [Cursor: self-driving codebases](https://cursor.com/blog/self-driving-codebases),2026 | Final design uses a root planner, scoped recursive subplanners and isolated workers returning a handoff to the owner | Ownership boundaries, scoped work and explicit handoffs | Large-resource throughput experiments allowed transient broken states; not our accepted-code guarantee or a single3060 deployment. Their intermediate overloaded-executor design was not the final architecture |
| [Anthropic Managed Agents](https://www.anthropic.com/engineering/managed-agents),2026 | Separates durable sessions, replaceable agent harnesses and execution environments | Session history distinct from the active model prompt; stable ports around replaceable strategies | Hosted infrastructure design, not evidence that a small local coding team performs better |

The broader controlled [Scaling Agent Systems study](https://arxiv.org/abs/2512.08296v3) finds architecture/task alignment matters: coordination can help decomposable tasks while adding overhead on sequential/tool-heavy work. It is not a Qwen repository-coding study. The [Anthropic multi-agent research system](https://www.anthropic.com/research/multi-agent-research-system) evaluates research, not coding; its reported gains and token multipliers should not be transferred to Buro.

The supporting source reviews retain additional task/model/budget caveats:

- [Coding systems](../output/research/coding-systems-2026-11-21.md).
- [Controlled evidence and failure studies](../output/research/team-evidence-2026-11-21.md).
- [Local Buro architecture audit](../output/research/buro-workflow-review-2026-11-21.md).

## What our measurements actually establish

[Private-project evaluation details removed.]

The local audit identified concrete reasons to change workflow:

1. Production `changeContext()` currently sends paths and before/after **character counts**, not the code/diff. The reviewer is instructed to read the actual repository. Re-exploration is partly caused by missing input, not merely inefficient model behavior. The new research controller supplies verified current code and changes.
2. Production check/review repairs return to the coordinator. The new research controller returns concrete findings to the original executor and freshly reviews the resulting revision.
3. `estimateManagedRequest()` counts UTF-8 bytes plus message overhead as a conservative upper estimate. A `MODEL_CONTEXT_EXHAUSTED` admission rejection before HTTP does not prove the physical Ollama window is full. Real tokenizer/provider accounting needs separate investigation; arbitrary lower estimates are not a safe fix.
4. Segment closure and final serialization consume model requests. A fixed three-tool-round rotation/four-window lifetime can terminate work without a patch. These policies must be evaluated per model and replaced by state/context-based behavior where appropriate.
5. The fixed24-request benchmark gate and the larger production run ledger have different remaining allowances. This explains why a correct DeepSeek candidate could reach service checks but fail to finish review. It does not justify removing required review or marking that run accepted.

These are workflow/context contracts and policy issues. Switching orchestration frameworks or distributing the service would not by itself fix them.

## Proposed execution design

### Stable foundation

Retain projects/goals/runs, role catalog and session identity; scoped workspaces/tools; provider/runtime ports; durable effect/check journals; independent evidence and final acceptance. Keep GPU inference reachable through HTTP independently of repository execution. These are useful product assets and boundaries even if the agent strategy changes completely.

Separate three concepts explicitly:

- **Durable session:** full private execution history and effects with recovery provenance.
- **Context view:** a selected, versioned projection of facts needed for the next step. Archive selection must not erase history or quietly discard required constraints.
- **Workflow strategy:** who receives a task, which evidence they see, how findings produce repairs and when the goal is complete. This should be replaceable behind the core's permission/effect boundaries.

### Default quality loop

Start with one scoped writing executor. Provide exact relevant current file content, APIs, criteria and known check failures. Run service-owned checks. Give a fresh critic complete verified changes and those check receipts; allow a typed request for missing context when the evidence is incomplete. Return concrete findings to the original executor. Recheck any changed revision and independently review it again.

The coordinator remains responsible for the goal, but a separate expensive language-model planning/integration call need not exist for every small step. For complex work it creates dependency-aware task contracts, owns unresolved decisions and selects authorized specialists. Independent test discovery is useful when it adds missing cases; it should not fabricate correctness by supplying an unchecked expected answer.

For small models, prefer explicit task and file identifiers, narrow edit interfaces and service-generated context packets. Do not rely on a4B worker being able to diagnose its own need for a stronger model. Routing/decomposition should use observed failures and capability evidence, respecting local-only and user-fixed model preferences. Fresh sessions of the same model have correlated errors; independent context is useful but does not turn agreement into proof.

### Alternative to evaluate

Add several isolated candidate attempts with visible-check selection, then fresh review. This tests whether extra inference is better spent on a team or on additional candidate generation/self-debugging. Selection must never see hidden test results. Avoid implementing a large global task DAG before smaller workflows show measurable value.

## Resource policy: no default aggregate hard stop

The user requirement is to avoid self-imposed product ceilings unless configured explicitly. Proposed behavior:

| Concern | Default product behavior | Optional user control |
| --- | --- | --- |
| Goal-wide request/token/time/session totals | Observe and display; no aggregate stop quota by default | Explicit request, spend, elapsed-time or session ceiling |
| Real context and GPU memory | Select context/chunks and schedule inference within measured model/hardware capacity | Context preference or concurrency setting within supported capacity |
| Repetition/no verified progress | Diagnose, request missing evidence, replan, change authorized strategy/model or surface a real blocker | Optional aggressiveness/cost preference; no hidden fixed repair counter masquerading as unlimited |
| Transport stall or unknown action | Preserve state and distinguish missing response from known failure; never blindly replay an unknown effect | Explicit recovery policy where provider/effect semantics support it |
| Source authority and result acceptance | Always preserve permissions, protected files, evidence freshness, checks and review | Changes to authority must be explicit; no budget setting grants more rights |
| Research comparison | Explicit finite ceilings and recorded actual usage | Chosen experiment configuration, separate from product defaults |

Usage accounting is not a quota. Keep the durable accounting/history and make enforcement conditional on the user policy. Review reserve is meaningful when an explicit finite envelope exists; unlimited aggregate work does not need an arbitrary withheld request allowance. Per-request output/context settings should follow actual model/API capacity and task needs, not become an unexplained goal-wide resource ceiling.

Migration needs a versioned policy: represent absent optional caps deliberately, rather than use enormous numbers or JSON Infinity. Existing runs keep their historical counters, receipts and explicit frozen limits; new behavior must not reset usage or automatically replay interrupted effects. A requested change to a running goal's cap needs its own auditable transition. Current production defaults remain unchanged pending that implementation.

## Validation and next implementation sequence

1. Correct measurement labels: conservative admission vs actual context; forced team vs automatic route; observed tokens vs monetary billing. Preserve failed trials.
2. Introduce versioned opt-in aggregate quotas while keeping usage/effect accounting independent. Audit hidden request/repair/window counters so the default does not stop a healthy goal through another ceiling.
3. Port verified review input and same-executor repair from the research controller into production behind an explicit strategy revision. Preserve fresh review and evidence-staleness checks.
4. Improve context views/token admission and remove needless model-assisted bookkeeping where a settled service observation suffices. Test recovery and provider-continuation boundaries before changing segment rotation.
5. Evaluate executor/checks; executor/critic/repair; coordinator/test-author/team; and a compute-matched extra-candidates/self-debug baseline. Use multiple held-out real issues and repeated trials. Report accepted changes, regressions, elapsed time, actual tokens and human interventions, not agent count. Equal maximum allowances alone do not prove equal compute or the causal benefit of roles.
6. Repeat on RTX3060/Qwen3.5 9B only when the user reports it available. Verify model digest, settings and GPU residency. A successful Mac4B test verifies a mechanism; it does not imply a guaranteed speed or quality gain on different hardware/model.

The new three-variant research runner is documented in [TEAM-QUALITY-EXPERIMENT.md](TEAM-QUALITY-EXPERIMENT.md). Its finite ceilings are experimental controls. Its fixed queue-reference expectations and single small task are deliberately limited; they do not prove arbitrary test generation or the complete product hypothesis.

## Implementation and latest local evidence

The prepared experimental slice was committed as `77a016e` and passed605default tests, production build/typecheck and independent review. A same-model Mac smoke then ran all3variants: executor/checks12generations/1edit/78s; executor/review10/0/40s; coordinator/test-author/team11/0/58s. None reached independent review or passed the final oracle. Outcomes were conservative context admission or the four-window worker ceiling, not the global24generation envelope. Thus this pilot cannot measure the quality contribution of review, and reinforces the need to audit self-imposed context/window restrictions before judging model ability. RTX remained untouched. The full evidence is linked in [the experiment document](TEAM-QUALITY-EXPERIMENT.md).
