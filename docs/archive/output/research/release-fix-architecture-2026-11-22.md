# Independent architecture review: native default permission binding

Date: 2026-11-22. Baseline: `85ade5b`. Read-only review of the working native startup fix, its deterministic contracts and the parent's offline installed-client probe. This reviewer changed no production/test source, issued no model or RTX request, accessed no original user project, and left `output/ux/` untouched.

## Native adapter finding

No blocking architecture issue was found in `adapters/codex/runtime.ts:116–121`. The per-process `default_permissions` value is JSON-quoted and derives from the same host-generated `nativeVerificationPolicy.id` as the adjacent named profile definition. It follows the trusted base argument list (`:139–141`), so it does not inherit a different global default for this review process. No configuration file or machine-wide default is edited.

This change is reached only after the existing immutable-view owner, project, Run, source workspace/base and read-only checks (`:80–95`). The generated policy itself is unchanged: root deny, minimal OS support, explicit original/private/temp denials, issued source/output/toolchain reads, network disabled. It gains no write grant. Ordinary native writer startup does not enter that branch and retains its explicit workspace-write contract.

Thread start/resume and every turn still select the exact issued profile. `activePermissionProfile.id` must match before a thread is accepted; absent or different acknowledgements reject rather than use a legacy sandbox. Current owner/view identity and registry validity are rechecked before dispatch and subsequent turns. Start disposal/error closes the acquired connection through its existing path. The diff adds no retry, session fallback, reconciliation clearing or new cancellation behavior.

The native tests now assert the generated default equals the explicit start/resume permission ID, including completed and submitted turns; ordinary writers have no generated default; wrong and missing acknowledgements dispatch no turn; revoked or rebound input still blocks work. These are meaningful argument/wire contracts, not real installed-client enforcement evidence.

## Installed-client probe and evidence boundary

The parent's new `scripts/check-codex-verification-startup.cjs` creates a task-owned temporary root and separate empty HOME/CODEX_HOME/config for each variant. Its child environment is an explicit PATH/HOME/CODEX_HOME/TMPDIR/LANG allowlist, excluding credentials. The outer macOS sandbox denies all network. No `turn/start` is emitted. Process groups are bounded by a 20-second timer, killed during completion cleanup, and the parent removes the temporary root. Its supplied read-only profile comes from the actual policy/executor helpers.

The initially inspected probe attempted both initialize and thread/start. Its retained log showed the intended pre-fix rejection (`missingDefaultError=true`, initialize false, exit 1), and the fixed configuration reached initialize. However, its thread/start returned RPC error rather than acknowledgement. The parent subsequently identified an inner filesystem-helper sandbox failure under the outer network-denied sandbox. This is not a successful acknowledgement proof and must not be reported as one.

I recommended that response routing accept only actual replies without `method` (server requests sharing a numeric ID must not count as responses), and that the probe assert explicit baseline/fixed exit states. The parent elected to narrow this diagnostic to initialize only, retaining the network deny instead of weakening it to obtain thread acknowledgement. Review of the final adapted script/result remains a parent integration gate at this report checkpoint. A real installed-client initialize result proves configuration startup only; exact acknowledgement is covered by deterministic wire tests until the authorized real native workflow supplies stronger evidence.

## Adjacent changes inspected

The pending Qwen prompt clarification imports the shared `isWorkerRoleId` helper without a platform dependency or import cycle. It lists eligible existing worker IDs and explains reuse versus create, while the semantic rejection retains the exact offending ID and points back to the frozen Brief. It adds no broad catalog query or permission remapping. That clarification does not remove the conservative context/headroom constraint; a new live result is required before claiming improved model quality.

The pending RTX harness retains ordinary comparison's loopback-only validator and uses a separate explicitly opted-in, exact-endpoint/model contract for the temporary evaluation configuration. No RTX network request was made by this reviewer. Full review of its final tests and controls can follow once the owner completes that slice.

## Independent validation

Ran `node --test tests/codex-verification.test.ts tests/managed-check-dispatch.test.ts` with the host permissions required for local sandbox fixtures: **10/10 passed**, no skips, 409.309667 ms. Log: `/private/tmp/buro-release-fix-architecture-tests-2026-11-22.log`. `git diff --check` passed. Counts overlap the implementation/parent gates and are not additive.

This review clears the native source delta within its stated boundary. It does not claim successful real thread acknowledgement, live review/acceptance, crash recovery, Qwen task success, RTX readiness, production SQL adoption or default-none activation. The user's RTX readiness answer remained “still connecting” during this review.

## Final initialize-only probe review

The parent subsequently adapted the script and supplied `/private/tmp/buro-native-default-initialize-2026-11-22.log`. I inspected the final source and that result. Response parsing now ignores messages with `method`, the script emits only initialize/initialized, and its output explicitly says `threadStartSent: false`, `modelTurns: 0` and configuration/initialize-only coverage. It asserts the pre-fix variant has missing-default stderr, initialize false and exit 1; the fixed variant must initialize, exit 0 and have no RPC error or timeout. The retained result meets those exact assertions. Network denial, empty task-owned HOME/config, child-environment allowlist, bounded process-group cleanup and temporary-root removal remain in place.

This supersedes the pending adapted-probe review noted above. No blocking issue remains in that startup diagnostic. It proves that the installed CLI accepts the generated default/profile configuration and initializes; it deliberately makes no real thread acknowledgement or model execution claim. The earlier nested-sandbox thread-start failure is preserved as diagnostic history and has not been relabelled as an acknowledgement success. Stronger exact-acknowledgement evidence remains the native wire contracts and subsequent authorized real workflow.

## Final explicit RTX harness architecture review

I reviewed `scripts/lib/live-provider-runner.cjs`, `scripts/lib/model-comparison.cjs`, `scripts/check-rtx-model-comparison.cjs` and `tests/rtx-model-comparison.test.ts`. No blocking architecture/boundary issue was found within this evaluation-only slice.

Ordinary comparison still rejects non-loopback Ollama endpoints. The separate RTX validator requires explicit RTX/Ollama/comparison opt-ins, an exact documented LAN endpoint, the fixed installed 9B model, and only local/hybrid arms. A hybrid route separately requires the DeepSeek opt-in. The RTX contract rejects credentials, query/hash/path additions, other target origins and non-synthetic source cases. URL selection is explicit rather than inherited from an ambient Ollama endpoint. The CLI validates the contract before opening the private credential store. The lower comparison layer still validates the fixed DeepSeek endpoint, source-transfer opt-in, model IDs and unchanged maximum limits.

The actual live-runner delta adds private-network trust only to its newly constructed temporary evaluation connection after that contract succeeds. It edits neither saved machine resources nor an active provider, and introduces no SSH, model pull, fallback endpoint or second authority. A normal LAN connection without that explicit contract remains untrusted/local-only-blocked. Existing transport enforcement restricts requests to selected metadata/chat routes and rejects redirects (`createBudgetedFetch`); live model availability/cloud-model rejection remain separate existing factory gates. Parent discovery should record the actual installed digest because a model tag by itself is not immutable identity.

The queue fixture/task/oracle identity, external holdout, real distinct worker/fresh review requirement, 24-generation pilot, output ceiling and coding wall are unchanged. Local context stays 16K and connection capacity one. The controlled full-controller test verifies forwarding to both arms; the real resource-factory/injected-transport test verifies temporary trust/configuration and diagnostic admission, including no generation when the normal LAN route is untrusted. That is stronger than a schema-only test, but it is not actual RTX discovery, coding quality, GPU residency, process recovery or a live accepted Run.

Independent command: `node --test tests/rtx-model-comparison.test.ts tests/model-comparison.test.ts tests/live-evaluation-budget.test.ts tests/boundaries.test.ts`: **43/43 passed**, no skips, 2410.086917 ms. Log: `/private/tmp/buro-release-fix-architecture-rtx-tests-2026-11-22.log`. All transports in the RTX cases were injected; this reviewer made no real endpoint/model/RTX call. Formatting and `git diff --check` pass. These counts overlap other focused/full gates and must not be added together. The native source and these final evaluation boundaries are clear for the parent's full suite and separately authorized live checks. The Qwen owner was still finalizing its small prompt compaction, so this review does not relabel an earlier prompt snapshot as a completed model-success proof.
