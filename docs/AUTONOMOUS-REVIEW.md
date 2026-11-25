# Autonomous team review

An enabled review cycle gives an implementation an independent check even when its executor worked alone. It uses the same sessions, backends and tools as ordinary work.

## Flow

1. The executor completes its task turn and its remaining helpers are joined.
2. Every configured participant starts a fresh session against the same task and actual workspace. The executor's summary is explicitly a claim to verify, not evidence.
3. Reviewers inspect the code and run appropriate checks. Their focus, model and optional tool selection come from configuration.
4. Each session returns a structured summary and actionable findings. Tool execution still uses the backend's native protocol; the review report is domain data, not a substitute function-calling adapter.
5. Findings return automatically to the original executor, which checks them, makes corrections and verifies the work.
6. Fresh review sessions inspect the revision. The cycle ends when the team returns no actionable findings, the run is canceled or a configured round limit is reached.

Participants run sequentially. This keeps checks in the shared workspace from racing and works with endpoints whose inference capacity is one. Reviewer sessions may use ordinary helpers through their inherited tool scope.

## Configuration

Settings contains a `review` object. `runs.start` and `runs.retry` accept a `review` override in their ordinary `options`. There are only application defaults and explicit run overrides.

```json
{
  "review": {
    "enabled": true,
    "maxRounds": null,
    "participants": [
      {
        "name": "Correctness and verification",
        "instructions": "Check behavior and independently run appropriate repository tests.",
        "modelId": null
      },
      {
        "name": "Architecture and simplicity",
        "instructions": "Inspect boundaries, coupling and unnecessary complexity against the task."
      }
    ]
  }
}
```

Names are labels. The implementation does not branch on them. Add, remove or rewrite participants as needed. An omitted/null model uses the executor's current model; its normal thinking and sampling settings apply. A participant's optional `tools` list can narrow the run's available tools, never grant tools outside an explicit run scope.

Omitted/null `maxRounds` means no fixed round count. A positive value is an explicit limit on review rounds. If findings remain on the last round, the executor still receives them and can correct the code; the result is marked `limited`, rather than claiming a final clean review.

The shipped setting is opt-in and includes two editable participant descriptions. The user's local Buro settings have been enabled with no fixed round limit. Other installations and explicit `enabled: false` runs keep the original direct execution behavior.

## UI and evidence

Settings exposes the team editor, models, focus instructions and optional round count. Goal run options can inherit, enable or disable review and override the team. The run detail has an Automatic review tab with each session's findings, observed commands and a link to its conversation.

`Run.review` stores the configuration snapshot, cycle status and reports. Actual command receipts are collected from the reviewer and its descendant sessions. They remain separate from the model's own summary. A successful command is not automatically labeled a passing test: reviewers must interpret it against the task.

Review sessions inherit workspace access. Their default instructions request source inspection without source edits while allowing build/test artifacts. Read-only runs stay read-only; findings are reported without attempting corrections.

## Failures and limits

A failed or malformed review is visible as a failed review result. It does not erase a completed implementation or become an approval to publish it. Cancellation joins active sessions and preserves files. Startup recovery marks unfinished review state interrupted and does not replay tool effects.

The cycle does not add an accepted-commit requirement, minimum score, model allowlist or a permission to apply changes. Independent model opinions and green checks are evidence with limits, not a guarantee of correctness. Normal result inspection and application remain available.

## Validation

Integration tests exercise real session/tool execution, file corrections, another independent review round, model selection, tool-scope narrowing, run overrides, cancellation, failure reporting, read-only work, optional round limits and recovery. The browser test edits and saves a team, enables review for a run and opens its completed reports.

The [real RTX snapshot](assets/architecture/autonomous-review-validation.json) records Qwen 35B with thinking, a 16,384-token context and a 4,096-token response allowance. One executor and two independent reviewers completed in 143.9 seconds over 18 model requests. Both reviewers ran repository checks, and the parent verified empty, ordinary, negative and fractional inputs plus immutability. The first review round found no actionable issues, so this native-model run did not exercise a correction round. Automatic corrections and repeated review were verified by integration tests using controlled model responses with real files and tools.

This small runtime validation is separate from the original Qwen/Flint UI migration comparison, which used the pre-feature code revision. It confirms integration, not general coding quality or production readiness.

The subsequent [real repository task](AUTONOMOUS-REVIEW-REAL-TASK-2026-11-25.md) completed with two independent reviewers in 40m 56s. Both returned no findings and made no corrections, while missing a requested component-file split. One summary incorrectly claimed that a timed-out test command passed. The report separates model statements, command receipts and the parent's final verification; this case does not establish a quality gain from review.
