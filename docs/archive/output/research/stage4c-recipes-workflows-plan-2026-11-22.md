# 4C2–4C3: recipes, roles and first setup

Read-only preparation while 4C1 is in progress. No production code, model endpoint or user project was changed. Implement only after the 4C1 commit and its gates.

## What the current code really does

- `adapters/files/project-manager.ts:66` (`FileProjectRepository.inspect`) reads root `package.json`, chooses npm/yarn/pnpm from metadata/lockfiles, recognizes four script names, selects the first check, infers dependency linking and emits monorepo warnings. Setup is currently empty. These are Node-specific heuristics inside the repository adapter.
- `core/project-application.ts:157` seeds coordinator/reviewer when opening a connected project, then adds every `operationalRoles` entry: five roles before any work. `adapters/files/project-store.ts:94` also still has a raw `options.roles || defaultRoles` fallback, even though the store factory normally passes `[]`.
- `core/execution.ts:537` already creates missing coordinator/reviewer atomically in the run-start transaction, freezes role versions and resource decisions before dispatch, and delegates worker proposals to the coordinator. Its fallback content still imports `defaultRoles` directly.
- `core/results.ts:162` fails with `ROLE_MISSING` for a missing preview/PR/deployment role. It already has the correct transaction for freezing the role, actual operation context and resource decision before preparation.
- `core/execution-ports.ts:4` reserves five literal role IDs for workers. That is broader than actual independent-review/coordinator separation and conflicts with arbitrary operational roles that can also implement work.
- `core/workflow.ts` is an unused phase/gate prototype. Do not grow a second execution engine around it.
- `adapters/files/resource-configuration.ts` requires at least one runtime/profile and creates a Codex connection profile implicitly. `plugins/resources.ts` dereferences the default profile; `plugins/runtime.ts` requires a default runtime even when a router exists. These prevent a truly empty configured installation.
- The model/team form already tolerates a missing current profile in several places. The server schemas, composition and catalog error paths are the larger blockers. ProjectPicker currently enables automatic research from command availability alone, so an empty model setup would connect a project and immediately fail research.

## 4C2: active check-recipe contributions

Add a small sealed `CheckRecipeCatalog`, registered through the trusted startup configuration hook before project management is installed. Move the existing Node discovery implementation into a real builtin contribution; do not leave both implementations active.

Suggested application-side contract:

```ts
type RecipeFacts = {
  head: string;
  files: readonly { path: string; content: string; digest: string }[];
  directories: readonly string[];
};
type CheckRecipeProposal = {
  checks: ProjectCommand[];
  defaultCheckIds: string[];
  setup: ProjectCommand[];
  environmentRecipe?: EnvironmentRecipe;
  dependencies?: ProjectProfile['dependencies'];
  warnings: string[];
  evidence: { path: string; digest: string }[];
};
type CheckRecipeContribution = {
  id: string;
  revision: string;
  label: string;
  inputs: readonly string[];
  propose(facts: RecipeFacts): CheckRecipeProposal | undefined;
};
```

The host captures declared, bounded repository facts. Relative paths, private paths, symlinks, file size/count and evidence membership are checked at that boundary. Contributions do not receive arbitrary filesystem/process access through the contract. Trusted installed code still shares the process; this is an architectural port, not a hostile-plugin sandbox.

The catalog validates detached results with `ProjectCommandSchema`/`EnvironmentRecipeSchema`, checks unique IDs and default-check membership, and supplies contribution ID/revision outside the contribution-authored proposal. No `execute`, `apply(doc)` or arbitrary RPC callback belongs in this interface. Unknown package-manager names should produce a warning rather than become a shell prefix.

Inject the catalog into `FileProjectRepository` through `projectManagementPlugin`. `inspect` invokes it and builds a draft only for an unconfigured repository. Return proposal provenance alongside the existing `RepositoryInfo.profile`; keep a saved profile authoritative and unchanged. The existing profile form is the initial review/save path, so no new generic plugin RPC is needed. A later explicit recipe refresh can use the existing profile revision guard.

The first extraction should preserve current Node behavior, including no automatic install on inspection. An environment/setup proposal is data reviewed in the draft, not a process run by inspection. Final execution still uses the frozen project profile, `ProjectEnvironments`, registered executors and `ProjectChecks.run`; recipes cannot fabricate checks or change acceptance during a run.

Files: new `core/check-recipes.ts`, `protocol/check-recipes.ts`, builtin `adapters/check-recipes/node.ts`, a small Cordis registration service; edits to `FileProjectRepository`, `projectManagementPlugin` and the inspect proposal display. Keep Node I/O out of core.

Acceptance: Node discovery through the real catalog; one synthetic non-Node manifest contribution producing checks plus an environment recipe through actual composition; zero processes/model requests during inspect; invalid output/default references/duplicate IDs and unsafe inputs rejected; manual saved commands preserved; actual final immutable checks still run through their original authority.

## 4C3a: operation-driven role templates, consumed on demand

Use a trusted `RoleTemplateCatalog` for the content of required workflow roles, plus an explicitly selected workflow-role binding contribution:

```ts
type RoleTemplateContribution = {
  id: string;
  revision: string;
  create(context: { operation: ServiceOperation; profile?: ProjectProfile }): RoleDraft;
};
type WorkflowRolesContribution = {
  id: string;
  revision: string;
  templateFor(operation: ServiceOperation): string | undefined;
};
```

`RoleDraft` contains only title, description, instructions and descriptive kind. The composition explicitly selects one installed workflow-role contribution; it maps actual operations to registered template IDs. A third contribution can be selected through the same real path without competing with a generic builtin matcher. Missing bindings or template IDs are configuration errors, never registration-order fallback. The actual `ServiceOperation` still supplies the required role ID and mechanics; the workflow-role contribution cannot replace those. Both catalogs must have real consumers in start/result preparation, not be empty extension promises.

Move coordinator/reviewer and preview/PR/deployment content from `defaultRoles`/`operationalRoles` into the builtin coding-workflow registration. Dynamic deployments use their actual configured operation and role binding, so a custom deployment role ID gets a deployment template without a new literal-ID branch. A template cannot modify the operation's requirements, grant tools, pick an endpoint or skip checks.

Production consumers are the existing transactions in `ExecutionService.start` and `ResultService.prepare`. An existing latest user role always wins, including its instructions and model preference. Otherwise create exactly the required role once, with service-owned ID/version/timestamps, and freeze it with the actual operation/resource decision before dispatch. Save template provenance with the created role or run snapshot for UI explanation. Resume uses frozen role content; updating a template does not rewrite existing roles or settled grants.

Remove role seeding from `ProjectApplication.open` and the raw FileProjectStore fallback. A newly connected project really has an empty team. The first coding run creates coordinator/reviewer; the coordinator then reuses or proposes workers through the existing team-plan validation. A result operation creates only its missing preparation role. Explicit user roles remain editable and are never replaced by generated defaults.

Replace the five-name worker reservation with the actual workflow bindings needed to preserve coordinator/reviewer separation. Do not remove independent review or allow its saved reviewer session to become an implementation receipt. Delivery roles can legitimately serve implementation too, as the operation catalog already expresses.

Do not advertise a generic workflow DAG/plugin engine here. This is an active contribution seam for role content within the real coding workflow. A different phase scheduler needs an actual host consumer before adding a workflow selector or arbitrary phase callbacks. Preserve the single execution lifecycle and effect authority; remove or clearly leave the unused `core/workflow.ts` prototype outside the production claim.

Acceptance: connect/restore has zero roles; first run creates exactly the needed roles once; duplicate receipts/restarts do not reseed; missing custom deployment role is created and frozen before preparation; user role versions/preferences survive; unknown operations remain stopped; a third template is consumed by real service composition. Configured checks and fresh independent review remain mandatory. No AI score or model-brand branch is added.

## 4C3b: empty resource configuration and usable first profile

This is a separate schema/composition cut, not just deleting the Codex default:

- Use required `defaultProfile: string | null`; allow empty connections/runtimes/profiles. Validate a non-null default against configured profiles. `defaultResources()` returns empty arrays and null. Registered builtin descriptors still exist, but registrations are not configured execution grants.
- A project override may select an active profile even when the machine default is null. Otherwise `ResourceSelection.forProject` raises `RESOURCE_PROFILE_REQUIRED`; never select the first profile or invent Codex.
- Compose a router over an empty `RuntimeCatalog`. Remove mandatory `defaultRuntimeId` from the routed path and the `profiles.find(...)!` dereference. An explicit standalone adapter host can supply its own adapter factory; there must be no implicit native fallback.
- `resources.list` remains available before model setup and returns provider/backend descriptors, configured pending definitions and a clear selection issue. For a project with no selected profile, omit `selected`, return no eligible role pool and keep history readable instead of throwing the entire catalog request.
- `resources.setup.save` must accept the first profile while the default remains null. It still creates IDs atomically, starts no model and preserves explicit restart/selection. After restart, `resources.use` selects the profile deliberately. Resource events already propagate this transition to every client.
- ProjectPicker bases automatic research on actual selected resources, not merely the presence of the research RPC. Connecting a repository must work without any model. The research checkbox is unavailable with a clear next action until configuration can serve that operation.
- The first-profile wizard uses the candidate for coordinator/worker/reviewer when no profile exists, with explicit data policy. One small local model can serve all roles through distinct sessions; this does not remove independent review. Model templates/locality remain server-authored.

Keep the current honest restart lifecycle for this cut. A new provider needs activation before discovery, and a model/profile needs activation before selection. For one-restart manual setup, users can save the connection and an explicit model/backend/profile before restarting; do not claim the separate writes are one atomic transaction. A combined draft setup transaction or live instance leases are a later measured UX improvement, not an excuse for hot replacement under existing grants.

Real first-run UX: connect repository → review detected checks → empty project/team with a clear Configure models action → choose an installed provider or explicit native backend → save connection/model/profile → restart as shown → explicitly select profile → optionally research → create goal. If checks are missing, show Configure checks rather than queue a coding run that will fail. The existing `ExecutionService.start` nonempty registered-check gate and fresh review are preserved.

Acceptance: a clean synthetic service has zero projects/resources/roles and starts no Codex subprocess; global UI/CLI can configure the first connection and profile; first selection works after restart; no-resource history remains readable; no model call occurs merely by opening/saving setup; current stale-revision, pending-config, unknown-operation and cross-client invalidation tests still pass. Pre-release schemas/callers change cleanly together, with no old-format aliases.

## Implementation order

1. Finish/commit 4C1 and its independent gates.
2. Implement 4C2 recipe catalog plus the moved Node consumer and non-Node proof; review boundaries and commit.
3. Implement 4C3a on-demand role templates and empty connected team; review transactional snapshots/recovery and commit.
4. Implement 4C3b empty model configuration plus the complete first-profile UI/CLI path; prove clean startup and commit.

Terminology followup in this UI slice: change “Review accepted changes” to “Review changes”. The review occurs before acceptance. Do not edit that label during 4C1.
