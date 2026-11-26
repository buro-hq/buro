# Independent review of the large-task outputs

Both saved implementations were inspected separately from their in-flow reviewers. This is a manual assessment by the current assistant, not a blind study or an external coding benchmark. The implementation snapshots were not edited. Findings use the exact assignment, Desktop preferences, actual code and targeted reproductions; in-flow summaries are treated as claims.

## Outcome

| Observation                                                            | Buro / Flash team                                | Native Codex CLI                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| Complete flow wall time                                                | 2h02m30s                                         | 26m43s                                                         |
| Review rounds                                                          | 2                                                | 3                                                              |
| Independent existing check                                             | Lint, format and types passed                    | Lint, format and types passed                                  |
| Repository and canonical tests                                         | 139/139 passed                                   | 140/140 passed                                                 |
| Build and independent preset API checks                                | Passed                                           | Passed                                                         |
| Clearing an edited instruction field preserves explicit empty override | Failed targeted browser reproduction             | Passed the same reproduction                                   |
| Concurrent save/delete leaves the preset deleted                       | Failed targeted application API reproduction     | Passed the same reproduction                                   |
| New preset clear button exposed to accessibility tools                 | Not exposed                                      | Exposed                                                        |
| API cost                                                               | $6.225497508, from returned usage and peak rates | Account quota; no API bill inferred                            |
| Reported input/output tokens                                           | 84,039,175 / 933,957                             | 13,772,319 / 116,350                                           |
| Request accounting                                                     | 1,655 API requests                               | 12 CLI agent turns; underlying model-request count unavailable |

Codex completed this observed workflow about 4.6 times faster. It ran alongside Flash after an initial Flash-only stage, so these are practical flow times rather than isolated hardware latency measurements. Codex uses GPT-6.1-Sol/high and native tools; Buro uses DeepSeek Flash/high and portable tools. The result does not establish a general model leaderboard.

Flash usage included 68,391,168 cached and 15,648,007 uncached input tokens. All 1,655 requests returned usable billing data; calls were between 01:47 and 03:49 UTC, within the weekday peak window. The official rates were checked on November 26; the date is treated as an ordinary Chinese working day. The observed balance moved from $15.61 to $9.39, with cent precision. Codex usage is the sum of reported CLI turn usage, including 12,893,824 cached input tokens; it is not a count of twelve model requests. No decoder tokens/second is invented for either cloud flow.

## Reproduced Flash defects

### Empty instructions become inherited instructions

`src/features/tasks/TasksPage.tsx:107` assigns `event.currentTarget.value || undefined`. Select a preset with nonempty instructions, open Run options, erase the instruction text and start. The actual WebSocket request omits `options.instructions`, causing application defaults to be inherited. The required empty-string override is lost.

The same actual TasksPage and API path were exercised in both checkouts. The run-start boundary was captured without invoking inference. Flash submitted `{ modelId: 'fixture-main', review: { enabled: false } }`; Codex submitted the same fields plus `instructions: ''`. Both browser runs had no runtime errors. This is a source defect despite the original green suite.

### A concurrent edit can resurrect a deleted preset

`modules/presets/preset-service.ts:29` reads the record, awaits that read, then calls the upserting `store.save`. Against the real SQLite-backed application, `Promise.all([presets.save(existing), presets.delete(existing)])` leaves the Flash record present. The save resumes after deletion and recreates it.

Codex uses the existing `RecordStore.patch` operation at `modules/presets/service.ts:32`. The same SQLite reproduction leaves the record deleted. This verifies the supplied adapter behavior; it does not claim that every possible third-party storage adapter is atomic.

### The new clear button is hidden from accessibility queries

The new preset Select at `src/features/tasks/TasksPage.tsx:73` uses Mantine's clearable control without exposing a named clear button. The actual browser accessibility query finds no “Clear preset” button. Codex explicitly sets its name, `aria-hidden: false` and a keyboard tab stop in `src/entities/preset/ui/selector.tsx:31`. This observation concerns the clear control; it does not prove that every alternative deselection interaction is unavailable.

## Architecture, cleanliness and preferences

Both implementations keep presets as copied launch data, use module-owned storage through the replaceable storage interface, validate external input at the API boundary, refresh queries from notifications, preserve run history and avoid new dependencies or role/model branches.

Flash duplicates launch-option editing across the preset editor and TasksPage. The different handling of empty strings is an observed consequence. It adds a route-level page inside the feature slice and imports the new server implementation directly rather than exposing a module `index.ts`. Its four new tests remain at the root of `tests/`, despite the review profile's unit/integration/e2e classification preference; `preset-service.ts` repeats its folder context. The simple `reviewState` helper returns a ternary despite the chosen preference for an explicit `if` in two-way returns. These are preference/structure findings, separate from the functional defects.

Codex shares `LaunchOptions`, reuses one controlled `LaunchOptionsEditor`, separates pages/features/entities, exposes the server module through `index.ts`, and classifies tests under integration/e2e with a reusable fixture. Its reviewer editor displays inherited settings without copying untouched defaults into explicit overrides and retains unavailable model ids visibly. It did broaden the pre-existing review validator to `z.strictObject`; that changes unknown-field handling outside the new preset API. No documented client failure was reproduced, so this is a minor scope observation rather than a confirmed functional regression. The new fixture would better follow the requested whitespace style with blank lines between repository setup, transport construction and application setup.

## Manual quality rubric

These scores assess this task's saved code and evidence. They are subjective, not runtime acceptance gates, public benchmark scores or proof that undiscovered defects do not exist.

| Dimension                      | Maximum | Buro / Flash | Native Codex |
| ------------------------------ | ------: | -----------: | -----------: |
| Functional completeness        |      35 |           28 |           35 |
| Architecture                   |      25 |           22 |           24 |
| Simplicity and cleanliness     |      15 |           12 |           15 |
| Desktop preference conformance |      15 |           11 |           14 |
| Verification quality           |      10 |            8 |           10 |
| Total                          |     100 |           81 |           98 |

Flash's functional deductions follow the empty-override defect and save/delete race. Architecture and preference deductions follow the observed entry-point, layout and test-classification departures. Its green tests miss the reproduced cases. Codex has no confirmed functional defect from this independent pass; the minor scope and whitespace observations account for its deductions.

## Team behavior and experiment limitation

Flash saved 45 sessions: one main coordinator, 38 worker-model sessions and six configured review sessions. The parent chain reached depth 13. Some nested sessions inherited the main instruction to delegate implementation again. There were 46 session-start attempts, not 46 successfully saved workers. Main-model calls numbered 71, worker-model calls 1,173, and review-model calls 411. The first configured review began only after about 82.4 minutes.

This is a significant scenario/instruction-inheritance confound. It shows a problematic team trajectory, not the intrinsic latency of a single Flash executor. Before using the deferred combinations to compare efficiency, configure implementation helpers through explicit saved descriptions/instructions and inspect the actual handoff graph. Avoid assigning the coordinator's delegation instruction to implementation children; this can be done as scenario data without hardcoded engine roles or team-size restrictions.

Codex's initial implementation took 604 seconds. Nine independent review turns across three rounds found and corrected issues including an inaccessible clear control; correction turns took 186 and 93 seconds. Its final three reviews reported no findings. Flash's first round reported two findings, then its second round reported none, but the independent checks above found remaining defects. More completed review records therefore do not automatically establish correctness.

The separate zero-turn native network setup failure is excluded from quality scoring. The large report and its initial HTTP-400 push failure are reporting/transport issues, not model implementation failures. Saved code has not been applied to the main application. Deferred Flash+Qwen, Pro+Flash and Pro+Qwen flows have not started.
