# Large-task flow comparison

## Experiment

Compare a Buro team using official DeepSeek Flash for coordination, implementation and three independent reviewers with native Codex CLI on one full-stack feature: reusable launch presets. Both start from revision `7738a09`, receive the same task and reviewer profiles, keep isolated code, and undergo the same independent final validation. Changes remain experimental until separately reviewed and applied.

The feature spans persistent module-owned storage, public contracts, API validation, notifications, preset management, editable goal-launch options, localization and tests. Applying a preset copies values into explicit Run options; it adds neither role-specific behavior nor a runtime settings hierarchy. The [exact task](benchmarks/reusable-launch-presets.md), hashes and invocation settings are saved with the experiment artifacts.

The Buro main session delegates implementation through ordinary session tools; that instruction is scenario configuration. No model names or mandatory team shapes are added to the runtime. Review findings return autonomously for correction. Native Codex uses its normal CLI tools and an execution session, followed by three independent review sessions using the same profiles, with findings returned to the original execution conversation. Review rounds have no configured limit in either flow.

Codex uses the current local CLI selection: `gpt-6.1-sol`, high reasoning, CLI 0.172.0. This is a comparison of complete workflows, not an isolated claim about model intelligence: engines, tokenizers, context behavior and native tools differ and must be disclosed. Both final snapshots receive identical independent tests and manual assessment. Nested sandbox failures are recorded separately from final-source failures.

## Quality rubric

Scores are a reporting aid, not a runtime completion gate. Do not score unfinished dimensions as successful or invent a total before there is enough evidence. Record concrete file/code examples for each assessment.

| Dimension                               | Points | Evidence                                                                                         |
| --------------------------------------- | -----: | ------------------------------------------------------------------------------------------------ |
| Functional completeness and regressions |     35 | Observable API/UI behavior, persistence, launch semantics and existing behavior                  |
| Architecture                            |     25 | Ownership, module boundaries, public contracts, dependency direction and separation of UI/server |
| Simplicity and cleanliness              |     15 | Duplication, unnecessary abstractions/conditions, dead code, scope and dependencies              |
| Desktop preference conformance          |     15 | Three reviewer profiles, named contracts, meaningful grouping, formatting and folder conventions |
| Verification quality                    |     10 | Meaningful tests, honest tool receipts, discovery and actionable handoff                         |

Report total wall time, execution/review/correction stages, requests, native token usage, API cost where calculable, quota use where observed, and independently checked results separately from quality. Subscription Codex usage is not an API dollar bill. Include team and code-change timelines, representative code differences and full patches in the HTML analysis. Reviewer claims do not substitute for independent checks.

## Run plan

| Session                         | Flow                                                | State               |
| ------------------------------- | --------------------------------------------------- | ------------------- |
| Current                         | Buro Flash coordinator + Flash executor/reviewers   | Running             |
| Current                         | Native Codex execution + same three review profiles | Running in parallel |
| Tomorrow / next resumed session | Flash + Qwen on RTX                                 | Deferred            |
| Tomorrow / next resumed session | Pro + Flash                                         | Deferred            |
| Tomorrow / next resumed session | Pro + Qwen on RTX                                   | Deferred            |

Today uses no RTX and no Pro calls. Deferred variants are recorded, not automatically scheduled. Stop model work when actual weekly remaining capacity is at or below 5%, preserve interrupted results, finish a reviewable checkpoint, commit and push. This threshold supersedes earlier 7%, 10% and 20% floors.

## Independent code review requested

After both flows end or are interrupted, independently inspect each saved implementation against the same task and Desktop preferences. Review the actual patches, relevant module contracts and independent verification receipts without treating team reviewer claims as evidence of correctness. Record findings about functionality, architecture, simplicity, cleanliness and preference conformance with file references and representative code examples. Distinguish confirmed defects from optional improvements, source defects from environment limitations, and unfinished work from a completed failure. Add this assessment and its evidence to the comparative HTML report. This review is pending and separate from the three in-flow reviewers.

## Parallel execution update

At the user's request, native Codex now runs alongside Buro in a separate checkout. The existing Flash worker was adopted by a replacement controller without restarting or interrupting its model sessions. Flash had an initial solo stage; later host CPU/tool activity overlaps. Per-flow wall times therefore describe this practical parallel execution and are not isolated latency measurements. Independent final checks run after model work ends.

The first native setup attempt failed during account-quota preflight because the harness stripped proxy environment variables needed by the normal Codex connection. It made zero model turns. Its files are archived separately, the native worker now preserves the host's network configuration, and the corrected native run has started. This setup failure is excluded from model-quality scoring.
