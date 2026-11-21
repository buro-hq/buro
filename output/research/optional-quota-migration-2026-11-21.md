# Optional quotas and durable usage: selected new design

Date: 2026-11-21. Read-only implementation audit and design recommendation; no production behavior changed. The product is unreleased and the user explicitly permits a clean break: no old execution-format readers, legacy strategies, runtime-ledger import or old-run resume compatibility are required. The user requirement is **no default aggregate request, token, elapsed-time or session ceiling**. Explicit user limits remain supported. Permissions, acceptance, physical capacity and unknown-effect recovery are independent of that choice.

## Selected approach

Introduce clean **UsageAccounting + optional quota** contracts and one transactional SQLite project store. Keep Core/Cordis/runtime/provider/tool boundaries. Old execution data stays a non-executable read-only archive, rather than becoming a live compatibility obligation. Do not add a SQLite usage database beside an authoritative JSON run summary. Do not replace finite limits with enormous numbers or JSON `Infinity`.

SQLite alone is insufficient: new decisions use incremental summaries and the specific operation receipt, not every SQL operation row reconstructed into the current record. Active context and historical session artifacts are paged independently. This is a focused new storage/accounting design, not a new orchestration framework. Format versions on new records support future evolution; they do not imply an old-data restoration path.

## Why changing the default constant is insufficient

- [protocol/run-budget.ts:42](../../protocol/run-budget.ts) supplies64requests/131072reserved-output/256tools, with review capacity8/16384/32. Absence currently selects this finite policy in [core/run-budget.ts:190](../../core/run-budget.ts).
- [core/run-budget.ts:83](../../core/run-budget.ts) recounts the whole operation record; validation, transitions and summaries repeatedly traverse it. Its17408-entry guard at line130 is another stop after numeric ceilings are removed.
- [adapters/files/project-store.ts:151](../../adapters/files/project-store.ts) clones and persists the project document, including private ledger records, per transaction. [project-run-budgets.ts:25](../../adapters/files/project-run-budgets.ts) correctly commits private charges and public summary together. That atomicity must survive.
- Runtime turn/session counters, repair counters and archive/window ceilings are separate blockers. [Managed checkpoint schema:103](../../adapters/files/managed-sessions.ts) caps archive count15; current segment policy also has its own finite lifetime.
- [runtime-resources.ts:174](../../adapters/resources/runtime-resources.ts) currently mixes model limits and execution-policy revisions into runtime identity; [runtime-router.ts:61](../../core/runtime-router.ts) and [managed-runtime.ts:919](../../core/managed-runtime.ts) enforce that snapshot during restoration. The new contracts should separate provider/session identity from optional quota revisions. There is no requirement to reconstruct the old combined identity or make its checkpoints executable.

## Policy semantics

Use explicit override states, with a separate resolved snapshot:

```ts
type QuotaOverride =
  | { mode: 'inherit' }
  | { mode: 'none' }
  | { mode: 'bounded'; limits: ExplicitFiniteCaps };

type ResolvedUsagePolicy = {
  schemaVersion: 1;
  revision: string;
  quota: null | ExplicitFiniteCaps;
  origin: 'default' | 'machine' | 'project' | 'goal' | 'operator';
  enforcementCoverage: 'managed-admissions' | 'native-observed' | 'mixed';
};
```

For new configurations, missing override means inherit; the root default resolves to `none`. Explicit `none` clears inherited caps. A versioned policy-patch command must distinguish leave-unchanged, set-bounded, set-none and restore-inheritance. Resolve inheritance before starting the run and snapshot that result. Never use `value || finiteDefault`: zero must not mean unlimited, and `none` must not silently revive an inherited quota.

Finite caps are nonnegative safe integers with explicit dimensions and at least one configured ceiling. Scope must be visible: model admissions, output tokens, total tokens, or estimated spend are different quantities. A time limit should initially resolve into an absolute persisted expiry, including queue/pause/restart; another interpretation needs another explicit field. The UI should present “No limit” as a real state, not a large placeholder number. Existing full semantic CAS and idempotent commands remain applicable.

In `none` mode, admission still validates owner, scope, stable operation identity and provider/request correctness, then records the operation. It does not reject because a lifetime counter reached a product constant. Review allowance is withheld only inside a user-configured finite envelope. With no aggregate envelope, phase totals remain useful statistics without reserving an arbitrary number of requests away from implementation.

## Separate usage history from quota exposure

Current `maxReservedOutputTokens` sums requested output reservations permanently, even when observed output is much smaller. That is a conservative reservation ceiling, not actual token spend. Retain that historical metric, but do not label it as measured consumption.

For new runs, maintain separate counters for historical requested/admitted output, known observed usage and outstanding reservation exposure. A quota can charge **settled observed usage plus pending upper bounds**. Known completion releases unused pending allowance while preserving its receipt; unknown outcomes hold their reservation until reconciled. Releasing a reservation must not erase an operation or reduce lifetime observed counters. Per-request output-cap overrun or malformed accounting remains a typed provider/protocol-integrity problem, independent of whether aggregate quotas are enabled.

Exact input/token or money ceilings require an honest accounting capability. Codex's internal API calls are not equivalent to Buro runtime turns; some native usage arrives only after completion. A mixed run cannot advertise an exact whole-run request or currency cap if part of its client traffic is opaque. Reject unsupported hard-cap promises or offer a clearly scoped/estimated setting; retain unknown values rather than zero. Provider-price estimates are not billing receipts.

## Storage choice and atomicity

| Option | Assessment |
| --- | --- |
| Remove count guards from existing JSON records | Small edit, but whole-record validation/rewrites and archive growth remain; not the selected long-run solution |
| Independent JSONL usage log plus JSON public summary | Creates a two-commit consistency problem; making it safe requires an authoritative WAL/replay/compaction design |
| Paged JSON immutable archives plus atomic manifest | Suitable for large private context artifacts, provided references are committed only after durable writes; not by itself an atomic replacement for usage/run/event transactions |
| One SQLite project state/operation authority | Selected for new admission: operation receipt, incremental counters, run projection, policy revision, event sequence and command receipt can share one transaction |

The new store needs a narrow transactional accounting operation instead of exposing an ever-growing private `operations` map in every `ProjectDocument` draft. Core receives the resolved policy, current summary, proposed operation and prior receipt; it returns a pure grant/deny/counter delta. The adapter commits that decision and the owning run/event/receipt atomically before dispatch. Usage completion is another idempotent transaction keyed by the original operation ID. Duplicate identical operations return the original result; conflicts fail. Do not reconstruct every receipt on the hot path.

Large session messages, tool outputs and archived contexts remain private immutable artifacts with paged references and checksums. Store the active context/index and archive manifest transactionally. An artifact written before a failed manifest commit is an orphan for later garbage collection; it grants no authority. A committed reference to a missing or corrupt artifact blocks recovery. Pagination limits page size, not total permissible lifetime history.

Keep one writer/transaction owner and publish events after commit. Do not introduce a second authoritative scheduler or split public usage and private receipts across unrelated transactions. Existing core and provider interfaces remain the architectural boundary even where their internal storage transaction shape evolves.

## Clean rollout and archival

1. Define one new configuration/execution/accounting format, explicit override commands and pure admission rules. Root defaults resolve to `none`; project/goal `inherit`, `none` and `bounded` remain intentional new settings. Remove mandatory turn/session/repair/window lifetime cutoffs throughout the new runtime, UI, CLI and checkpoint schema; do not recreate24/256/64 through defaults elsewhere.
2. Implement the transactional store and paged session/artifact interfaces for new runs. Start with fresh run, session, operation and event identities. Public run projections, private effects, quota revisions and idempotency receipts have one authority. New effects are persisted before dispatch, and crash recovery uses only the new format.
3. Preserve old run files and previously saved results as a read-only, non-executable archive. The new engine does not restore their sessions, import their runtime ledgers, infer missing historical usage or replay their operations. Archive access can use opaque original files or existing static reports; no active old-format reader or compatibility resolver is part of this design. No deletion or destructive cleanup is authorized.
4. If useful, provide a separate explicit import for project definitions, goal intent and material data only. Validate them into new records and show the selected settings before import. Do not silently carry old hidden limits, old acceptance, check evidence, runtime IDs or operation receipts into fresh runs. Material bytes can be relinked or copied with normal path/hash/privacy validation; credentials are not part of this import. Source repositories remain untouched.
5. Activate the clean engine only for new runs. There is no automatic continuation of an old run. Users can start a new attempt from deliberately selected goal/source data; that is a new execution with fresh observations, not a resumed old session. The previous archive remains available without granting execution authority.
6. Allow an explicit operator command to change the quota of a **new-format** running goal using CAS and an auditable policy revision. Preserve every existing receipt and counter in that run; do not rewrite earlier policy history. Recompute allowance from known usage and outstanding exposure. A known-before-dispatch quota pause may continue after the change, while an unknown effect still needs reconciliation.

For new sessions, keep endpoint/provider/model/data-policy identity and private continuation integrity separate from quota policy. Changing a quota does not grant another endpoint, model or write scope. A provider/model change, where permitted, requires an explicit new assignment/session decision. Request cancellation and unknown-action guards remain mandatory even without aggregate ceilings.

The clean SQLite engine and removal of hidden lifetime cutoffs should be reviewed as separate implementation stages before claiming support for unrestricted-duration goals. Neither old execution compatibility nor a large task DAG needs to delay that work.

## Required verification gates

- No-quota runs cross the former64/256request and17408operation boundaries without a quota stop; archives cross4/15 with paged retrieval and retained provenance.
- Finite explicit caps reject before dispatch, include all roles and honor review allocation only when configured. Exercise inherited finite → explicit-none and none → finite transitions over both transports and CLI/UI defaults.
- Known usage releases only unused pending exposure; unknown/cancelled usage stays recorded. Duplicate reservation/completion is idempotent; conflicting payloads and malformed usage fail without new effects.
- Inject crashes before and after reservation, state/event/receipt commit, publication and usage observation. Reopen must show one authoritative result and no duplicate tool dispatch.
- Old execution data never enters the new recovery/dispatch path. Archive access and optional project/goal/material import cannot create an automatic session resume or replay a historical effect.
- Storage tests cover interrupted new-store activation, orphan artifacts, missing pages, writer contention and large-history performance. Optional definition/material import is explicit and non-destructive; no credentials or raw private continuation enter public receipts or archives outside protected storage.
- Test unknown native accounting and mixed coverage so “unlimited” never fabricates zero cost, while optional hard-cap UI never claims unsupported end-to-end guarantees.

This is a proposed clean design, not an implementation or a test result. Existing production defaults and files have not been changed. Models, RTX, credentials and original user projects were not accessed.
