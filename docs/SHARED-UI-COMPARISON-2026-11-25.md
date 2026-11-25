# Shared UI migration comparison

The [standalone HTML report](reports/shared-ui-model-comparison-2026-11-25.html) includes measured results, untouched model code, aligned differences, the applied version, actual session assignments and a chronological tool log.

## Task and method

Qwen 3.6 35B-A3B Q4_K_M and Flint 40B-A2B Q4_1 received the same task from commit `035f0a27a792ab436795a5fc467f1923c14129cc`. Each used an independent worktree and the Buro runtime at that revision. The task migrated BrandMark, ThemePreview and Panel into `src/shared/ui`, required named public exports, browser aliases and imports through that public entry, and preserved behavior. Delegation was allowed without prescribing a team structure.

Inference ran sequentially through Ollama on the RTX 3060 12 GB / 32 GB RAM machine. Thinking was enabled; context/output allowances were 32,768/8,192 tokens, temperature 0.6, top-p 0.95, presence penalty 0, capacity 1 and retries 0. Dependencies and browser binaries were provisioned equally. Models were unloaded between cases. A one-hour external diagnostic budget existed, but neither case reached it.

## Observed results

| Model     | Run outcome                                | Wall time | Decoder rate  | Requests | Helpers | Changed paths |
| --------- | ------------------------------------------ | --------- | ------------- | -------- | ------- | ------------- |
| Qwen 35B  | Completed; public API requirement missed   | 1,381.5 s | 42.3 tokens/s | 42       | 0       | 17            |
| Flint 40B | Interrupted after repeated malformed calls | 236.3 s   | 48.1 tokens/s | 160      | 0       | 0             |

Wall time includes dependency preparation: approximately five seconds for Qwen. The HTML separates preparation from inference and work. Decoder rate uses reported output tokens divided by completed server generation duration and includes thinking tokens. It excludes prompt evaluation, loading, tools and failed attempts without terminal timing.

Qwen preserved all six component-rendering cases and passed independent lint, formatting, types, all 122 baseline tests and a production build. It created the public entry point but most consumers still imported internal component paths, missing an explicit architecture requirement. It also introduced an unnecessary mapping of seven theme fields despite structural type compatibility.

Qwen spent 1,061.6 reported server seconds evaluating input, roughly 77% of total wall time; decoding took 231.0 seconds. Prompt evaluation and the number of model turns dominated this run. These observations do not isolate the underlying cache, offload or engine causes.

The model's own `npm test` invocation reported 115/122 passing inside its command sandbox. The parent ran the untouched output outside that nested environment and all 122 passed. The model called the failures pre-existing; a matched baseline inside the same sandbox was not run, so that wording remains a model claim.

Flint executed two file reads but made 160 failed command calls, repeatedly sending an empty argument key. The evaluator stopped the unproductive run; there is no production-model stop rule based on that count. A separate replay captured `{"name":"command","arguments":{"":"ls -la"}}` directly in Ollama's response. Buro's normalized call retained the same arguments. This locates the malformed object upstream of Buro, without distinguishing weight behavior from engine parsing. No argument-repair adapter was added.

Flint's unchanged baseline still passed host lint/test/build. Those passes do not count as an implemented migration. Its elapsed interruption time is not a completion time or evidence of better task efficiency.

## Parent review and applied changes

The Qwen result was selected and corrected autonomously by the parent. All consumers now use `@/shared/ui`. The unnecessary palette mapping was removed, the Vite alias uses standard Node ESM path resolution, and TypeScript paths no longer require a global `baseUrl`. The final combined code passed 130 tests, lint, formatting, type checks, a production build and all six unchanged-markup cases.

The [autonomous review feature](AUTONOMOUS-REVIEW.md), committed separately as `5510884`, was added after these model runs. It did not influence their comparison. Its own native RTX validation used one executor and two independent reviewers; correction loops were also exercised with controlled model responses and actual file/tool execution.

Neither original migration run created a helper or obtained an independent agent review. The report distinguishes actual tool operations, model completion claims and the parent's verification. Stage labels in the chronology organize observations; they are not runtime workflow gates.

## Limits and cleanup

This is one migration and one run per model, not a general coding score or a release qualification. The 15-token/s preference is only an initial model-selection criterion; both models exceeded it while differing substantially in useful results.

The prior RTX model server was restored. No models or inference engines were installed for this comparison. Raw requests, private reasoning and isolated evaluation data stay under ignored `artifacts/`. The HTML contains source code and sanitized observations, not private reasoning or credentials.
