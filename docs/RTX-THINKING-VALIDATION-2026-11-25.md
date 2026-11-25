# RTX thinking validation

All ten scenarios have finished. Qwen 35B and Flint produced code passing all eight functional assertions in both scenarios. Qwen 9B passed the ordinary task but its review scenario was interrupted after repeated delegation and file reads. Both DeepSeek R1 connections returned prose instead of executing tools, leaving the initial files unchanged.

These are single runs of two small synthetic tasks through the current Buro/Ollama integration. They do not establish general coding scores or isolate the effect of thinking: every run requested thinking, and every connection produced observed private continuation.

## Configuration

| Setting                     | Value                                             |
| --------------------------- | ------------------------------------------------- |
| Hardware                    | RTX 3060 12 GB, 32 GB system RAM                  |
| Code revision               | 88fecc9e70e33077e20e2ff5485d0566754d4d1e          |
| Transport                   | Ollama over the local network, without a proxy    |
| Context / output allowance  | 32,768 / 8,192 tokens                             |
| Sampling                    | temperature 0.6, top_p 0.95, presence_penalty 0   |
| Endpoint capacity / retries | 1 / 0                                             |
| Loading                     | Sequential scenarios; unload before each scenario |
| Fixture                     | synthetic-ready-queue-v1                          |

Unspecified sampling options retain each installed model's server defaults. This is a controlled comparison of the explicit settings, not a search for optimal settings for every model.

The ordinary scenario asks the agent to fix queue readiness and priority handling. The review scenario starts with passing public examples and an incorrect tie-break, asks for an independent read-only collaborator, a fix and follow-up review. Eight functional assertions inspect the resulting files; the request/helper counts describe actual execution rather than proving every collaboration instruction was followed.

## Ordinary task

| Model                   | Final files             | Whole-task time | Generation rate | Requests | Helpers |
| ----------------------- | ----------------------- | --------------- | --------------- | -------- | ------- |
| Qwen 3.5 9B Q4_K_M      | 8/8                     | 65.1 s          | 54.5 tokens/s   | 7        | 0       |
| Qwen 3.6 35B-A3B Q4_K_M | 8/8                     | 68.6 s          | 45.6 tokens/s   | 7        | 0       |
| Flint 40B-A2B Q4_1      | 8/8                     | 777.2 s         | 46.5 tokens/s   | 40       | 0       |
| DeepSeek R1 14B         | Unchanged: 3/8 baseline | 105.6 s         | 9.6 tokens/s    | 1        | 0       |
| DeepSeek R1 32B         | Unchanged: 3/8 baseline | 748.4 s         | 2.5 tokens/s    | 1        | 0       |

## Review scenario

| Model                   | Outcome                                  | Whole-task time | Generation rate | Requests | Helpers |
| ----------------------- | ---------------------------------------- | --------------- | --------------- | -------- | ------- |
| Qwen 3.5 9B Q4_K_M      | Interrupted; final files remained at 7/8 | 1,893.8 s       | 52.8 tokens/s   | 261      | 9       |
| Qwen 3.6 35B-A3B Q4_K_M | Completed, 8/8                           | 647.8 s         | 45.4 tokens/s   | 70       | 7       |
| Flint 40B-A2B Q4_1      | Completed, 8/8                           | 1,152.0 s       | 47.4 tokens/s   | 156      | 3       |
| DeepSeek R1 14B         | Unchanged: 7/8 baseline; no tools        | 67.7 s          | 9.9 tokens/s    | 1        | 0       |
| DeepSeek R1 32B         | Unchanged: 7/8 baseline; no tools        | 257.5 s         | 2.6 tokens/s    | 1        | 0       |

The Qwen 9B review was stopped manually after over 31 minutes of repeated delegation and reads. It did not complete the task. The other scenarios did not reach the runner's one-hour diagnostic time budget.

Flint's root conversation and two collaborators completed, but another collaborator failed with `MODEL_STREAM_INTERRUPTED`. Final code still passed all eight assertions. Retries were disabled, so this run is not evidence of error-free collaboration.

Both DeepSeek connections had thinking enabled and produced thinking data, but neither emitted a structured tool call in either scenario. Their answers described changes, tests and collaborators without performing them. No files changed. The surviving 3/8 and 7/8 assertions already passed before execution; they are not credit for a generated fix. Follow-up configuration experiments did not establish native tool use; the JSON protocol prototype was removed.

## Reading the timings

Generation rate is the sum of reported output tokens divided by the sum of server `eval_duration` for completed timed responses. It excludes loading, prompt evaluation, tools and failed response attempts. Whole-task time includes those costs and collaborator waits. Partial output from an interrupted stream has no complete terminal timing and is not counted as a fully timed response.

This distinction matters: Flint generated at roughly the same rate as Qwen 35B, yet needed 40 rather than 7 requests on the ordinary task. Qwen 9B generated faster but did not finish the review. Neither raw token rate nor team size is a sufficient selection criterion.

The ordinary runs also recorded different memory residency through Ollama's running-model API. Qwen 9B's reported loaded allocation fit in VRAM; the larger connections had non-VRAM allocations. These observations are retained in the data snapshot. They include runtime allocations and must not be treated as exact model-weight sizes or independently measured process RAM. The results do not support a universal slowdown factor for CPU offload.

## Current conclusion

Qwen 35B is the strongest practical candidate in this matrix: both final results passed, and it finished both scenarios substantially sooner than Flint. Its seven-helper review is still expensive for a small change. Qwen 9B remains promising for direct tasks, while reliable coordination needs further work. The current R1 connections are excluded from working agent comparisons. The user's practical speed target is at least 15 generated tokens/s with thinking enabled, alongside result quality and whole-task time; Buro does not enforce this preference as a runtime gate.

The prior model server was restored after the matrix, and its health endpoint responded successfully. Evaluation processes are no longer running.

The [follow-up tool diagnosis](R1-TOOL-DIAGNOSIS-2026-11-25.md) records the configuration experiments, removal of compatibility workarounds and fresh native checks on Qwen 9B/35B and Flint. All temporary diagnostic aliases were removed.

## Evidence

The committed [matrix snapshot](assets/architecture/rtx-matrix.json) contains final and baseline assertions, timings, request/helper/tool counts, file changes, memory observations and source/harness/task hashes for all ten scenarios. Private reports and isolated evaluation state remain under ignored `artifacts/model-evaluation/` and `artifacts/manual-style-rtx/`.

The earlier [two-model illustration](assets/architecture/rtx-sample.json) and chart remain a subset of this completed matrix. See the [architecture page](../ARCHITECTURE.md) for execution and measurement boundaries.
