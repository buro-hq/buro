# Buro: context and independent second-opinion request for Kimi / GLM

Prepared November 26, 2026. This is a self-contained handoff, not a transcript. Answer the user in Russian; keep repository code, comments, documentation and identifiers in English. Russian localization and intentional Unicode test data are exceptions.

## Local files and ready-to-paste instruction

All handoff files are inside the project:

- Repository: `/Users/redzumi/Desktop/projects/buro`
- Main context: `/Users/redzumi/Desktop/projects/buro/docs/handoffs/buro-context-for-kimi-glm.md`
- Source excerpts: `/Users/redzumi/Desktop/projects/buro/docs/handoffs/buro-source-excerpts-for-kimi-glm.md`
- Complete handoff archive: `/Users/redzumi/Desktop/projects/buro/docs/handoffs/buro-kimi-glm-handoff-2026-11-26.zip`

Ready-to-paste instruction:

```text
Review the Buro project independently.

Repository: /Users/redzumi/Desktop/projects/buro
First read: /Users/redzumi/Desktop/projects/buro/docs/handoffs/buro-context-for-kimi-glm.md
Then read relevant code excerpts: /Users/redzumi/Desktop/projects/buro/docs/handoffs/buro-source-excerpts-for-kimi-glm.md
Full selected source, experimental patches and evidence: /Users/redzumi/Desktop/projects/buro/docs/handoffs/buro-kimi-glm-handoff-2026-11-26.zip

Assess the architecture, agent workflow, experiment validity, code quality, speed and cost. Separate observed facts from hypotheses and untested forecasts. Challenge the previous assistant's 81/98 scores and speedup estimates.

Propose a minimal prioritized improvement plan. Preserve configurable models, instructions and teams rather than adding hardcoded roles or hidden limits. Initially provide analysis and a plan without starting paid model runs.

Answer in Russian; project code and documentation remain English.
```

These are local Mac paths. A cloud chat without filesystem access cannot open them merely from the text: attach the named Markdown files or the archive. Do not claim to have read unavailable files.

## 1. What I want from you

Independently assess this project and the evidence below. Challenge the previous assistant's conclusions, scoring and proposed changes. Do not merely repeat them. Separate observed facts, hypotheses, engineering preferences and untested estimates.

First response requested:

1. Your assessment of Buro's practical potential and its largest current weaknesses.
2. Which conclusions the experiments support, and which they do not support.
3. A prioritized, proportionate implementation plan focused on reliability, cost, speed and code quality.
4. A concrete design for shared policy, project context, parent instructions and collaborator assignments that avoids accidental recursive delegation while preserving intentional collaboration.
5. How to improve tools, context, review and measurement without adding hardcoded roles, hidden limits or a new orchestration framework.
6. A small, inexpensive experiment that could falsify your proposed improvement, including which observations to record.
7. An honest estimate of likely gains, explicitly identifying unsupported precision or missing evidence.

This initial request is for analysis and a plan. It is not an instruction to spend money on new model runs. If the user subsequently asks you to implement and provides repository access, inspect the actual code, make the smallest coherent changes, test the behavior, self-review and save a reviewable Git checkpoint.

If you only receive this document, do not pretend you inspected the repository or executed tests. Use the supplied observations and excerpts, then request only the specific source files needed to resolve remaining questions. The companion source excerpts and archive provide code when available. The user's localhost report URLs are not accessible from a separate cloud chat; use the attached Markdown/source files instead.

## 2. Product intent

Buro is a modular coding-agent workbench. A user describes a result; the system runs work in an isolated checkout, supports collaborators and model selection, records activity and code changes, and can perform configurable independent reviews with autonomous correction. Local and cloud models can be combined. Native Codex can also be a backend.

The practical aim is useful finished changes that follow the user's code and architecture preferences, with understandable cost, time and provenance. A large number of agents, review reports or green tests is not itself success. We are investigating whether hybrid workflows can offer a useful quality/cost/time tradeoff; that benefit has not yet been established.

The user wants autonomy and flexibility. Agents, names, instructions and model assignments should be data. The execution kernel should not depend on role names, a fixed team size, one provider or an obligatory phase sequence. Meaningful trust-boundary validation and process/file isolation remain necessary.

## 3. Repository and current state

- Repository: https://github.com/buro-hq/buro
- Local checkout during the experiment: `/Users/redzumi/Desktop/projects/buro` on macOS.
- Branch: `master`.
- Handoff source checkpoint: `8d6fb1f` (completed comparison and independent review). The handoff itself is a later documentation-only change; identify its actual HEAD if working in the repository.
- Large experiment code baseline: `7738a09` in separate experimental checkouts.
- The generated preset implementations were NOT applied to the main product source. Their full patches/source snapshots are experimental results.
- Both large flows have ended. No new Pro/Qwen combination is running.
- Deferred variants: Flash + RTX Qwen, Pro + Flash, Pro + RTX Qwen. They were requested for a later session, not automatically scheduled.
- The user allowed the RTX machine to be switched off. Do not assume it is online.

Main references in the repository:

- `docs/LARGE-FLOW-COMPARISON-2026-11-26.md`
- `docs/LARGE-FLOW-INDEPENDENT-REVIEW-2026-11-26.md`
- `docs/benchmarks/reusable-launch-presets.md`
- `docs/reports/large-flow-comparison-2026-11-26.html`
- `docs/PREFERENCE-REVIEW-COMPARISON-2026-11-25.md`
- `docs/LOCAL-MODEL-OPTIMIZATION-2026-11-25.md`
- `docs/reviewers/code-style.md`, `architecture.md`, `buro-architecture.md`
- `docs/CODE-STYLE.md`

Ignored local experiment artifacts: `artifacts/large-flow-comparison-2026-11-26/` and `artifacts/preference-review-comparison/`. They contain raw evidence, private continuation/history and isolated workspaces; do not publish or upload those directories wholesale. This handoff package includes selected source and public evidence, not credentials or private model reasoning.

## 4. Current architecture and places to inspect

```text
agent/                     portable model/tool contracts and HTTP providers
modules/
  application/             composition and resource ownership
  tasks/                   user intent
  runs/                    isolated attempts and optional review cycle
  sessions/                portable conversations and the common execution loop
  agents/                  reusable descriptions and collaborator tools
  models/                  configuration, catalogue and transport registration
  engines/                 portable model backend and native Codex backend
  commands/                command tools and OS sandbox
  storage/                 replaceable stores, SQLite primary
src/                       browser UI, partly legacy layout, FSD for new responsibilities
shared/contracts/          contracts genuinely shared across server/UI
  review.ts
  index.ts
tests/                     separate unit/integration/e2e tests and fixtures
```

Task, Run and Session are distinct entities linked by ids. Modules own their state; SQLite stores current entities. Queries/commands use direct interfaces; events notify views to refresh. There is no general declarative workflow DSL. Runs have isolated worktrees; collaborators within a Run share its workspace. Applying changes and publishing are separate actions.

Important files:

| Concern                                                          | Source                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| Collaborator creation, wait and follow-up                        | `modules/agents/session-tools.ts`                        |
| Shared-background wording                                        | `modules/sessions/instructions.ts`                       |
| Session creation, completion, tool execution and model switching | `modules/sessions/session-service.ts`                    |
| Bounded request-context view                                     | `modules/sessions/context.ts`                            |
| Run-level settings and initial instructions                      | `modules/runs/run-service.ts`                            |
| Configurable review and correction                               | `modules/runs/review.ts`                                 |
| Defaults                                                         | `modules/settings/defaults.ts`                           |
| Backend contract and single-prompt usage capability              | `modules/engines/backend.ts`, `model-backend.ts`         |
| Provider registration                                            | `modules/models/transports.ts`                           |
| Native Codex integration                                         | `modules/engines/codex-backend.ts`                       |
| Command execution and isolation                                  | `modules/commands/command-tools.ts`, `native-sandbox.ts` |
| Compact Node test output                                         | `tooling/test-reporter.mjs`                              |

### The observed instruction-inheritance risk

The current collaborator creation includes:

```ts
modelId: modelId ?? parent?.modelId,
instructions: instructions ?? agent?.instructions ?? parent?.instructions,
context: parent?.context,
```

So an inline collaborator without explicit instructions or a selected description inherits the parent's instructions. In our large scenario those instructions told the main session to coordinate by delegating implementation. Some children inherited that instruction and delegated again.

The Run entry point chooses instructions as follows:

```ts
instructions: input.options?.instructions ?? history?.instructions ?? settings.instructions,
```

Session creation itself does NOT silently add application settings:

```ts
instructions: input.instructions ?? '',
```

`sessionInstructions` concatenates supplied instructions and a labeled background block. It explicitly says the shared background is not the current assignment, but that wording did not prevent the observed behavior.

Do not assume that deleting the parent fallback alone preserves all common policy. Trace where shared user rules are owned and passed. Propose a simple explicit contract for shared policy versus a parent's particular assignment. Preserve intentional nesting and user-supplied descriptions; model/role-name branches or fixed recursion/team-size ceilings are not the requested solution.

### Existing capabilities to preserve

- An ordinary session/tool loop serves main agents, collaborators and reviewers.
- `session_start` can choose a model. Without an explicit model it inherits the parent model.
- Review participants have editable names/instructions and an optional `modelId`; omitted review model inherits the executor model.
- Review is configurable and optional. The user's enabled scenario sends actionable findings back for automatic correction, then fresh reviews.
- Review rounds can be unlimited (`maxRounds: null`). Do not turn a reporting score into an execution gate.
- `session_wait` waits for the collaborator's turn; do not assume all excess calls were a short-poll timeout bug.
- Provider-native tool calling is required. Do not parse prose or arbitrary JSON into executable tool calls.
- Private continuation/reasoning is scoped to compatible provider/model revisions and is not public transcript content.

## 5. What has already been fixed

Do not redo these as if they were still pending:

1. Structured review schemas were omitted from instruction-style response transports in an earlier run. The generic schema-delivery repair is committed; native schema transports and instruction transports are tested separately. It is not a text-to-function-call workaround.
2. Context sizing was repaired: UTF-8 serialized bytes, tools/schema overhead and output reserve are considered; complete tool exchanges stay intact; measured single-prompt usage can raise the tokens-per-byte estimate.
3. That calibration is enabled only for backends declaring `inputUsageScope: 'prompt'`. Native turn/thread totals must not be interpreted as a single prompt. Instrumentation wrappers must preserve this capability.
4. This sizing remains an estimate, not an exact tokenizer or a guarantee for all future text. Full stored history and files remain intact when a smaller view is sent.
5. A compact Node test reporter preserves failures, paths, diagnostics, stdout/stderr and the real exit status while suppressing ordinary passing-test noise. In one captured suite it reduced output bytes by about 83%; this is NOT an 83% reduction in cost or wall time.
6. The generic context repair passed 135 root tests when implemented. Later experimental checkouts have different test totals; do not combine them into one claimed root result.

Broader tool-output retrieval/compaction, a visible per-run money budget, improved instruction ownership, adaptive reasoning/model selection and parallel snapshot reviews are proposals, not all implemented features.

## 6. Large real-model experiment

Task: reusable named launch presets spanning persistent storage, public contracts, API CRUD/validation/notifications, management UI, editable launch controls, localization and tests. Applying a preset copies values into explicit RunOptions. An empty string and disabled review must remain explicit overrides. Editing/deleting a preset must not alter historical Runs or application defaults. The exact task is included at the end.

Both started at `7738a09` with the same assignment and three review focuses: code style, architecture and Buro architecture. Reviewers could send actionable findings back for correction, with no configured round cap.

| Setting        | Buro flow                                                            | Codex flow                                           |
| -------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| Execution      | Buro main Flash session + Flash implementation collaborators         | Native Codex CLI, outside Buro                       |
| Model          | Official `deepseek-flash`, observed version DeepSeek-V4.1-Flash-1017 | Configured `gpt-6.1-sol`                             |
| Thinking       | Enabled, high                                                        | High                                                 |
| Context        | Buro projection 131072 tokens                                        | Native CLI management                                |
| Output reserve | 16384 tokens/request                                                 | Native CLI management                                |
| Review         | Three Buro review profiles on Flash                                  | Same three profiles in fresh native Codex sessions   |
| Corrections    | Main session receives findings and delegates                         | Findings returned to original execution conversation |
| CLI            | Not the native Codex path                                            | Codex CLI 0.172.0                                    |

Codex began after an initial Flash-only stage, then ran in parallel in its own checkout. The flow times are practical observations with some host CPU/tool overlap, not isolated latency tests. Different models, engines, tools and context management are part of the compared workflows; this does not isolate model intelligence.

### Results

| Observation                    |              Buro / Flash |                                             Native Codex |
| ------------------------------ | ------------------------: | -------------------------------------------------------: |
| Complete wall time             |                  2h02m30s |                                                   26m43s |
| Review rounds                  |                         2 |                                                        3 |
| Repository and canonical tests |                   139/139 |                                                  140/140 |
| Lint, format, types, build     |                    Passed |                                                   Passed |
| Independent preset API checks  |                    Passed |                                                   Passed |
| Reported input tokens          |                84,039,175 |                                               13,772,319 |
| Reported output tokens         |                   933,957 |                                                  116,350 |
| Cached input tokens            |                68,391,168 |                                               12,893,824 |
| Request accounting             |         1655 API requests | 12 CLI agent turns; underlying request count unavailable |
| Cost                           | $6.225497508 API estimate |               Account quota; no API dollar bill inferred |
| Manual quality rubric          |                    81/100 |                                                   98/100 |

The manual rubric is functionality 35, architecture 25, simplicity/cleanliness 15, Desktop preference conformance 15, verification 10. The rubric weights were specified before scoring, but the scores are subjective post-run judgments by the current Codex-based assistant, unblinded to model identity. They are NOT an external benchmark or proof of no undiscovered defects. Please critique the scores rather than treating them as ground truth.

Cost used actual returned cache-hit/miss/output usage. All Flash calls were 01:47–03:49 UTC on November 26, within the documented weekday peak window, treating the date as an ordinary Chinese working day. Peak per-million rates were $0.006 cached input, $0.30 uncached input and $1.20 output. Pricing is time/version dependent. Output/continuation tokens are not charged twice. Codex turn aggregates are not twelve individual model requests. Cloud decoder tokens/second were unavailable and were not invented.

### Where Flash's cost went

| Connection group      | Calls |     API cost |
| --------------------- | ----: | -----------: |
| Main model            |    71 | $1.046604444 |
| Worker-model sessions |  1173 | $4.578445944 |
| Configured reviews    |   411 | $0.600447120 |

The largest measured expense was the worker trajectory, not configured review. Removing reviews first would not address most of this bill.

### Team trajectory and confound

- 45 saved Flash sessions: one main coordinator, 38 worker-model sessions, six configured review sessions.
- Parent-chain depth reached 13.
- There were 46 session-start attempts, not 46 saved workers.
- Some nested sessions inherited the coordinator's delegation instruction.
- First configured review started at about 82.4 minutes.
- These observations identify a substantial scenario/instruction-inheritance problem. They do not quantify how much each individual mechanism contributed or prove that Flash is intrinsically unsuitable.
- Native Codex's initial implementation took 604 seconds. It had nine independent review turns and two correction turns (186 and 93 seconds), ending with three no-finding reviews.
- Flash's first round returned two findings, its second round none. Independent later checks still found defects.

## 7. Findings from separate independent inspection

The current assistant inspected both saved code snapshots separately from in-flow summaries. This was not a blind study. New targeted checks were written after inspection; they are separate from the original all-green suite.

### Flash: edited empty instructions are lost

`src/features/tasks/TasksPage.tsx:107`:

```ts
instructions: event.currentTarget.value || undefined,
```

Reproduction: select a preset with nonempty instructions, open Run options, erase the text and start. The actual TasksPage/WebSocket path omitted `options.instructions`, so application defaults were inherited. Codex's shared controlled editor preserved `instructions: ''`.

This browser test captured the run-start boundary without running inference. Both browser sessions had no runtime errors. It validates request semantics, not model performance.

### Flash: concurrent save can resurrect a deleted preset

`modules/presets/preset-service.ts` first awaits an existence check, then calls the upserting `store.save`.

```ts
const [updated] = await Promise.all([
  app.presets.save({ id, name: 'Concurrent edit', options: {} }),
  app.presets.delete({ id }),
]);
```

Against each real SQLite-backed application, Flash left the preset present; Codex left it deleted. Codex uses the existing `RecordStore.patch` operation. This demonstrates the supplied SQLite adapter behavior, not a guarantee for every conceivable third-party adapter.

### Flash: new clear control is hidden from accessibility queries

The new preset Select had no accessible button named “Clear preset.” Codex explicitly supplies a label, `aria-hidden: false` and a tab stop. This does not prove every alternative deselection interaction is unavailable.

### Structure and style observations

Flash duplicates overlapping launch controls in the preset editor and TasksPage, puts a route-level page inside its feature slice, imports the new server implementation directly without a public module index, and leaves four new tests at tests root instead of the selected classification. Its short module filenames and simple-return style do not fully follow the preferences.

Codex reuses a shared `LaunchOptions` contract and one controlled `LaunchOptionsEditor`, uses pages/features/entities and a public server entry, and classifies integration/e2e tests with a fixture. Minor observations: it changed the pre-existing review schema to `z.strictObject` beyond the new preset API (no documented client regression was reproduced), and fixture setup would read better with blank lines between meaningful groups.

These are experimental preset implementations. Their defects are NOT defects newly merged into the main Buro product. Do not silently apply either entire patch while fixing session orchestration.

## 8. Earlier local-model evidence

Hardware: RTX 3060 12 GB VRAM, 32 GB system RAM, i5-12600KF, Windows, NVMe. The latest measured native runtime was Ollama 0.40.16 and stock llama.cpp b12359 CUDA 12.4. Treat versions and installed state as last observations, not a guarantee the machine is online or unchanged.

| Model / format                            |               Recorded package/weight size | Recorded speed                                                | Quality/status caveat                                                                                                 |
| ----------------------------------------- | -----------------------------------------: | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Qwen3.6 35B-A3B Q4_K_M                    |                   23.94 GB, hybrid GPU/RAM | 42.9 decoded tokens/s in the small task                       | 34m02s; tests/build/behavior passed, 28 lint errors, native review request failed; medium interrupted                 |
| Qwen3.5 9B Q4_K_M                         |                                    6.55 GB | No fresh comparable rate in this phase                        | Installed baseline candidate; do not invent a score                                                                   |
| Gemma 4 12B Q4_K_M                        |                            8.02 GB package | 66.2 decoded tokens/s in small task; 61–82 in short 8K probes | Small 17m, 138 canonical tests/build/behavior passed, 11 lint errors and incomplete review; medium stopped by user    |
| MiMo V2.6 Distill Qwen 9B Q4_K_M          |                                    6.55 GB | 48.1 decoded tokens/s in task; about 55–57 in short probes    | Operator stopped small task after context saturation; saved snapshot had lint/test issues; no complete post-fix cycle |
| Flint 40B-A2B Q4_1                        |                                   25.99 GB | No fresh same-task rate                                       | Pending comparable quality evidence                                                                                   |
| Qwen3.8 dense 27B Q4/Q3 with optional MTP | Q4 16.56 GB, Q3 13.15 GB, MTP head 1.37 GB | About 4.5–9.2 decoded tokens/s across tested variants         | Below user's 15 tokens/s preference; those three files were deleted with authorization                                |
| Bonsai 2.5 27B Q2_0                       |     7.67 GB official stock-compatible file | 31.5–32.5 in short 32K preflight; 26.27 in full small task    | User stopped at 40m15s; 134 tests/lint/types/build/behavior passed, only code-style review finished                   |

GB are decimal file/package sizes, not exact VRAM allocations. Small preflight speed is not whole-task latency. Thinking contributes output tokens/time. More total parameters does not imply more active computation in a MoE model.

Bonsai's official Q2_0 file works with upstream llama.cpp from the stated b11556 minimum; the smaller PTQ1_0/PQ2_0 formats require the PrismML fork. Our measured deployment used existing stock b12359, not the special fork. The download was pinned and SHA-256 verified. A stalled download wrapper was recovered without changing weights.

The last observed free disk space after deleting Qwen3.8 files was about 52.4 GB. Deletion freed 31.08 GB. Do not treat this as a live inventory or delete other models based solely on this document.

The user prefers at least about 15 decoded tokens/s for local candidates, but finished-code quality and whole-task time are primary. Thinking is required in planned comparisons; native function calling must be verified. A text-to-tool fallback is not desired.

## 9. RTK, tools and context observations

An earlier tool trace contained a recursive search through dependencies/binaries at a 256 KiB output cap, and a failing Node test result around 62 KiB. This pollutes context and makes failures harder to interpret.

The installed RTK 0.30.0 incorrectly returned exit 0 on one captured failing Node-test fixture. An isolated rtk-oss 1.2.1 replay preserved exit 1 but its generic fallback retained only a small tail with insufficient failure detail. This is evidence about those versions/commands, not a claim that all RTK filters are broken. The global RTK executable was not replaced. A general tool-output layer must preserve the true exit code, useful errors and a retrievable full result rather than blindly wrapping every command or using `tail` to hide failures.

Good candidate improvements:

- Short, current repository maps and relevant file references rather than repeated whole-project scans.
- Compact tool receipts with useful failure detail, and range-based access to full output.
- Review focused on actual changes, affected contracts and requirement-specific risks.
- Reuse check results only for the same relevant code snapshot and environment.
- Parallel independent reviews of a saved snapshot, without competing file edits/build outputs.
- Stable provider-compatible prefixes, with actual cache-hit/miss measurement.
- Per-assignment model/reasoning choices, preserving quality and testing changes.
- On RTX, measure repeated input processing and KV reuse before assuming decoder optimization is the main bottleneck.

MTP is not universally beneficial: it improved one Qwen3.8 Q4 case but slowed the tested Q3 case. Flash Attention, KV types, slot/cache reuse and speculative decoding depend on architecture, build, memory and workload. Preserve a quality comparison; do not promise multipliers from a different GPU or model.

## 10. Proposed work, not yet implemented

1. Define and fix instruction ownership/inheritance without role-name branches or fixed team/depth limits.
2. Add a meaningful no-paid-model integration test proving inherited policy/assignment behavior while preserving intentional collaborators and nesting.
3. Improve delegation handoffs: clear assignment, relevant facts, changed files, observed checks and remaining issues. Do not create a mandatory workflow DSL or another universal state machine.
4. Add visible usage/cost/time by session/stage and an explicit optional user budget. Report unknown usage as unknown, not zero.
5. Improve configured review substance and retain an independent final behavior check. Keep profiles editable and review optional in the kernel.
6. Run a small controlled Flash experiment only after the user selects it. A proposed budget was $0.50–1; no such money cap is currently implemented or already enforced.
7. Test Flash + Qwen next, then the deferred Pro combinations if useful, with comparable tasks and disclosed scenario changes.
8. Self-review behavior, architecture and simplicity; run appropriate checks; record actual results; commit/push a logical checkpoint when authorized.

Integrating launch presets into the main product is separate from this orchestration repair. The cleaner experimental implementation is not automatically a merge decision.

## 11. Forecasts that must not be mistaken for evidence

The previous assistant proposed these planning ranges without controlled post-change measurements:

| Change                               | Estimated whole-task speedup | Expected quality effect                              |
| ------------------------------------ | ---------------------------- | ---------------------------------------------------- |
| Instruction/delegation repair        | 1.5–3x                       | Less assignment confusion; magnitude unmeasured      |
| Relevant project map/context         | 1.1–1.3x                     | Better focus; unmeasured                             |
| Compact tool results                 | 1.1–1.4x                     | More visible errors; unmeasured                      |
| Focused review/check reuse           | 1.1–1.5x                     | Better attention to changed risks; unmeasured        |
| Parallel reviews                     | 1.1–1.3x whole task          | No intrinsic quality increase from concurrency alone |
| Stable prefixes/cache                | 1–1.2x                       | No direct correctness gain                           |
| Reasoning-effort adjustment          | 1.1–1.4x                     | Possible regression; requires comparison             |
| Fix the two reproduced Flash defects | Little direct acceleration   | About +7 points in the previous subjective rubric    |

These ranges overlap and must not be multiplied or added. A 40–60 minute target for the formerly two-hour scenario was suggested as a testable goal, not a forecast established by data. Please assess whether these estimates are justified; replace precision with uncertainty where appropriate.

## 12. Operational preferences

- The user dislikes unnecessary permission questions and broad architecture rewrites that create more restrictions. Routine authorized, reversible local work should proceed to a concrete reviewable result.
- Do not introduce arbitrary team-size limits, fixed role/model allowlists, acceptance scores, minimum finding counts or universal mandatory phases to mask the observed failure.
- Keep actual external-input validation, credential protection, OS isolation and uncertain-action accounting. Do not weaken them merely to make nested tests pass.
- The user's current Codex weekly reserve is **5% remaining or lower**. The last observed value at handoff preparation was 8%; it changes over time. This is not a claim about Kimi/GLM subscription limits.
- If using the original machine, `python3 artifacts/architecture-refactor/check-quota.py` reads actual Codex account limits. No access means status unknown; do not manufacture it from context-window usage.
- Before stopping for that reserve, preserve the current work, finish an appropriate checkpoint, commit/push and record remaining work. No new inference should be started at/below the reserve.
- Native Codex requires the normal host network configuration. A harness startup attempt stripped proxy variables and failed at quota preflight before any model turn; preserving the normal environment fixed it. Do not globally remove network variables just because a different HTTP integration used a direct route.
- Keep passwords, API keys, private connection databases and private reasoning outside public artifacts. No credentials are included here.
- PR descriptions are empty by default unless the user asks for one; titles are short. Do not send messages to other people without explicit authorization.

## 13. Code and architecture preference summary

The original preference file is `/Users/redzumi/Desktop/buro-code-architecture-preferences.md`. Its substantive preferences are reproduced below and expanded in the three complete review profiles appended to this handoff.

### Code and architecture

- Capability-owned modules; UI/server/portable SDK separated. One server process and replaceable boundaries, with room to extract a module as a plugin later.
- Ordinary imports within modules; explicit interfaces at meaningful boundaries. No mandatory factory/DI wrapper for every small operation.
- Small meaningful named functions and files separated by responsibility. Stateful owners are classes; pure helpers do not need classes.
- Explicit documented public signatures and named structured contracts. Expected failures use ordinary result objects with optional fields; exceptions are for unexpected failures.
- Validate untrusted external input once at its boundary; normally trust typed internal calls.
- New data values rather than mutation of caller-owned state. Behavioral tests rather than exact internal-call sequences.
- Commands/queries through direct interfaces; events announce changes. Ordinary code for cross-module scenarios.
- Task/Run/Session separate. SQLite primary behind replaceable stores. Logs are diagnostic/history, not mandatory replay state.
- Application defaults plus explicit Run overrides. Avoid long settings hierarchies. Keep portable conversation history across model changes; private adapter continuation remains correctly scoped.
- Agent reports completion and the system records it. Optional configured autonomous review may return findings and corrections; it is not a global mandatory kernel gate.
- Independent Runs are isolated; collaborators in one Run coordinate shared files. After interruption use a new attempt with saved files/history rather than replaying uncertain actions.
- Update all callers in a deliberate internal API refactor and remove obsolete forms instead of keeping forwarding aliases.

### Naming, style and whitespace

- Short local names when context is clear; descriptive names when they resolve ambiguity.
- Early returns, shallow nesting. Unbraced simple if bodies go on the next line. Separate checks and meaningful groups with blank lines.
- Separate const declarations. Arrow functions outside classes; concise expression arrows where appropriate.
- Prefer if for a simple two-way return instead of a ternary. Name meaningful compound-condition parts, without inventing variables for every trivial expression.
- Destructure when several fields are used. Readable transformation chains and async/await.
- Named exports; combine values/types from one file using inline type when applicable. Framework-required default config exports are allowed.
- Object arguments for multiple application parameters. Each property of a nonempty call-object argument goes on a new line. Short positional calls, variable/return objects, arrays and chains may remain inline.
- Two spaces, LF, final newline, spaces inside braces. Tab inserts spaces. About 100 columns; do not split URLs or literal text only to meet a number. Continued logical operators stay at the prior line's end.
- Explain non-obvious implementation reasons; document public contracts without narrating every statement.
- ESLint/Stylistic owns source formatting; Prettier owns the other supported text formats. Do not add competing formatter owners.

### Folders and imports

- FSD for new UI responsibilities; only needed layers/slices. Atomic Design categories for shared UI.
- Small server modules stay flat with short filenames such as models/catalog.ts, not unnecessary contracts/services/storage trees.
- Public module index.ts entries with explicit exports. Relative paths internally, supported aliases between modules.
- Shared cross-runtime contracts/common code in root shared/; browser helpers in src/shared/. Internal implementation/storage types stay with their owner.
- Genuinely universal helpers may enter the right shared library with their first consumer; business rules stay capability-owned.
- All new files kebab-case, including React files; component/class symbols PascalCase.
- Tests outside production code under tests/unit, tests/integration, tests/e2e. Do not migrate all legacy tests during an unrelated feature.
- The working root shared alias is #shared/contracts, not an instruction to invent a second loader for an illustrative @shared spelling. UI uses @/ where supported.

## 14. Verification and source-reading order

Useful project commands:

```sh
npm run check
npm test
npm run build
npm run format
npm run fix
```

The literal recursive test glob used for independent discovery was `node --test "tests/**/*.test.ts"`. Preserve the existing suite; one model previously replaced it with an unquoted glob that omitted root tests. The compact reporter is optional for diagnostics; `npm run test:verbose` retains full ordinary output.

If repository access is available, start with git status, the relevant AGENTS.md, package.json and the current HEAD. Then read the instruction creation path above, the reviewer profiles, the actual session/tool contract and the smallest related tests. Do not start with another repository-wide refactor or the ignored raw credential/state directories.

Nested sandbox runs can fail on hard links, inaccessible Git object stores, missing Playwright browser caches or nested isolation. These must be distinguished from code regressions. The final independent checks were outside that nested environment. Fake transports in feature verification test domain behavior only; the reported model-flow runs were real inference, not scripted answers.

The small/preset experimental code is not in main product HEAD. Use the supplied full patches or source snapshots to inspect it; do not search main HEAD for a preset file and conclude the experiment never happened.

## 15. Sources and places to verify fresh claims

These are starting references, not evidence that a particular optimization works on this hardware:

- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://api-docs.deepseek.com/guides/kv_cache
- https://api-docs.deepseek.com/quick_start/pricing
- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- https://github.com/rtk-ai/rtk
- https://huggingface.co/prism-ml/Ternary-Bonsai-2.5-27B-GGUF
- https://github.com/PrismML-Eng/Bonsai-demo

Verify model availability, prices, engine support and benchmarks from current primary sources before recommending new deployments. Do not treat our local measurements as public leaderboard values or compare benchmark versions/scaffolds as if identical.

## Appendix A. Exact large-task assignment

# Reusable launch presets

Implement a complete reusable launch-preset feature in Buro. A user should be able to save, edit and delete named launch configurations, select one when starting a goal, adjust the copied settings, and start an ordinary isolated Run. Presets are editable data, not agent roles or a new execution framework.

A preset contains a stable id, a nonempty display name, and launch options for the main model, instructions and autonomous review configuration. Review participants retain their editable names, instructions and optional model overrides. Preserve the distinction between an omitted setting and an explicit override such as review.enabled=false or an empty instructions string. Reuse the existing review editor and portable public contracts where appropriate.

Provide the public application feature and persistent SQLite-backed storage through the existing replaceable storage interfaces. Expose these API methods: presets.list({}), presets.get({ id }), presets.save({ id?, name, options }), presets.delete({ id }). A list returns the preset records, get returns the matching record or undefined, save returns an ordinary result with ok, preset or error, and delete removes only the preset. Creation generates an id; updating retains it. Reject invalid external inputs at the API boundary. An unknown update target is an expected unsuccessful outcome. Do not add arbitrary name/participant/model limits, role-based branches or compatibility aliases.

The application UI needs an accessible place to manage presets and a preset selector in the existing goal launch controls. Selecting a preset copies its model, instructions and review settings into editable controls. Starting submits explicit RunOptions through the existing runs.start path. Do not persist a live preset reference on Run or introduce an extra settings-resolution hierarchy: later preset edits/deletion must not alter historical runs or application defaults. Clearing the selection must leave launching without a preset usable. Refresh preset lists after create/update/delete using the existing notification/query conventions. Add English and Russian labels, useful loading/empty/error feedback, and preserve existing goal creation, launch controls and review editing.

Use the user's code, architecture, folder and whitespace preferences in docs/reviewers/code-style.md, architecture.md and buro-architecture.md. New public contracts that genuinely cross UI/server boundaries belong in shared/contracts with its supported public entry. Keep ownership and dependencies explicit, UI and server responsibilities separate, and add only the FSD layers needed for this feature. Existing legacy folders are not an instruction to migrate unrelated features. No new dependencies or unrelated architecture migrations.

Add meaningful tests under tests/ for API behavior, SQLite persistence across application restarts, copied-option isolation, disabled-review/empty-instruction overrides, preset updates/deletion, and the actual UI create/select/edit/launch flow. Run the appropriate existing checks and report observed outcomes. Infrastructure tests can fail inside nested sandboxes (Git metadata access, link operations, unavailable browser caches); distinguish those failures from source defects, do not weaken isolation or modify unrelated tests to hide them, and do not repeatedly rerun unchanged infrastructure failures. An independent harness will validate the final snapshot outside that nested sandbox.

Deliver the implementation and a concise factual handoff. Autonomous reviewers will inspect the actual files against all three profiles and return actionable findings for correction. Do not publish, merge, apply this isolated experiment to another workspace, or access host credentials. All repository prose and comments are English; Russian is for localization or intentional test data.

## Appendix B. Complete code-style review profile

# Code style reviewer

Review the changed code against the user's code, code-style and whitespace preferences. These instructions are a configurable review assignment, not privileged behavior in the runtime.

## Focus

- Use short local names when their meaning is clear. Add detail when it distinguishes entities or removes ambiguity. Name meaningful operations, even when used once; avoid wrappers that add no responsibility.
- Prefer early returns and shallow control flow. Put an unbraced `if` body on the following line. Separate successive checks and the following work with a blank line; elsewhere, separate logical groups rather than every statement.
- Name the meaningful parts of a compound condition, then combine them in one readable `if`. Do not invent a variable for every trivial expression. Prefer `if` for a simple two-way return decision.
- Declare each variable separately. Prefer arrow functions outside classes, concise expression bodies for simple transformations, and `async/await`. Preserve a justified serialized promise tail or generator rather than mechanically breaking its semantics.
- Destructure when several fields are used. Keep a readable transformation chain together instead of naming every intermediate step. Return new data values when updating objects; avoid mutating inputs.
- Give public functions explicit signatures and return types. Use named contracts for structured public data; ordinary primitive types remain appropriate for primitive results. Document public behavior, inputs and outcomes. Keep implementation comments for non-obvious reasons.
- Use object arguments for multiple application parameters. Every property of a nonempty object argument goes on a new line, including constructor calls. Short positional calls, returned objects, variable objects, arrays and method chains may stay on one line.
- Use named exports. Combine values and types from one file into one import with inline `type`; retain valid type-only imports. Framework-required default configuration exports are an established exception.
- Use existing runtime-supported aliases between modules and relative imports inside a module. Follow public entry points. New files use kebab-case; component/class symbols use PascalCase. Preserve the repository's explicit file extensions where that is the local convention.
- Use two spaces, LF, final newlines, spaces inside braces, and operators at the end of continued conditions. Treat 100 columns as a guide, not a reason to split literal text or URLs.
- Keep repository prose, comments and identifiers in English. Localization and intentional Unicode test data are exceptions. Let ESLint own source formatting and Prettier own the other supported formats; do not introduce competing formatters.

## Evidence and findings

Read the actual working tree and new files against the supplied base. Changes may be uncommitted: a commit-only range is not the implementation diff. Use `docs/CODE-STYLE.md` and the existing formatter configuration to resolve concrete formatting details.

Review new and touched code. Report a concrete departure from an explicit preference even when the compiler does not enforce it; identify the path and smallest useful correction. Do not expand the task into unrelated legacy cleanup, demand stylistic alternatives not selected by the user, or invent findings to fill a quota.

Preserve behavior while correcting style. Appropriate behavior tests are useful; tests of exact internal call ordering or copies of implementation details are not substitutes. Do not change implementation source as the reviewer; temporary check artifacts may be created and cleaned up.

Report observed checks honestly. A timeout, nonzero test run, or a successful shell pipeline containing failed tests is not a full pass. Distinguish environment failures from source defects and test claims against receipts. Return no findings when the touched code meets the preferences.

## Appendix C. Complete architecture review profile

# Architecture reviewer

Review ownership, boundaries, contracts and simplicity against the user's architecture and folder preferences. Focus on the changed capability and its consumers.

## Focus

- Group modules by capability. Keep browser UI in `src/`, server features in `modules/`, and the portable SDK in `agent/`. The SDK must not depend on application implementations.
- Each module owns its state and exposes a public interface. Stateful owners use classes with methods; pure transformations do not need a class. Avoid a shared mutable application model.
- Keep interface and implementation boundaries explicit. Prefer ordinary imports inside a module and explicit dependencies at replaceable boundaries. Do not require factories or dependency injection for every small function.
- Commands and queries return through direct interfaces. Events notify consumers of changes; they do not orchestrate business work. Describe cross-module scenarios in ordinary code rather than a general step DSL.
- Keep modules independent enough to extract as plugins later. Add an extension boundary when it serves an actual dependency; do not build a plugin installation framework or separate service for a small feature.
- Shared cross-runtime contracts and genuinely common code belong under root `shared/`, organized by purpose. Internal storage and implementation types remain with their owner. Browser presentation utilities belong under `src/shared/`. Universal helpers can enter the appropriate shared library with their first consumer; business rules remain capability-owned.
- Use FSD for UI responsibilities, creating only needed layers and slices. General components belong in Atomic Design categories inside shared UI. Pages may own page-specific logic. Avoid cross-feature internals and artificial slices with no responsibility.
- Small server modules remain flat, with short filenames inside their owner folder. Public module entry points use explicit named exports. Consumers use public entries and supported aliases; internal imports are relative. Do not add a loader just to reproduce an illustrative alias spelling from the quiz.
- New files use kebab-case. Tests belong under `tests/`, classified by behavior as unit, integration or e2e. New tests must be discoverable without dropping the existing suite; do not reorganize all legacy tests for an unrelated feature.
- Validate external inputs at trust boundaries and normally trust typed internal calls. Expected unsuccessful outcomes use ordinary result contracts; exceptions represent unexpected failures. Prefer one understandable result interface with optional fields over unnecessary unions and wrappers.
- Keep working defaults and explicit overrides. Avoid duplicated matching/validation/business rules, speculative abstractions, compatibility forwarding files and parallel old/new internal APIs after a deliberate refactor.

## Evidence and findings

Inspect actual changed and new files, their owners, public consumers and relevant behavior. Changes may be uncommitted. Green checks do not establish correct ownership, but an architectural opinion needs a concrete dependency, contract or task consequence.

Apply the preferences to new/touched responsibilities. Existing migration debt or a documented task exception does not justify a project-wide rewrite. Do not create an interface, service or shared type with no meaningful contract solely to satisfy a pattern.

Report the path, the boundary or ownership issue, its consequence, and a proportional correction. Do not edit implementation source as the reviewer. Use checks that resolve a real uncertainty, keep environment failures separate, and return an empty findings list when there is no actionable issue.

## Appendix D. Complete Buro architecture review profile

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
