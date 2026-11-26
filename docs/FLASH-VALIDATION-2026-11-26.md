# Flash validation of policy/assignment and receipts fixes

November 26, 2026. Controlled re-run of the launch-presets task on `deepseek-flash`
(thinking high, temperature 1.0, topP 0.95) against runtime `490b765` with the P0
policy/assignment split, P1 run usage and P3 tool receipts. Same task, coordination
mandate, model and three review profiles as `LARGE-FLOW-COMPARISON-2026-11-26.md`;
only the runtime differs. Budget stop $1.0 for the final run; peak DeepSeek rates
$0.006/M cached input, $0.30/M uncached input, $1.20/M output.

## Attempts

| Attempt | Condition | Outcome | Cost |
| ------- | --------- | ------- | ---- |
| 1 | Under the outer DSH file sandbox | Every file/command tool failed `sandbox-exec: sandbox_apply: Operation not permitted` (exit 71). Run cancelled. | ~$0.06 |
| 2 | Unsandboxed host | 12.4 min, 7 sessions (main + 6 chained workers, depth 6), 20 file edits. Runner crashed on a `git diff` snapshot exceeding the 12 MB `maxBuffer` after the model copied the repository into `.pristine-check/`. | ~$0.49 |
| 3 | Unsandboxed host, fixed runner | 3.6 min, main session worked solo (0 collaborators), 45 requests, 58 `read_file`, 13 `command`, 2 `receipt_read`. Failed on `MODEL_RESPONSE_LIMIT` — one model response exceeded 4 MB (`agent/providers/http.ts:265`) with `retries: 0`. | ~$0.13 |

Total spend across the three attempts: about $0.68, below the intended budget.

## Confirmed findings

1. **The P0 mechanism fix holds.** In attempt 3 the main session never inherited a
   delegation mandate as an assignment: it did the work directly and used
   `receipt_read` to page through large command output. No instruction-inheritance
   cascade occurred. Attempt 3 is the first observation of the intended single-loop
   behavior end to end.

2. **Receipts work under a real model.** `receipt_read` was exercised by the model in
   attempt 3 with zero tool failures; oversized tool output no longer floods the
   request context (P3).

3. **Run-level instructions are shared policy, so a delegation mandate re-triggers
   delegation.** Attempt 2 kept the original coordination mandate verbatim
   ("Delegate implementation … to flash-worker using session_start"). Under P0 that
   text flows into every session's `<work_policy>`; the defusing wrapper did not stop
   each worker from re-delegating (depth 6) after re-reading 30–50 files. This is the
   second-order problem to fix: a role-specific mandate is not shared policy.

4. **Flash with thinking-high and temperature 1.0 is non-deterministic in delegation.**
   Identical instructions produced a 6-deep cascade in attempt 2 and a solo run in
   attempt 3. Cascade depth is not a stable property of the configuration.

5. **The flow is fragile to non-model failures.** Three distinct failure modes were
   hit in three attempts: nested sandbox profile, runner snapshot buffer, and the 4 MB
   response guard. None is a delegation/code-quality defect.

6. **Token economics improved where the run was healthy.** Attempt 2 (before the
   runner crash) reported about 9.9M input tokens at 94.5% cache hits after 12.4 min,
   versus 84M total (81% hits) for the original two-hour run. The stable shared-policy
   prefix measurably raises cache reuse.

## Unresolved

- A completed implementation/review cycle was never produced, so no final session
  count, cost or quality score is available for the fixed runtime. The "worker sessions
  drop to ≤10" goal was not conclusively measured because attempt 2 crashed and attempt 3
  ran solo before failing on the response limit.

## Recommended next fixes (separate from presets integration)

1. Strengthen the `<work_policy>` defusing wording, or add an explicit
   main-session assignment channel, so a coordination mandate is not broadcast as
   policy to every collaborator. See `modules/sessions/instructions.ts`.
2. Make a single oversized model response non-fatal: raise or make configurable the
   4 MB guard in `agent/providers/http.ts`, and retry a `MODEL_RESPONSE_LIMIT`
   transient failure instead of ending the run.
3. Keep the runner snapshot resilient (already fixed: larger buffer, per-snapshot
   try/catch) for future experiments.

Raw evidence and the runner live under `artifacts/flash-validation-2026-11-26/`
(attempt-1-nested-sandbox, attempt-2-runner-crash, attempt-3 source) and are not
published.
