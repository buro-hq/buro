# 5A2 independent SQLite atomicity and process checks

Parent: `5534809`. Scope: the new standalone project-usage transaction kernel and its real SQLite adapter. Existing JSON/runtime/machine configuration remain unchanged; this is not production adoption or an additional live accounting authority.

`node --test tests/sqlite-usage-atomicity.test.ts`: **11/11 passed**, no skips. Log: `/private/tmp/buro-stage5a2-atomicity-tests.log`. Scoped Prettier and `git diff --check` passed.

The tests use real temporary SQLite databases, connections and child processes. They cover rollback after account/operation/event writes, no observer publication before commit, exact command/fingerprint replay across reopen, rejected async/thenable callbacks, and retained transaction capabilities closing after success or rollback. Malformed observed usage commits a poisoned account and observed receipt before an outer caller error. Public paged events exclude private account/operation/command identities, fingerprints, malformed input and observation keys.

Two actual processes compete with matching command fingerprints: exactly one callback executes, both callers receive the same saved result, and only one operation, charge and event persist. With conflicting fingerprints, only one callback executes and the other process is rejected. These are accounting transaction claims, not HTTP/model/tool dispatch claims.

The crash fixture pauses after writes inside the synchronous callback or after the awaited transaction commits. The parent terminates that child with `SIGKILL`, reopens the database and verifies complete rollback or complete persistence respectively. Retrying the command results in exactly one total admission and public event in both cases. All spawned children are awaited or terminated by cleanup.

A guarded fault fixture changes only `account_json.revision` in an explicitly marked temporary test database. At `Number.MAX_SAFE_INTEGER`, separate operations still retain unknown and observed statuses across reopen; accounting poison and the unknown reservation remain. Ordinary observation cannot silently reconcile the unknown operation. Production exposes no raw SQL mutation API, and this test does not claim authentication against arbitrary database modification.

Event pagination retains its original watermark while later writes remain available through a fresh page. Conflicting frozen policies, duplicate account ownership and changed result-preparation owner bindings do not rewrite accepted state.

The scaling case creates **1,000, 10,000 and 17,409 actual SQL operation rows** through the semantic API, in batches. At each size, a point account read, point operation read and exact operation replay produce identical query-observation traces, with at most one returned/changed row per statement. Adapter source uses the unique owner key and composite operation primary key. This is bounded returned-row/indexed-query evidence, not a throughput benchmark or a measurement of SQLite internal page visits.

No models, network endpoints, RTX machine, credentials or original user repositories were used. The kernel does not yet bind owners to actual Run/research/preparation entity rows, capture canonical model payloads, manage dispatch leases or replace file-backed sessions/routes. Those remain required adoption work.
