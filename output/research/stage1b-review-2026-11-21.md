# Stage 1B verification-view boundary review

Date: 2026-11-21. Independent source review of the working-tree implementation after `fd50e27`. This reviewer made no production edits, called no models/RTX and did not rerun the full suite. The parent owns the final code freeze and validation.

## Current verdict

**Clear for the bounded stage 1B implementation.** The final targeted source reread clears the legacy script-directory alias, registered-entrypoint replacement and standalone hash/open race findings. The design enforces the source-view boundary rather than relying on before/after equality alone. The installed native permission probe supplies specific additional evidence below. This reviewer did not rerun the parent's tests or claim that unverified platforms, imported dependency closures or arbitrary native executables share the tested guarantees.

## Correct boundaries present

- Git source inputs are materialized from content-verified immutable objects, with independent metadata and no alternates to the live writer repository. Raw bytes/modes and a baseline diff remain available without checkout filters or executing repository configuration.
- Declared check outputs are separate from captured source. The real Darwin sandbox denies source writes, chmod, rename and link-based mutation while allowing declared outputs/home/cache/temp. Linux uses a distinct implementation and needs its own execution evidence; source inspection is not a Linux test pass.
- Core binds view ownership to project/run/workspace/base/tree and retains check/review evidence for the accepted tree. Managed reviewer sessions pin the active view ID/tree privately and reject another or released view instead of silently reading the implementation workspace.
- View cleanup is attempted on normal, failed and cancelled workflow paths. Missing/unsupported isolation is explicit; Docker is not silently run on the host.
- Public `.buro/project.json` and `.env.example` remain distinct from private runtime/credential paths. Both candidate and baseline manifests are now validated before copying Git objects.

## Blocking finding found during review: legacy script-directory permission

The initial `NodeChecks` verification fallback launched the original trusted script with Node permission `--allow-fs-read=path.dirname(script)`. A script placed at the live project root therefore retained read access to that project's live `src/`, despite `GOAL_WORKSPACE` pointing at the frozen view.

Controlled reproduction `/private/tmp/buro-node-view-alias-review.ts` passed1/1 in approximately0.11seconds. A real child Node check read `passing-live` beside its original script while the issued view contained `failing-frozen`, and returned passed1. It used only temporary synthetic files, not models or user repositories. This proves the alias exists; the original service-owned script need not intentionally mutate source for its provenance to be misleading.

**Cleared by targeted final source review:** `NodeChecks.trustedScript` resolves registered repository scripts from the issued view using an explicit canonical `sourceRoot`, and daemon check registrations supply that root. A standalone trusted script receives permission for that one file, never its original directory; relative dependencies must be supplied as frozen inputs. Missing/escaping frozen scripts and a standalone symlink to the live run are rejected. The canonical CheckPort workspace argument is normalized internally to the view root. The eight new real-child tests cover these cases; their successful execution is reported by the implementation owner/parent, not rerun by this reviewer.

**Trusted entrypoint authority corrected:** `NodeChecks` takes a private copied registration, entrypoint bytes and SHA256 at construction. The selected frozen, standalone or non-view entrypoint must match that digest before spawn; candidate always-pass replacement, later host-file replacement, caller registration mutation and a file appearing after failed registration are explicitly rejected. A frozen registered version can remain authoritative after a later host edit.

**Standalone hash/open race cleared:** standalone and non-view execution now uses an owned, read-only per-invocation copy of the registered bytes rather than reopening the validated live pathname in child Node. Cleanup is in `finally` and covers failure/cancellation; the Node child receives permission for the exact copy, not its source directory. The parent reports23focused tests passing (17Node plus6isolation), including deterministic post-validation live replacement in both modes, CommonJS and cancellation cleanup. I read the final code/tests without rerunning them. The pin covers the selected entrypoint, not arbitrary imported test/module dependency closures.

## Privacy counterexample checked and cleared

An initially plausible path was deleting a tracked private file from the candidate while retaining its blob through the copied baseline Git tree. The latest materializer validates the baseline manifest too. A temporary `.env.production` deletion probe was correctly rejected with `VERIFICATION_VIEW_UNAVAILABLE` before issuing a view. The attempted vulnerable-behavior assertion failed as expected; no private baseline blob was exposed by that tested path. All content was synthetic.

## Explicit qualifications

- Native review now requests a per-process named permission profile with root deny, minimal platform reads, explicit original/private/temp denies and issued read roots. It requires the exact active-profile acknowledgement and revalidates the active view before each turn; shell environment inheritance is disabled separately from the credentialed controller. The [native probe receipt](native-verification-policy-probe-2026-11-21.json) reports the installed `codex-cli0.171.0` offline sandbox allowing issued input, denying original project/sibling temporary reads and denying output writes, plus16focused wire/adapter tests passing. I inspected the receipt and source, not a live model. This is macOS installed-client evidence, not proof of all app-server model-driven built-in file tools, Linux enforcement or arbitrary executables; unsupported/ignored profiles fail without a broader fallback.
- Check process-group lifecycle is a pre-existing bounded limitation: `runProjectCommand` waits for the command/stdio, but registration removal alone does not prove every detached/background descendant stopped. Source-view immutability is enforced independently. Do not advertise complete descendant termination until effect/process leases cover it.
- Prepared read-only dependencies/toolchains are allowed environment inputs. Read-only access by the check does not make the underlying dependency directory immutable against every external host actor. Environment identities and lifecycle/lease guarantees must be stated at their actual coverage.
- Canonical output grants now use the same helper in core and `ProjectChecks`, with normalization, deduplication and parent/child collapse. This closes the initial order/nested-path disagreement; the parent strengthened the combined-grant test.
- Legitimate projects that write build/cache artifacts need declared output recipes. A permission-denied check must remain distinguishable from a candidate code defect; do not spend model repair cycles trying to alter a host-owned sandbox policy.

No new default goal budget or mandatory strict planned-path scope is justified by this work. Advisory implementation paths and optional strict scope remain independent from truthful verification inputs.
