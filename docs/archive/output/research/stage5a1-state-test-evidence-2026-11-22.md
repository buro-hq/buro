# Stage 5A1 incremental accounting state tests

Implementation-verification evidence, 2026-11-22. Files: `tests/usage-accounting-state.test.ts` and the independent test-only `tests/fixtures/usage-reference.ts`. Core implementation belongs to the accounting agent; this work changes no old runtime, storage adapter, quota default or user state.

Focused command: `node --test tests/usage-accounting-state.test.ts`.

Result: **13 passed, 0 failed, 0 skipped**. Local log: `/private/tmp/buro-stage5a1-state-tests.log`. Formatter and diff checks passed. This receipt describes focused tests only, not the final full-suite/review result.

The cases cover explicit finite policies, caller immutability/detached results, protected work/review request and tool admissions, output allowance reduction down to the requested minimum, identical replay with unchanged revision/counters, conflicting admission/observation receipts and account ownership.

Known settlement releases unused outstanding output exposure while preserving cumulative admitted output and the existing finite enforcement basis. Measured zero, input-only/output-only partial usage, absent usage and unknown outcomes have distinct knowledge counters. A settled unknown observation cannot silently become known zero. Revision/known-token overflow is rejected or yields retained poison evidence rather than a reset counter or unsafe integer.

An independent whole-history oracle recomputes totals through 200 interleaved work/review generation/tool admissions, pending/known/partial/unknown settlements and exact replays. This deliberately slow test-only oracle is separate from the implementation's incremental update logic.

The 1K, 10K and 17,409-operation cases pass only one current account, one prior receipt and one proposal to each function. A simulated indexed receipt repository records one lookup and one stored receipt per new admission; replays add lookups and no stores. Current account serialization stays below 2 KB. The explicit finite caps permit the former 17,408-entry boundary to be crossed. No lifetime history container is accepted as an account field: an accidental `history` getter is rejected without reading it.

These are pure state/contract checks with an in-memory test index. They do **not** prove SQLite query plans, transaction atomicity, durability, runtime throughput or constant elapsed time; those require the real authority implementation and crash/scale tests in 5A2 onward. No model, network endpoint, credential, RTX machine or original user repository was accessed.
