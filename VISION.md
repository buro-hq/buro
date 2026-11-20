# Buro product vision

## Purpose

Buro turns a coding goal into a reviewable, verified change. The user supplies the outcome and constraints; a coordinator investigates the project, delegates focused work, selects specialists, checks results and repairs findings. The user can inspect or redirect the work whenever needed.

The product should make smaller models and different coding clients useful through bounded assignments, relevant context, reliable tools and independent verification. The quality target is a higher rate of correct accepted changes at a comparable budget, or comparable quality at a lower cost. Agent count and conversation length are not success metrics.

## Current product and next milestone

The current production runtime is Codex CLI. The next implementation milestone includes **Ollama and the DeepSeek model API**, alongside the existing Codex adapter. Both providers are part of that milestone's acceptance criteria. DeepSeek Harness is a reference architecture, not a required runtime or dependency.

Ollama and DeepSeek use a Buro-managed agent runtime: Buro owns the tool loop, sessions, delegation and checkpoints. Codex remains a separate client adapter. A project can use one provider throughout or combine available clients and models under its selected policy. A managed-runtime project must be usable without Codex installed.

[Architecture](ARCHITECTURE.md) defines the target boundaries, [providers](docs/PROVIDERS.md) defines the first integrations, and [roadmap](ROADMAP.md) tracks delivery. The README and operational guides describe shipped behavior. The UX prototype demonstrates proposed interaction; its simulated runs are not implementation evidence.

## Default experience

1. Connect a repository. Buro inspects its configuration, instructions, structure and available checks, retaining the source of each proposal.
2. Choose execution resources and data policy once. Installed local models are discovered; remote providers use private machine configuration.
3. Describe the desired outcome. Project context and verification defaults are inherited; detailed overrides are available in place.
4. The coordinator investigates and starts useful work. It chooses the team while learning about the task rather than requiring the user to approve a fixed roster.
5. Buro runs independent checks, obtains a fresh review and sends concrete findings back for repair within the allowed budget.
6. The user receives the change, evidence, limitations and next available action. Acceptance, application, PR creation and deployment have separate states.

Routine work proceeds under saved policy. Questions are reserved for missing requirements, unavailable resources, material product choices or actions outside that policy. One unanswered question should block only the work that depends on its answer.

## Project model

The hierarchy is Project → Goal → Run → Task → Attempt → AgentSession.

A project owns shared input materials, configuration, available roles and resource preferences. A goal owns its intent, criteria and selected inputs. Several runs may explore the same goal independently. A run owns a versioned task graph, worktree, decisions, attempts, verification and results.

A role is a versioned definition of a skill and instructions; a session is one concrete assignment. The coordinator can reuse roles or propose a missing specialization. A new role appears as a candidate during the run and becomes reusable after successful evaluation or an explicit user action. Creating a role cannot grant new tools or permissions.

Project inputs, goal inputs, session context and run outputs remain distinct. Outputs retain provenance and become shared input only through an explicit promotion. Sessions reference immutable material versions; a user's later edit cannot silently rewrite the evidence of earlier work.

## Automation and control

The coordinator proposes what to do next. Buro validates decisions and owns scheduling, processes, tool execution, state transitions and acceptance. Delegation works across clients and does not require a coordinator client's native subagent feature.

The user can pin a role, change future defaults, clarify an active goal, pause work, answer a saved question or choose another available execution profile. Changes create revisions and invalidate affected evidence; they preserve completed work and previous attempts.

Provider choice is subordinate to project policy. A local-only goal stays local. A hybrid goal can use DeepSeek or Codex for permitted context and tasks within its budget. A provider failure does not silently authorize sending local material to a remote service.

## Quality with smaller models

Assignments have a narrow objective, known inputs, file boundaries, expected artifacts and a verification contract. Workers receive the context needed for that assignment instead of the entire team's conversation. Context budgets use model tokens and include room for responses and tools.

Implementation and review use separate sessions. Buro runs trusted acceptance checks against the actual integrated change. A successful model response or another agent's agreement cannot substitute for command results, inspected diffs and satisfied criteria.

The coordinator adapts the amount of delegation to task complexity and available resources. Several logical agents may share one local model and run sequentially. More simultaneous inference requests are useful only when resource capacity and task independence justify them.

Repeated identical failures trigger a revised assignment, a permitted resource change or a precise request for help. They do not produce an unlimited conversation. A stronger remote model is an available option when configured and allowed, not a mandatory part of local operation.

## Interface

The project is the entry point. It shows the next useful action, active runs, blockers and a compact explanation of the automation path. Goals have a searchable dense list; concurrent runs have visible context and stable identifiers.

The run overview contains the coordinator and agent map, timeline and an agent-focused feed on the right. Clicking an agent opens its assignment, client/model, bounded context, actions and evidence below the map. History uses the saved event stream; it is not reconstructed from model prose.

Verification starts with problems and missing evidence. Large changes use a file tree. The result explains changed behavior and the next available action. Technical settings unfold where needed; the primary flow does not expose scenario navigation or require configuring a complete team.

The project team presents reusable role definitions and their sessions compactly. Materials use a scope tree and list. Checks belong to project rules and concrete run evidence rather than a detached quality score.

## First milestone acceptance

[Private-project evaluation details removed.]

The first provider slice does not wait for a general task graph, automatic crash replay or SQLite migration. Those extensions follow through the same contracts. These criteria define the next implementation milestone, not capabilities already shipped by the current Codex-only runtime.
