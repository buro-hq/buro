# Reusable package boundary audit

[Private-project evaluation details removed.]

## Selected split: three shared packages

The root proposal in [REUSABLE-AGENT-PACKAGES-2026-11-21.md](../../docs/REUSABLE-AGENT-PACKAGES-2026-11-21.md) matches the observed coupling. Three shared packages are sufficient initially:

| Package | Responsibility | Dependencies / exclusions |
| --- | --- | --- |
| `@buro/agent-contracts` | Generic model messages, session and operation references, stream/lifecycle/usage outcomes, model capability metadata and provider/tool/context/journal ports | No Buro protocol, Project/Goal/Run, Git/workspace paths, code-review roles, Cordis, platform I/O or credentials |
| `@buro/agent-runtime` | Agent/tool loop, context selection, cooperative continuation, cancellation, effect sequencing, usage observation and optional quota decisions | Depends on contracts, receives all side-effect implementations through ports; no repository discovery, code acceptance or voice-turn policy |
| `@buro/model-providers` | Ollama/DeepSeek transports, wire-stream normalization, provider-specific context projection/private continuation, metadata and observed usage | Depends on contracts; provider-specific subpath exports; no app config discovery, tools, workflow decisions or session database |

[Private-project evaluation details removed.]

[Private-project evaluation details removed.]

The runtime must not import a concrete provider; the host supplies one. Providers must not import the runtime or either application. No independent service or event bus is required merely to publish these packages.

## Why current files are not ready-made public packages

1. **`core/model-ports.ts` mixes transport-neutral and coding-specific types.** `ModelProvider` is a useful seed, but the same file imports coding `RuntimePurpose`, `ManagedWorkSegments` and `ManagedWorkerStepChecks`. `ToolScope` requires project/run/workspace/path/command/base-commit data. A non-coding host should not manufacture a fake repository to use a tool.
2. **`core/managed-runtime.ts` is coupled to Buro ownership.** Its constructor requires `ProjectRegistry`; `start()` and `resume()` read a project's runs, policy, materials and Git base. It imports `inScope`, environment repair, worker checks, work-segment evidence and `ManagedRunBudgetPort`. Exporting that class unchanged would export the Buro application model as an allegedly generic runtime.
3. **`core/ports.ts` is an umbrella application module.** `AgentRuntime.start()` requires project identity and optional coding assignment/workspace. `DomainError` lives alongside `ProjectDocument` and registry types. Both runtime errors and generic contracts need neutral homes; type-only imports still leak application dependencies in public declarations.
4. **`core/runtime-router.ts` combines generic handles with application selection.** It validates role assignments, consults project resource profiles and persists project/run/workspace routes. Buro should keep this routing policy; a generic session handle/router cannot require its project protocol.
5. **`core/runtime-events.ts` is not a generic streaming API.** Events require `runId`/`threadId`, include command and repository-segment events, and expose completed messages rather than text deltas. Provider adapters already consume SSE/NDJSON streams, but `ModelProvider.complete()` exposes `onProgress()` without an incremental text payload. This is an actual contract change needed for another interactive host, not simply another `subscribe()` call.
6. **Provider implementations are close to reusable but not isolated.** Ollama/DeepSeek and `http.ts` import `DomainError` from Buro's umbrella module. Provider revisions use `node:crypto`. Credentials are correctly resolved through a callback in DeepSeek, but Buro's config/credential loader belongs outside the provider package. Do not promise browser portability while Node imports remain; a Node-first host package is acceptable if declared and tested.
7. **Repository tools are domain/platform adapters.** `RepositoryTools` imports Node filesystem/process APIs, project check execution, `inScope` and dependency-manifest rules. It stays in Buro. The shared runtime only needs tool definitions, host-issued authority references and an executor port.
8. **`createRuntimeResources()` is application composition.** It constructs Buro file configuration, credentials, project ledger, repository tools, checks, providers and runtimes. It is not the public generic factory. Cordis plugins remain in Buro's host.
9. **Private checkpoint schema is application-shaped.** `FileManagedSessions` validates repository scopes, segment/check evidence and Buro-specific transitions. Split the generic operation journal/session state from host extension data rather than publish all of this schema as the universal agent session.

## Authority, persistence and optional quotas

A generic tool call should carry a stable operation ID and an opaque host-issued authority reference. Buro resolves that reference to a worktree, allowed writes and exact permitted commands. Another host resolves it to its own capabilities. The model does not create or expand the reference.

The generic runtime can sequence intent/admission, dispatch and observation through an injected journal port. That port must specify conflicting/idempotent operations, pending/completed/unknown outcomes and cancellation. It must not secretly become a second authoritative storage system.

For Buro, run state, incremental usage, domain events and command/dispatch receipts must commit through one host transaction authority. If the selected fresh persistence adapter is SQLite, these records belong in the same ACID boundary; generic agent storage in a separate database followed by an eventual Buro summary would break this ownership. Current file-backed state must not be described as already SQLite. A fake memory journal is enough for an independent consumer test, not proof of durable multi-record atomicity.

Observation of usage is generic; an optional user quota can be generic pure admission policy. Goal-wide review reserve, role priorities, workspace capacity and quality acceptance belong to Buro. No default quota should be reintroduced by generic per-turn/session/window counters. Physical request capacity, host permissions and unknown-effect reconciliation are separate concerns.

## What remains Buro-specific

Projects, goals/runs, team/role catalog, coordinator task proposals, repository discovery, Git/worktrees, build/environment preparation, trusted test recipes, review-evidence gathering, candidate selection and final code acceptance remain outside the generic runtime. The writer/check/critic/repair workflow composes generic sessions; it is not a required lifecycle for every application.

[Private-project evaluation details removed.]

Native Codex remains a Buro adapter initially. Its process launch, project root, environment executor, native sandbox and event normalization are materially different from a generic HTTP model provider. Treating it as equivalent without capability/usage declarations would hide those differences.

[Private-project evaluation details removed.]

Conceptually, another host composes:

```text
model-providers/ollama or /deepseek
          + host tool authority resolver
          + host journal/admission implementation
          + host context inputs
          -> agent-runtime session
          -> normalized text/tool/usage/lifecycle events
```

The host supplies IDs, instructions, capability grants and completion policy; no `ProjectRegistry` is required. A minimal verification host can expose a harmless in-memory tool, consume incremental text, cancel a turn and inspect its final/unknown outcome. This test must use built package artifacts installed outside the Buro repository, not source path aliases.

[Private-project evaluation details removed.]

## Extraction proof gates

[Private-project evaluation details removed.]

The selected three-package design is consistent with the root plan. The main blockers are extraction of application ownership from the current managed loop, a genuinely incremental event contract, a host-transaction-aware journal port, explicit Node/runtime support, and independently consumable package outputs. None requires assuming or implementing a speech stack in the agent packages.
