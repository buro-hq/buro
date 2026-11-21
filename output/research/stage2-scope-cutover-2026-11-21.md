# Stage 2: advisory scope and capability cutover

Source review: 2026-11-21, current uncommitted stage-1B tree above `fd50e27`. Read-only review; no production changes or test/model executions. This is an implementation map, not evidence that advisory scope is already active.

## Selected minimal contract

Replace the overloaded planned-path authority with one explicit scope value, shared by the profile, resolved execution policy, run snapshot, worker envelope and private tool scope:

```ts
type WorkScope = {
  mode: 'advisory' | 'strict';
  plannedPaths: string[];
  protectedPaths: string[];
};
```

New project discovery sets `mode: 'advisory'`; `src/` may be a suggestion, never an implicit hard boundary. Advisory paths can be empty when discovery is needed. Strict mode requires a deliberate nonempty selection; `./` means the whole authorized working copy. Do not derive the mode from an empty array, backend name or a separate UI-only checkbox. A host-issued resolved policy also carries its revision and origin; freeze that value with the run/session dispatch grant.

The exact field spelling can follow the parent stage-2 contract, but mode must travel with paths at every enforcement point. A clean prerelease cutover should update schemas, fixtures and explicit project configuration together; no fallback that interprets old `allowedPaths` as a new mode.

Split the current `inScope()` responsibilities into reusable pure decisions:

1. Workspace-authorized path: canonical relative path, no traversal/service directories/protected paths. Always enforced.
2. Planned-path match: advisory classification only.
3. Write decision: authorized path AND (`mode === 'advisory'` OR planned-path match).

Keep filesystem-root confinement, symlink restrictions, credential exclusions, reviewer read-only authority and checked/reviewed/committed revision identity independent of the planning checkbox. Do not implement advisory mode by disabling the existing `safe()` predicate wholesale.

## Complete implementation map

| Layer / exact files | Required change |
| --- | --- |
| `protocol/domain.ts`, `protocol/projects.ts`, `protocol/schema.ts` | Scope type/schema in ProjectProfile, ExecutionPolicyView, Run snapshots/attempts and event/snapshot projections. Currently the three repeated execution-policy schema shapes independently contain `allowedPaths` and can silently strip a new field. Prefer one shared schema. Record observed additional paths separately from hard violations. |
| `adapters/files/project-manager.ts` (`executionPolicy`, discovery at ~206) | Carry mode, project-profile revision/origin; discovery currently selects `src/` as mandatory scope. Keep source changes in isolated run worktrees. |
| `core/execution-ports.ts` (`inScope`, `resolveTeam`) | Separate hard path validity from planned matching. A worker's proposed adjacent path is legal in advisory mode; strict proposals remain within the user's selection. Do not weaken protected paths. |
| `core/execution.ts` (`verify`, planning/continuation/reviewer prompts) | Always validate hard boundaries and exact verification identity. Advisory additional files are recorded and reviewed rather than blocking checks. `scopePreserved` must mean hard policy respected; expose additional-path evidence separately so UI does not call useful extra edits a violation. Replace “Only these paths may change” in advisory prompts. |
| `core/worker-assignments.ts` (`runWorkerAssignments`, `assignmentScopePreserved`) | Dispatch persists mode plus assignment paths. Before/after comparison still detects reversion of previous workers' changes, but classifies advisory path deviations instead of throwing `WORKER_SCOPE_VIOLATION`. Hard protected/Git/symlink violations remain errors. Both success and known-failure/replacement branches call the same decision. |
| `core/worker-envelope.ts`, `protocol/worker-tasks.ts` | WorkerEnvelope scope includes mode. `buildWorkerEnvelope` must not reject additional advisory task paths. `workerInstructions` / `workerPrompt` must describe planned work rather than invent a strict grant. Keep public input references distinct from write permissions. |
| `core/planning-policy.ts` | Include explicit mode in the brief and schema; replace unconditional “permitted paths / file input grants no writing outside assignment” rules with actual policy semantics. An envelope or planner size limit is not a scope setting. |
| `core/ports.ts`, `core/runtime-router.ts` | Assignment start contract and saved-dispatch identity compare scope mode/revision as well as paths. An arbitrary model-proposed path never changes the owning user policy. |
| `core/model-ports.ts`, `core/managed-runtime.ts` | ToolScope/private assignment carry scope mode/revision. `start` and `resumeSession` preserve exact owner/identity; resume currently filters assignment paths through project `inScope` and would reimpose strict mode. Revalidate the effective grant before each effect, not only at session creation. |
| `adapters/files/managed-sessions.ts` | Persist and validate mode in current scope, scope history and assignment; transition validation binds it to an explicit host revision. Restart cannot reset policy or erase deviations. |
| `adapters/tools/repository-tools.ts` | `definitions` offers editing in advisory mode even with no planned paths. `edit_file` uses the shared write decision after hard private/symlink checks. Keep readOnly checks unconditional. Return/record the changed path so additional-file reporting comes from observed host effects, not model claims. |
| `core/work-segments.ts` (`assertSegmentScope`, `segmentMessages`) | Hidden hard fence: every changed file currently must match scope.allowedPaths, including on context rotation and check feedback. Apply the same mode-aware hard decision; preserve base/HEAD identity and complete fingerprint validation. Include mode in continuation context. |
| `adapters/checks/worker-step-checks.ts` (`selection`), `core/managed-worker-checks.ts` | Selection currently compares assignment paths exactly and rejects any path outside project `allowedPaths`; retain exact saved grant matching but make permission validation mode-aware. The subsequent segment-scope check must not restore strict behavior after an otherwise allowed edit. |
| `src/components/organisms/ProjectProfileForm.tsx`, `GoalRunAction.tsx`, `ResultPanel.tsx`, i18n | Relabel “Allowed paths” as planned scope, add the real opt-in “Forbid changes outside the selected scope”. Render the service's mode/origin/revision and additional files. Current GoalRunAction prints only a path list; do not infer strictness from it. |
| `core/services.ts` (`canAccept`) and result projection | Keep acceptance dependent on true hard boundary preservation, trusted checks, fresh review and exact tree. Additional advisory paths are visible evidence, not a false `scopePreserved=false`. |

Worker paths also serve current plan allocation/nonoverlap. Keep that intent distinct from user authority. Since workers currently run serially, broadening one advisory edit does not require inventing concurrent writers. If it touches an earlier worker's file, record that observed interaction for review; do not silently interpret advisory mode as permission for two simultaneous writers. Stage 7 needs actual ownership/leases or isolated worktrees, not prefix checks as a substitute.

## Check integrity is a separate rule

`core/environment-repair.ts::dependencyManifestPreserved` currently freezes **every** top-level `package.json` field except dependency fields; it rejects metadata edits and creating a new package, not merely weakening checks. Both RepositoryTools and final `verify()` enforce it. Do not silently retain this as “planned scope” or delete it indiscriminately.

For the scope substep, keep a separately named, visible trusted-check rule while migrating mode. Then narrow it around host-frozen acceptance inputs/check definitions: modifying a test or build script is a code change to review, while replacing the trusted acceptance command with the agent's choice must not create self-accepted evidence. Frozen commands alone are insufficient if they execute candidate-controlled package scripts. Either freeze/protect the actual trusted check dependency closure, or show that the check definition changed and require explicit service/user adoption before it counts as acceptance. Do not claim arbitrary script edits are independently verified by unchanged command text.

## Client-brand branches and replacement gates

| Current branch | Capability/policy treatment |
| --- | --- |
| `core/execution.ts` ~469 and ~1046: bounded planning only for `client === 'managed'` | Planning strategy requires enforceable tools-free structured turn, or explicit read-only inspection strategy. Choose by actual adapter/environment capability. Native unsupported no-tools is an honest capability difference, not a privileged legacy workflow. |
| `protocol/schema.ts` ~547: bounded planning requires managed coordinator | Validate frozen strategy requirements/capability revision, not a client string. A managed-branded test adapter without enforcement must not pass automatically. |
| `core/execution.ts` ~482: create usage ledger only when any managed client | All backends report usage coverage (`observed`, `partial`, `unknown`) through the common contract. Do not infer zero usage for a native session or promise a hard token cap with incomplete accounting. Aggregate default-none activation remains stage 5. |
| `core/runtime-router.ts::resumeSession`: historical direct Codex fallback | Remove on the explicit prerelease cutover. Require a durable route for any client; changing to another adapter is not reconciliation. |
| `protocol/resources.ts`: reserved literal `codex` ID / managed forbidden same ID; `CodexRuntime.id` constant | Use arbitrary configured backend IDs with adapter kind separately. Two instances of one adapter and a Codex-absent catalog must work. |
| `adapters/resources/runtime-resources.ts`: concrete adapter/provider construction | Factory branching is composition, not necessarily a workflow privilege. Stage 4 moves factories/parsers into trusted contributions. In stage 2 expose truthful capabilities per configured instance, not broad claims inferred from `client`. |
| `ModelTeamSetupForm.tsx`, `ExecutionResources.tsx`: managed-only probe/setup filters | Model inventory may remain provider-specific, but team/role eligibility and required probes come from backend capabilities. Branding for labels is fine; backend-dependent authority is not. |

Required capability decisions include tools-free turns, structured completion, immutable-source read-only review, repository write confinement, strict planned-path write enforcement, cancellation outcome and accounting coverage. Bind environment enforcement with backend capability: a backend can inherit a verified host sandbox but cannot invent it. **Post-hoc scope rejection is not prevention**; the checkbox promises to forbid edits, so an adapter that can only inspect changes afterwards must reject strict assignment before dispatch or run behind enforceable host authority. No provider fallback or remote data-policy expansion is implicit.

## Focused acceptance evidence

Update existing tests in `tests/execution.test.ts`, `execution-planning.test.ts`, `project-planning-policy.test.ts`, `managed-runtime.test.ts`, `worker-envelope.test.ts`, `work-segments.test.ts`, `managed-worker-checks.test.ts`, `worker-step-checks.test.ts`, `worker-storage.test.ts`, `runtime-router.test.ts`, `projects.test.ts`, and shared fixtures; confirm actual filenames when implementing.

Add one cross-layer scenario, not many mirrored unit tests: planned `src/a.ts`; a writer edits `tests/a.test.ts` too. Advisory mode must reach independent checks/review/checkpoint and report the additional path. Strict mode must deny before the write for a capable managed broker. Repeat after context rotation, check feedback, known-failure continuation and restart; none may reintroduce strictness or forget the grant. Protected/service files, traversal, aliases and read-only reviewer writes remain denied in both modes. Changing policy requires a new host revision and settlement of any conflicting pending effect.

Backend parity cases: same capability contract under two arbitrary IDs; tools-free planning accepts a capable non-Codex adapter and rejects a falsely labeled one; native read-only review is tested against absolute live-source reads; unsupported strict capability gives a typed reason plus valid reviewer/backend selection action; no installed Codex is required by a managed-only host. Stage-1B immutable tree/checkpoint and unknown-effect regressions remain required.

Boundary review should search all `inScope`, `allowedPaths`, `Only these paths`, `outside.*assignment`, `assertSegmentScope`, client-name predicates and private scope schemas after implementation. A green UI checkbox plus a permissive final check is not an end-to-end cutover.
