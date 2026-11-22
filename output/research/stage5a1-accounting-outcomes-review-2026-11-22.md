# 5A1 independent usage-outcome checks

Parent: `e145893`. Scope: new pure accounting foundation only. No production runtime, existing budget/default, storage adapter, UI, model endpoint or original repository was changed by this test work. SQLite persistence and actual effect-boundary wiring remain later steps.

`node --test tests/usage-accounting-outcomes.test.ts`: **23/23 passed**, no skips. Server TypeScript, scoped Prettier and `git diff --check` also passed. Log: `/private/tmp/buro-stage5a1-accounting-outcomes.log`.

The scenarios distinguish missing/opaque/partial usage from explicitly reported zero, preserve unknown reservations, release settled output exposure without refunding cumulative finite allowance, and reject ordinary unknown-to-observed reconciliation. Exact replay is zero-delta; changed observations, foreign owners/operation IDs and tool receipts cannot settle a generation. Caller-owned inputs and accepted receipts survive denial and mutation of detached replay output.

Nine malformed usage forms produce an applied poisoned account and an observed receipt instead of throwing away the provider observation. Their private identity survives JSON persistence without NaN/null/Infinity aliases. Over-grant output retains measured usage, and other already admitted responses can still settle after poison. Input-total overflow and exhausted revision representability retain the observed receipt with explicit accounting failure. A 20,000-level malformed value cannot cause recursive identity encoding to throw before poison; unsupported complex values are not copied into accounting records.

These tests prove returned transition semantics, not database durability or dispatch idempotency. The future journal transaction must commit an applied poison result and canonical response before raising its error outside the transaction. Complete private response artifacts are not an accounting receipt's payload.

Review found that a saved terminal observation identity could contradict its stored usage/status. The parent fixed validation, and a regression now rejects changed output, removed input and changed status under the original identity. This is local consistency checking, not authentication of arbitrary caller-supplied account state. Future SQL transactions must still preserve immutable receipts, including malformed/complex observations whose original raw payload is deliberately absent from the accounting record.
