# Same-model team-quality experiment

This is an opt-in research runner, not a production acceptance option. It compares three workflows on identical fresh copies of the synthetic ready-queue component:

- `executor-checks`: one executor and service-owned public checks, with bounded corrective feedback. No independent model reviewer; control only.
- `executor-review`: the same executor/check loop plus a fresh read-only reviewer; concrete findings return to the original executor. Every changed revision receives a new reviewer.
- `team-review`: a tools-free coordinator proposes a compact assignment, and an independent test author proposes declarative edge-case inputs before implementation. The same executor/check/review/repair loop follows.

The service retains the full original goal and constraints alongside agent proposals. All variants use one requested model, one provider, identical context/request-output settings, identical source/task/oracle hashes, and the same global research envelope (24 generations, 65,536 reserved output tokens, 64 total tool/check charges and five minutes coding wall time). Review variants reserve 4 generations / 8,192 output tokens / 8 tools inside that envelope; the control reserves zero. This is an explicit allocation difference, not an extra allowance. Actual work, segment closure, serialization, coordinator, author and review requests all count in the owning durable ledger. There are no inference diagnostics outside it.

At most two service-directed repairs are shared across public/generated-check and reviewer findings. Automatic runtime worker-check feedback is disabled for this experiment so the same repair allowance cannot be counted twice. Executor identity/scope/cumulative accounting persist; independent roles use fresh sessions. Coordinator, test author and reviewer have no tools. Full verified editable source, diff and check facts are passed to review, with before/after fingerprints and content consistency checks. Oversized required context fails explicitly rather than being silently truncated. Unknown effects remain charged and are not replayed.

The fixed queue semantics let the trusted controller derive expected outputs for model-proposed test inputs. No generated JavaScript or model-supplied expected answer is executed or trusted. This is easier than authoring correct tests for arbitrary real projects; it does not establish a universal test-author capability. Candidate code executes only in a read-only, network-denied child; final public and hidden oracles run after confirmed runtime cleanup, even when the workflow failed. A deadline cannot be overwritten by a late successful result.

Final code correctness, experiment completion and reviewer approval are separate measurements. `productionAccepted` is always false and no accepted commit is created. One synthetic case and a few runs cannot establish reliability or prove the role architecture causes improvement. A later compute-matched single-executor self-debug/best-of-N control is needed to distinguish role benefits from additional inference. Hidden tests must never guide candidate selection.

## Run

```sh
BURO_TEAM_QUALITY=1 BURO_LIVE_OLLAMA=1 node scripts/check-team-quality.cjs
```

Optional arguments select comma-separated variants and 1–3 repetitions. Repetition order rotates. The default model is the installed Mac `qwen3:4b-instruct-2507-q4_K_M`, context16K/output2K, literal loopback Ollama only. RTX/cloud endpoints and user source cases are rejected. Credentials are not loaded. The report goes to ignored `artifacts/team-quality-comparison.json`; `BURO_TEAM_REPORT` overrides the destination.

These are experimental ceilings, not a proposed product default. The user requests no aggregate hard stop by default in production; optional user-configured ceilings, usage accounting, physical context/memory limits and correctness/permission guards must be designed separately after the architecture research. Existing production defaults are unchanged in this implementation.

## Initial Mac smoke

Implementation commit `77a016e`; one trial per variant, same installed Mac Qwen4B and settings. [Full sanitized evidence](../output/evaluation-2026-11-21/team-quality-mac.json).

| Variant | Generations | Successful edit actions | End-to-end | Outcome |
| --- | --- | --- | --- | --- |
| Executor/checks | 12 | 1 | 78s | Conservative context admission stopped the worker; final code failed |
| Executor/review | 10 | 0 | 40s | Four-window worker ceiling; final code failed |
| Coordinator/test-author/executor/review | 11 | 0 | 58s | Four-window worker ceiling; final code failed |

No variant reached the independent-review stage. This cannot establish that review improves or harms quality: implementation did not complete. The first variant's edit did not establish common code correctness. Ceilings were unchanged. There was no manual candidate repair, no production acceptance and no RTX call.

The `MODEL_CONTEXT_EXHAUSTED` outcome is our conservative admission estimate, not proof Ollama filled its actual token window. The four-window ceiling is a harness policy, not a physical GPU limit. These failures reinforce the need to separate optional product quotas from context projection, progress control and permissions. The research runner remains a tool for controlled comparisons; its finite ceilings are not proposed product defaults.
