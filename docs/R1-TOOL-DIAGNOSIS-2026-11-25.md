# DeepSeek R1 tool diagnosis

The original R1 14B and 32B connections received native tool definitions but returned no structured calls. Captured API responses already lacked `message.tool_calls`; Buro did not discard a valid call while decoding them. This diagnoses the current integration, not general DeepSeek coding quality.

The deployment is not fixed. A temporary alias saved a replacement template in its configuration but still reported the embedded GGUF template as its effective prompt source. It did not provide a valid test of an active replacement template.

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

## What needs correction

1. Select an actually active tool-aware template or renderer that includes available definitions and preserves tool exchanges.
2. Match the generated call format to an output parser that returns structured `tool_calls`.
3. Verify the complete marker exchange, then rerun coding scenarios. If the current Ollama path cannot provide that contract, test the same weights through the installed llama.cpp engine.

This work belongs at the model/backend boundary. The diagnostic does not require a new role, acceptance policy or admission gate in the session loop. It also does not justify treating arbitrary assistant text as executable instructions.

## Cleanup and evidence

The temporary alias was removed, original 14B/32B tags were preserved, and the prior model server was restored and passed its health check. User connections and the application default were unchanged.

The [sanitized snapshot](assets/architecture/r1-tool-diagnosis.json) records all probes, effective metadata, template analysis and cleanup. Raw requests, reasoning and responses remain under ignored `artifacts/deepseek-tool-diagnosis/`. The [original matrix](RTX-THINKING-VALIDATION-2026-11-25.md) retains its measured outcomes; its R1 rows are not generated-code quality scores. Qwen 35B remains the practical choice from that matrix.
