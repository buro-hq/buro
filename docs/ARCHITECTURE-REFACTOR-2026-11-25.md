# Architecture refactor checkpoint

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

Code and architecture preferences are saved on the user's Desktop in `buro-code-architecture-preferences.md`. The stopping threshold is actual weekly remaining capacity below 20%; before stopping, finish a tested checkpoint, commit and push it, and record outstanding work.

The first explicit review scenario encountered an interrupted API stream before its fix was applied. HTTP generation now retries temporary connection/stream failures with a configurable count, preserving private diagnostic causes and clearing provisional text. A regression test interrupts a partial tool proposal and confirms the resulting edit executes exactly once; cancellation and authentication errors do not repeat it. Native tool execution remains outside that retry mechanism.

A subsequent diagnostic review exposed repeated delegation of the same assignment: the unframed shared context was interpreted as a fresh instruction. That diagnostic was stopped after 82 seconds. Shared background is now explicitly separated from the current assignment, and advisory defaults call for distinct useful subtasks. There is no role-based delegation ban or fixed team size. Attempt ancestry is kept on runs rather than reusing a collaborator parent link.
