# Native immutable-review default permission binding

Date: 2026-11-22. Baseline: `85ade5b`. This implementation changes only `adapters/codex/runtime.ts` and `tests/codex-verification.test.ts`. No live model, RTX endpoint, original user project, global configuration or `output/ux/` operation was performed by this agent. No commit was made.

## Defect and correction

The previous real native trial reached reviewer acquisition after producing a correct candidate, but stopped `ENVIRONMENT_UNAVAILABLE`. Its separately recorded offline diagnostic showed that installed Codex app-server 0.171.0 rejects a configuration defining named permissions profiles without `default_permissions`, before initialization. Naming the profile later in thread/start cannot satisfy that startup requirement.

Native immutable-review start now appends a per-process `-c default_permissions=<JSON-quoted issued profile ID>` immediately after the generated `permissions.<issued-id>` definition. Both values derive from the same host-generated `nativeVerificationPolicy`. The override follows base arguments and applies only when the current verified view has authorized immutable native review. It does not edit a file or a user/global default.

The underlying policy is unchanged: root deny, minimal OS reads, explicit original/private/temp denial, issued source/toolchain/output roots read-only, network disabled. Explicit thread/start, thread/resume and turn/start permission IDs remain the issued ID. Exact activePermissionProfile acknowledgement and current owner/view revalidation are unchanged. No legacy read-only/workspace-write fallback is introduced for review. Ordinary native writer start receives no generated permission/default override.

## Regression evidence

Before changing the production adapter, the native verification suite was run with new start/resume argument assertions. Both failed because `default_permissions` was absent; four other cases passed. Log: `/private/tmp/buro-native-default-before-2026-11-22.log`. This was a deterministic wire/argument reproduction, not a real CLI startup or model call.

The final tests cover:

- review start's default selects exactly the same issued profile as its explicit thread permission and both completed/submitted turns;
- review resume starts a new process with the same issued default and explicit resume/turn permission, without legacy sandbox fields;
- ordinary writer remains workspace-write without a review default/profile override;
- missing or different profile acknowledgement rejects before a native model turn;
- changed owner/base or revoked view prevents further native turns;
- the existing real immutable-view/native-policy harness regression and prepared-isolation checks remain green.

Executed `node --test tests/codex-verification.test.ts tests/model-comparison-verification.test.ts tests/managed-check-dispatch.test.ts` with host permissions needed for actual macOS sandbox checks: **11/11 passed**, no skips, 2551.250625 ms. Log: `/private/tmp/buro-native-default-focused-2026-11-22.log`. Changed-file formatting and `git diff --check` passed. There are three additional test cases in the native suite; the original start test also gains exact default-binding assertions. These focused counts overlap parent full validation and must not be summed with it.

The fake native stdio fixture verifies emitted arguments, wire ownership and refusal; it does not validate the real installed CLI's parsing or enforcement. Real network-denied app-server startup/acknowledgement proof and the separately authorized live workflow belong to the parent integration gate. This agent does not claim live end-to-end success, full crash recovery or resolution of the separate Qwen planning/evaluation gaps.
