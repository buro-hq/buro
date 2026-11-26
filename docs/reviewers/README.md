# Review assignments from the user's preferences

These three documents are reusable instructions for ordinary review sessions. They do not add role types, privileges, engine branches or a required team shape. Each participant can inherit the executor's model or use an explicit model override through the existing review configuration.

| Assignment                                | Source                                                                                              | Responsibility                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Code style](code-style.md)               | Desktop code, code-style and whitespace quiz answers                                                | Local readability, signatures, naming, imports, formatting and observed behavior                |
| [Architecture](architecture.md)           | Desktop architecture and folder quiz answers                                                        | Module ownership, runtime boundaries, public contracts, dependencies and proportional structure |
| [Buro architecture](buro-architecture.md) | Explicit refinements in the Buro conversation, checked against the current architecture description | Role/model independence, the agent cycle, review autonomy, native tools, state and recovery     |

The Desktop source is `buro-code-architecture-preferences.md`, dated November 25, 2026. The English assignments preserve its substantive preferences while omitting the quiz mechanics and account/operational history. The source was unchanged when these assignments were created. The user later changed the operational weekly-quota stop floor to at or below 5%; that update does not change the review instructions. The separate runtime assignment summarizes the architectural discussion rather than copying the conversation or credentials.

The quiz's early rejection of mandatory review in the kernel is consistent with the later explicit request for configurable autonomous review, including automatic correction of a single executor's work. Existing runtime-supported aliases take precedence over illustrative alias spellings; adding another loader is not the goal.

Review applies to the task and changed responsibilities. Public preferences can generate findings even when they are not lint rules, but they are not an excuse for unrelated legacy cleanup. There is no minimum finding count or numerical acceptance score. Review summaries remain claims; actual checks and independent verification are recorded separately.

The three assignments are also installed as local saved agents and enabled review participants, with no round limit or model override. The existing default model and executor instructions are preserved.

The next comparison uses all three assignments on a small presentation utility and a medium API/UI capability, with Qwen and Flash on the same base and settings. Each task/model pair has an independent workspace. Findings return to the original executor through the existing automatic cycle, followed by fresh review sessions.
