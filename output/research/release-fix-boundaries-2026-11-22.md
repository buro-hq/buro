# Independent native/planning/RTX boundary review

Date: 2026-11-22. Baseline: `85ade5b`. This reviewer inspected the working fixes without editing production or owned test/harness files. No real model, RTX API, SSH, download, original-project or `output/ux/` operation was performed. RTX remains a parent-only readiness/live gate.

## Native default binding

`adapters/codex/runtime.ts:116–123` defines the generated permission profile and immediately sets `default_permissions` to the same JSON-quoted issued ID. Both originate from `nativeVerificationPolicy`; there is no caller-supplied replacement profile, file/global configuration write, or new read/write root. The arguments follow the base arguments, and ordinary writer start receives no generated review default. Existing owner/base/view validation, explicit thread start/resume/turn permission, exact acknowledgement and revocation guards remain active. Missing or different acknowledgement still prevents model turns. No legacy sandbox fallback was added.

The new fake-wire cases test emitted startup/resume defaults and explicit permissions together, reject a different acknowledgement, and preserve the ordinary writer path. They establish adapter binding/refusal, not real CLI enforcement or current coding quality.

## Installed-client offline probe

The final `scripts/check-codex-verification-startup.cjs` creates an empty private task HOME/CODEX_HOME/TMPDIR and passes only an explicit minimal environment to the actual installed CLI. Its outer macOS sandbox denies all network operations. It sends initialize/initialized only: no thread/start or turn/start path exists in the final script. JSON-RPC server requests are not mistaken for same-ID responses. Process groups are bounded by a 20-second timeout, killed on completion, and temporary roots are removed.

The parent log `/private/tmp/buro-native-default-initialize-2026-11-22.log` records the relevant distinction: baseline exits 1 before initialize with the missing-default error; adding the default exits 0 with initialize successful and no RPC error/timeout. The script asserts both exit codes and initialization outcomes. `threadStartSent=false`, `modelTurns=0`, and its coverage explicitly excludes acknowledgement.

An earlier diagnostic attempted thread/start under the same outer sandbox and received a nested macOS fs-helper `sandbox_apply` EPERM. It must not be counted as real profile acknowledgement or as proof that the product permission binding fails. The final probe narrows its claim rather than weakening production isolation. Exact real thread acknowledgement and fresh review still require the separately authorized live path; this reviewer made no such request.

## Explicit RTX route

The ordinary comparison validator remains loopback-only. `validateRtxComparison` in `scripts/lib/model-comparison.cjs` is a separate route selected only for an explicit `rtx` object. It restricts arms to hybrid/all-local managed Buro, requires comparison and RTX/Ollama live opt-ins, and requires a DeepSeek opt-in for the hybrid arm. The shared `rtxEvaluationContract` pins the canonical documented target `http://192.168.50.10:11434/` and exact installed candidate `qwen3.5:9b-q4_K_M`. Other targets/ports/protocols, URL credentials/query/fragment/path, models and non-synthetic source cases reject.

`scripts/check-rtx-model-comparison.cjs` validates that contract before reading credentials. It does not turn an ambient Ollama endpoint into trusted LAN input. The resulting `private-network` trust is derived only from the validated explicit contract and written only to the newly created temporary resource configuration. Existing machine defaults, credentials, saved production profiles and owned sessions are not retargeted. Capacity remains one and local context 16K; pilot accounting, five-minute wall, explicit source-transfer boundary, fixed fixture/task/oracles, required successful worker and fresh reviewer remain unchanged.

The existing observed fetch wrapper rejects redirects (`redirect: 'error'`) and checks requests against the selected API routes. No SSH/server-lifecycle/model-pull path was added. Existing cloud-model/local-only checks remain effective. The actual injected-transport regression uses a real temporary host/configuration: ordinary LAN has no trust and stops `DATA_POLICY_BLOCKED` before a generation; explicit RTX adds the exact temporary trust and reaches one fake diagnostic before its bounded diagnostic limit stops it. These are meaningful configuration/authority proofs, not an actual available RTX, installed digest or model-quality result. The parent must obtain readiness, record exact discovered digest/capabilities and preserve failed trials separately before claiming live results.

## Planning clarification

The reviewed clarification exposes existing eligible worker IDs for action=reuse and explains action=create for new reusable roles. Shared `isWorkerRoleId` excludes reserved service roles. The complete original role catalog/goal/scope remains in Brief; no role/resource/path/check authority is inferred from a model title. The rejection identifies the offending role ID and points to Brief.roles/create, without adding an aggregate catalog scan to the narrow accepted-plan writer. Actual File/SQLite tests reject the missing reused role without publishing state/events/grants, then accept the corrected create and preserve the original assignment grant through reopen.

This is guidance/diagnostics, not a context-budget fix. The conservative estimator, schema/history retention and quotas are unchanged. Neither a valid future Qwen plan nor a larger correction output allowance follows from these tests; such claims require the separately measured prompt and live outcomes. The planning capability revision continues to identify backend mechanics/grants; exact actual prompts remain retained in private session history.

## Validation

Executed `node --test tests/codex-verification.test.ts tests/rtx-model-comparison.test.ts tests/model-comparison.test.ts tests/live-evaluation-budget.test.ts tests/planning-policy.test.ts tests/run-plan-contract.test.ts` with the required host permissions for local sandbox/oracle checks: **86/86 passed**, no failures or skips, duration **2892.85925 ms**. Log: `/private/tmp/buro-release-fix-boundaries-tests-2026-11-22.log`. Counts overlap existing tests and any parent full-suite gate and must not be added to them. `git diff --check` passed.

## Final compact planning delta

After the planning owner finalized the compact wording, I inspected the actual source and tests again. The initial line still permits reuse only from the explicitly enumerated eligible worker IDs, requires a complete reusable non-goal-specific new role otherwise, forbids service roles and retains exact step owner identity. Its shorter `No service roles` wording does not weaken `isWorkerRoleId` or semantic reserved-role rejection. The precise error still identifies the offending ID, says `not in the catalog`, and points to create versus Brief.roles; it does not grant service roles or expand the narrow named-role read. Complete Brief catalog/goal/scope and all criteria/path/resource grants remain unchanged.

The final numerical diagnostic deliberately reports no token-budget repair: replaying the same prior 5,373-byte bad plan would yield 783 output tokens instead of the original 789. This six-byte net growth is disclosed; an earlier 582-token verbose draft was replaced before final gates. Intended first-plan correctness and feedback improvements still require live evidence. History/schema projection and conservative admission are unchanged.

I reran the same six-suite independent gate on that final delta: **86/86 passed**, zero skips, **7391.923459 ms**, log `/private/tmp/buro-release-fix-boundaries-final-tests-2026-11-22.log`. The earlier 86/86 timing above is a prior working-draft gate, not an additional set of unique tests. Final report formatting and `git diff --check` pass.

No blocking boundary finding remains in the reviewed final native/planning/RTX/initialize-only changes. Full integrated checks, user readiness, real native acknowledgement and RTX live quality remain parent gates. No quota removal, SQL activation, reduced-beta approval or publication is established here.
