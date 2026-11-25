# Explicit RTX synthetic comparison harness

Date: 2026-11-22. Preparation after `85ade5b`, while the user turns on the RTX host. This agent made **zero remote or model requests**, performed no discovery/SSH/model download, changed no original project or machine configuration, and did not touch `output/ux/`. Readiness and any live results belong to the parent separately.

## Contract and implementation

Subsequent simplification: there is now one `scripts/check-model-comparison.cjs --target rtx` entrypoint. `validateComparison` and the shared `evaluationTargetContract` validate the chosen target directly. The preliminary separate RTX CLI, `validateRtxComparison`, `rtxEvaluationContract` and fake-loopback workaround described below were removed before commit. The original five-case counts below retain their preliminary provenance; the later implementation passed 52/52 related focused tests including six updated RTX/CLI tests. No real RTX request occurred in either stage.

The ordinary `validateComparison` remains loopback-only. A separate `validateRtxComparison` is selected only when the caller supplies an explicit `rtx` contract. It permits only `mixed-buro` and `ollama-buro`, with an exact target at `http://192.168.50.10:11434/` and exact installed baseline model `qwen3.5:9b-q4_K_M`. The shared pure `rtxEvaluationContract` in `scripts/lib/live-provider-runner.cjs` requires `BURO_RTX_MODEL_COMPARISON=1` and `BURO_LIVE_OLLAMA=1`, validates the target/model, and rejects a non-synthetic source case. The comparison still requires `BURO_MODEL_COMPARISON=1`; a hybrid arm additionally requires the DeepSeek live opt-in. Credentials, URL query/fragment/path changes, other hosts/ports, native-only arms and a replacement model reject before a comparison fixture or transport is invoked.

The new `scripts/check-rtx-model-comparison.cjs` reads the explicit `BURO_RTX_ENDPOINT` flag and validates the complete comparison contract before loading the private credentials store. It does not use the ambient Ollama endpoint or retarget a saved production connection. It pins the installed 9B model, runs hybrid then all-local by default, and accepts an explicit subset via the ordinary arm CSV. There is no legacy/bounded planning argument: planning remains capability-selected.

The live runner needs a small additional change because its isolated Ollama connection previously omitted private-network trust. Only the explicit validated RTX contract now adds `trust: private-network` to that newly created temporary connection. Normal runner connections retain their earlier auto/untrusted representation. Capacity remains one; the Ollama runtime gets the same **16,384 context / 2,048 maximum output** envelope used by the current Mac comparison. The global comparison context remains 32K so DeepSeek retains its earlier cloud context. The same 24-generation total, diagnostic accounting, reserved-output ceiling, five-minute coding wall, task/fixture/oracle hashes, distinct-worker requirement, immutable service checks and fresh review remain unchanged.

The provider transport still allows only the selected endpoint's existing `/api/tags`, `/api/show`, `/api/chat` routes with redirects rejected. The new contract does not broaden production trust, add a second orchestrator, download a model, or bypass cloud-model/local-only checks. Model availability/capability discovery and actual coding quality remain live gates.

## Deterministic evidence

`tests/rtx-model-comparison.test.ts` adds five cases:

- the real CLI without target/live opt-ins exits with a typed blocked result and no stdout;
- ordinary comparison still rejects the LAN endpoint, while the explicit contract rejects missing opt-ins, wrong endpoint/model/arms and preserves the existing quotas;
- an invalid comparison rejects before credential callback, fixture/provider invocation or effects;
- the actual comparison controller passes the exact fixed queue identity, frozen budgets and 16K local context to both controlled arms and never accepts a failed workflow;
- the actual resource factory/live runner uses an injected transport and a real temporary project/configuration. Without the contract, the LAN all-local profile rejects `DATA_POLICY_BLOCKED` before any generation. With it, the saved temporary connection has exact private-network trust, endpoint, capacity and context, and the real probe reaches one synthetic diagnostic before the shared diagnostic limit stops the next request. `live: false`, original synthetic source preserved, and no coding Run is created. This proves trust/config/probe wiring, not full real RTX execution.

Executed `node --test tests/rtx-model-comparison.test.ts tests/model-comparison.test.ts tests/live-evaluation-budget.test.ts`: **40/40 passed**, zero skipped, 2483.298625 ms. Log: `/private/tmp/buro-rtx-harness-tests-2026-11-22.log`. Formatting and `git diff --check` pass. Counts overlap existing comparison/budget tests and must not be added to a parent's full-suite count. Earlier exploratory test assertions incorrectly expected serialized auto trust and generation counts; these were corrected to the actual existing resource-policy behavior, not by weakening production policy. No earlier assertion failure is claimed as a product defect.

## Parent-only live invocation after readiness

```sh
BURO_MODEL_COMPARISON=1 BURO_RTX_MODEL_COMPARISON=1 BURO_LIVE_OLLAMA=1 BURO_LIVE_DEEPSEEK=1 BURO_RTX_ENDPOINT=http://192.168.50.10:11434 BURO_COMPARISON_REPORT=output/evaluation-2026-11-22/rtx-current.json node scripts/check-model-comparison.cjs --target rtx
```

The local-only subset is `ollama-buro`; the hybrid subset is `mixed-buro`. For a local-only subset the DeepSeek opt-in is unnecessary. No live invocation was performed by this agent. The parent must first confirm user readiness and installed exact model/digest, preserve prior trial reports, and record actual code changes/checks/reviewer/holdout outcomes independently of a successful connection probe. Failed attempts remain failed; there is no automatic retry or silent quota increase.
