# Preference-based review comparison

Started November 25, 2026; preliminary results recorded after midnight Moscow time on November 26. The [interactive report](reports/preference-review-comparison-2026-11-25.html) contains the task descriptions, code snapshots, team/orchestration timeline and individual verification outcomes.

## Setup

Four independent workspaces use base `65bc6f7`: a small material-size presentation task and a medium goal-search API/UI task, each on Qwen3.6-35B-A3B Q4_K_M and official DeepSeek Flash. Thinking is enabled, context is 32K, maximum output per request is 8K, capacity is one and review rounds have no configured limit. The three [review assignments](reviewers/README.md) are code style, architecture and Buro runtime architecture. They inherit the executor model. Names and instructions are configuration data, with no new runtime role types.

## Completed small-task results

| Measurement                                | Qwen                                           | Flash                                   |
| ------------------------------------------ | ---------------------------------------------- | --------------------------------------- |
| Total observed run                         | 34m02s                                         | 11m24s                                  |
| Initial implementation                     | 19m32s                                         | 4m44s                                   |
| Review phase                               | 14m26s                                         | 6m36s                                   |
| Model calls                                | 75                                             | 153                                     |
| Reported input tokens                      | 1,334,578                                      | 2,832,443                               |
| Reported output tokens, including thinking | 26,630                                         | 65,273                                  |
| API charge                                 | $0; local operating costs not metered          | $0.232292394                            |
| Independent behavior                       | Pass                                           | Pass                                    |
| Repository tests                           | 140/140 pass                                   | 133/133 pass                            |
| Production build                           | Pass                                           | Pass                                    |
| Lint/style                                 | Fail, 28 object-argument formatting violations | Pass                                    |
| Review outcome                             | Incomplete: one native generation failure      | Incomplete: one report contract failure |

These run times include review attempts that did not produce a complete review cycle. They are not measurements of two fully approved releases. Zero recorded findings does not mean zero defects when a reviewer failed.

Flash used a bounded unit-selection loop, three table-oriented tests and recursive test discovery. Qwen used logarithms with a small-byte guard, ten tests and explicit root/unit globs. Both put the pure helper in browser shared/lib, exported it through the public entry and preserved the material actions in independent browser checks. Flash's implementation is the simpler of these two samples; Qwen's extra tests did not prevent style violations. Exact files and before/after trees are available in the HTML code viewer.

Qwen reported about 42.9 generated tokens/s during decoding, but 13.4 output tokens/s over model-call wall time. Its completed requests accumulated about 1,290 seconds of input evaluation, 621 seconds of decoding and 29 seconds of loading. Faster decoding alone would leave much of the task latency intact.

## Failures and repair

The Qwen code-style session received HTTP 200 and then a native Ollama generation error. Windows engine logs at `2026-11-26T00:05:45+03:00` recorded a tool-call parsing failure: `XML syntax error on line 3: unexpected EOF`. Other native calls succeeded. This establishes a native parsing failure, not lack of function-calling support, and does not distinguish malformed generation from a parser defect. No application-side tool parser was introduced.

The Flash code-style report contained a naming observation, but its JSON finding used `issue`/`file` rather than the required `message`/`path`. The generic JSON instruction transport had not delivered the schema at all. Commit `f992728` fixes schema delivery for instruction transports, while native JSON-schema transports retain their existing wire contract. The original benchmark remains frozen.

Four real API contract probes validated after that fix. The first pair used full saved public history directly; the medium request was therefore much larger than the original bounded request. Those are unbounded diagnostics, not matched comparisons. A second pair uses the ordinary nominal 32K public-history context builder. Neither pair replays private adapter continuations or constitutes a full correction cycle. All four calls remain in the diagnostic ledger: $0.023708856 total, separate from the original cases. The reported naming and test-double suggestions are minor review opinions, not independently demonstrated functional defects.

The product fix passed lint, formatting, type checks, 131 repository tests and a production build. Its contract regression test covers instruction, JSON-object and native JSON-schema modes without mutating saved conversation history or converting text to tool calls.

## Medium task and unfinished local result

Flash medium completed in 27m35s, with 412 model calls, 9,956,514 input tokens, 124,549 output tokens and a calculated API charge of $1.174651044. Independent lint/types/build, 136 tests and real API/browser search checks passed. Its code-style report encountered the same missing-schema defect, so review remained incomplete and no automatic correction cycle was verified. Original Flash cases cost $1.406943438 together; with all four diagnostic probes, the new comparison's measured API charge is $1.430652294. Local power/hardware and web-research costs are outside that ledger.

The implementation keeps matching in TaskService, validates the optional query at the API boundary and uses the existing UI query subscription for updates. It adds no framework or new state owner. The named TaskListInput follows the existing server-owned Task types, instead of the newer preference for root shared/contracts. That is an explicit architectural migration tradeoff; passing behavior checks does not establish complete compliance with every folder preference.

The operator interrupted Qwen medium after 58m49s to prioritize the already requested Qwen3.8 experiments. The user had not selected an interruption option. This is an unfinished implementation, not a completed quality failure or a measured time to completion. Saved files passed repository tests and independent API/browser behavior checks, but lint reported 21 formatting errors and the production build rejected an unsupported Mantine TextInput `onClear` property. The executor had not reached the reviewers. Its new test was also placed directly in tests/ rather than the requested classified subdirectories. These findings describe the saved partial code only.

Qwen3.8 Q4 and MTP artifacts finished downloading and passed SHA-256 verification on the RTX machine. Downloading overlapped the last part of Qwen medium, so that run is not an isolated speed measurement. Native llama.cpp probes use a separate 8K context and do not overlap the original executor. Q4 measured about 4.5 decoded tokens/s; Q4 with MTP measured 7.2–8.1 tokens/s across the requests, approximately 1.7 times faster on the repeated short prompt. Both completed a native tool round trip and identified the fixture's zero-division bug. Neither reached the user's 15 tokens/s threshold. The conditional Q3 run completed at 8.9–9.2 tokens/s, with a successful native tool round trip and the same fixture diagnosis. Q3+MTP also completed, but was slower at 5.9–7.8 tokens/s. Gemma 4 12B completed at 61–82 tokens/s with thinking and a successful native tool round trip. Its installed Ollama package automatically uses MTP; native engine logs confirm 49/49 target layers and 5/5 assistant layers offloaded to GPU at 8K context. All short native preflights have ended. The next useful quality comparison is the same repository tasks on Gemma; no full Buro quality result is claimed yet.

These short probes establish allocation, latency and native tool round trips, not full repository-level quality. Initial launcher and port-inspection failures were harness defects and are excluded from model scoring. The probes did not remove existing models. A separate storage cleanup later retired the unused local DeepSeek R1 14B/32B packages, retaining Qwen 9B/35B and Flint. The [research note](LOCAL-MODEL-OPTIMIZATION-2026-11-25.md) records public scores, model/quantization provenance, hardware assumptions and engine options.

## Gemma repository-quality follow-up

The user requested real quality checks after the native preflights. Gemma 4 12B now runs the same small and medium task definitions in two new independent workspaces, sequentially on the RTX. The target base remains `65bc6f7`, thinking is enabled, the requested context is 32K, maximum output is 8K and the same three reviewer assignments inherit the executor model. Findings return automatically for correction, without a configured review-round limit.

The Buro runtime is `c6156f2`, including the schema-delivery repair, while the original Qwen/Flash matrix retains its original runtime. Gemma uses temperature 1.0/top_p 0.95 and the installed package's native MTP defaults. This is a practical follow-up, not a strict same-runtime or same-sampling comparison. Original results remain unchanged. Independent lint/types/tests/build and API/browser checks run after each saved result, including an interrupted or failed result when files exist. No full Gemma quality result is available at launch.

Published model-card scores were rechecked November 26: Gemma 12B reports LiveCodeBench v6 72.0, GPQA Diamond 78.8 and MMLU Pro 77.2. Qwen3.6-35B-A3B reports 80.4, 86.0 and 85.2 respectively. These are publisher evaluations of full models with different evaluation setups, not scores for our Q4 files or Buro reviewers. Gemma 12B's card does not provide a separate SWE-bench result. Sources: [Gemma card](https://huggingface.co/google/gemma-4-12B), [Qwen card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B).

The Gemma small run ended after 17m00s and 80 model calls, with 889,077 reported input tokens and 31,770 output tokens. Native decoding averaged about 66.2 tokens/s over completed metered requests, while input evaluation accumulated 416 seconds and decoding 480 seconds. The failed native request has no returned usage and is excluded from those token/duration totals. The medium run is still active at this checkpoint.

Small-task behavior and production build passed. Lint found 11 errors, despite the code-style reviewer reporting no findings. The architecture reviewer failed on an ordinary tool-enabled request because Ollama completed without an assistant answer; it was not the final structured-report call. The Buro architecture reviewer completed without findings. Review therefore failed and no successful automatic correction cycle was established.

The generated npm test script used an unquoted recursive glob, so the shell selected only eight added tests and omitted the original root suites. Independent verification now also invokes Node with the literal quoted recursive pattern, ignoring model-edited npm discovery: all 138 original-plus-added tests passed. The passing npm script alone would have overstated regression coverage. This discovery regression and the lint failures remain defects in the model's saved code; independent checks do not silently repair it.
