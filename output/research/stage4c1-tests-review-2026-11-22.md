# Stage 4C1 independent tool contribution and host-boundary review

Reviewed on 2026-11-22 against `d4239d9` plus the current tool-contribution working tree. Disposition: **clear within trusted startup tool registration, bounded repository effects and saved managed-session tool identity**, after the retained-schema correction below. This reviewer added tests only, with no production edits or commit.

## Independent evidence

**94/94 tests passed** in the final combined run after the source owner's freeze, across the new independent and architecture regressions, tool contributions, managed tool revisions, managed host effects, the actual SDK loop, SDK durable recovery, managed runtime/resume, process isolation, repository search, resource contribution integration and architecture boundaries. `npm run typecheck` passed. These focused tests overlap the owner's final suite; they are not an additive distinct total or a claim that this reviewer ran the entire suite.

Local receipts: `/private/tmp/buro-stage4c1-independent-tests.log`, `/private/tmp/buro-stage4c1-independent-schema.log`, `/private/tmp/buro-stage4c1-independent-schema-final.log` and `/private/tmp/buro-stage4c1-independent-typecheck.log`. No browser was needed for this server/adapter stage. No model endpoint or external network was used. Process-isolation tests execute bounded local fixture commands, including proving that unauthorized network access is denied.

## Independent regressions added

`tests/stage4c1-review.test.ts` adds three passing cases. The dispatch cases use the actual Pi SDK runner, `ManagedAgentRuntime`, `RepositoryTools`, a sealed contributed catalog, real temporary files and `FileManagedSessions` reopened from disk:

1. The provider proposes a permitted custom write followed by a differently named command tool that is unavailable because no command is granted. The whole batch rejects before the first handler, file mutation or action intent. The reopened checkpoint retains the exact completed provider receipt, both proposed wire IDs and private continuation. The first target file is unchanged and no second model request occurs.
2. A standalone catalog registers the familiar name `run_command` with a read effect and a bounded file-read implementation. A read-only SDK session advertises and executes it as a read tool, records one completed host receipt and preserves the file. Its name neither grants command authority nor triggers the removed hardcoded command exclusion. This deliberately uses a standalone catalog; normal first-party composition reserves its already registered built-in names through duplicate rejection.
3. A contribution's real Zod refinement, absent from the advertised JSON schema, still rejects invalid input before its handler and accepts valid input. This protects the choice to preserve the actual parser rather than rebuilding a weaker parser from JSON metadata.

These tests verify actual dispatch and durable state, rather than inferring authority from labels or capability metadata alone. They use a synthetic provider and do not establish live-model task quality or performance.

## Existing tests independently rerun

The implementation owner's actual Cordis contribution tests exercise registration through the trusted startup hook, sealed admission, the Pi runner and the sole durable action journal. Post-write `DomainError` and invalid handler output leave an unknown action receipt, preserve the changed file and prevent a follow-up request or retry. They therefore cover a real repository mutation rather than a fabricated action status.

The bounded-helper lifetime tests hold an actual rename while the handler returns, proving broker settlement waits for the effect. A retained facade cannot start a later edit. Another test performs the rename and then fails, while the handler swallows the rejected helper promise; the broker still rejects instead of returning the handler's claimed success. Argument, scope, output and registration handoffs are tested for detachment; stronger helper effects, excluded/private files and immutable-view escape attempts are rejected.

The managed tool-revision cases prove cached sessions fail before inference after a revision change, a fresh runtime cannot reopen the saved session with another revision, checkpoint writes cannot rewrite the captured revision, and a revision change during inference preserves the exact observed response while dispatching no proposed tool. Restoring the original configuration allows legitimate continuation. Existing SDK/effect tests cover canonical batch order, in-flight receipt fencing, lost receipt recovery and preventing automatic replay of an unknown effect.

## Retained-schema finding

After the first 91-test run, the architecture review added an adversarial nested-schema case. This reviewer independently reproduced the failure: mutating the retained source Zod object's nested field changed the registered parser while the catalog's published parameters and revision still described the original string field. The original valid input then failed as ordinary arguments, with no explicit configuration change. This contradicted captured tool identity even though the plugin code is trusted.

The owner added a private semantic-schema liveness guard. It preserves the real Zod parser, including refinements, checks the definition graph while ignoring legitimate parse caches, and reports explicit `TOOL_CONFIGURATION_CHANGED` if retained definitions drift. It runs before metadata/revision publication and before/after argument parsing, without freezing the plugin's source object. The broker's revision getter also observes catalog liveness, so cached sessions cannot evade drift detection. The regression now rejects the changed definition before the handler; neither the old advertised contract nor its revision silently acquires the new numeric interpretation. A second architecture case proves liveness observation does not evaluate a schema default factory. The final 94/94 broad run and repository typecheck passed after this correction.

## Boundary assessment

Tool definitions and execution share one sealed catalog for built-ins and trusted contributions. The catalog captures name, revision, description, effect, parameter schema and handler identity; duplicate, unknown and late registration do not invent an executable fallback. Definition parameters and handler input/output cross detached boundaries. Declared schemas are validated before handlers and again by each bounded helper; undeclared nested fields are not silently discarded.

The generic host filters definitions and validates every proposed name/effect in the entire model batch before publishing action intents. `RepositoryTools` separately enforces the contribution's declared effect and the host scope for each facade operation. Read access does not imply write or command access. Strict scope, read-only/verification views, configured-command equality, protected paths, dependency-manifest protections, private-path exclusion and process confinement remain owned by the existing host adapters.

Contributions receive six bounded repository operations, not a raw filesystem, executor, mutable scope or journal. The adapter marks the start of possible write/process effects conservatively, drains started helper promises and closes helper admission when the handler settles. Failures after a possible mutation propagate to the existing host reconciliation path; they are not downgraded because they happen to look like ordinary domain-validation failures. Preflight/ordinary read failures remain recoverable tool results.

Every managed broker must provide a nonempty revision and an effect lookup. The saved session captures that revision; start/resume, cached and loaded sessions, and active host checks preserve it. Private checkpoint transitions reject revision replacement. The configured managed backend revision also incorporates the broker revision, protecting routed identity in addition to the private session check. Tool changes cannot silently retarget an old session through ordinary continuation.

## Simplicity and explicit remaining limits

Extracting the previous repository switch into registered built-ins, one broker and a bounded operations adapter is a useful separation. There is no need for a second tool-action ledger, a tool-specific scheduler or a parallel plugin permission system. Keep contribution registration and the small effect policy centralized; repository confinement belongs in the existing adapter rather than being reimplemented by every tool. The Zod definition observer is the most specialized new code: keep it private, pin/test its supported Zod representation, and preserve the parser/refinement and first-parse cache regressions when upgrading the dependency rather than expanding it into a general object-cloning framework.

These are trusted in-process startup plugins, not a sandbox for hostile extension code. A handler could import other Node capabilities on its own, and declared revisions cannot prove that an author's hidden closure/global state never changes. The constrained facade governs host-provided effects and prevents accidental scope/journal bypass; it does not isolate arbitrary malicious installed code. There is no dynamic installation/hot replacement contract, and changed tools intentionally require restoring matching saved identity or starting an explicit new workflow.

This stage adds tool contributions only. Context/check/workflow/role contributions, empty connected-team bootstrap, independently consumed package distribution, SQLite authority, default-none budgets, operational preparation receipts and concurrent-goal scheduling are not completed by these changes. Existing read/scan/output bounds and execution budgets remain present; no claim here removes them.

No real model endpoint, offline RTX host, original user repository, credential value, external message, deployment or Git commit was accessed by this reviewer. No new blocking finding remained after independent validation.
