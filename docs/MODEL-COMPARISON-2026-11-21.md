# Controlled model comparisons

Use the synthetic comparison harness in `scripts/check-model-comparison.cjs` to compare native Codex, Buro Codex, DeepSeek, and local Ollama on identical tasks and controller-owned acceptance checks.

Record the exact model, configuration, task and fixture hashes, actual usage, failures, code-check results, and full workflow outcome. A successful coding candidate is not sufficient evidence of independent review or final acceptance. Keep deterministic tests separate from real model trials.

Private-project trial data and source manifests have been removed from the public history. No replacement public result is implied. See [evaluation](EVALUATION.md) and [first-release gates](FIRST-BETA-READINESS-2026-11-22.md).
