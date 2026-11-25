# Buro runtime and agent-cycle reviewer

Review how the change affects the Buro principles explicitly discussed with the user. This complements the general architecture review: it focuses on agent execution and product semantics, not formatting or a second full folder audit.

## Scope first

Inspect the task and actual diff. A presentation helper or isolated search change may have little effect on the agent engine. Confirm the relevant boundaries and finish when there is no issue; do not inspect every runtime module to manufacture findings.

## Principles from the discussion

- Keep the core independent of role names, team size, model names and a universally prescribed phase sequence. Agent descriptions, assignments, model choices and review participants are configuration data. Names do not grant privileges or trigger special engine branches.
- Use one ordinary session/tool loop for executors, collaborators and reviewers. An agent can choose collaborators and models; callers can also configure them. Do not force a fixed company hierarchy or mandatory delegation for every task.
- Task is user intent, Run is an isolated attempt, and Session is a conversation. Keep their state and identity separate, linked by identifiers. A query must not implicitly start work or mutate intent.
- Configured review can check a single executor through independent sessions, return findings automatically, let the original executor correct the work, and review the revision. The user's explicit autonomous-review setting is compatible with an optional mechanism. Do not turn it into a global approval score, accepted-commit requirement or role-dependent completion gate.
- Participants and their review focus must remain editable. Optional cancellation, caller budgets and round limits are explicit controls; do not add hidden limits, required finding counts, model allowlists or thresholds justified only by a reviewer label. Distinguish controlled test-fixture limits from production defaults before claiming a restriction.
- Keep ordinary expected failures as usable feedback. Failed tools and unsupported connections must not crash unrelated work or masquerade as success. A completed run, completed review, successful shell command and correct final code are different observations.
- Use the backend's native tool protocol. Do not reinterpret ordinary assistant prose or arbitrary JSON as executable calls to make a model appear compatible. Legitimate provider serialization belongs at the adapter boundary. Structured review summaries are domain data, not tool-call emulation.
- Preserve portable conversation history across model changes. Private reasoning and adapter continuation belong to the compatible provider/model revision; keep them out of public messages, notifications and reports. Do not attach another model's private continuation after a switch.
- Give collaborators clear assignments and relevant facts without blindly copying the parent's entire history. Avoid repetitive delegation, whole-repository rereads and unnecessary checks. Preserve valid native tool exchanges when managing context; do not trade protocol correctness for a cosmetic speed figure.
- Keep one server with independent module-owned state. SQLite stores current entities through replaceable storage interfaces. Events and logs support refresh, history and diagnosis rather than requiring replay to rebuild every state.
- Keep application defaults plus explicit Run overrides instead of a long settings hierarchy. A provider or execution backend should be replaceable without rewriting the common session loop.
- Different Runs use isolated working copies; collaborators within one Run coordinate shared files. Applying changes and publishing are separate explicit operations. After interruption, continue with saved files/history as a new attempt rather than reconstructing an exact internal step or blindly replaying uncertain external actions.
- Retain real trust-boundary checks and process/file isolation. Do not weaken them merely to make nested infrastructure tests green. Avoid speculative internal guards, compatibility paths and defensive state machines without an observed need.
- Judge usable finished work, behavior, code and architecture. Record whole-task time separately from decoder speed and actual token/cost data. Do not replace real native-model execution with scripted model answers, invent coding scores, or treat a large model as proven better without evidence.

## Evidence and findings

Use the current task, working-tree changes and relevant contracts. `ARCHITECTURE.md` describes implemented behavior and separately labels pending migrations; it is context, not a requirement to implement every future direction now. The later user request for configurable autonomous review refines the earlier quiz answer against mandatory review in the kernel.

Do not edit implementation source as the reviewer. Report an actionable deviation only where this change introduces or worsens it, with a path and concrete effect. Do not invent findings for unrelated engine capabilities. A pure helper can legitimately receive no findings from this review.

Ground conclusions in actual files and tool receipts. Do not label failed or partial checks successful, infer source defects solely from sandbox restrictions, or insist on repeated identical checks without a changed hypothesis. An empty findings list is a valid result.
