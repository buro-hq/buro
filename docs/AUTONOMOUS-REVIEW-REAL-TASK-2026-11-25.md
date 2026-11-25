# Autonomous review on a real repository task

The [standalone HTML report](reports/autonomous-review-real-task-2026-11-25.html) contains the exact task, actual session stages and command receipts, the initial implementation, the unchanged final model patch, and the parent's adjustments.

## Task and configuration

Qwen 3.6 35B-A3B Q4_K_M moved generic feedback components and `useOperation` out of `src/features/common` into the shared UI/library modules. The task required public named exports, updated consumers, separate component files, unchanged behavior and a short structure-document update.

Application and task source were frozen at `91ace81b3c7889352c2a07baef7fb7380f004846`. The run used native Ollama tools on the RTX 3060 12 GB / 32 GB RAM machine, thinking enabled, context/output allowances of 32,768/8,192 tokens, temperature 0.6, top-p 0.95, capacity 1 and retries 0. Proxies were disabled.

Two configured reviewers used fresh sessions on the same model: Behavior and verification, and Architecture and simplicity. They ran sequentially. No review-round limit or finding quota was configured, no defect was planted, and the parent supplied no task guidance during the run.

## Observed result

| Actual stage                 | Wall time | Model requests |
| ---------------------------- | --------- | -------------- |
| Initial implementation       | 22m 29s   | 33             |
| Behavior review and report   | 5m 14s    | 16             |
| Architecture review/report   | 13m 10s   | 20             |
| Total, including preparation | 40m 56s   | 69             |

There were three sessions, one review round, zero reported findings and zero automatic code corrections. The captured before-review and final model patches are identical. The subsequent review occupied about 18m 24s within this run; this is not a controlled comparison with a separate no-review run.

All 22 independent browser behavior checks passed before review. The raw model result also passed host lint, formatting, types, all 130 tests and a production build. However, the executor explicitly declined the requested separate `query-feedback.tsx`, leaving both components in `error-notice.tsx`. Neither reviewer reported this layout miss. No functional regression was established.

The behavior reviewer claimed that `npm test` passed while its actual command timed out with exit 128; the same summary also acknowledged failures. The architecture summary used similarly overbroad wording before acknowledging environment failures. The report preserves these statements as model claims beside the failed receipts. A completed review records the absence of reported findings, not a successful test suite or a guarantee of quality.

Seven full-suite attempts timed out, consuming approximately 17 minutes. Reported server input evaluation took 863.0 seconds and decoding 411.5 seconds. Aggregate decoder throughput was about 43.5 tokens/s, including thinking; it excludes prompt evaluation, tools and loading.

## Parent adjustments and verification

The parent separated `QueryFeedback`, used the existing localization alias in the new components and removed duplicated documentation. The applied result passed lint, formatting, types, all 130 tests, a production build, the structural inspection and all 22 browser checks. English/Russian feedback markup matches the baseline after normalizing generated Mantine alert IDs.

A separate parent fix, `34b22d8`, corrected the controlled review test fixture's handling of a failed write attempt and bounded that fixture to its two expected rounds. All eight review tests pass normally. The full nested-sandbox suite now finishes in 4.9 seconds with 122 passes and eight environment failures instead of hanging. Production defaults and the user's unbounded review configuration were preserved.

The earlier baseline sandbox attempt also failed and timed out without the migration. Host results and nested-sandbox results are distinct evidence. The parent did not weaken command isolation or change the model run to obtain passing checks.

The prior RTX server was restored and returned a healthy status. No models or engines were installed. Raw state, transcripts and private reasoning remain under ignored `artifacts/`.

This case confirms that the configured review sessions run independently. It does not demonstrate a quality improvement or a native-model correction round. More precise checking against explicit task requirements and reporting grounded in command receipts remain the useful follow-up; no role-specific runtime branches or new execution gates are justified by this result.
