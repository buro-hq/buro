# Project discovery contributions

Project inspection obtains Git facts and proposes a draft configuration without executing project commands or calling a model. The built-in Node recipe recognizes existing `test`, `typecheck`, `check` and `lint` scripts, the declared package manager or lockfile, and dependency-linking hints. It no longer lives inside the filesystem repository adapter.

Trusted startup plugins register a `CheckRecipeContribution` through `ctx.projectContributions.checkRecipes` in `createHost({ configure })`. Registration is sealed before project management starts. Each contribution declares exact relative inputs and receives only its own detached, frozen manifest facts. The callback receives no filesystem, model, process or executor port.

Inputs distinguish bounded UTF-8 text from file/directory presence. A directory input such as `node_modules` is checked as metadata; its contents are never traversed. Private paths and symlinks are rejected before manifest bytes are read; `.env.example` remains allowed. Capture permits at most 16 declarations per contribution, 64 distinct inputs per inspection, 256 KiB per text file and 1 MiB of text overall.

Recipes return data: validated project checks, default check IDs, setup commands, optional environment recipe/dependency hints, a name suggestion and warnings. Commands pass the existing project/environment schemas. Duplicate command IDs and conflicting project settings fail explicitly instead of depending on plugin registration order. A recipe does not select an executor, grant tools or generate a passed check receipt.

`RepositoryInfo.checkRecipes` exposes the contribution ID/revision, observed HEAD and input paths/presence. Existing text inputs include the SHA-256 of captured bytes. Manifest content stays out of provenance. Inspection checks HEAD again before publishing; a concurrent commit requires another inspection. Dirty working-tree facts can still be proposed with their actual hashes and the existing dirty-tree warning; this is not a full immutable snapshot of an uncommitted repository.

A saved `.buro/project.json` remains authoritative. Its profile and name are returned without invoking recipe callbacks, so installing another detector cannot replace manual commands or make opening an existing profile depend on unrelated discovery inputs. For a new repository, the proposed draft appears through the existing connect/profile form and is saved explicitly by the user.

The installed code is trusted and runs in the service process. The bounded facts API is an application boundary, not a sandbox for hostile plugin code. Output validation establishes a valid proposal shape; the recipe author is responsible for deriving meaningful commands from the declared project evidence.

After configuration, the existing prepared executor and `ProjectChecks` run the selected commands. Checks use the frozen project profile and final immutable acceptance view; independent review and reconciliation rules remain unchanged. Opening or saving a discovery proposal never installs dependencies, executes a test, queues a goal or changes model limits.
