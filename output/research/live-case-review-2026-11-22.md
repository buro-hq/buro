# Synthetic live-case and oracle review

Date: 2026-11-22. Source baseline `5a09e30`. Read-only review of `scripts/lib/model-comparison.cjs`, its live runner and generated-probe oracle. No production/test edits, model requests, RTX contact, original-project access or `output/ux/` changes. This is preflight evidence, not a live trial result.

## Suitable current smoke workload

The fixed `synthetic-ready-queue-v1` task requires an actual two-file JavaScript correction: preserve priority zero, admit only unfinished tasks with every dependency completed, include dependency-free tasks, sort priorities descending stably and preserve inputs (`scripts/lib/model-comparison.cjs:20–81`). Fresh repositories receive identical source/task/oracle hashes (`:86–95`, `:293–307`). This is a useful small implementation/check/review integration smoke, without dependencies or real-project source transfer. It is not representative of a large application, frontend work or complex repository setup.

The final oracle covers **three public and five holdout cases**. Public cases check zero, independent readiness and incomplete dependency rejection; holdouts cover null/missing priority defaults, mixed priorities, completed/blocked task filtering and stable equal priorities. Inputs are recursively frozen; parent-owned expectations are not candidate assertions. Candidate values run in a read-only, network-denied child, with nonce/output-shape validation, a hard wall and process-group reaping (`:100–198`, `:245–290`). Scope/hashes are checked before and after; protected file changes, symlinks and unexpected paths fail (`:200–243`). Printed success or a model summary cannot pass the oracle.

`scripts/lib/team-experiment-probes.cjs:30–43` similarly lets a test-author propose only bounded declarative inputs, never expected outputs or code. Expected behavior follows fixed requirements. These generated probes are a separate experiment mechanism; ordinary model-comparison arms do not automatically exercise it.

## Production acceptance remains separate from correct code

The real Buro runner requires a completed Run, accepted commit, independent approved review and nonempty all-passing acceptance checks (`scripts/lib/live-provider-runner.cjs:1168–1177`). It verifies unchanged original fixture, exact expected changed paths, external holdout and an actual successful worker in a distinct session from coordinator/reviewer (`:1179–1228`). The outer report evaluates the same final public/holdout oracle for failed workflows too, but requires the provider workflow status `passed` for Buro acceptance (`scripts/lib/model-comparison.cjs:710–749`). A correct candidate with incomplete review therefore remains unaccepted.

The fixture permits one repair (`scripts/lib/model-comparison.cjs:339`) and the real workflow can react to a check/reviewer rejection. It does **not deliberately force** a reviewer rejection followed by same-writer repair, a public-check-passing negative acceptance case, stop/resume or process-crash recovery. A successful smoke must not be reported as proving those separate release gates. If a natural rejection/repair occurs, report the actual retained evidence without inferring it from the configured allowance.

## Minimal live matrix and reporting

Run **codex-buro, deepseek-buro and ollama-buro** sequentially on this one fixed case with current defaults and no automatic retries. A codex-direct arm is an optional contemporary baseline, with no Buro worker/review requirement. Mixed mode can remain a separate later observation rather than expand this initial three-route smoke. Keep Ollama loopback-only, RTX off and synthetic temporary fixtures only.

Current `runModelComparison` rejects non-undefined `planningControls` and derives planning from actual saved backend capabilities (`scripts/lib/model-comparison.cjs:624`, `:696–705`). Do not supply the old CLI `legacy`/`bounded` argument from historical docs; leave that argument absent and record `actualPlanning`. Do not change budgets or models after observing a failure to turn the same trial into an apparent pass.

Report each route's model, candidate edit/scope, public and holdout counts, service acceptance, fresh review, successful worker, elapsed time, final stop/error classification and actual request/usage coverage. Preserve partial failed candidate oracles separately from acceptance. Native internal generation/context ceilings are not managed-ledger ceilings; native usage stays observed/unknown where unavailable (`scripts/lib/model-comparison.cjs:539–604`, `:633–646`). A single trial per route establishes current smoke outcomes, not statistical reliability, a model ranking or Buro quality improvement.

## Validation

Executed `node --test tests/model-comparison.test.ts tests/team-experiment-probes.test.ts`: **19/19 passed**, zero skipped, duration 2360.851292 ms. Log: `/private/tmp/buro-live-case-review-tests.log`. These existing deterministic tests cover fixture identity, baseline/fix behavior, protected-path and forged-oracle defenses, immutable inputs, parent expectations, capability-selected planning and failure-with-correct-diff rejection. No live request was issued by this reviewer. Their count overlaps the prior full suite and must not be added to the live trial count.
