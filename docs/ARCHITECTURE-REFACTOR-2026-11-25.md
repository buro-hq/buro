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
- Application-directory ownership acquired before recovery, so a second server cannot interrupt the first server's work.

## Still required before production cutover

- Finish the CLI entrypoint and launcher authentication.
- Preserve optional preview and delivery actions independently of run completion.
- Archive the existing working state, switch production entrypoints, and remove obsolete runtime and client code.
- Reconcile the public documentation and run the complete release checks and self-review.
- Run the completed application against the configured DeepSeek Flash with thinking. Use comparable tasks and settings to Qwen, inspect the finished code and agent collaboration, and report wall time separately from provider-reported token speed. No live model quality result has been collected for this implementation yet.

Code and architecture preferences are saved on the user's Desktop in `buro-code-architecture-preferences.md`. The stopping threshold is actual weekly remaining capacity below 20%; before stopping, finish a tested checkpoint, commit and push it, and record outstanding work.
