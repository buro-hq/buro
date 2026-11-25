# Stage 4C1 independent architecture and boundary review

Date: 2026-11-22. Baseline `d4239d9`. Reviewed the sealed tool catalog, registered built-ins, bounded repository facade, managed broker identity, checkpoint transitions, host action admission/receipts and Cordis startup composition. Reread the final helper-lifetime and semantic-schema liveness fixes after the source owner froze them.

## Decision

Bounded clear. No remaining blocking regression found in the reviewed 4C1 scope. Built-in and contributed tools now use one catalog and the existing host action journal. The change adds no second scheduler, effect ledger or model-controlled registration path.

## Findings and corrections

P2 — nested argument-schema aliases could silently change the registered parser. Registering a Zod object with a nested string field, then mutating the retained nested schema before its first invocation, caused the old advertised string to fail and a numeric value to reach the handler while the tool revision and advertised schema stayed unchanged. This was reproduced independently without filesystem operations.

The final catalog keeps the real Zod parser, including refinements, and privately observes its semantic definition graph. Drift fails with `TOOL_CONFIGURATION_CHANGED` before publication/invocation or handler execution. The check covers nested definitions/check callbacks, ignores legitimate first-parse caches, and inspects ordinary accessor descriptors without calling their getters. Original plugin-owned schemas are neither frozen nor silently rewritten. `RepositoryTools.revision` delegates to the live catalog check, so a cached managed session cannot bypass it through an old captured revision string.

The new independent tests prove that the retained nested-schema mutation cannot execute the numeric interpretation and that repeated catalog/definition/revision reads do not evaluate a default factory. The independent test reviewer additionally proved that a real refinement absent from JSON Schema still rejects its invalid input; the implementation does not replace the parser with an incomplete JSON Schema validator.

The final helper-lifetime changes also address the earlier effect ambiguity: an unawaited bounded mutation must settle before the host can receipt the enclosing tool; helper admission closes when the handler settles; and a rejected possible mutation cannot be hidden by the handler swallowing its promise. A later domain-shaped error or invalid handler output after a write remains fatal/unknown, rather than becoming ordinary recoverable validation feedback. These fixes were independently read and tested through real private checkpoints and the actual SDK loop.

## Architecture and authority

`ToolContributionCatalog` captures name/revision/description/effect, advertised parameters and handler identity. Duplicate, unknown, unsealed and late registration have explicit failures. Its only registration entry point is trusted service-process code installed before startup sealing. `createHost.configure` lets a real Cordis plugin register a third tool before application commands become available; RPC, project data and model output cannot install callbacks.

The existing repository operations were extracted into registered built-ins and one bounded adapter, rather than copied into each contribution. Contributions receive a detached argument object and six bounded operations, not the executor, raw workspace scope, private session store, broker or host journal. Returned results are validated/copied. A handler's declared read access cannot acquire a write/command helper; a write tool does not acquire command access, and a command tool does not acquire direct edit access. Each helper also checks the actual frozen workspace grant.

Definition filtering and whole-batch admission use registered effect metadata for every tool name. Familiar names do not grant authority: a read-only tool named `run_command` stays a read tool; a differently named command tool remains unavailable in read-only/strict sessions. A forbidden later call invalidates the entire proposed batch before action intents or earlier effects dispatch. Argument/path validation errors remain ordinary tool feedback only when no ambiguous mutation has begun.

Read-only/view grants, strict planned writes, protected files, dependency/check-command preservation, private-path exclusions, symlink checks, exact configured commands and process confinement remain in the existing host/adapters. Host dispatch still uses the original saved call and opaque action ID. Bounded helper composition is subordinate to that one action intent/receipt; it cannot reserve its own host action or replace a receipt. The adapter waits for all accepted helper promises and closes retained facades before returning.

Every managed broker now declares an explicit revision and effect lookup. The saved session captures `toolRevision`; persisted transitions prohibit replacing it. Start/resume, cached/reopened sessions and active host checks verify it. The managed backend identity also hashes the broker revision, so routed identity and direct private-session identity both reject changed tools. A change during generation preserves the exact observed model response/continuation but dispatches no proposed action. Restoring tools cannot erase old pending/unknown effects or renew request/check/segment allowances.

The actual Pi scheduler, canonical generation/action receipts, cancellation latch, scope/role/resource grants and immutable final checks/reviewer remain authoritative. A contributed tool result is not final acceptance evidence, a new runtime grant or permission to execute external delivery.

## Independent validation

Focused host/catalog/SDK run: **55/55 passed** across tool contributions, revision changes, whole-batch gates, canonical calls/receipts, helper lifetime, scope authority, scheduler phase/order, cancellation and actual SDK receipt recovery. The final catalog-dependent rerun after the last source freeze passed **19/19**, adding the independent non-JSON refinement regression; most of this set overlaps the first run.

Broader regression run: **91/91 passed** across real worktree read/edit/check acceptance, file search, explicit continuation, changed/unknown grants, immutable review views, worker checks and budgets, provider outcomes, reconciliation and recovery. This includes source edits during checks/review, lost receipt replay prevention and unchanged final acceptance ownership.

`npm run typecheck` and `git diff --check` passed. Tests used fake providers, isolated temporary repositories/private session stores and sandboxed test commands. No live model, RTX, real external endpoint, credential material or existing user repository was accessed. This reviewer edited only `tests/stage4c1-architecture-review.test.ts` and this report; production fixes were made by their owners.

## Simplicity and bounded followups

The catalog/broker/operations split is useful and keeps one dispatch/effect owner. The semantic Zod observer is the most specialized addition: it is private, tied to the pinned Zod representation and covered by alias/default/refinement/first-parse regressions. Preserve those tests on dependency upgrades instead of growing a generic schema-cloning framework. A contribution author's hidden closure/global state remains its explicit versioning responsibility.

Composite command evidence is a real remaining limitation, not an authority blocker. A contributed command tool may call multiple configured command helpers. The current host event projection keeps one enclosing action ID and derives completion from the final aggregate tool result, so multiple starts need not have matching per-command completions. The built-in command tool performs one command, and final acceptance checks remain separate. Track per-helper evidence IDs and actual completion receipts in the later storage/event work; do not impose a one-command quota or claim that the composite timeline is already complete.

These are trusted in-process plugins, not isolation of hostile installed code. The facade bounds host-provided operations; it cannot stop arbitrary plugin code from importing Node capabilities or refusing to settle its own promise. Registration changes require rebuilding the matching catalog/restarting the service, not hot replacement under an executing session.

This stage does not implement the next context/analysis/check/recipe/workflow/role contributions merely because their plans exist. It does not publish reusable packages, remove current scan/context/action/run bounds, solve operational preparation's separate unknown-outcome receipt gap or complete concurrent-goal scheduling. Old checkpoints without the new required tool identity fail closed; no compatibility migration or inferred old broker grant is claimed.
