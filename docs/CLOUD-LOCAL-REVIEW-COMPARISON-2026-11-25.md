# Cloud and local models: a matched Buro task

The [interactive HTML report](reports/cloud-local-review-comparison-2026-11-25.html) contains the full comparison, original source excerpts, before/after and model-to-model differences, team stages, actual tool receipts and spending by stage.

All three models received the same task, application revision and review configuration. The task moved generic feedback and action state into shared modules. Production code and model settings were left unchanged by this comparison.

## Findings

For this behavior-preserving migration, Flash was the strongest observed time/cost choice: 3.55 times faster than local Qwen and 2.14 times faster than Pro. Its published-tariff cost was $0.308177; Pro's was $2.675312, or 8.68 times more. This is a result for one repository task, not a general coding ranking.

All three untouched model outputs passed independent lint, formatting, types, production builds, all 130 repository tests and all 22 browser behavior checks. All used the requested component split and public shared entries. The hook file is byte-identical to the original in every result. There is no observed functional-code advantage for Pro on this task.

The same runtime started one executor and two independent reviewers for each model without provider-specific workflow changes. Every team returned zero findings in one round. Captured initial and final Git trees have no source differences after review. The team added verification evidence, but this run did not demonstrate an automatic repair or a measurable code-quality gain.

The differences are mostly in style and execution. Qwen leaves relative i18n imports and infers QueryFeedback's return type. Flash uses the existing localization alias, explicit ReactElement and explicit internal file extensions. Pro also uses the alias and explicit return type, but leaves some browser-local imports extensionless. All resolve and pass the same browser/type checks; these are small consistency differences, not demonstrated functional defects.

Qwen used 74 model calls, Flash 129, and Pro 210. Flash produced a base-versus-new React SSR comparison using Mantine stand-ins, plus hook smoke checks with a React state stub and correctly reported the 122/130 nested-sandbox outcome. Pro spent many calls inspecting individual environment failures and running additional style/test commands. Qwen batched more operations but suffered substantially longer model-call latency as context accumulated.

Most of the tariff bill is repeated input: approximately $0.2825 of Flash's $0.3082 and $2.5824 of Pro's $2.6753. The direct charge for reasoning output is much smaller; its retained history may also add input fees. These results favor reducing unnecessary context/calls before assuming that disabling thinking is the right saving. Non-thinking quality was not tested.

Qwen's server reported 1,137.0 seconds evaluating input and 389.3 seconds decoding, plus 29.4 seconds loading. Its pure decoder rate was 43.4 tokens/s, while the common client-observed output/model-call metric was 10.7 tokens/s. Cloud server-only decoder timings were not exposed, so their 128.9/59.3 client-observed rates must not be compared directly with Qwen's 43.4 decoder-only figure. Accumulated-context processing explains much of the observed local latency without isolating its engine/cache/offload causes.

Qwen's executor and both reviewers still used an overbroad all-checks-pass label while also showing 122 pass / 8 fail. Flash and Pro explicitly reported the environment failures instead of declaring the full suite successful. Some narrative counts and test descriptions are imprecise; the report therefore distinguishes claims, actual command receipts and independent host verification.

The first Flash pilot was stopped after 232.7 seconds because the earlier fixture could hang under the native sandbox and the model gave npm test a 30-minute allowance. Its 34 calls cost $0.030769 by the published tariff. All primary runs were restarted on the same already-repaired fixture revision. The pilot is included in spending and excluded from the matched performance table.

Across the paid cloud runs and pilot, native usage and the published rates give $3.014258. The final account-balance change was $3.02, consistent within its one-cent display resolution. Earlier case-end snapshots were lower and continued changing after the last model request, so those intermediate deltas cannot precisely allocate charges per model. No absolute wallet amounts are exported.

For this type of change, use Flash when cloud execution is acceptable; keep Qwen as the local option when avoiding a per-token API bill matters. This case supplies no reason to pay for Pro by default. Review configuration remains editable; choosing a different reviewer model does not require branching on role names in the runtime.

## Full comparison

Values below refer to untouched outputs from the matched runs. The stopped pilot and older Qwen run are excluded from this table. Individual balance snapshots are timing-sensitive; the reconciled aggregate is recorded under spending.

### Outcome and quality

| Measurement                                                                                              | Qwen 35B local        | DeepSeek Flash        | DeepSeek Pro          |
| -------------------------------------------------------------------------------------------------------- | --------------------- | --------------------- | --------------------- |
| Run / independent review                                                                                 | completed / completed | completed / completed | completed / completed |
| Required file layout present                                                                             | Yes                   | Yes                   | Yes                   |
| Public imports and layer direction                                                                       | Yes                   | Yes                   | Yes                   |
| Browser behavior checks                                                                                  | 22/22                 | 22/22                 | 22/22                 |
| English / Russian markup preserved (Generated alert IDs normalized; actual styles and content retained.) | Yes                   | Yes                   | Yes                   |
| Host repository tests                                                                                    | 130/130               | 130/130               | 130/130               |
| Lint, formatting and types                                                                               | Passed                | Passed                | Passed                |
| Production build                                                                                         | Passed                | Passed                | Passed                |
| Reported findings / review rounds (Finding entries can repeat across reviewers and rounds.)              | 0 / 1                 | 0 / 1                 | 0 / 1                 |
| Automatic source changes after review                                                                    | No                    | No                    | No                    |
| Changed paths in raw model result                                                                        | 23                    | 23                    | 23                    |

### Time and work

| Measurement                                                                                                    | Qwen 35B local   | DeepSeek Flash                  | DeepSeek Pro                    |
| -------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------- | ------------------------------- |
| Total observed run time                                                                                        | 27m 50s          | 7m 51s                          | 16m 49s                         |
| Initial implementation after setup                                                                             | 14m 07s          | 2m 37s                          | 7m 05s                          |
| Review + correction wall time (Includes reports and any executor continuation after the first review begins.)  | 13m 40s          | 5m 09s                          | 9m 40s                          |
| Sum of model call durations (Includes provider/network/queue/prefill and generation, excludes tool execution.) | 26m 12s          | 5m 32s                          | 13m 11s                         |
| Output tokens / model-call second (Common client-observed denominator; not pure server decoder throughput.)    | 10.7             | 128.9                           | 59.3                            |
| Local server prefill / decoder time                                                                            | 18m 57s / 6m 29s | Server-only timings not exposed | Server-only timings not exposed |
| Pure server decoder throughput (different denominator from client-observed rate)                               | 43.4 tokens/s    | Not exposed by API              | Not exposed by API              |
| Output tokens / whole-task second (Includes tools, tests, review and setup; output includes thinking.)         | 10.1             | 91.0                            | 46.5                            |
| Median model-call duration                                                                                     | 5.60s            | 2.35s                           | 3.37s                           |
| Model calls / sessions                                                                                         | 74 / 3           | 129 / 3                         | 210 / 3                         |
| Tool operations / failed operations                                                                            | 151 / 20         | 163 / 12                        | 318 / 18                        |
| npm test commands / timed out                                                                                  | 3 / 0            | 11 / 0                          | 15 / 0                          |

### Tokens and money

| Measurement                                                                                                                              | Qwen 35B local                        | DeepSeek Flash        | DeepSeek Pro          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------- | --------------------- |
| Input tokens across all requests (Repeated input is counted again. Tokenizers differ between providers.)                                 | 1,187,935                             | 3,025,899             | 5,126,800             |
| Cached input tokens                                                                                                                      | Not reported by this local meter      | 1,166,080             | 1,255,936             |
| Input cache-hit share                                                                                                                    | Not reported                          | 38.5%                 | 24.5%                 |
| Uncached input tokens                                                                                                                    | Not reported by this local meter      | 1,859,819             | 3,870,864             |
| Output tokens, including thinking                                                                                                        | 16,881                                | 42,843                | 46,925                |
| Reasoning tokens within output (Included in output; never charged twice.)                                                                | Separate count not reported           | 18,998                | 22,579                |
| Total reported tokens                                                                                                                    | 1,204,816                             | 3,068,742             | 5,173,725             |
| Calculated model API charge (Qwen electricity and hardware are unmetered, not free by assumption.)                                       | $0.000000                             | $0.308177             | $2.675312             |
| API input cost / output cost                                                                                                             | $0.000000 / $0.000000                 | $0.282471 / $0.025706 | $2.582401 / $0.092912 |
| Direct reasoning-output cost within output cost (A subtotal, not an extra charge; retained reasoning history can also incur input fees.) | Separate reasoning count not reported | $0.011399             | $0.044706             |
| Observed case-end balance change; not final model bill                                                                                   | No API debit                          | $0.21 (rounded)       | $2.45 (rounded)       |
| Review + correction API charge                                                                                                           | $0.000000                             | $0.198874             | $1.524577             |
| Same tokens repriced without input cache (Arithmetic tariff scenario, not an additional charge or a measured second run.)                | Not applicable                        | $0.479591             | $3.476600             |
| Tariff saving versus the no-cache arithmetic scenario                                                                                    | Not applicable                        | $0.171414             | $0.801287             |
| Usage coverage for charged calls                                                                                                         | Local usage; no bill                  | 129/129               | 210/210               |

### Approach and scope

| Measurement                                                                                                                         | Qwen 35B local                                                                                       | DeepSeek Flash                                                                                                                     | DeepSeek Pro                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Model ID                                                                                                                            | qwen3.6:35b-a3b-q4_K_M                                                                               | deepseek-flash                                                                                                                     | deepseek-v4-pro                                                                                                   |
| Execution environment                                                                                                               | RTX 3060 12 GB + 32 GB RAM; partial GPU/RAM offload; Ollama 0.40.16                                  | Official managed API; server hardware not reported                                                                                 | Official managed API; server hardware not reported                                                                |
| Thinking configuration                                                                                                              | Native thinking enabled                                                                              | Enabled; high effort                                                                                                               | Enabled; high effort                                                                                              |
| Thinking observed in completed requests (A model can emit zero reasoning tokens in an enabled thinking request.)                    | 74/74                                                                                                | 107/129                                                                                                                            | 193/210                                                                                                           |
| Configured context / output allowance (Shared character-based context construction; native provider windows and tokenizers differ.) | 32,768 / 8,192                                                                                       | 32,768 / 8,192                                                                                                                     | 32,768 / 8,192                                                                                                    |
| Editing / inspection strategy (Tool counts cover executor and reviewers, including temporary checks and failures.)                  | 39 read_file and 44 edit_file operations; more batched proposals, 51 shell commands across the team. | 19 read_file operations plus 58 command_read and 63 command calls; temporary rendering checks were created and cleaned up.         | 117 read_file and 147 command operations; many individual environment-test investigations across 210 model calls. |
| Hook implementation                                                                                                                 | Byte-identical to original                                                                           | Byte-identical to original                                                                                                         | Byte-identical to original                                                                                        |
| Localization import in moved UI                                                                                                     | ../../../i18n/index.ts                                                                               | @/i18n/index.ts                                                                                                                    | @/i18n/index.ts                                                                                                   |
| QueryFeedback return annotation                                                                                                     | Inferred JSX return                                                                                  | Explicit ReactElement                                                                                                              | Explicit ReactElement                                                                                             |
| Internal sibling / lib imports                                                                                                      | Explicit .tsx / .ts                                                                                  | Explicit .tsx / .ts                                                                                                                | Some extensionless browser imports                                                                                |
| Validation reporting                                                                                                                | Says all checks pass while listing 122/130; actual failed receipts remain visible.                   | Explicit 122/130; base-versus-new rendering observations; no false full-suite green claim.                                         | Explicit eight environment failures; additional individual-test/style investigations.                             |
| Persistent scope of final patch                                                                                                     | 23 paths: requested UI moves, consumers and structure docs.                                          | 23 paths: requested UI moves, consumers and structure docs.                                                                        | 23 paths: requested UI moves, consumers and structure docs.                                                       |
| Observed review contribution                                                                                                        | Independent checks; zero findings; no source corrections.                                            | Smoke/render comparison with temporary stand-ins; zero findings; no source corrections. Parent verification used the real browser. | Independent checks and environment diagnosis; zero findings; no source corrections.                               |

## Concrete code differences

The hook implementation is byte-identical across all three outputs. These excerpts show the small remaining style/import differences; they do not establish different algorithms or functional defects.

### Qwen to Flash: localization alias and return annotation

```diff
--- Qwen 35B local/src/shared/ui/molecules/query-feedback.tsx
+++ DeepSeek Flash/src/shared/ui/molecules/query-feedback.tsx
@@ -1,9 +1,10 @@
 import { Loader, Text } from '@mantine/core';
-import { t } from '../../../i18n/index.ts';
+import type { ReactElement } from 'react';
+import { t } from '@/i18n/index.ts';
 import { ErrorNotice } from './error-notice.tsx';

 /** A small read-state indicator that preserves already displayed data. */
-export const QueryFeedback = (input: { loading?: boolean; error?: string }) => (
+export const QueryFeedback = (input: { loading?: boolean; error?: string }): ReactElement => (
   <>
     <ErrorNotice error={input.error} />
     {input.loading && (
```

### Flash to Pro: sibling import extension

```diff
--- DeepSeek Flash/src/shared/ui/molecules/query-feedback.tsx
+++ DeepSeek Pro/src/shared/ui/molecules/query-feedback.tsx
@@ -1,7 +1,7 @@
 import { Loader, Text } from '@mantine/core';
 import type { ReactElement } from 'react';
 import { t } from '@/i18n/index.ts';
-import { ErrorNotice } from './error-notice.tsx';
+import { ErrorNotice } from './error-notice';

 /** A small read-state indicator that preserves already displayed data. */
 export const QueryFeedback = (input: { loading?: boolean; error?: string }): ReactElement => (
```

### Flash to Pro: public hook/type entry

```diff
--- DeepSeek Flash/src/shared/lib/index.ts
+++ DeepSeek Pro/src/shared/lib/index.ts
@@ -1 +1,5 @@
-export { useOperation, type Operation, type OperationOutcome } from './use-operation.ts';
+export {
+  useOperation,
+  type Operation,
+  type OperationOutcome,
+} from './use-operation';
```

## Spending

| Scope                                                                      | Input tokens | Output tokens | Tariff calculation | Observed balance change |
| -------------------------------------------------------------------------- | -----------: | ------------: | -----------------: | ----------------------: |
| Qwen 35B local — complete matched run                                      |    1,187,935 |        16,881 |          $0.000000 |          Not applicable |
| DeepSeek Flash — complete matched run                                      |    3,025,899 |        42,843 |          $0.308177 |         $0.21 (rounded) |
| DeepSeek Pro — complete matched run                                        |    5,126,800 |        46,925 |          $2.675312 |         $2.45 (rounded) |
| Stopped Flash pilot — old fixture; excluded from primary comparison        |      710,344 |         7,791 |          $0.030769 |         $0.03 (rounded) |
| All paid cloud calls, including the pilot (stage rows above are subtotals) |    8,863,043 |        97,559 |          $3.014258 |         $3.02 (rounded) |

Total calculated DeepSeek charge, including the stopped pilot: $3.014258. Matched Flash + Pro runs: $2.983489. The pilot is charged once and is not included in the primary performance or quality comparison. Stage rows below are subtotals, not additional charges. Observed account-balance change through the final snapshot: $3.020000; difference from the tariff calculation: $0.005742. A nonzero discrepancy is not explained by an assumed discount.

Reasoning is already included in output tokens and is not charged twice. Every cloud request has native usage metadata, consistent cache-hit/miss counts and a unique response ID. Qwen has no token API charge; electricity and hardware costs were not metered. Research and hosting costs are outside this ledger.

The final aggregate wallet movement agrees with the published-tariff calculation within the one-cent display resolution. Earlier case-end snapshots had not yet reflected all later observed deductions. Their individual changes should not be treated as precise model invoices. Absolute wallet amounts and API credentials are not published.

Observed off-peak USD rates per million tokens, freshly checked on November 25, 2026:

| Model           | Cached input | Uncached input | Output |
| --------------- | -----------: | -------------: | -----: |
| deepseek-flash  |       $0.003 |          $0.15 |   $0.6 |
| deepseek-v4-pro |       $0.022 |          $0.66 |  $1.98 |

Source: [official DeepSeek model pricing](https://api-docs.deepseek.com/quick_start/pricing/). All request timestamps fell outside the published peak windows.

## Method and limits

All three primary runs use the same task hash and application/source revision 34b22d85d96b95e5662fa47009ae2a731ea3bb80. This revision includes only the already-committed review-test fixture fix on top of the earlier task base. The source files to migrate are unchanged. Runtime code, task text and review configuration match; no defect or finding quota was planted.

One independent workspace per case. Flash and Pro run sequentially through the official DeepSeek API with the saved private credential. Provider prefix-cache state is not controlled; the preceding Flash pilot may have warmed reusable prefixes, and actual hit/miss counts are reported. Qwen runs on the RTX 3060 12 GB / 32 GB RAM machine independently of the cloud calls. Host tool execution shares the Mac; these are observed application times, not an isolated hardware benchmark. No proxies, text-to-tool emulation, argument repair or model-specific role rules were added.

Thinking is enabled for all models. DeepSeek uses explicit high effort; Qwen has its native thinking toggle without a directly equivalent effort scale. Buro context/output settings are 32,768/8,192 tokens, capacity 1, retries 0. The shared context builder uses a character estimate rather than exact provider tokenization. Ollama enforces its configured context; the managed API has a larger native context window.

The same sampling values are sent: temperature 0.6, top-p 0.95 and presence penalty 0. DeepSeek documents that temperature and presence penalty are ignored in thinking mode; top-p behavior differs between Flash, Pro and tools-free reporting. Equal sent fields do not imply identical sampling behavior.

Native SSE usage is metered before the existing transport normalizes it. Token counts include every recorded request, executor/helper/reviewer work, structured reports, and any correction loops. Raw provider cache-hit, cache-miss and output counts determine charges; reasoning tokens are already part of output. No API keys, private reasoning or absolute wallet amounts are exported.

Rates were checked on November 25, 2026, including a fresh uncached fetch after a billing discrepancy. Every observed request timestamp is checked to be outside the published weekday peak windows, so the off-peak USD rates apply regardless of holiday status. Calculated usage charges are distinct from rounded balance deltas; other account activity or billing precision can affect that cross-check.

The stopped Flash pilot used the earlier revision with a known hanging fixture. Its 34 requests are included in the spending ledger but excluded from the matched model table. Its run was canceled while waiting on a full-suite command with a 30-minute timeout, not during a model generation.

A successful shell pipeline can still contain failed tests. Host checks and 22 real browser behavior cases verify the untouched result. Native command-sandbox outcomes are shown separately: nesting this repository's OS-isolation tests can produce environment failures. Review summaries are model claims; command receipts and parent verification are independent evidence.

Only one task and one matched run per model are represented. The task is a behavior-preserving migration, not a general coding benchmark. Empty findings do not establish defect absence, and unchanged source does not demonstrate a quality improvement. Models may share blind spots even in independent sessions.

All experiments finished. The prior owned RTX model server was restored and its health endpoint returned status ok. No models or engines were installed, and production model/default/review settings were not changed. Raw transcripts, private reasoning, credentials and wallet snapshots remain under ignored artifacts.

## Exact task

```text
Move reusable action feedback out of the features layer.

The UI currently shares ErrorNotice, QueryFeedback and useOperation through src/features/common. These are generic browser UI primitives, not a business feature. Migrate them into the existing shared layer without changing their behavior.

Use src/shared/ui/molecules/error-notice.tsx and query-feedback.tsx for the components, and src/shared/lib/use-operation.ts for the hook and its Operation/OperationOutcome types. Expose named exports through the existing src/shared/ui/index.ts and a new src/shared/lib/index.ts. Shared-library consumers must import through @/shared/ui or @/shared/lib; use relative imports within each shared module. Keep the existing UI exports available. The existing @/i18n/index.ts infrastructure is allowed; relocating localization is outside this task.

Update every consumer, remove the old features/common implementations without compatibility forwarding files, and preserve translations, loader/error markup and all hook behavior: busy state, error reset before an action, explicit failed outcomes, thrown failures, successful returned values, clear(), and finally resetting busy. Keep API names, generic types and the fallback error text unchanged. Do not introduce new state managers, wrappers, dependencies, workflow restrictions or unrelated migrations.

Inspect the repository conventions in docs/STRUCTURE.md and the existing style configuration. Update that document briefly to describe the completed migration. Tests remain under tests/. Run appropriate checks, including npm run check, npm test and npm run build; report actual observed results, distinguishing command-environment failures from source defects. Keep changes proportional to a behavior-preserving move.

The configured review team will independently inspect the implementation and return actionable findings automatically. You may use ordinary collaboration tools if useful, but a particular team structure is not required. Do not commit, publish or apply changes outside the isolated workspace.
```

## Review configuration

```json
{
  "enabled": true,
  "maxRounds": null,
  "participants": [
    {
      "name": "Behavior and verification",
      "instructions": "Independently inspect the implementation against the task and base diff. Verify error/loading rendering and useOperation behavior, including rejected promises and explicit failed outcomes. Run appropriate existing tests and inspect their output. Preserve the public API, translated feedback and fallback error text. Report confirmed defects within scope; do not require tests that merely mirror a file move."
    },
    {
      "name": "Architecture and simplicity",
      "instructions": "Independently inspect the actual diff, public exports, consumer imports, FSD boundaries and repository style. Shared primitives must not import business features; the existing localization infrastructure is explicitly allowed. Look for stale paths, duplicate implementations, lost types and unnecessary wrappers or abstractions. Check the requested documentation update. Report actionable issues, not speculative preferences."
    }
  ]
}
```

## Sources

- [DeepSeek model versions, pricing and peak/off-peak rules](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek native completion usage fields](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek thinking, effort, tool history and sampling behavior](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek model discovery metadata](https://api-docs.deepseek.com/api/list-models/)
