# Architecture refactor checkpoint

## Current checkpoint: 25 November

The manual code-style pass is committed in `19515fc`: named arrows and public contracts, clearer conditions, async control flow and explicit exceptions for serialized Promise tails. The full suite passed 126 tests, including the browser scenario, alongside lint, types, nine formatter checks and production build. Decorative metadata separators were replaced with field descriptions, layout and status badges in `f4bbc94`; lint/types and the browser scenario passed again. Both commits are pushed and their CI checks passed.

`88fecc9` adds optional server-reported timing to portable completions and evaluation reports. Ollama durations are normalized from nanoseconds to seconds; missing or invalid values remain unknown. Forty-seven provider/consumer checks and the full lint/type check passed, and CI passed. The RTX matrix runs from a separate checkout of this revision, using all five selected models with thinking, 32,768 context tokens and 8,192 output tokens. The default user connection and state are unchanged. Measurements and private isolated evaluation state are under `artifacts/manual-style-rtx/`; reports are under `artifacts/model-evaluation/`. No complete five-model comparison is claimed yet.

The folder quiz is complete and saved in the Desktop preferences file. Its conventions and the pending migration are described in [folder conventions](STRUCTURE.md). The folder migration and final real-project smoke task remain after the RTX matrix.

The new implementation lives in `modules/`. Each feature owns its records and exposes an ordinary API. `createApplication` composes the modules in one process. SQLite stores current state; activity is separate diagnostic history. A task describes intent, a run owns an isolated attempt, and sessions own portable conversations.

Sessions share one model/tool loop. Agent descriptions have no reserved names, privileges or phase order. Model selection can change within a session. Collaborators inherit explicit access settings. Completion saves the agent's result without a universal review or scoring gate. Review remains available through ordinary collaborators and tools.

HTTP model transports and the native Codex adapter use the same tool broker. Private continuation data and credentials stay outside public history. Workspaces isolate file changes; applying a result is a separate command and preserves unrelated source changes.

## Implemented and checked

- Task, run, session, agent, model, material, project, result and settings modules.
- SQLite and replaceable JSON record storage, restart as a new attempt, cancellation and process cleanup.
- Thinking transports, native model discovery without inference, configurable concurrency and a common session history.
- Authenticated feature API, CLI transport wrapper, feature-owned UI queries, feature pages and an office view following arbitrary sessions.
- Browser test covering project connection, goal creation, a sandboxed file edit, conversation history and explicit result application; desktop and mobile navigation.
- Independent previews with live output and separate ports, stopped with their application owner.
- Explicit draft PR publication onto a fresh remote base, excluding initial user edits; PR bodies stay empty by default.
- Application-directory ownership acquired before recovery, so a second server cannot interrupt the first server's work.

## Production cutover completed

The launcher, daemon, CLI and browser now use the feature APIs. The obsolete Cordis runtime, workflow admission, profile hierarchy and old client snapshot have been removed. Portable model transports remain independently consumable. Historical designs are under `docs/archive`; previous source and retired workflow tests are retained in Git history.

The local state and a source bundle are archived on the Desktop. Four older linked workspaces already referred to missing Git metadata before the move; their files and references are preserved in that archive. The new database starts independently, with the explicitly requested DeepSeek Flash thinking connection selected.

The current suite passes 105 behavioral checks, including real launcher/UI/CLI startup, parallel browser fixtures, shutdown during startup and publication, cancellation of catalogue requests, and restarting a saved attempt after its task is removed. Type checking, production build and formatting pass. Earlier totals counted the retired implementation's tests and do not describe the current suite.

## Live validation completed

The final DeepSeek Flash thinking runs passed all 3 public and 5 independent cases. The ordinary queue task took 16.48 seconds with 7 requests and no helper; the explicit review/repair scenario took 211.56 seconds with 55 requests and four helpers. Both ran the same final core revision. Their code, actual collaboration, diagnostic failures and measurement limits are recorded in [Flash validation](FLASH-VALIDATION-2026-11-25.md). Decoder timing was unavailable, so no decode speed is claimed.

The remaining limitation is model efficiency: the explicit review scenario delegated more work than this small change needed. It completed correctly, and the runtime imposes no role count or mandatory review gate.

Code and architecture preferences are saved on the user's Desktop in `buro-code-architecture-preferences.md`. The user updated the stopping threshold to actual weekly remaining capacity below 7%; before stopping, finish a tested checkpoint, commit and push it, and record outstanding work.

## Request-context calibration: 26 November

The MiMo task exposed a request-sizing defect: the fixed four-character estimate left only hundreds of tokens for responses configured to allow 8K. Sessions now measure UTF-8 bytes, reserve tool-definition and response-schema overhead, and calibrate input density from reported prompt usage. Each turn keeps its highest observed density separately for each model/backend revision. Calibration is opt-in through the backend's inputUsageScope: prompt contract; cumulative native-agent turn/thread counters are not interpreted as one prompt's size. Unknown usage retains the initial estimate; this is not an exact tokenizer or a guaranteed bound for every new input distribution.

Context remains a temporary view. Saved history, complete captured tool results, private adapter continuation ownership and tool-call/result correlation remain intact. The loop still has no role/model-name branches or new completion gates. Regression scenarios exercise multibyte context, output/overhead reservation, reported-usage feedback and preservation of logs/private continuation. Lint, formatting, types, 135 tests and production build passed.

A native MiMo input-size probe on the same saved interrupted history measured 31,096 prompt tokens with the old projection and 23,219 with the calibrated projection, leaving 9,549 tokens within 32K. Each diagnostic generated at most one token and executed no proposed tools; it does not establish completed-task quality. A preceding calibrated probe failed with a network timeout and is excluded from that measurement. The prior RTX server was restored after the probe. [Comparison and limits](PREFERENCE-REVIEW-COMPARISON-2026-11-25.md).

## Post-review improvements

Concurrent model connection edits previously read stale private rows: rotating a key and renaming a connection together could restore the old key. Configuration mutations now execute in order inside the model catalogue, including default selection and deletion; inference remains independent. SQLite and JSON tests verify the new key survives concurrent edits and restart, and an unexpected failed edit does not block later changes.

The UI no longer shares a global invalidation revision. Each read subscribes to its feature and owner; a fixed refresh window coalesces notifications without repeatedly postponing the timer. In-flight reads finish and update the view, followed by one more read if needed. Continuous output, slow reads, late responses and reconnect handling are covered without replaying commands.

Conversation headers and messages are separate records committed atomically in one namespace. Normal execution appends new messages and updates metadata; it does not rewrite older messages. Public session reads return metadata and `sessions.messages` returns bounded chronological pages. SQLite applies indexed owner/status selection in storage, including activity filters. A selected execution still loads its own history into memory before context projection; the JSON reference adapter still rewrites its namespace file.

Existing histories migrate once, preserving message identities and private adapter state. Migration is idempotent if interrupted after copying. All 15 current local histories were verified byte-for-byte after migration, with a private SQLite backup retained under `artifacts/architecture-refactor/`. The long-history tests cover 1,201 messages, forward/backward windows, restart, deletion, transaction rollback and live bursts spanning several pages. A SQLite audit trigger confirms that repeated model/tool turns never update a previously saved message. Browser coverage checks reopening a recent page and explicitly loading earlier messages.

The post-review suite had 117 tests; production build, type checking and formatting passed. The additional code-style quiz and spacing discussion are saved in the Desktop preferences file. EditorConfig, ESLint Stylistic and the shared correctness configuration now implement the automatic conventions, including guard returns and object arguments; Prettier owns other text formats. See [code style](CODE-STYLE.md) for commands, editor integration, regression checks and the semantic preferences that remain review guidance.

The tooling checkpoint passes 126 tests, source/asset checks, type checking and the production build. Nine formatting regressions exercise output, syntax, JSX text, repeated formatting and ownership/exclusions. A structural comparison of emitted JavaScript for 111 changed existing sources isolated the intended React dependency fix, a redundant test initialization, and the requested localized file-status presentation with its browser assertion. The latter now uses a filename and a separate status badge, without a decorative separator. Repeated fixing left the 131 files in the initial formatting snapshot unchanged, and existing dependency versions were retained.

The post-review runtime was also exercised with DeepSeek Flash thinking on revision `84f4301`: both scenarios passed 8/8 independent/public cases. The ordinary task took 18.20 seconds and 7 requests, and review/repair/follow-up took 76.66 seconds and 23 requests with one collaborator. Both completed without HTTP retries or output truncation. See the updated [Flash validation](FLASH-VALIDATION-2026-11-25.md) for artifacts and measurement limits.

The first explicit review scenario encountered an interrupted API stream before its fix was applied. HTTP generation now retries temporary connection/stream failures with a configurable count, preserving private diagnostic causes and clearing provisional text. A regression test interrupts a partial tool proposal and confirms the resulting edit executes exactly once; cancellation and authentication errors do not repeat it. Native tool execution remains outside that retry mechanism.

A subsequent diagnostic review exposed repeated delegation of the same assignment: the unframed shared context was interpreted as a fresh instruction. That diagnostic was stopped after 82 seconds. Shared background is now explicitly separated from the current assignment, and advisory defaults call for distinct useful subtasks. There is no role-based delegation ban or fixed team size. Attempt ancestry is kept on runs rather than reusing a collaborator parent link.
