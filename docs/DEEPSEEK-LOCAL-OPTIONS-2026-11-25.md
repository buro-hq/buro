# Local DeepSeek options

Research checked on November 25, 2026 for an RTX 3060 12 GB, 32 GB RAM, i5-12600KF and one NVMe drive. The machine currently has 43.1 GB free on C:. Our working-model preference is native tool calling, thinking enabled, at least 15 generated tokens/s, and good results on actual Buro tasks. This preference is not enforced in application code.

## V4 Flash through another engine

Insufficient resident memory does not make inference impossible: Colibri streams cold experts from SSD. Its [API documentation](https://github.com/JustVugg/colibri/blob/main/docs/api.md#tool-calling-support) lists native DeepSeek V4 DSML tool calls behind OpenAI-compatible endpoints. Buro already has the matching transport boundary; testing it would not require a special JSON tool adapter. Its [Windows distribution](https://github.com/JustVugg/colibri/blob/main/docs/windows.md) includes CUDA engines.

However, the [closest published configuration](https://github.com/JustVugg/colibri/blob/main/docs/deepseek-v4.md#performance-rtx-5080-16-gb-2-nvme-mirror-32-gb-ram-i9-class-cpu) uses an RTX 5080 16 GB, 32 GB RAM, two mirrored NVMe drives and an i9-class CPU. It decodes at 1.5–1.6 tokens/s at approximately 3.3k context, with a 90-second cold prefill for 3,324 tokens. These are the engine author's measurements, not ours. The better results on a 62 GB RAM / 24 GB VRAM machine cannot be applied to our smaller caches. We found no measured basis for expecting 15 tokens/s on our machine.

## Smaller formats and other runtimes

| Option                                                                                                      | Published footprint or configuration                                 | Evidence and limitation                                                                                                  | Decision for this machine                                                 |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [Unsloth V4-Flash GGUF](https://huggingface.co/unsloth/DeepSeek-V4-Flash-GGUF)                              | Lowest listed dynamic quant about 82.5 GB                            | Supports current llama.cpp; too large for full residency here. Colibri can stream it                                     | Below our speed target on the closest measured SSD-streaming setup        |
| [KTransformers + SGLang](https://github.com/kvcache-ai/ktransformers/blob/main/doc/en/DeepSeek-V4-Flash.md) | Validated example: RTX 5090 32 GB and at least 200 GB system RAM     | Reports 20+ tokens/s and native reasoning/tool parsers                                                                   | Different hardware class; not a 32 GB RAM solution                        |
| [REAP K160](https://huggingface.co/0xSero/DeepSeek-V4-Flash-0731-REAP)                                      | 160/256 routed experts retained; 107.8 GB tensor payload             | Structurally validated and smoke-tested on DGX Spark; benchmark parity not established                                   | Still too large; pruning also needs quality validation                    |
| [GALE 1-bit](https://huggingface.co/benjzzz/DeepSeek-V4-Flash-GALE-1bit)                                    | 55 GB; published test uses four GPUs and 62 GB RAM                   | Author reports 3.4–4.1 tokens/s, weak coding behavior, 4k context and prompt-dependent tool behavior                     | Does not meet speed/quality goals; not a drop-in replacement              |
| [deepseek-v4-in-c](https://github.com/ronak-create/deepseek-v4-in-c)                                        | Original approximately 160 GB checkpoint streamed with low RAM usage | Author reports 1.62–1.74 seconds/token with GPU, about 0.57–0.62 tokens/s; CLI tool encoding is not a supplied tool loop | Useful systems research, not a practical Buro backend at our target speed |

Quantized or pruned V4 Flash remains a large model; these are not validated 14B/32B distillations with inherited full-model tool scores. The smaller examples found do not establish native coding/tool quality comparable to the original.

## V4 versus V4.1

The [original V4-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash) has 284B total parameters and 13B active per token. [V4.1-Flash](https://www.deepseek.com/en/news/deepseek-v4-1-flash/) is a different, larger 552B model. The public API now routes the older V4-Flash identifier to V4.1-Flash; local weights do not change because an API alias changes.

The [Unsloth V4.1-1017 guide](https://unsloth.ai/docs/models/deepseek-v4.1-flash) lists an approximately 233 GB IQ1_S download, including 110.6 GB of Engram tables. Its recommended path still requires roughly 128–145 GB combined memory with those tables on SSD. That is a requirement of that serving path, not proof that every disk-streaming engine needs that much memory. Neither that path nor the reviewed Colibri measurements establish our 15-token/s target on the RTX 3060.

## Current selection

Keep Qwen 35B as the main candidate, Qwen 9B for direct tasks and Flint as a comparison. Our [measured matrix](RTX-THINKING-VALIDATION-2026-11-25.md) reports roughly 45–55 generated tokens/s for them, with important differences in whole-task time and collaboration reliability. No large DeepSeek download or new engine installation was performed during this research.
