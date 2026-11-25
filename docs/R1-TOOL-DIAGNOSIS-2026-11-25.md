# DeepSeek R1 tool diagnosis

The original R1 14B and 32B connections received native tool definitions but returned no structured calls. Captured API responses already lacked `message.tool_calls`; Buro did not discard a valid call while decoding them. This diagnoses the current integration, not general DeepSeek coding quality.

The current R1 connections are excluded from our working agent comparison. Native function calling was not established, and the proposed JSON tool adapter was removed. No model allowlist or compatibility gate was added to Buro.

## Method

Nine probes used real RTX inference through Buro's existing `OllamaProvider`, `ModelBackend` and session loop. One read-only tool had a newly generated name and returned a random marker unavailable in the prompt. Success required actual dispatch followed by the exact returned marker. No project files were edited.

Requests and raw NDJSON responses were captured before normalization. Original connections received the random function name only in the native `tools` field. Name-exposure probes asked the model to name that function without invoking it. Explicit-catalog variants also placed its definition in system instructions; another specified a JSON call shape.

Every probe requested thinking, used an 8,192-token context and 1,024-token output allowance, disabled retries, and contacted the LAN endpoint without a proxy. These are diagnostic settings, distinct from the coding matrix. Original R1 probes returned normal final responses without reaching their output limit.

## Results

| Connection and condition       | API tool calls | Executed calls | Marker returned | Observation                                              |
| ------------------------------ | -------------- | -------------- | --------------- | -------------------------------------------------------- |
| Qwen 9B, native tools          | 1              | 1              | Yes             | Positive control completed the real exchange             |
| R1 14B, native tools           | 0              | 0              | No              | Described what the user should do                        |
| R1 14B, name exposure          | 0              | 0              | Not applicable  | Returned get_weather instead of the supplied random name |
| R1 32B, native tools           | 0              | 0              | No              | No structured action                                     |
| R1 32B, name exposure          | 0              | 0              | Not applicable  | Did not reproduce the random name                        |
| R1 14B, explicit catalog       | 0              | 0              | No              | Mentioned the correct function in prose                  |
| R1 14B, catalog and JSON shape | 0              | 0              | No              | Matching name/arguments JSON remained ordinary content   |
| Temporary alias, action        | 0              | 0              | No              | Replacement template was not effective                   |
| Temporary alias, name exposure | 0              | 0              | Not applicable  | Embedded-template path remained active                   |

Matching JSON in ordinary content was diagnostic output, not an executed action. The application did not add automatic execution of JSON or code extracted from arbitrary assistant prose.

## Template and parser evidence

Both original R1 connections advertised tools/thinking capabilities, but `/api/show` reported `template_source: gguf_chat_template` with no explicit renderer or parser. Their exposed Jinja templates were identical, represented previous tool calls, and did not reference the top-level available tools catalog. Rendering those templates against captured initial requests omitted the random function names.

Ollama documents `template_source` as the source actually used to build the prompt, including embedded GGUF Jinja templates. See the [show API](https://docs.ollama.com/api-reference/show-model-details#response-template-source). A stored `TEMPLATE` directive was insufficient in this deployment: the temporary alias retained the replacement in its modelfile while reporting the original GGUF template/source as effective.

The evidence points to tool-catalog rendering and call parsing in this R1/Ollama configuration. It establishes that definitions were sent, raw structured calls were absent, explicit instructions changed the output, and Buro's tool path worked with the control. It does not establish that R1 can never use tools, nor capture every internal stage of Ollama's prompt construction.

## Follow-up experiments and decision

Five further engine-configuration probes explicitly selected renderers/parsers: three used `deepseek3.1` / `deepseek3`, and two used a tool-aware Go template with `qwen3-thinking`. Ollama reported these settings as active. The catalog became visible, but all five responses still contained zero native API tool calls. These configurations did not establish working function calling for the installed weights.

An uncommitted schema-constrained JSON protocol prototype dispatched real read-only calls. An early 14B probe repeated calls; a revised probe returned the observed marker with additional prose, failing the original exact-answer criterion. Neither was a coding validation. The 32B experiments were interrupted. At the user's request the prototype, its transport and its tests were removed; no substitute function-calling protocol ships.

It was too strong to attribute the entire failure to connection configuration. A missing catalog is a concrete defect, but fixing it does not prove that the weights reliably use tools. Advertised capabilities and an inherited template are insufficient evidence of model training or agent reliability. The [official R1-0528 card](https://huggingface.co/deepseek-ai/DeepSeek-R1-0528) separately reports tool benchmarks for the full model and reasoning/coding benchmarks for its Qwen3-8B distillation; those full-model tool scores must not be transferred to our smaller models.

Working comparisons now prioritize native tool use, thinking enabled and a practical generation-rate target of at least 15 tokens/s. This is an experiment-selection preference, not an application restriction. Whole-task time and resulting code quality remain separate measurements. See the [local DeepSeek alternatives](DEEPSEEK-LOCAL-OPTIONS-2026-11-25.md).

## Runtime simplification and verification

The old non-thinking Ollama history projection was also removed. It silently blanked selected assistant commentary and carried provenance conditions for intermediate messages. Its unused context metadata and delegation hooks through the provider, backend, session and evaluation wrapper were deleted. Native wire formatting remains in each provider; bounded conversation context remains shared.

Regression checks now cover complete history serialization for all thinking settings and verify that ordinary JSON or call-like text never becomes an executable action. Lint, formatting, type checks, the build and all 122 remaining tests passed.

Three fresh native RTX probes after cleanup each executed one tool and returned its hidden result:

| Connection | Whole probe | Result included | Exact marker-only answer          |
| ---------- | ----------- | --------------- | --------------------------------- |
| Qwen 35B   | 36.72 s     | Yes             | No, explanatory sentence          |
| Qwen 9B    | 17.30 s     | Yes             | Yes                               |
| Flint 40B  | 26.88 s     | Yes             | No, Markdown and explanatory text |

These probes demonstrate the native exchange after cleanup. They are not new coding-quality scores, and the strict output-format failures remain recorded.

## Cleanup and evidence

All temporary R1 aliases were removed, original 14B/32B tags were preserved, and the prior model server was restored and passed its health check. No probe remains running. User connections and the application default were unchanged.

The [sanitized snapshot](assets/architecture/r1-tool-diagnosis.json) records all probes, effective metadata, template analysis and cleanup. Raw requests, reasoning and responses remain under ignored `artifacts/deepseek-tool-diagnosis/`. The [original matrix](RTX-THINKING-VALIDATION-2026-11-25.md) retains its measured outcomes; its R1 rows are not generated-code quality scores. Qwen 35B remains the practical choice from that matrix.
