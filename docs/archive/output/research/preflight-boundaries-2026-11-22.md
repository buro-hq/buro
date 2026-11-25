# Preliminary architecture boundary review after 233bcc8

Date: 2026-11-22. Independent source inspection before the next implementation wave. Production sources and tests were not changed. The existing reduced-beta proposal remains unapproved, so this review retains the authorized default-none target and its prerequisites. No live models, native clients, RTX, original user repositories or `output/ux/` were accessed.

## Finding: the partial authority migration is coherent, but cannot yet support default-none

This is a planned architecture gap, not a newly reproduced regression. `plugins/host.ts:185–187` still selects `FileProjectStoreFactory`; `adapters/files/project-store.ts:86–101` supplies the narrow facets through that same sole document transaction. There is no observed SQL sidecar or live dual-write. `adapters/sqlite/project-usage-authority.ts:71–86` explicitly defines standalone v8 usage/entity/material/settings/Run authority without a live scheduler. It is not an implementation of the full legacy `ProjectStore` interface.

The current interface itself retains `snapshot`, generic `transact` and optional seeded `runs` in `core/ports.ts:39–70`. A factory switch now would require fabricating a growing Run projection for existing execution/session/router/result/apply consumers. That would preserve the coupling the saved plan is intended to remove. Keep the existing single File authority until actual consumers and public reads no longer require this aggregate; do not introduce compatibility wrappers as the SQL cutover.

## Finding: growing public and private state is still on the critical path

`ProjectDocument` owns arrays/maps of roles, goals, Runs, receipts and budgets (`core/ports.ts:20–37`). Each File transaction clones its current state (`adapters/files/project-store.ts:248–250`), writes the full JSON document (`:191–201`) and snapshots clone all Runs (`:206–220`). `Run` still contains delivery history, agents, events, commands, changed-file contents and checks (`protocol/domain.ts:298–309`), with nested agent messages at `:142` and attempt snapshots at `:281–292`.

Public delta packing helps wire/storage volume but does not normalize authority. `adapters/files/event-log.ts:47–69` special-cases only events/agents/commands; other changed Run fields replace complete values, and an updated agent still contains its accumulated message array. There is a genuine keyset timeline facet (`core/project-runs.ts:143–154`), but existing socket subscription still uses the old public event stream and snapshot sequence (`daemon/websocket.ts:79–86`). This is not complete client history pagination or a bounded replay/live handoff.

Private managed persistence is also aggregate. `ManagedSession` contains all messages, scope/turn authority arrays, actions and work-segment archives (`core/model-ports.ts:38–94`; `core/work-segments.ts:100–115`). `FileManagedSessions` reads and validates the whole checkpoint then serializes and replaces it (`adapters/files/managed-sessions.ts:751–782`). Existing history is private and durable in its declared File scope; it is not a normalized incremental session/effect journal sharing the project/accounting transaction.

Public excerpts must remain labelled as excerpts. `core/runtime-projection.ts:64–86` truncates message text to 12,000 characters and command output to the final 30,000 characters. A later complete artifact reader must not treat those values as complete source evidence. This review did not establish that every native full output is already retained elsewhere.

## Finding: lifetime ceilings remain actual production stops

These are confirmed code paths and documented pending policy work, not regressions introduced by 233bcc8:

| Scope                        | Current source and behavior                                                                                                                                         | Required treatment                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Whole managed Run            | `protocol/run-budget.ts:20–47`: required finite schema; defaults 64 requests, 131,072 reserved output tokens, 256 tool calls                                        | Optional explicit quotas with preserved counters/receipts; absent default quota                        |
| Managed turn/session         | `protocol/resource-builtins.ts:64–70`: turn default 24, session default 256; enforced at `core/managed-loop-host.ts:74–77` and `core/managed-host-effects.ts:54–55` | Logical continuation with bounded active context; no hidden reset or lifetime stop                     |
| Worker windows/feedback      | `core/work-segments.ts:37–43`: four segments; `core/worker-step-checks.ts:46–51`: two feedback steps; actual stop at `core/managed-worker-checks.ts:155–162`        | Incremental history plus cooperative context/repair continuation                                       |
| Repair/team                  | `protocol/projects.ts:33–34`: max two workers and max two repairs; `protocol/execution.ts:11–31`: team schema max two                                               | Remove lifetime repair policy coherently; team/capacity evolution remains a distinct workflow decision |
| Material lifetime/active set | `core/project-materials.ts:184–188`: library 1,000, active project materials 64                                                                                     | Paged library and explicit selection/context grants; no lifetime library ceiling                       |

Physical/model-request and bounded-page constraints are different. Do not indiscriminately delete context-token/output-token bounds, per-upload byte limits, cursor page limits or safe integer checks. `core/request-policy.ts:22–28` honestly uses an upper byte estimate rather than measured token count; preserving or replacing that trusted estimator is separate from aggregate-quota removal.

## Finding: neutral contracts are real; four installable packages are still a target

The inspected `agent/contracts` and `agent/providers` imports do not pull in Buro Core/protocol, Cordis, React or Node modules. Their independent DOM-only typechecks use empty ambient types (`agent/contracts/tsconfig.json:3–11`, `agent/providers/tsconfig.json:3–11`). The neutral loop contract preserves host-owned admission and original saved action arguments (`agent/contracts/loop.ts:16–41`). These are useful existing boundaries.

The source tree still has one root private `package.json` and no four-package workspace manifests/exports. Both package tsconfigs use `noEmit` and source `.ts` imports. `tests/provider-package-consumer.test.ts:11–45` does prove separately compiled providers run after source removal; it is stronger than a same-repository import test, but not an npm pack/install proof for all four packages or a neutral external-backend lifecycle. `core/model-ports.ts:11–25` still defines Buro-shaped tool authority; it should remain host application responsibility during extraction.

## Release path while the narrower beta scope is unapproved

1. Finish semantic current worker-task revisions and remaining executor state writers. Preserve original plan/assignment identity, revised-task authority, known successful work and stale-attempt rejection.
2. Move actual runtime observations to indexed owner lookup and durable receipt deduplication. Events committed unsuccessfully must remain redeliverable; late observations cannot acquire a newer attempt's authority.
3. Move actual native and managed session/effect/usage writers into the one project authority transaction: intent/grant, normalized observed response, complete proposed tool batch, action/check receipts, accounting and unresolved effect index. Retain the acquired adapter for cleanup and refuse unknown-effect automatic replay.
4. Migrate genuine revision-bound acceptance, research/result preparation and application ownership. Do not expose a fabricated accepted Run to unblock an earlier SQL consumer.
5. Store complete private artifacts and normalized history independently from bounded active context; deliver paged public history with a proven replay/live handoff. Remove whole-history reads from execution decisions and port consumers.
6. Only then cut the clean pre-release composition to SQL, delete temporary File aggregate authorities, and remove audited default/lifetime ceilings while retaining explicit user quotas and physical constraints. Run adverse crash/reopen, rollback, context-rotation and former-limit crossing proofs.
7. Run controlled actual Codex/Mac Ollama/DeepSeek coding-quality and negative-acceptance tasks, fresh-user service/UI flow, clean-machine macOS installation and cleanup evidence. Resolve the previously recorded intermittent project UI timeout with enough diagnostics to distinguish a real runtime hang from a slow harness. Publication remains a separate action.

The first six steps form the persistence/default-none dependency chain. The saved bounded-beta alternative could change that release chain only after an explicit scope decision; this review does not make that decision. No defensible completion percentage or calendar estimate follows from passing test counts alone.

[Private-project evaluation details removed.]

## Validation and limits

Ran `node --test tests/request-policy.test.ts tests/work-segments.test.ts tests/run-budget-rules.test.ts tests/provider-package-consumer.test.ts`: **29/29 passed**, no skips, duration 747.197 ms. Log: `/private/tmp/buro-preflight-boundaries-tests.log`. These are existing focused tests, overlap the previous 1368-test stage baseline, and do not prove current live-model quality, complete crash recovery or full SQL execution. No new production defect was reproduced by this boundary-only review.
