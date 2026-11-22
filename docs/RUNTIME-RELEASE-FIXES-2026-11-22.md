# Native startup, planning guidance and RTX evaluation preparation

Date: 2026-11-22. Baseline: `85ade5b`. The user authorized implementing the next release fixes while connecting the RTX computer. Five agent roles worked in waves: native implementation, Qwen diagnosis/clarification, isolated RTX harness, independent architecture review and independent boundary review. Original user projects and `output/ux/` are preserved. The reduced beta scope and production SQL/default-none cutover remain unapproved/unimplemented.

## Native permission default

`CodexRuntime.start` now sets a per-process `default_permissions` to exactly the same generated immutable read-only profile defined by `permissions.<id>`. Explicit thread/start, resume and turn permissions and exact profile acknowledgement remain mandatory. Revoked/changed views still reject. Ordinary writers receive no generated review default and retain their existing path. No global/user configuration is edited and no legacy sandbox fallback is introduced.

The installed app-server startup probe is reproducible with `node scripts/check-codex-verification-startup.cjs`. It uses an empty private temporary HOME/CODEX_HOME and an outer network-denied macOS sandbox. The old configuration exits 1 before initialize with the missing-default error; the corrected configuration initializes and exits 0. It sends no thread or model turn. This proves startup/configuration parsing, not real profile acknowledgement or tool enforcement. An earlier attempt to include thread/start inside the outer sandbox failed because macOS's native filesystem helper could not establish a nested sandbox; that is retained as a diagnostic environment limitation, not acknowledged permission evidence. A subsequent real trial stopped in the worker before review, so it did not exercise the corrected review path. Wire contracts cover acknowledgement/revocation behavior; actual end-to-end acknowledgement after this fix remains unverified.

[Native implementation](../output/research/native-default-fix-2026-11-22.md), [installed startup receipt](../output/evaluation-2026-11-22/release-fixes/native-default-initialize.json), [architecture review](../output/research/release-fix-architecture-2026-11-22.md), [boundary review](../output/research/release-fix-boundaries-2026-11-22.md).

## Qwen planning

The previous Mac Qwen trial tried to reuse `worker` while only coordinator/reviewer existed. The new prompt lists eligible existing worker IDs for reuse and explicitly requires create otherwise. Rejection now names the missing role and points to create or Brief.roles. Actual File/SQLite plan commands retain all role/resource/scope/receipt protections; diagnostics do not add a whole-catalog query or silently mint a role.

The second failure was different: the conservative context estimate reduced the correction's output allocation to 789 tokens in a 16,384 context. The complete rejected 5,373-byte plan and duplicate host-appended JSON schemas consume that headroom. Neither pilot nor Run request allowance was exhausted. The clarification alone does not fix this context problem: replaying the exact old invalid plan with the compact new wording permits 783 output tokens. These figures describe the preserved pre-projection trial, not the later request-projection change recorded in the adaptive orchestration implementation. No arbitrary history truncation or token-estimator division is applied.

[Exact diagnosis and numbers](../output/research/qwen-planning-diagnosis-2026-11-22.md). No new live Qwen success is inferred from deterministic prompt/command tests.

## RTX harness

The single `scripts/check-model-comparison.cjs` entrypoint selects `--target local` (default, loopback-only) or explicit `--target rtx`, pinned to the saved LAN target and existing `qwen3.5:9b-q4_K_M`. The RTX target permits only fully local and mixed DeepSeek-coordinator/reviewer plus RTX-worker arms. It retains the same generated queue fixture and independent public/holdout oracle, service checks, distinct successful worker and fresh reviewer requirement. Context is 16K for Ollama and capacity is one. Required opt-ins and exact endpoint are validated before credentials are opened. The preliminary duplicate RTX CLI/validator and loopback substitution were removed during the subsequent simplification review.

Private-network trust exists only in the new temporary evaluation configuration under that explicit contract. Default LAN trust, endpoint discovery/scanning, SSH, model downloads and machine-settings changes are not introduced. The actual host with injected transport proves configuration/diagnostic wiring without contacting the RTX machine. See [harness review and command](../output/research/rtx-harness-2026-11-22.md). Live RTX evidence requires the user to report readiness and successful metadata discovery of the pinned installed model.

## Validation

After the final source changes, **1380/1380 tests passed**, no skips, duration **83,563.050417 ms** (`/private/tmp/buro-release-fixes-full-tests-2026-11-22.log`). Build/typecheck and all changed-source/test formatting passed. Independent focused reviews passed **43/43** plus **10/10** architecture/native cases and **86/86** final boundary cases; implementation subsets passed **11/11**, **64/64** and **40/40**. These counts overlap and must not be added to the full suite. Eleven new cases extend the previous 1369-test baseline.

Those counts describe the preliminary frozen fixes before the later request/context/team/CLI simplification. The later stage and its own final validation are recorded in implementation progress; the preliminary numbers are not reused as verification of changed code.

The [code manifest](../output/evaluation-2026-11-22/release-fixes/code-manifest.json) records hashes for the live follow-up. Prior real trials and their report hashes remain unchanged. No UI code changed, so previous browser evidence is retained with its original provenance; it is not a new browser run. Installation, crash-effect journals, full SQL execution, default-none and broad model reliability remain separate gates.
