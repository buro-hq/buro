# Product API, UI and test-surface audit

Date: 2026-11-21. Scope: UI resource/team/run policy views, browser/CLI client, WebSocket protocol, build/distribution and representative test suites/scripts. Read-only source audit; no production code, live UI, models, RTX, credentials or original user repositories were accessed. The parent reports a fresh 605/605 `npm test` run, successful build/typecheck and formatting; those checks were not rerun here. Findings below distinguish source-observed behavior from unexecuted regression scenarios.

## Verdict and strengths

The UI and CLI already share the same transport client and application commands. Browser code does not import core, adapters or Cordis. Strict request/event parsing, command receipts, reconnect replay with the same pending request ID and capability-based feature visibility are useful foundations. Preserve these rather than create separate UI, CLI and future automation implementations.

The product is not yet backend-neutral or independently packageable. The visible setup and some recovery controls repeat closed client/role assumptions and finite policies. Tests provide substantial deterministic protocol/recovery coverage, but their aggregate count is not evidence of live-model coding quality, browser acceptance or independently consumable packages.

Fixed Buro concepts such as a default coordinator/reviewer, code-check evidence and familiar role presentation are not inherently bad hardcode. The issue is when these become universal runtime requirements, privileged client branches, hidden stops or a second source of execution policy.

## Ranked findings

### PS01 — P2: backend extensions still require product UI edits

Evidence: [ModelTeamSetupForm.tsx:57](../../src/components/organisms/ModelTeamSetupForm.tsx) and line83 match only managed definitions; lines100 and135 branch on Codex/managed and construct managed definitions. [ExecutionResources.tsx:324](../../src/components/organisms/ExecutionResources.tsx) filters diagnostics to managed runtimes. [TeamPanel.tsx:23](../../src/components/organisms/TeamPanel.tsx) repeats five profile-role IDs, and lines184–212 restrict per-role selection to the worker pool while profile roles are forced to auto.

Effect: the current two supported transport families are understandable, but registering a third backend in the runtime catalog does not make it configurable or inspectable through the actual product. Coordinator/reviewer selection exists in team-profile setup; it is not accurate to say those models cannot be configured at all. The asymmetry is how role preferences and backend configurations are represented and extended.

Direction: use one backend catalog with capabilities and adapter-owned validated configuration. Keep a useful compact first-party form, with common model/endpoint/role settings and an advanced section for adapter-specific options. Prefer explicit trusted UI contributions or common metadata over arbitrary executable UI schemas. All eligible backends can fill any role; unsupported scope/accounting/streaming stays explicit. Test a third backend through setup, diagnostics, role selection and unavailable-capability feedback without central brand branches in orchestration.

### PS02 — P2: settings round trips preserve arbitrary stops and can change unseen policy

Evidence: [ProjectProfileForm.tsx:217](../../src/components/organisms/ProjectProfileForm.tsx) labels `maxWorkers` as concurrent workers and admits only1/2, while worker dispatch is serial and that field limits total logical plan membership. Lines224–227 expose repair0/1/2 only. Lines43–51 rebuild every setup command and overwrite `timeoutMs` with300000 on any save. [ModelTeamSetupForm.tsx:138](../../src/components/organisms/ModelTeamSetupForm.tsx) spreads finite parsed defaults back into new runtime limits.

Effect: the user cannot represent observation-only quotas or open-ended repair using these controls. Editing an unrelated profile field can change a setup timeout the form never displayed. This is an actual source-level round-trip behavior, not a live browser reproduction.

Direction: distinguish model request capacity, active inference/writer concurrency and logical team/task creation. Default aggregate quotas and repair/window lifetime limits are absent; explicit opt-in policy is a real state. Preserve command IDs/timeouts unless edited. Test no-op settings round trips and new none/inherit/bounded states across UI, CLI and service; do not merely rename fields while schema defaults recreate the stops.

### PS03 — P2: recovery requires human clarification and project-wide idleness even when the API does not

Evidence: [RunRecoveryPanel.tsx:215](../../src/components/organisms/RunRecoveryPanel.tsx) disables repair submission unless instructions are nonempty; [protocol/schema.ts:191](../../protocol/schema.ts) defaults them to an empty string. The panel at lines40–42 and [GoalRunAction.tsx:90](../../src/components/organisms/GoalRunAction.tsx) block continuation/start when any run in the project is queued/running/canceling. The individual disabled buttons do not explain which existing run or capacity owns that block.

Effect: recoverable work can need a human-authored sentence merely to proceed. Project-wide mutual exclusion is shown as inability to act rather than queueing or observable capacity. These current product constraints reduce autonomy even when the model and tools are ready.

Direction: permit continue from known failure evidence without new prose; request clarification only for a real unresolved decision. Show the blocking run/resource and queue action rather than one unexplained disabled button. Do not bypass unknown-effect reconciliation to make Continue convenient. Tests must distinguish waiting capacity, explicit user pause, known repair input and unknown effect; new runs retain independent workspaces and writer ownership.

### PS04 — P2: a client timeout loses the identity needed to safely retry a mutation

Evidence: [socket-client.ts:162](../../clients/socket-client.ts) creates a new UUID for each command. Its timeout callback at lines169–170 deletes the pending request and tells the user to retry. Reconnection correctly resends still-pending requests with the original identity at line158. [transport.test.ts:153](../../tests/transport.test.ts) proves server deduplication when the caller manually reuses the same request ID after a lost response.

Effect: after the client-side timer expires, a UI retry calls `command()` again and has a different ID. The first command may already have committed or still be running. Server receipts cannot deduplicate two different request IDs. This is a source-confirmed ambiguity; no duplicate-production-transaction reproduction was run in this audit.

Direction: expose durable operation/request handles and a status/retry API retaining the original identity. Client observation timeout means unknown/pending, not confirmed command failure. Test commit-before-delayed-response, timeout, reconnect, browser retry and conflicting payload reuse. Avoid automatic replay of an unknown external effect.

### PS05 — P2: there is no single visible effective-policy and stop-reason projection

Evidence: [GoalRunAction.tsx:81](../../src/components/organisms/GoalRunAction.tsx) presents one change-scope string; [RunRecoveryPanel.tsx:72](../../src/components/organisms/RunRecoveryPanel.tsx) displays `issue.message` and has specific old-budget copy at lines81–87. The profile checkbox at lines173–185 switches between saved/current check settings, while separate notices say the budget stays frozen. [ExecutionResources.tsx:180](../../src/components/organisms/ExecutionResources.tsx) already distinguishes saved/pending-restart configuration, and [useResourceCatalog.ts:7](../../src/features/resources/useResourceCatalog.ts) correctly checks negotiated feature capabilities.

Effect: there are useful truthful messages, but the user must assemble effective settings from project profile, run snapshot, role preference, resource configuration and lower-level stop behavior. There is no compact common view showing what is inherited, what actually stopped work, and which next action is valid.

Direction: add a service-owned effective execution projection: selected backend/model and reason, applied policy revision/origin, active capacity/wait owner, quota off or explicitly set, task scope mode, and a typed stop reason with one relevant action. Keep it compact; advanced details are expandable. Do not expose every internal counter as a required user configuration checklist. The user's latest decision makes task path scope advisory by default, with an optional strict checkbox. That must be an explicit policy mode; it does not make stale check/review evidence acceptable.

Tests: inheritance/explicit-none round trips; saved versus pending connection; queue versus terminal blocker; advisory versus strict task scope; exact accepted revision in both modes; consistent reason/action in UI and CLI.

### PS06 — P2: some run projections still merge logical roles with concrete attempts

Evidence: [model.ts:29](../../src/model.ts) selects the first role snapshot and first agent matching a role to derive `owns`; [model.ts:120](../../src/model.ts) selects the first reviewer to infer current phase. In contrast, [RunInspector.tsx:151](../../src/components/organisms/RunInspector.tsx) selects an exact thread or the latest agent for a role. It then displays `roles[agentName]`, whose assignment metadata can come from the earlier first match.

Effect: repeated assignments/reviews can show a latest session with earlier role-level ownership metadata, or infer phase from an earlier reviewer. This matters for the planned many-task, repeated-review architecture. It is a source-derived inconsistency, not a browser crash claim.

Direction: identify role definitions, role versions, task attempts and sessions separately in the presentation model. Derive phase from durable workflow state/events, and display assignment scope from the selected session. Test two attempts of the same role with different paths/resources and multiple reviewers across revisions. Keep the good dynamic fallback in `roleViewsForRun()` for newly created role IDs.

### PS07 — P2: the normal test command is narrower than product acceptance

Evidence: [package.json:16](../../package.json) runs Node tests only, while browser checks are separate scripts at lines12–27. [check-production.cjs:16](../../scripts/check-production.cjs) checks an empty replay view, screenshots and absence of recording requests; it does not exercise a live coding goal. [deepseek-live-regressions.test.ts:23](../../tests/deepseek-live-regressions.test.ts), [ollama-live-regressions.test.ts:50](../../tests/ollama-live-regressions.test.ts) and [provider-recovery-contract.test.ts:220](../../tests/provider-recovery-contract.test.ts) inject fake HTTP responses. That is appropriate deterministic contract testing despite the historical live-regression names.

Effect:605 passing tests are useful evidence for these contracts, not a claim of live DeepSeek/Ollama/Codex quality, browser flow success or benefit from several small-model roles. Browser scripts and evaluation reports remain separate evidence. No coverage percentage or CI success is inferred from test count; no `.github/` workflow was present in the inspected tree.

Direction: keep four explicit gates: pure/runtime contract tests, browser service-flow tests, package consumer/architecture tests, and controlled real-model evaluations. Run relevant deterministic/browser checks at each implementation stage; live evaluations are separately opted in and use approved frozen inputs. Benchmark equal-model workflows plus a compute-matched self-debug control, with hidden tests outside candidate selection. Preserve the existing realistic fake-stream, interrupted-tool and source-isolation tests rather than replace them with simple mocks of implementation details.

### PS08 — P2: build success does not produce reusable server/runtime packages

Evidence: [package.json:5](../../package.json) is a private single package with no exports/workspaces. Its build at line10 typechecks and builds the Vite web app. Both [tsconfig.json:12](../../tsconfig.json) and [tsconfig.server.json:9](../../tsconfig.server.json) use `noEmit`; the server uses source `.ts` imports. No `packages/` distribution existed in this review. [boundaries.test.ts:19](../../tests/boundaries.test.ts) uses a regular-expression layer guard, not package export/declaration/resolved-dependency tests.

Effect: source-level modularity is real, but another app cannot yet install the proposed contracts/runtime/providers/adapters as proven standalone artifacts. This is a target gap, not a broken currently published SDK.

Direction: build explicit exports and declarations for the four selected packages and install packed artifacts into an independent temporary consumer with no repository aliases. Verify no Buro domain, Cordis, UI or concrete project store leaks into generic contracts. Native process adapters declare their platform/runtime requirements; importing one backend must not install/start another. Add resolved dependency-DAG and negative fixture checks alongside the existing useful layer guard.

### PS09 — P2: automation entry points still assume the seeded Buro project; MCP is future work

Evidence: [cli/main.ts:10](../../cli/main.ts) and [socket-client.ts:74](../../clients/socket-client.ts) default to `codex-panel`; [provider.tsx:69](../../src/data/provider.tsx) also falls back to that ID. [CommandSchema:50](../../protocol/schema.ts) is the centrally validated application command union, and [daemon/websocket.ts:59](../../daemon/websocket.ts) parses that union before dispatch. The inspected `daemon/`, `cli/`, `clients/` and package scripts contain no Buro MCP server; MCP references in tests concern disabling Codex-owned transports.

Effect: the shared application API is a solid base for automation, but an empty production catalog needs explicit project discovery/selection before the CLI connects to a project snapshot. It would be inaccurate to call future goal creation through MCP already implemented. A new plugin command also requires an explicit public schema update; the typed command bus alone does not make the public API an arbitrary open extension surface.

Direction: separate application discovery from selecting a project session. Empty catalog/onboarding must work without demo IDs. Add an MCP adapter later over the same validated application commands and receipts, not a second scheduler or permissive bypass. For actual command extension needs, use trusted contributed schemas/namespaces with stable public capabilities; retaining closed first-party command contracts is a valid deliberate API choice, not inherently a defect. Test empty-catalog CLI/UI, discovery and future MCP command parity.

## Suggested implementation order

1. Fix accepted-revision and unknown-effect guarantees found by the agent-system audit; relaxed task scope does not relax evidence identity.
2. Define common backend/policy projections and expose meaningful stop/wait/continue actions. Remove hidden default quotas and unnecessary human clarification requirements through the complete contract change.
3. Align UI/CLI setup with contributed backend capabilities, deliberate per-role preferences and the empty production catalog.
4. Extract and prove the four standalone packages; keep browser and provider-quality gates separate from deterministic test count.
5. Add future MCP over the same application API when needed. Do not introduce a second orchestration engine merely to expose automation.

No fixes, dependency installations, new tests or runtime calls were performed by this audit. Source links identify the inspected implementation; later changes must revalidate their line positions and behavior.
