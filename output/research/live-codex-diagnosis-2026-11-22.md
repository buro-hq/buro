# Current Codex trial: verification-view integration failure

Date: 2026-11-22. Trial on `5a09e30`, synthetic queue fixture only. Read-only diagnosis; no production/test edits, live requests, retry, RTX or original-project access by this reviewer. `output/ux/` remains untouched.

## Observed result

The Codex worker completed both source edits. The Buro public acceptance check passed 1/1, and the independent outer oracle passed **3/3 public and 5/5 holdout**, with the permitted two-file scope and identical oracle source hash before/after each phase. The workflow was correctly left unaccepted: `acceptedCommit=false`, `independentReviewer=false`, current status `needs-attention`; reviewer acquisition failed before a reviewer model turn.

Canonical evidence: `output/evaluation-2026-11-22/current-synthetic.json`, arm `codex-buro`; inner evidence: `current-synthetic-trials/codex-buro-capability-selected.json`. The immutable actual stop in the synthetic File store records **`VERIFICATION_VIEW_CHANGED`**, text **“The verification view is not registered.”** The public Run stop retains the same typed code and the original workspace/history. This is an integration failure in the comparison check adapter, not evidence of failed Codex implementation quality.

## Root cause

`scripts/lib/live-provider-runner.cjs:979–983` invokes `fixture.createChecks({projects, executors})` rather than its normal `ProjectChecks` implementation. The queue fixture's custom factory at `scripts/lib/model-comparison.cjs:351–377` ignores that argument; its `run` accepts only the first five parameters and ignores Core's sixth `verificationView` options argument. It calls the independent `canonicalOracle`, which creates another `EnvironmentExecutors` at `:252` and performs an ordinary workspace registration at `:253`. It never registers the issued view on the shared host executor used by Codex.

Core retains and publishes the view before review (`core/execution.ts:190–217`, `:305–337`). The real native reviewer starts with that view. `adapters/codex/runtime.ts:94` asks the shared executor for `verificationPolicy(view)`; `adapters/environments/executors.ts:383–385` delegates to `launchVerification`, whose missing-registration guard at `:352–356` throws the exact observed error. The native client's model review is never dispatched. Weakening this guard would invalidate immutable verification ownership.

The ordinary production `ProjectChecks.run` consumes the sixth argument, validates the view/owner/frozen environment, and calls the shared `registerVerification(view, signal)` before check execution (`adapters/checks/project-commands.ts:114–178`). Therefore this trial does **not** establish the same failure on the ordinary production check path. The harness additionally does not use the issued immutable view for its custom check source; any correction must preserve the canonical oracle while honoring that contract, rather than merely registering an unrelated directory.

## Misclassification

`scripts/lib/live-provider-runner.cjs:663–748` classifies the stop by older issue/message heuristics and ignores `run.stop.code`. It reports `qualityFailure`, `LIVE_CODING_QUALITY_FAILED`, evidence `unknown`. `scripts/lib/model-comparison.cjs:540` then maps the inner `quality-failed` status to outer `failed`. Preserve that raw report, but interpret the actual typed immutable stop as a verification integration failure. Correct code alone remains insufficient for Buro acceptance; the missing fresh review must not be waived or inferred from outer holdout success.

## Independent offline evidence

Ran `node --test tests/codex-verification.test.ts tests/managed-check-dispatch.test.ts`: **7/7 passed**, no skips, 338.148542 ms. Log: `/private/tmp/buro-live-codex-diagnosis-tests.log`. These tests use fake native stdio and synthetic temporary inputs; no model request occurs. They verify registered native immutable policy, acknowledged named permissions, revocation rejection and required prepared isolation. They do not cover the comparison fixture's custom port, explaining why the harness defect survived those gates.

A no-effect one-off probe calls `new EnvironmentExecutors().verificationPolicy(view)` with an unregistered synthetic descriptor and asserts the exact code/message above. It passes before filesystem or process access: `unregisteredViewErrorReproduced=true`, `externalEffects=0`. This reproduces the missing-registration guard, not the whole live workflow again.

No retry or source fix was made during this diagnosis. A later harness correction should use the real immutable check contract/shared executor (including release), retain independent public/holdout oracles and original scope, add a deterministic fixture/native-review regression, and record any new live result separately from this failed first attempt.

## Independent boundary review of the subsequent correction

The implementation agent subsequently changed only `scripts/lib/model-comparison.cjs` and added `tests/model-comparison-verification.test.ts`. I reviewed that working patch before the parent's separate fresh Codex launch; this reviewer made no implementation edits or model requests. The original failed trial remains evidence of the pre-correction harness.

The custom factory now constructs the real `ProjectChecks` with the shared host executors. Its run forwards the supplied immutable verification options and requires the ordinary service check to pass as well as the independent controller-owned oracle. For issued inputs the oracle uses the exact `verificationView.readRoot`, asserts that identity and calls `launchVerification(view, argv, true)` on the same shared executor. It does not perform an ordinary environment registration, create `.buro/environment`, or write private setup under readRoot. The original ordinary workspace path remains only for the outer candidate oracle, outside issued-view checks. Factory cleanup delegates to `ProjectChecks.releaseVerificationView`, retaining signature-bound revocation.

No native policy/registry guard was weakened. The standard check path still validates project, owning Run, workspace/base, complete view identity, selected output paths and frozen prepared environment before registration. The parent oracle still owns expected values and frozen inputs; the new regression includes a candidate that monkeypatches public assertions and makes the public script pass, but remains rejected by the controller oracle. Fixture/task/public/holdout literals and their identity derivation are unchanged by this patch.

I ran `node --test tests/model-comparison-verification.test.ts tests/model-comparison.test.ts tests/codex-verification.test.ts tests/managed-check-dispatch.test.ts` with the required host permissions for actual macOS sandbox execution: **21/21 passed**, no skips, 7128.782583 ms. Log: `/private/tmp/buro-live-codex-boundary-after-host-tests.log`. The regression verifies baseline rejection, fixed-view success, preserved native read-only policy, wrong view/workspace rejection, absent ordinary metadata under readRoot, oracle resistance to spoofed assertions, and cleanup revocation. Existing fake native-policy and dispatcher contracts remain green.

An earlier run under the default nested sandbox passed 20/21 and failed the new positive check assertion; the same code passed under required host permissions. That earlier log (`/private/tmp/buro-live-codex-boundary-after-tests.log`) is retained as an environment limitation, not a reproduced code defect. No confinement fallback or weakened assertion was used to obtain the successful result.

No blocking boundary finding remains in the reviewed harness correction. These deterministic checks do not establish that the installed real native client will acknowledge the policy or complete review; that evidence belongs to the separately recorded fresh live trial. Current collector status/classification issues remain uncorrected and must still be interpreted from the actual stop and inner report.

## Fresh follow-up: native app-server startup requirement

The parent's separately recorded `codex-verification-followup.json` again has a correct two-file candidate with **3/3 public and 5/5 holdout**. The shared-view registration correction worked: the former missing-registration stop is absent. Review now fails at the subsequent native acquisition boundary with immutable stop **`ENVIRONMENT_UNAVAILABLE`**, text **“The native client could not establish the required immutable-review permission profile.”** Its persisted review route is unknown and has no external thread ID. This remains unaccepted, with no fresh reviewer result or acceptance commit. It must not be relabelled as a model implementation-quality failure.

The real adapter wraps non-Domain startup/RPC errors at `adapters/codex/runtime.ts:203–209`, so the original app-server stderr is not preserved in the public stop. The installed CLI remains **codex-cli 0.171.0**, matching the earlier offline policy probe. Fresh offline generated schemas still expose `ThreadStartParams.permissions` as a named profile string, require it to be separate from `sandbox`, and expose `ThreadStartResponse.activePermissionProfile`. This rules out a simple absence of that schema feature; schema support alone is insufficient startup evidence.

At the parent's request I ran one bounded offline initialization diagnostic with the **same generated read-only profile recipe**, a new task-owned empty HOME/CODEX_HOME/config, a minimal child environment with no credentials, and an outer macOS sandbox profile `(version 1)(allow default)(deny network*)`. Only initialize and, conditionally, thread/start were allowed in the script; no turn/start was sent. A 20-second child timeout and forced process cleanup bounded it. The CLI exited before initialization with the exact sanitized stderr:

```text
Error: config defines `[permissions]` profiles but does not set `default_permissions`
```

Receipt: `offlineNetworkDenied=true`, `modelTurns=0`, `config=empty-task-owned`, `cli=0.171.0`, `outcome=process-exit`, `exitCode=1`. Temporary roots were removed; original/global configuration and credentials were neither printed nor changed. This reproduces a native app-server configuration failure, not a provider/model request.

`nativeVerificationPolicy` currently adds `permissions.<issued-id>` (`adapters/codex/verification-policy.ts:52`), while the native start arguments append that definition without `default_permissions` (`adapters/codex/runtime.ts:118–150`). Passing a named profile later in thread/start cannot satisfy a configuration requirement enforced before initialize. The older `codex sandbox -P <id>` probe already selected a profile at CLI startup, so it did not cover this app-server default requirement. Fake stdio tests likewise accept the supplied flags without validating a real CLI configuration.

A candidate correction is to set `default_permissions` to the **same issued immutable read-only profile**, retaining the explicit thread/turn named profile and exact acknowledgement guard. This is a configuration binding, not permission broadening or a legacy sandbox fallback. It needs deterministic argument/wire regression and another explicitly recorded offline startup/acknowledgement proof before any further live review. This reviewer made no such source change, second startup probe, live request or trial retry. The task-owned empty-config probe does not independently characterize every possible user configuration; the observed live generic failure and this exact reproduced startup requirement are recorded separately.
