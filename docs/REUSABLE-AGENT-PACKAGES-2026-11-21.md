# Reusable agent foundation for Buro and other hosts

[Private-project evaluation details removed.]

## Selected split

Keep one repository and one Buro application, with three independently consumable workspace packages. Names are provisional until actual package publication. Do not split each policy into another package or introduce independent services.

| Package | Owns | Must not own |
| --- | --- | --- |
| `@buro/agent-contracts` | Domain-neutral session/operation IDs, normalized model messages and stream events, usage coverage, capabilities, provider/tool/context/journal ports and typed outcomes | Project/Goal/Run, Git, file paths, coding roles, Cordis, React, credentials, provider wire payloads |
| `@buro/agent-runtime` | Model/tool execution loop; cancellation and cooperative continuation; request/context selection policies; pure usage/quota admission; durable operation sequencing through injected ports | Project registry, repository discovery, shell execution, code review/acceptance, voice turn policy, platform process ownership |
| `@buro/model-providers` | Ollama and DeepSeek transports through explicit subpath exports; normalized streaming, provider projection/continuation, request capabilities and observed usage | Reading Buro configuration or credentials, tools, workflow decisions, session database or environment-global defaults |

Context strategies and usage policies begin as modules inside agent-runtime with narrow public exports. Extract another package only when a real second consumer needs an independent lifecycle or dependency set. A future Node/SQLite persistence adapter is separate from these packages, but not an excuse for a second authoritative ledger.

[Private-project evaluation details removed.]

Runtime receives a provider through a port; it does not import the provider package. Neither providers nor contracts import the runtime or either application. Provider-specific code must be reachable through explicit exports, without importing an unrelated transport. Native Codex remains a Buro adapter until an independent native-client contract and consumer justify generalizing it.

## Why existing directories cannot simply become packages

[Private-project evaluation details removed.]

Use the new contract to remove these couplings; do not preserve the old API with compatibility wrappers. Production coding behavior stays in a Buro layer that composes the extracted primitives.

## Host-owned authority and persistence

A generic tool request contains a tool name, validated arguments, operation ID and an opaque host-issued authority reference. The host resolves this reference to the actual permission context; a model cannot mint or expand it. Buro resolves it to a worktree/path/command policy. Another host can resolve it to its own permitted capabilities without inventing a repository.

The runtime requests a durable admission/dispatch grant and records an observed result through an injected journal port. This port must define idempotency, conflicting receipts, cancellation and unknown outcomes; an arbitrary `saveSession()` callback is insufficient for durable effects.

A dispatch grant binds the operation, authority and relevant state revision; uncommitted or stale grants cannot authorize execution. Revalidation and claim semantics must prevent a cancellation or policy transition between admission and dispatch from creating a second or unauthorized effect.

For Buro, the journal implementation participates in the **same SQLite authority** as run state, incremental usage, events and command receipts. Do not place the reusable runtime's ledger in a separate database with a later Buro summary update. The transaction implementation remains host-owned. Pure admission returns decisions/deltas; adapters own I/O and dispatch only after committed intent.

New session recovery preserves the original provider/model/data-policy identity, operation sequence and private continuation. A quota change is not authority to move data or replay an unknown operation. The lack of legacy compatibility does not remove recovery requirements for the new engine.

## What stays in Buro

Projects, goals/runs, task planning, coordinator decisions, role assignments, Git worktrees, repository tools, environment repair, trusted check recipes, independent code review, acceptance and integration remain application responsibilities. UI/CLI/MCP expose this application, and Cordis composes it.

[Private-project evaluation details removed.]

[Private-project evaluation details removed.]

The second host supplies its own instructions, tools/authority resolver, journal implementation and completion policy. It selects an Ollama or DeepSeek provider and consumes normalized text/tool/usage/lifecycle events. It can abort a session without assuming that closing its UI or output stream confirms a remote request or tool stopped.

[Private-project evaluation details removed.]

## Extraction sequence and acceptance

[Private-project evaluation details removed.]

Required evidence includes no-quota continuation past former counters, explicit finite-cap admission, bounded/paged context without lost evidence, idempotent journal conflicts, usage coverage and cancellation under streamed/tool responses. Buro's store tests additionally verify the single transaction boundary; a fake in-memory consumer proves portability, not production durability or voice performance.

See [the source-level package audit](../output/research/reusable-package-boundaries-2026-11-21.md) for coupling evidence and [the selected execution decision](EXECUTION-DESIGN-DECISION-2026-11-21.md) for workflow, accounting, cutover and evaluation gates. No packages, code, dependencies, releases or user repositories were changed by this design document.
