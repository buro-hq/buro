# User repositories

Buro connects existing Git repository roots; it does not copy the source project into its own checkout. Every connected repository owns `.buro/` metadata and isolated worktrees. The service checkout stores a catalog of linked paths.

## Connect and configure

1. Inspect a repository with the directory picker or an absolute path. Inspection is read-only and rejects non-Git/nested roots and unsafe metadata symlinks.
2. Optionally connect and research it. A read-only agent proposes components, checks and missing infrastructure without installs, servers, migrations or deployment.
3. Review/edit/save the profile. Ready research is acknowledged by a manual save; applying suggestions preserves manual commands and boundaries. Stale proposals cannot overwrite a newer profile or changed repository.
4. Verify the environment using a separate worktree and configured commands before starting a goal.

Existing legacy metadata is detected read-only during inspection and migrated when opening/connecting. Migration retains IDs, profiles, history, roles and receipts, and repairs operational paths/worktrees. Conflicting directory names or a live writer stop migration. Backups and progress manifests remain private under `.buro/local/metadata-migration/`.

## Profile

`.buro/project.json` contains the project ID/name and versioned profile:

- Context, allowed/protected relative paths and base branch.
- Check definitions/default selections, setup commands and dependency strategy.
- Worker/repair limits.
- Components with working directory, launch command, readiness path/port and verification instructions.
- PR configuration and explicit staging/production environment definitions.

Profiles use optimistic revisions. Editing execution settings while a goal is active is blocked. Committed control-state is authoritative: a stale readable profile export is recovered rather than rolling back newer settings.

## Execution and source protection

New goals use the base branch unless a completed parent run is selected. Each run freezes its execution policy, selected checks, role definitions and materials. User source edits remain in the original checkout. Agents work in `.buro/worktrees/R-ID`; the service checks scope and protected instructions and creates the accepted checkpoint.

Applying an accepted result checks source branch/head, cleanliness and ancestry. Diverged branches require manual merge/cherry-pick. No force update or automatic source branch change is performed.

For Node projects, ordinary execution can link source node_modules. Monorepos require an explicit dependency strategy because workspace symlinks may point into the source checkout. Per-goal environment repair instead uses a private node_modules/cache and disables install scripts. It permits dependency fields/lockfiles while preserving scripts and check configuration.

See [onboarding and delivery](ONBOARDING-AND-DELIVERY.md) and [recovery](RECOVERY.md). Runtime metadata and credentials are private; the shared profile can be versioned separately.
