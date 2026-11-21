# Stage 2B architecture, code and boundary review

Date: 2026-11-22. Independent review of the frozen stage 2B working tree over `6d70631`, including the final selector-containment fix and root integration. This reviewer made no production edits, ran no models/RTX, and did not rerun the full suite. The parent owns canonical validation and the commit.

## Verdict

**Clear for the bounded stage 2B scope-policy slice.** Planned paths are advisory by default, optional strict scope has explicit backend admission and managed-tool prevention, and additional accepted edits remain visible as service-derived evidence. The review's strict grant-expansion finding is fixed. No further blocking finding was identified in the requested final source freeze.

This stage does not remove budgets/quotas, finish a neutral agent loop or establish a general sandbox for arbitrary plugin code. Existing immutable verification and unknown-effect reconciliation remain independent acceptance requirements.

## Policy and boundaries

- `WorkScope` explicitly separates `mode`, `plannedPaths` and `protectedPaths`. The shared strict schema is used for project policy, execution snapshots, assignments and private tool scope; old `allowedPaths` is not a silent compatibility alias. Strict mode requires a nonempty plan. Discovery creates advisory policy with an empty plan rather than a hidden `src/` fence.
- `writeAllowed` checks actual file effects. Hard path checks remain independent of advisory guidance and reject traversal, absolute/drive paths, control characters, backslashes, service/dependency directory aliases and protected paths. The repository broker retains private-file filtering and symlink rejection. These authorizations do not turn arbitrary host processes or a malicious trusted plugin into a sandboxed implementation.
- Advisory workers, coordinator work, resumed sessions and context rotations receive consistent scope instructions. Necessary adjacent edits are permitted; empty plans mean discovery, not that every file is an unexpected deviation. Worker changes and reversions of earlier serial-worker edits are observed and recorded rather than automatically classed as failures for crossing an old allowlist.
- Managed strict support is an explicit new capability revision. The repository broker omits and rejects `run_command` in strict sessions; the managed runtime independently removes and rejects that command even when a broker advertises it. The permitted source-edit tool checks each actual destination. Candidate-controlled live intermediate checks are skipped in strict mode, after checking for unresolved prior check receipts. A skipped check does not become a fabricated passed receipt.
- Router admission requires `strictPlannedWrites` for writable strict work, including the root coordinator and resumed sessions, regardless of client label. Read-only inspection does not acquire unnecessary write requirements. Forged assignment mode, protection set or saved worker plan is rejected before a start intent. Unsupported strict execution has an actionable user-facing explanation instead of a request to repair code.
- Scope and check-definition integrity remain distinct: adjacent advisory changes can preserve scope while protected package/check-definition changes fail integrity. Final checks still run against an immutable source view, followed by a fresh independent reviewer and a checkpoint of the verified tree. This stage does not weaken those stage 1B conditions.
- Managed checkpoint validation now also protects unsegmented coordination sessions. Scope changes require a consistent explicit append-only scope revision; previous instructions, action receipts, authority history and unresolved outcomes cannot be rewritten through a permission refresh.

## Blocking finding cleared: exact file grant expanded into directory grant

The initial assignment validator called `writeAllowed(selector, parentScope)`. For a parent strict plan `['src']`, an assignment selector `['src/']` normalized to the same endpoint and passed. That assignment then authorized `src/child.ts`, which the parent exact-file plan did not authorize. Endpoint membership did not prove containment of the future grant.

The final `planPathAllowed` separates selector containment from actual-file checks. A directory or root selector needs a covering parent directory/root grant; an exact parent file cannot provide it. Alias normalization preserves this distinction. The shared predicate is now used by team resolution, managed start/resume, router assignment admission, worker envelope construction, assignment dispatch and recovery.

I read the final implementation and regressions for exact file versus directory/root, slash and `./` aliases, nested directories and changed parent scope on resume. The owner reports the focused scope/boundary/localization subset passing 14/14, and the managed selector/start/resume subset passing 62/62. I did not rerun them.

## Evidence reviewed

The new full-flow synthetic tests use real `RepositoryTools`, `GitWorkspaces`, `FileProjectStore`, managed private checkpoints, `ProjectChecks`, runtime routing and a fresh managed reviewer. Their provider responses are deterministic fakes. In both modes they attempt an allowed edit, an adjacent edit and a protected check edit; they verify real check execution, reviewer source reading, tree identity through the Git checkpoint and preservation of original project source. Advisory accepts and reports the adjacent file; strict prevents its edit. Protected check edits fail in both modes. These are integration tests of service behavior, not live-model quality results.

The final reviewed core derives `ScopeObservation` from the captured candidate revision, not from a model envelope. Before completion it requires its mode, tree, empty violations and additional-path list to match the accepted revision and policy, alongside the independent check/review evidence. The result UI displays additional paths only with matching revision evidence. An empty discovery plan reports no artificial list of all files as deviations.

Reported owner/parent validation at the review freeze: final integration subset 30 passing; two real full-flow scope cases passing; root execution subset 196 passing; foundation scope/UI subset 14 plus 43 project tests; managed runtime subset 113 passing before the focused selector extension; worker subset 45 passing. These subsets overlap and must not be summed as a unique test count. Canonical full-suite/build/format results belong to the parent's final report.

## Qualifications and remaining work

- Strict prevention here relies on the configured managed broker and runtime's bounded tool lifecycle, not arbitrary external processes or untrusted plugin implementations. Read-only/protected-path policy and final rejection should not be advertised as proof that every advisory command or native tool was prevented from attempting a transient write. Optional strict capability is not inferred for native backends.
- Previously documented source-view, imported dependency, platform and process-descendant limitations still apply. This review does not upgrade those guarantees through the scope selector fix.
- Aggregate budgets, request/tool/session quotas and existing orchestration defaults are unchanged in this slice. Their opt-in policy and hidden-limit audit remain subsequent work.
- Neutral backend/session contracts, planning brand removal, reusable package distribution and the broader coordinator/plugin product design remain unfinished roadmap items.
- Existing prototype data uses the old schema and should be archived before live cutover. The pre-release decision permits this clean contract break; no implicit migration is claimed.

The implementation restores planned-path autonomy while keeping explicit strict selection, transparent deviations and verified acceptance as separate mechanisms.
