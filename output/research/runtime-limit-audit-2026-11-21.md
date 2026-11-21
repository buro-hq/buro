# Runtime and model hidden-limit audit

Date: 2026-11-21. Scope: managed runtime, request admission, segments, worker-check feedback, private session/ledger validation, provider transport and native Codex lifecycle. Read-only source audit; no model, network, RTX, credential or original-project access. Only this report and [the32-entry inventory](runtime-limit-inventory-2026-11-21.json) were created. Schema maxima are recorded separately from defaults. Workflow/team/project/transport caps outside these files are for the parent audit.

## Main result

Removing the visible run budget will not make ordinary Buro execution unlimited. Several independent policies and checkpoint schemas can still terminate a healthy assignment. The user wants default observation-only aggregate accounting with optional explicit hard quotas; implementing that requires versioning the whole enforcement chain, not increasing a constant.

| Layer | Actual default / hidden condition | Consequence |
| --- | --- | --- |
| Managed run |64generation attempts,131072reserved-output tokens,256tool/check charges | Any one may stop further effects |
| Protected review allowance |8requests,16384output,32tools reserved inside that total | Work can stop already at56requests/114688output/224tools |
| One managed turn |24generations and64tool/check charges | Close/final JSON bookkeeping counts too |
| One managed logical session |256cumulative requests across turns/windows | Removing the run cap still leaves a lifetime cap |
| Worker segmentation |Close after3tool rounds or60% conservative pressure; maximum4windows | A worker can use its windows before making an edit |
| Automatic worker-check feedback |2failed-check feedback transitions, frozen literal2 | Independent repair stop, also consumes segment windows |
| Checkpoint archive |15archives; policy validator allows at most16windows | Raising just the default4 still encounters another ceiling |
| Ledger storage |17408operation keys maximum | Removing numerical quotas still makes a longer ledger invalid |
| Context admission |UTF8 JSON bytes +16/message, not observed token usage | Can reject a request before HTTP while actual model window may still have room |
| Minimum output headroom |min(128, configured output cap) | Short structured responses may be refused by the conservative estimate |

Sources and exact enforcement locations are in inventoryR01–R18. The production factory injects the durable budget port, conservative request policy, segment policy and worker-check service when their required ports exist ([factory](../../adapters/resources/runtime-resources.ts), lines74–95). Direct test constructors can omit optional ports; that is not the normal production default.

## Hidden migration blockers

1. V1policy requires finite positive numeric caps. Omitted runtime values become finite defaults; null/zero/Infinity do not mean unlimited. Use a versioned optional-cap representation.
2. The private budget validator rejects more than17408operations ([core/run-budget.ts](../../core/run-budget.ts), line130). Receipt storage must become paged/append-only or versioned before a genuinely long run can work.
3. Private sessions separately cap archives to15, checks to8selected IDs, feedback steps to2, evidence manifests to256changed paths. These constraints are repeated across types, schema and transition validation; removing just an outer condition is insufficient.
4. Runtime resource configuration identity hashes runtime limits, request-policy revision and segment limits ([runtime-resources.ts](../../adapters/resources/runtime-resources.ts), lines174–183). Old routes may reject a new default before private resume. Managed checkpoint loading also requires the exact saved segment policy, and transitions forbid rewriting stored limits. User subsequently authorized a clean pre-release cutover: archive old state as non-executable, do not maintain legacy resolvers or checkpoint resume. New-format endpoint/model identity checks remain mandatory.
5. [PrivateJSONFiles](../../adapters/files/private-json.ts) reads, clones and atomically rewrites entire records. There is no explicit byte ceiling there, but unbounded receipts and archives become a memory/I/O/storage problem. Separate durable history from bounded active views.

## Context and progress costs

Segment rotation currently estimates raw session messages ([managed-runtime.ts](../../core/managed-runtime.ts), line444), while actual generation admission estimates the provider's projected request view (line466). Ollama non-thinking projection can remove tagged assistant commentary. Thus rotation can happen earlier than the actual packet needs.

The fixed estimator ([request-policy.ts](../../core/request-policy.ts), lines23–28) uses serializedUTF8bytes for messages/tools/schema plus16/message. A custom output policy cannot return a different estimate: prepareManagedRequest recomputes and checks equality. A tokenizer-aware estimator needs its own trusted/versioned contract; merely reducing a heuristic would risk actual overflow and silent constraint loss.

Rollover requires a model closing response. A continuing close consumes one generation; a complete close then requests a separate final envelope. Ordinary Ollama work completion also has a separate final JSON generation. Closing output is capped at512tokens and nextTask at1000characters. These requests are charged, can exhaust per-turn allowances, and add no file edit by themselves. Investigate whether some fully settled transitions can be owned by the service; preserve unresolved tool chains, provider continuation and unknown-outcome reconciliation.

The new window receives the original anchor task plus at most6observed tool receipts of512characters each. Historical source in the original task may now be stale, and the worker is told to re-read needed source. This is a likely repeated-read driver. Prefer current verified file/evidence references and selective retrieval, without representing old outputs as current truth or exposing private continuation.

## Limits to retain as technical or correctness boundaries

- Actual model context/capabilities, GPU concurrency and supported request output remain finite. Current Buro context/output defaults32K/4K and schema maxima256K/32K are configuration choices, not universal provider limits.
- HTTP responses are bounded at4MiB; changed-file evidence at256paths,1MiB/file and32MiBtotal; Git inspection has15s/2MiBoperation bounds. Keep safe I/O while providing streaming/paging/task-splitting rather than quietly omitting evidence.
- Native RPC acknowledgements have45s health timeouts and MCP discovery15s/1MiB bounds. Native shutdown uses1s stdin grace then SIGTERM/SIGKILL escalation. These are operation/lifecycle safeguards, not user goal budgets.
- Production managed/native goal turns currently use a10-minute inactivity policy. This is not the120s per-turn experimental adapter setting. Queue waits and model metadata/loading currently sit inside the same managed inactivity clock, so a busy endpoint can look stalled. Distinguish queued/loading/streaming/executing states.
- Endpoint capacities default to1for Ollama and2for DeepSeek (schema1–8); shared endpoint definitions use their minimum configured capacity. Queued sessions should wait rather than turn this into a cumulative goal cap.
- Unknown generation/tool/check outcomes must not be automatically replayed. Scope, private-data guards, immutable evidence and action IDs remain independent of unlimited aggregate resources.
- Native Codex internal API requests are not managed-ledger controlled. Show unknown coverage honestly rather than pretend zero cost or identical budget enforcement.

## Read-only behavior verification

Executed a pure in-memory Node assertion probe, with no provider/file-project work:

- Parsed managed defaults are exactly context32768/output4096/turn requests24/turn tools64/session requests256.
- Null caps are rejected by the current managed/runtime budget schemas.
- A default ledger permits56work reservations, rejects the57th, then admits8review reservations and rejects the next.
- A default ledger permits224work tool charges, then rejects another.
- Three tool rounds request closure even at1000estimated input against32Kcontext.
- A17window policy is rejected independently of the default4.
- A941-byte conservative estimate against1024context is rejected because83output headroom is below128. This is a deterministic admission test, not a tokenizer measurement.

No implementation changes, new test files, commits or live models were used for this audit. The previous605test baseline was not rerun.

## Recommended implementation order

1. Separate usage/effect accounting from optional aggregate enforcement, with one clean policy/checkpoint contract, without legacy resume.
2. Audit and remove default terminal turn/session/window/feedback counters together; retain explicit user caps and resumable scheduling.
3. Introduce current verified context views plus trustworthy estimator provenance. Improve progress diagnosis and same-executor repair before replacing numerical stops with more blind iterations.
4. Page durable receipt/history storage while keeping atomic ownership, idempotency and before/after evidence verification. A single transactional authority is preferable to two competing journals.
5. Keep technical per-request/I/O/lifecycle guards with typed recovery, and measure broader tasks separately from finite benchmark budgets.
