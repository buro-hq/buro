# Stage 5A1 independent incremental usage-accounting review

Date: 2026-11-22. Baseline `e145893` plus the new pure `core/usage-accounting.ts` foundation and its tests. **Clear within the explicit finite-policy transition contract**, after the malformed-identity correction below. This stage does not adopt the engine in a runtime or storage adapter. This reviewer added a test file and this report, with no production edits or commit.

## Independent evidence

**44/44 accounting tests passed** in an independent final run, covering core admissions/replay, the independent whole-history oracle and indexed-state simulation, malformed/partial/unknown outcomes, JSON persistence boundaries, terminal-receipt consistency and this review's two new regressions. Full `npm run typecheck`, `git diff --check` and formatting of this review's files passed. The count overlaps the owners' focused runs and is not additive; the parent owns the repository-wide final suite.

Local receipts: `/private/tmp/buro-stage5a1-independent-new.log`, `/private/tmp/buro-stage5a1-independent-tests.log` and `/private/tmp/buro-stage5a1-independent-typecheck.log`. The first log records the reproduced malformed-identity failure before correction; the final combined log records all passing cases after correction. No model, network, SQLite database, existing user repository, credential, RTX host, external message, deployment or Git commit was used.

## Independent regressions added

`tests/stage5a1-review.test.ts` adds two passing cases:

1. Six permutations settle three already admitted generations in different orders after interleaved review/work generation and tool admissions. The observations include complete known usage, explicitly measured zeros and input-only partial usage. Every order produces exactly the same account: correct known-subset counters, one unknown-output request, two outstanding output tokens, and unchanged cumulative admitted work/review allowances. Settling most exposure cannot replenish the exhausted finite output/tool caps, and exact observation replays have zero account delta.
2. Oversized malformed provider values cannot inflate the accounting operation with a copied payload. The cases cover a roughly 1.3 MiB scalar string, that string in a token field, an oversized unknown field name, a 10,000-digit BigInt and a BigInt-valued token field. Each produces an applied observed poisoned receipt, retains unknown output exposure, stays JSON-safe and blocks new admission without copying the malformed body into the hot receipt. Full malformed evidence belongs in the future private response artifact, not this row.

## Finding resolved during review

The original observation identity deliberately omitted unsupported complex malformed payloads, but copied arbitrary malformed strings and field names and converted BigInts to strings. A bad provider usage value could therefore put megabytes into the nominally small incremental operation receipt. The new independent regression first reproduced that growth.

The owner bounded only the codec for malformed identity values/keys and leaves unsupported values without an exact replay identity. The observed poison/status remains returned; invalid evidence is not rolled back or converted to measured zero. Legitimate token usage still consists of at most two safe nonnegative integer fields and is unaffected. This is a representation bound for invalid protocol data, not a new execution quota, hash engine or requirement to build artifact storage in 5A1. Small supported malformed scalar observations retain their exact replay identity; unsupported opaque observations cannot be silently reconciled by an ordinary replay.

The architecture review also found that explicit optional `undefined` fields and negative zero needed JSON-stable normalization. Its final regression independently passed after the owner normalized those representations. The outcome reviewer found terminal receipt inconsistency: a stored status/usage could contradict its old identity. The final validator recomputes normal terminal identities and rejects contradictory saved receipts. These are structural/semantic consistency checks, not authentication of arbitrary caller-supplied accounting state.

## Finite policy and knowledge semantics

Every account requires an explicit finite policy. Zero request/output/tool caps and an all-review reserve are actual policies; missing policy is an error. This module introduces neither an implicit default nor an unlimited-policy sentinel.

Admission enforces cumulative request, reserved-output and tool totals. Work cannot consume the configured review reserve; review may use the remaining total allowance, including more than the reserved minimum. Both phase and total constraints apply regardless of operation order. A requested output allowance may shrink only down to its declared minimum. A denial does not mutate the input account, prior receipt or policy.

`outstandingOutputTokens` is separate exposure. Once output is actually reported, the corresponding reservation stops being outstanding even if input usage is missing. The cumulative admitted output remains charged against the finite policy; a short response does not refund that finite allowance. The independent permutation test and existing state/oracle tests preserve that distinction.

Measured zero is known usage. Missing usage, empty usage and input/output-only usage retain their different knowledge states. Known token totals represent only reported subsets; partial requests are a subset of unknown-usage requests, not another additive category. An ordinary later observation cannot turn a settled unknown outcome into known zero or new usage. Exact supported replays preserve counters and revision, while changed owner, admission identity, phase, requested allowance or observation conflicts.

Malformed or over-allowance usage produces an applied poisoned account and an observed operation receipt with an error, instead of throwing away an already observed response. Aggregate arithmetic overflow is represented by a null known total and poison, never a wrapped number or measured zero. Already admitted responses may still settle after poison; fresh admissions are denied. Returned historical admission allowances under replay are evidence of the old allowance, not permission to dispatch another provider/tool effect.

## Incremental boundary and future authority

Each transition accepts one current account, one specifically looked-up prior operation if present and one proposal/observation. There is no lifetime operation map in the account. Closed record validation rejects injected historical containers without reading them, and results detach caller-owned policy/proposal/receipt objects. The account holds fixed counters, not a history-sized summary that must be recomputed for each operation.

The test-only oracle deliberately enumerates its own independent history. The 1K, 10K and 17,409-operation tests use an in-memory indexed lookup simulation, recording one lookup and one stored operation per new admission; exact replays do not store a new operation. They establish the pure API's lack of a former count ceiling or history-map input. They do not prove a SQLite query plan, crash safety, transaction atomicity, database durability, throughput or constant elapsed time.

The future caller must load the immutable account policy and exact operation row, then commit the account/operation transition atomically under real row authority. It must persist an applied poisoned transition and the canonical observed response before raising its returned error outside that transaction. It also owns unique operation identity, provider/tool dispatch claims, durable outcome reconciliation and protection against arbitrary policy/account/receipt replacement. The pure engine does not cryptographically authenticate those inputs and does not claim to.

At `Number.MAX_SAFE_INTEGER` account revision, a previously dispatched response still settles into a retained poisoned account/operation while the revision cannot increase. A future database implementation must therefore condition its write on operation status/identity as well as account revision; an account-revision-only compare-and-swap is insufficient at saturation. Conversely, a new admission at revision exhaustion is denied before dispatch. These explicit edge semantics should be carried into the future transactional tests rather than hidden by a reset or response rollback.

## Quality, simplicity and remaining work

The pure engine is appropriately separate from runtime scheduling, provider adapters, persistence and UI. Its small counter/operation interface is reusable without introducing an all-purpose event log or a parallel dispatch authority. Keep the malformed-identity codec narrow: valid numeric protocol data needs no general recursive serialization, cryptographic ledger or arbitrary private response body in the accounting row.

No production runtime, adapter, plugin, daemon, protocol or UI import of the new engine was found in this review. Existing runtime budget behavior, default quotas, request/output limits, legacy persistence and any former storage ceilings remain unchanged until explicit adoption. This is not yet the user's future default-none budget behavior, a SQLite rollout or an end-to-end unlimited-run solution. No production SQL proof was required or inferred for this bounded foundation.

No blocking finding remained in the reviewed transition contract after the final checks.
