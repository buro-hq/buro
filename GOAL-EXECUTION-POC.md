# Goal execution: architecture and evidence

Current implementation, 22 November 2026. [VISION.md](VISION.md) defines the product; [ARCHITECTURE.md](ARCHITECTURE.md) defines the full target. [Adaptive orchestration](docs/ADAPTIVE-ORCHESTRATION-2026-11-22.md) records the implementation decision and remaining limits.

Buro freezes a goal, policy, resources and material selection, prepares an isolated workspace and starts its coordinator. The coordinator can inspect and change sources using the existing backend tools, then choose a registered service action. Planning, delegation, integration and repair have no mandatory sequence. Native Codex and managed providers use the same structured action contract; Pi continues to own scheduling inside managed sessions.

```mermaid
flowchart TD
  Goal[Goal and frozen constraints] --> Workspace[Isolated workspace]
  Workspace --> AI[Coordinator chooses useful work]
  AI <--> Tools[Scoped repository tools]
  AI --> Actions[Registered service action]
  Actions --> Plan[Update working plan]
  Actions --> Delegate[Delegate or continue a specialist]
  Actions --> Check[Check current revision]
  Actions --> Review[Fresh independent review]
  Actions --> Ask[Wait for user input]
  Plan --> AI
  Delegate --> AI
  Check --> AI
  Review --> AI
  Ask --> Resume[Explicit continuation]
  Resume --> AI
  Actions --> Finish[Submit for acceptance]
  Finish --> Guard{Current checks and fresh approval of exact bytes?}
  Guard -->|No| AI
  Guard -->|Yes| Accepted[Accepted commit]
```

The action catalog is a sealed startup contribution. Plugins receive bounded semantic operations, not a Run/store mutation callback. An invocation serializes and drains its started operations, revokes retained ports when its handler returns and cannot swallow an uncertain operation to continue. The admitted catalog identity is checked before dispatch and continuation. A plugin-provided `accepted` or `terminal` value never grants completion authority.

A working plan is a recorded, editable artifact; it grants no permissions. Each delegation commits its own immutable role/version/resource/path/task grant before opening a worker session. The team may grow after new findings, within the saved project allowance. Exact repeated assignments can resume their original worker when supported. Otherwise a new session preserves the logical role and known context explicitly. Unknown outcomes block retry or replacement.

Workers execute serially in the run worktree. Before/after observations detect forbidden changes and reversions. Managed repository tools also enforce scope before dispatch. Native execution retains its backend constraints and post-execution checks; native child observations cannot manufacture an assignment grant. Fully local profiles never silently route to cloud models.

Checks, review and finish are separate operations. Checks issue a host-owned receipt for the actual base/HEAD/index/tree and immutable verification view. Review uses a fresh read-only session on that view. Source changes invalidate prior evidence; Git identity changes require intervention. Finish rechecks receipts, worker grants/results, scope, protected check definitions, cancellation, unknown effects and the actual revision before checkpoint and final acceptance. The coordinator can repair and request new evidence; it cannot approve itself.

Stopped attempts retain their workspace and exact inherited assignment references. Task validity follows each assignment separately, so a changed goal invalidates old compact tasks without dropping newly delegated tasks for the revised goal. Check-only recovery uses current evidence and runs fresh service verification. Repair continuation returns control to the coordinator. An explicit user question creates a genuine needs-attention stop.

Production still uses the sole File authority. The standalone SQL adapter implements the same delegation/continuation contracts on a fresh v10 format; production SQL routing and complete effect/history migration remain unfinished. Prototype formats have no compatibility or migration path. Default aggregate request/output/tool quotas and turn/session/feedback/team ceilings are absent; explicit user limits remain supported. The shared context plugin now rotates coordinator and worker windows without a default segment-count cap, retaining complete private archives and actual receipts. File history is still a growing aggregate. The former accepted-plan API/storage and closed fixed-pipeline experiment are removed; the working AI plan remains.

Deterministic tests exercise real File/SQL commands, routed managed sessions, injected Ollama/DeepSeek HTTP streams, immutable checks/review, plugin lifetimes and negative acceptance. Controlled 16K tests verify the full action grammar, coordinator context rotation across more than sixteen windows, resume, complete archives and failed-save/unknown guards. [Real Qwen validation](docs/QWEN-LOOP-VALIDATION-2026-11-23.md) distinguishes correct worker edits from service acceptance and records remaining context/quality failures. Actual native/RTX quality and broader crash/install gates remain separate. See [implementation progress](docs/IMPLEMENTATION-PROGRESS-2026-11-21.md).

Accepted results still use the existing [preview and delivery](ONBOARDING-AND-DELIVERY.md) services. Original source branches stay unchanged until explicit application.
