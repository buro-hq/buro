# Run recovery

A stopped run preserves its workspace, coordinator thread ID, policy, role definitions, checks and timeline. Restarting the service marks unfinished work interrupted; it does not automatically replay implementation, installs or delivery.

This is current Codex behavior. The target in [ARCHITECTURE.md](ARCHITECTURE.md) adds per-task action reconciliation and private Buro-managed checkpoints for Ollama and the DeepSeek API. Native client resume and checkpoint continuation are distinct; neither permits blindly replaying a tool action whose external result is unknown. Provider-specific recovery criteria are in [providers](docs/PROVIDERS.md).

## Operator flow

- **Rerun checks** verifies the saved implementation without replanning or rewriting files. A saved plan/team is required.
- **Continue with clarification** resumes the coordinator in the same workspace when supported. Revise the goal and provide specific instructions. If planning never completed, the coordinator finishes planning first.
- **Use current project settings** opts into revised commands/boundaries; otherwise the run keeps its original policy.
- **Start again** creates a new run from the configured base or selected parent rather than modifying the old run.

Stopped goal edits use optimistic revisions. A previous attempt records the old result, task, policy, time policy and material manifest before continuation. Independent checks and a fresh reviewer still gate acceptance.

Repair picks up revised goal attachments. Shared project context follows the current-profile choice; prior material snapshots remain in attempt history. Check-only recovery preserves the original material selection. Staged files are verified by hash.

## Environment failures

Managed runs restore their execution provider and probe readiness before continuing. A matching setup fingerprint skips installation only while readiness still passes; missing generated/runtime artifacts trigger preparation again. Environment recipes and project artifact caches survive between runs, and failed or cancelled setup never publishes a ready fingerprint.

Unchanged baseline dependency declaration failures can require attention rather than repeated agent repair/review calls. Fix dependencies or the configured environment and recheck. The explicit environment-repair option permits dependency/lockfile changes and installation in a private workspace; it does not permit bypassing checks, changing scripts or editing TypeScript configuration.

Worktree restoration checks canonical path, repository identity, Git base/control files and dependency layout. Unsafe or changed workspaces fail instead of being silently replaced. Accepted preview/delivery rechecks workspace cleanliness and the accepted commit.

## Time and cancellation

There is no overall goal wall-clock deadline. A turn stops after the default 10 minutes without coordinator/child-agent progress. Genuine child events refresh activity. Human pauses between attempts are excluded from displayed active work time; concurrent workers are not summed.

Cancellation is durable and interrupts the active phase. Metadata commits and external processes/Git operations are separate effects, so recovery always verifies actual state before acceptance or a retry.

## Delivery

An accepted implementation stays accepted if PR, preview or deployment preparation fails. Delivery history is separate. A successful deployment can be prepared again using the same accepted commit and current enabled configuration; fresh confirmation is required when configured. Ambiguous deployment outcomes are never automatically retried after service restart.
