# Stage 5A1 independent architecture and boundary review

Date: 2026-11-22. Baseline `e145893`. Final review after the accounting source freeze and the JSON-semantic replay/terminal-receipt corrections. This replaces the preliminary decision.

## Decision

Bounded clear. No remaining blocking finding in the reviewed pure-accounting scope. The foundation separates cumulative finite admissions, observed usage and unresolved exposure without introducing dispatch or persistence authority. It is suitable to proceed to the separately reviewed journal/storage integration; it does not establish that integration by itself.

## Findings resolved

P2 — optional `undefined` usage fields were semantically unchanged after JSON serialization, but the original identity codec treated their omission as a different observation. Accepted negative zero was likewise distinguished from JSON's ordinary measured zero. The independent regression reproduced a denied replay after actual JSON stringify/parse of the account, operation and observation. The corrected codec omits optional undefined counters and normalizes negative zero, preserving exact replay without changing known usage or counters.

The final source also validates a well-formed terminal receipt's saved usage/status against its observation identity. A changed valid usage value or status cannot retain an old key and replay as the original fact. The dedicated negative test was independently rerun. This is record consistency checking, not a claim to authenticate all possible malicious historical data.

## Foundation and authority

`core/usage-accounting.ts` is a finite, explicit policy foundation. It is not wired into SQL, runtime dispatch or product defaults in this slice. A zero allowance is a real zero; a missing policy is invalid, not an unlimited sentinel. Work/review counters and protected review reserves retain cumulative admission semantics. Observed usage and outstanding output exposure are separate: known output releases exposure without refunding cumulative admissions, and unknown output retains its exposure.

Each transition consumes the current fixed-shape account and the particular operation receipt. It does not receive, enumerate or clone an operation history. The operation index and whole-history oracle exist only in tests. This demonstrates a bounded-history-input algorithm, not a measured SQL performance result or a complete durable single-use journal.

The functions return denied, applied or replayed transitions. Historical allowances returned on replay are not fresh dispatch permission. The future journal must atomically claim an operation once before an effect. No duplicate executor, provider routing, scope decision or acceptance owner has been introduced.

## Observation evidence and arithmetic

Known input and output totals have independent request counts. Complete usage, partial usage and unknown usage are distinguished; partial is a subset of unknown and cannot be added to it. Explicit measured zeros are known values, while absent usage, empty usage and unknown outcomes do not fabricate zero measurement. Unknown settlement is sticky and cannot be upgraded by ordinary replay.

Malformed provider usage and over-allowance output return an applied poison transition with an observed operation receipt. They do not throw away the response before the caller can persist it. The account stops new admissions while other already admitted responses may still settle. Unsafe aggregates become null with poison rather than wrapping or becoming measured zero. The first account violation remains recorded; each violating operation retains its own error.

The recursive malformed-observation identity traversal was removed. Exact replay is supported for the flat scalar protocol; complex malformed usage produces a JSON-safe poison receipt without attempting to retain or recursively serialize arbitrary provider objects. Invalid oversized strings/field names and BigInt similarly retain poison without an exact observation key, keeping raw malformed provider payloads out of the hot receipt. These bounds apply to invalid diagnostic identity, not legitimate numeric usage or execution allowance. Repeated unsupported malformed payloads fail closed rather than claiming exact replay. The independent accessor/cycle/symbol regression confirms no getter evaluation, no serialization exception, no exposure release and no mutation of the admitted state.

Account/proposal/receipt shapes reject extra historical containers before cloning. Returned account, receipt and grant values are detached from caller-owned values. This validates typed private records; it is not authentication of arbitrary forged historical records or isolation from hostile JavaScript proxies.

## Persistence requirements deliberately left to 5A2

Account and operation updates must be atomic, with an indexed exact operation lookup and a single-use dispatch claim. Applied poison must be committed before raising its returned outer error. Unknown effects and unknown usage require their existing explicit reconciliation ownership, not a retry triggered by a historical allowance.

At the maximum safe account revision, settlement intentionally preserves the response and poisons without incrementing the saturated revision. Persistence must therefore verify and settle the pending operation atomically; account revision alone cannot serve as its sole settlement CAS token. This is a documented integration requirement, not a claim that this pure function already provides durable concurrency control.

## Independent validation

Final focused accounting run: **44/44 passed**, including the independent JSON replay and accessor/cycle/symbol regressions, altered terminal receipt, deep/oversized malformed usage, out-of-order settlement, whole-history oracle, 17,409-operation boundary, saturated revision and numeric overflow cases. Before the replay correction an overlapping **40/40** run passed; the added JSON regression then reproduced the defect and passed after its correction. These are overlapping runs, not 84 distinct tests. Full typecheck, `git diff --check` and independent-file formatting passed. The parent's full legacy suite/build remain separate owner evidence.

Only the independent regression file and this report are reviewer edits. No production edits, actual providers, network model requests, RTX, credentials, original repositories or Git mutations were used. Runtime/default budget changes, SQL wiring and reusable package publishing are not claimed complete by this slice.
