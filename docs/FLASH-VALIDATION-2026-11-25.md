# DeepSeek Flash thinking validation

The completed feature-module runtime was exercised through its ordinary task, run, session and tool APIs using the saved `deepseek-flash` API connection. Thinking was enabled, context was 32,768 tokens and output allowance was 8,192 tokens per request. Private reasoning continuations were observed; their contents are not included in the reports.

Both final scenarios used core revision `5b2ea36328da48227f6dec9306f15d4bbd80ee84` and harness hash `65aba8a172045aaeb6c34fd47912c11d2ea150c29d464b66a04ce13080543cd9`, on Node 24.9.0. They ran sequentially.

| Scenario                                 | Before: public / independent | Final: public / independent | Run wall time | Model requests | Helpers | Reported output tokens | Output tokens / whole-run second |
| ---------------------------------------- | ---------------------------- | --------------------------- | ------------: | -------------: | ------: | ---------------------: | -------------------------------: |
| Original ready-queue task                | 0/3 · 3/5                    | 3/3 · 5/5                   |       16.48 s |              7 |       0 |                  1,987 |                            120.6 |
| Independent review, repair and follow-up | 3/3 · 4/5                    | 3/3 · 5/5                   |      211.56 s |             55 |       4 |                 40,342 |                            190.7 |

Wall time covers starting the run through completion, including thinking, model requests, tools and collaborator work. Fixture preparation and the final independent verifier are outside that timer. Token throughput uses the provider's reported output tokens across all sessions, including thinking; concurrent sessions can overlap. It is not decoder throughput. The API supplied no decoder timing, and no decode speed is inferred. Neither final scenario needed an HTTP retry or hit the output allowance.

These are two small synthetic scenarios, each sampled once on the final runtime. They are not SWE-bench scores or a general coding ranking. The original fixture bytes match the earlier Qwen task; old Qwen runs used a different runtime, so their wall times do not establish a controlled model speed ratio here.

## Code and collaboration review

The ordinary task corrected dependency selection and priority zero, changing only the two requested source files. Independent checks confirmed the required output and unchanged inputs. The candidate still used explicit index decoration to make sorting stable; that is extra complexity on the tested modern Node runtime. Passing all cases does not make the solution minimal.

The review scenario started with passing public examples and a real defect that reordered equal-priority tasks by ID. The final change removed that tiebreaker in one line, leaving the correct priority function and protected checks untouched. The team performed read-only review, applied the fix and reviewed the changed files. A peer caught a factual error in an earlier reproduction example, which was corrected. All five sessions finished.

The team was still expensive for this tiny change: four helpers and 55 requests. The runtime allows useful collaboration without requiring it for every task; it does not enforce a team size or guarantee economical model choices.

## Findings fixed during validation

- An initial queue pilot passed 8/8 cases in 248.05 seconds but expanded into speculative invalid inputs and unnecessary defensive code. Working guidance now emphasizes the stated contract and simple changes. A subsequent diagnostic queue pass took 20.55 seconds before the final 16.48-second sample. These single samples cannot isolate which change caused the timing difference.
- A review attempt ended after 9.42 seconds when an API response stream broke. HTTP generation now retries temporary transport failures with a configurable count. A regression test interrupts a partial tool proposal and verifies that a completed edit executes once. Cancellation stops retry backoff; authentication errors are not retried. Native tool execution is outside this retry mechanism.
- Another diagnostic review repeated delegation of the same assignment and was stopped after 82.28 seconds. Shared task context is now explicitly framed as background, separate from the current assignment, with advisory guidance to delegate distinct useful work.
- The file tool rejected workspace-local `.buro` scratch files despite their isolation. Those files are now usable for temporary checks and stay outside result patches.

Raw local reports are retained under `artifacts/model-evaluation/2026-11-25T01-42-03-798Z-queue/report.json` and `artifacts/model-evaluation/2026-11-25T01-37-15-001Z-review/report.json`. Reports and workspaces contain synthetic source and remain outside Git.

The independent verifier does not control run completion. Agent completion saves the run result. The evaluation command separately exits with a failing status when its behavioral or task-specific file checks fail; its regression test demonstrates a model claiming completion without making the required fix.

Final repository checks: 105 tests passed, type checking and production build passed, and formatting passed. No real PR was published by these checks.

## Rerun after connection, subscription and history changes

Both scenarios were repeated on revision `84f4301a27bfe33054b3fdd9314ee25bfc4bca16`, with harness hash `467fb053cb04ec99d93ff00e431dcebe3f0ff94efef7413d132d03819da07fb3`. The saved connection ID is `deepseek-flash-thinking`; the requested/reported model remains `deepseek-flash`. Thinking, context and output allowances are unchanged.

| Scenario                                 | Final public / independent | Run wall time | Requests | Helpers | Reported output tokens | Output tokens / whole-run second |
| ---------------------------------------- | -------------------------- | ------------: | -------: | ------: | ---------------------: | -------------------------------: |
| Original ready-queue task                | 3/3 · 5/5                  |       18.20 s |        7 |       0 |                  2,486 |                            136.6 |
| Independent review, repair and follow-up | 3/3 · 5/5                  |       76.66 s |       23 |       1 |                 12,466 |                            162.6 |

The queue solution uses the dependency filter and stable sort directly, without index decoration. The review solution removes the incorrect ID tiebreaker and explains stable sorting. Only the requested source files changed. The review helper completed an initial review and a second user turn in the same session; both it and the main conversation finished. Private continuation was observed, with no HTTP retry or output-length terminal in either run.

These remain individual synthetic samples. The shorter review run does not isolate an improvement caused by storage or establish a general speedup. Throughput still includes thinking and overlapping sessions rather than decoder timing.

The reports are under `artifacts/model-evaluation/2026-11-25T10-49-10-893Z-queue/report.json` and `artifacts/model-evaluation/2026-11-25T10-49-38-559Z-review/report.json`. The updated repository suite passes 117 tests, including paged UI history. The 15 preexisting local histories retained identical message bytes after migration; SQLite integrity and metadata/message counts are consistent after the real runs, with no active sessions or runs remaining.
