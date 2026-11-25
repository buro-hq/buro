# Stage 5A1: smallest project authority contracts

Date: 2026-11-22. **Proposal only**, read against committed 4C3a plus the in-flight 4C3b empty-resource cutover. No production changes, model calls, credentials, user databases or repositories were used. The stage 5 transactional plan and optional-quota design remain the decisions; this document makes their first implementation slice concrete. Finite policies remain active throughout 5A. Default-none and removal of hidden lifetime limits belong to 5C after paged storage proves safe.

## Actual seams to replace

There are 21 direct `.transact` call sites across the five Core services and two file adapters listed below. They are not 21 different abstractions: the execution/result/research update helpers account for many runtime mutations behind a few call sites. Current `ProjectDocument` owns growing goals/runs/roles/events/receipts/budget maps; `Run` itself embeds events, commands, attempts, agents and delivery history. Saving these in one SQL JSON column would not solve growing reads/writes.

`ManagedSessionStore.save` is a second authority today. `generateManagedBatch` performs budget reserve, private generation intent save, provider call, private normalized response save, usage settlement, whole-batch tool reserve, then all action-intent save. These commits are separate even though their order is intentionally safe. `RuntimeRouteStore` is a third private file authority. The replacement must integrate them, not add a SQL accounting sidecar.

Current ownership has two concrete gaps: `managedBudgetOwner` deliberately returns no owner for research and some environment work; result preparation uses `ownerRunId` of the accepted coding run and therefore shares its ledger. New preparation/research owners must retain their own unresolved operations. They must not put an implementation reconciliation marker on an already accepted Run.

## One authority; transaction-bound views

Proposed module split: `core/project-state.ts`, `core/execution-journal.ts`, `core/usage-accounting.ts`. These contain plain TypeScript contracts and pure rules. Only `adapters/sqlite/` imports `node:sqlite`. The project factory returns one authority; state, journal, usage, route and session repositories are views over its transaction, never independently committing stores.

```ts
type Revision = number;
type Command = { id: string; fingerprint: string };
type Versioned<T> = { revision: Revision; value: T };
type Page<T> = { items: T[]; next?: string; watermark: number };

type ProjectOwner =
  | { kind: 'run'; runId: string }
  | { kind: 'research'; researchId: string }
  | { kind: 'result-preparation'; preparationId: string; runId: string; operationId: string }
  | { kind: 'environment-verification'; verificationId: string }
  | { kind: 'result-application'; applicationId: string; runId: string };

type OwnedOperation = { projectId: string; owner: ProjectOwner };

interface ProjectAuthority {
  readonly projectId: string;
  readonly state: ProjectState;
  readonly journal: ExecutionJournal;
  transact<T>(command: Command, apply: (tx: ProjectTransaction) => T): Promise<T>;
  subscribe(after: number, listener: (event: DomainEvent) => void): () => void;
  close(): Promise<void>;
}
```

Every owner names an existing row in this project, validated inside the transaction. Result preparation IDs identify **one attempt**, not a reusable `result-${runId}` label; `operationId` is the service-authored context such as `result.preview` or `result.deploy.staging`. Coding work, planning and review share the Run owner but retain their operation/role/grant identities. Result application remains its existing separate Git-apply intent, not another coding attempt. Environment verification without a Run gets a real verification owner. Global diagnostic probes use a separate `MachineOwner = {kind:'diagnostic'; probeId:string}` in the machine authority; they cannot pass a project path or invented Run ID.

`transact` starts `BEGIN IMMEDIATE`, checks the command receipt first, invokes a **synchronous** callback only if new, validates touched transitions and writes its result receipt plus all deltas/events atomically. Same ID+fingerprint returns the original detached result without invoking the callback or publishing another event. Another fingerprint conflicts. A callback returning a Promise is rejected with rollback; callbacks cannot await models, Git, files, credentials or plugins. Revision conflicts are detected against loaded entities in this transaction. SQLite serialization does not replace the service dispatch lease.

### Narrow state surface

`ProjectState` offers detached `project()`, `profile()`, `goal(id)`, `run(id)`, `role(id,version?)`, `research(id)`, `preparation(id)` and paged lists. Specific index queries replace admission scans: `activeRun()`, `unresolvedRunForGoal(goalId)`, `busyResultForGoal(goalId)`, `activeResearch()`, `activeMaterials(scope)`, `materialByContent(hash,scope)`, `activeApplication()`. All equivalent methods exist on `tx.state` and see that transaction's snapshot. A scope-limited query, not a callback over all records, expresses each admission invariant.

The minimum write methods are:

```ts
interface ProjectStateWrites {
  createGoal(goal: Goal): void;
  updateGoal(id: string, expected: Revision, patch: GoalEdit): void;
  deleteGoal(id: string, expected: Revision): void;
  appendRole(role: Role, expectedPreviousVersion: number): void;
  saveProfile(expected: Revision, profile: ProjectProfile): void;
  setExecutionHead(expected: string | undefined, head: string): void;
  createRun(run: RunAdmission): void;
  updateRun(id: string, expected: Revision, patch: RunStatePatch): void;
  captureRunGrant(id: string, expected: Revision, grant: RunGrant): void;
  createResearch(research: ResearchAdmission): void;
  updateResearch(id: string, expected: Revision, patch: ResearchStatePatch): void;
  createPreparation(preparation: PreparationAdmission): void;
  updatePreparation(id: string, expected: Revision, patch: PreparationStatePatch): void;
  saveVerification(verification: ProjectVerification): void;
  attachMaterial(prepared: PreparedMaterial): ContextMaterial;
  removeMaterial(id: string, expected: Revision): void;
}
interface ProjectTransaction {
  readonly state: ProjectStateQueries & ProjectStateWrites;
  readonly journal: JournalTransaction;
  readonly usage: UsageTransaction;
  appendEvent(change: DomainEvent['change']): void;
}
```

Patch types enumerate mutable current fields. They are **not** `Partial<Run>` or a generic JSON patch. `RunAdmission` captures original goal/profile/resource/workflow/check/material authority. `captureRunGrant` appends an explicitly validated planning/assignment/operation grant; it cannot overwrite accepted identities. A current run record excludes event/command/attempt/delivery-history arrays and private transcripts. Per-agent assignment/current status rows, attempt rows, timeline entries and command receipts have indexed append/settle methods on the journal. Frozen Role versions are append-only; `appendRole` preserves the existing user/workflow/coordinator provenance validator. Retained run/research role references are foreign keys to immutable versions, not copies a general patch can rewrite.

A DTO projection can assemble existing public Run shape while consumers migrate, but it is read-only, explicitly bounded and never passed to admission or session grant validators. It must not silently omit an unresolved older run. 5B introduces the public pagination/API changes; 5A1 should already name histories separately so an interim projection cannot become a storage API.

Material byte preparation remains outside the transaction. `attachMaterial` deduplicates/reactivates against committed metadata inside it and returns the **actual committed record**, fixing stale pre-read import/remove races. Captured grants retain immutable content references after removal. External immutable content files grant no read authority without committed metadata/reference rows.

## Journal: one effect boundary, one owner

`ExecutionJournal` exposes detached recovery queries `session(id)`, `route(id)`, `effect(id)`, `unsettled(owner/session)` and paged private history. Mutation methods exist only on `tx.journal`, so they can never independently commit behind state or usage. Minimal semantic commands:

```ts
interface JournalTransaction {
  createSession(header: SessionAdmission): void;
  appendScopeRevision(input: ScopeRevisionAdmission): void;
  admitTurn(input: TurnAdmission): void;
  admitGeneration(input: GenerationAdmission): GenerationPermit;
  observeGeneration(input: GenerationObservation): void;
  admitToolBatch(input: ToolBatchAdmission): ActionPermit[];
  claimEffect(input: EffectClaim): DispatchPermit;
  settleEffect(input: EffectSettlement): void;
  createRoute(input: RouteAdmission): void;
  bindRoute(input: RouteObservation): void;
  appendContext(input: ContextAppend): void;
  rotateContext(input: ContextRotation): void;
}
```

These semantic methods validate immutable/touched relationships; they do not run a provider or tool. `admitGeneration` calls pure accounting against `tx.usage`, records a private full request artifact, immutable session/turn/scope/grant references and the reservation in the **same transaction**. No quota admission can succeed without its generation intent. The returned permit is an opaque authority/owner/effect ID plus maximum output, not caller-selected SQL/database paths or a mutable scope.

`claimEffect` commits dispatch nonce+service lease identity before the external call. Same command replay can return the old permit but cannot authorize another caller: dispatch checks its own fresh nonce matches the committed one. Host failure after claim and before a terminal observation leaves an unresolved operation; an expired heartbeat alone never authorizes replay. A prepared intent with no dispatch claim can be settled known-not-dispatched only with evidence that no dispatcher obtained a claim. Unknown is never cleared by taking over a writer lock.

`observeGeneration` commits the full normalized terminal response, reported model/finish, continuation reference and usage observation atomically. Semantic failure (`length`, malformed tool batch, invalid usage) cannot erase that canonical observed payload. An invalid usage counter produces a durable accounting violation and a known observed protocol failure; it is not an unknown provider dispatch. A lost response stays unknown with outstanding exposure. Known preflight/rejected transport failures preserve their explicit outcome without fabricating zero usage for an opaque backend.

`admitToolBatch` validates the **whole** original batch against saved tool policy/revision, advertised definitions, duplicate lifetime call IDs, scope and quota; it atomically stores all original calls and reserves all tool admissions. SDK receives a detached response/actions only after this commit. Dispatch uses action IDs only; no SDK-provided arguments can replace canonical calls. Existing active-batch order/concurrency gates remain in the host. One completed action cannot hide an older foreign pending generation/action.

Each bounded helper command gets a child effect row (`parentEffectId`, invocation index, immutable command/check definition revision, workspace/view reference). A contributed handler that runs two processes therefore has two durable command outcomes; the aggregate tool receipt is not their replacement. A write followed by handler/output failure remains unknown, including DomainError. Read-only/strict effect controls continue to use declared tool mechanics, not names. SQL grants do not replace filesystem protection or immutable-view enforcement.

A native route/session is an equal adapter: start/turn/cancel/release use the same owner and effect claims. Its opaque internal model calls do not become measured API requests. Route resource/config/capability revision, read-only grant, purpose/operation/role decision, original role/pool grant, external session binding and immutable verification identity remain frozen. Old research sessions retain their original grant even after current research changes. Cleanup uses the acquired original adapter lease after registry revocation; choosing the current adapter by ID during cleanup is unsafe.

`SessionAdmission` stores immutable runtime/provider/model/tool identities, owner, initial scope, resolved finite limits and original task authority. Current header and active context are separate from messages/actions/checks/archives; no `load/save(ManagedSession)` contract remains in the new engine. Scope/turn authorities, worker-check receipts and segment rotations retain their existing invariants. Rotation seals the previous complete context and advances its manifest in one transaction without resetting usage, original task, scope or check authority.

## Incremental finite accounting first

`UsageAccounting` is a pure decision module, not another asynchronous budget adapter. Inputs are one current account summary, one resolved finite policy snapshot and the specific existing operation receipt. No function accepts `operations: Record<...>` or enumerates historical rows.

```ts
type UsageDecision<T> =
  | { kind: 'granted'; grant: T; delta: UsageDelta; operation: UsageOperation }
  | { kind: 'replayed'; grant: T }
  | { kind: 'denied'; code: string; message: string };

admitGeneration(account, policy, priorOperation, proposal): UsageDecision<GenerationAllowance>;
admitTools(account, policy, priorOperation, proposal): UsageDecision<ToolAllowance>;
observeUsage(account, priorOperation, observation): UsageSettlement;
```

`tx.usage.account(owner)`/`operation(owner,id)` perform indexed reads. Only journal semantic commands apply the returned counter delta and inserted/settled receipt; public projections derive from this same summary. Owner policy identity is frozen at admission. The adapter verifies expected account revision and nonnegative safe-integer deltas. Identical replay is zero-delta; different proposal/observation conflicts. Policy violations must commit their observed receipt/poison before a typed error is returned outside the transaction; throwing inside the callback would roll back the evidence.

Track separate counters now: admitted requests/tools/output allowance, known observed input/output and unknown-usage count, outstanding exposure. For **5A** keep existing finite quota enforcement basis (cumulative admitted output allowance, current work/review reserve) unchanged; do not silently release lifetime finite allowance merely because exposure becomes measurable. 5C switches to the explicitly designed optional quota semantics. New research/preparation accounts require a visible service-resolved finite policy; they must not bypass policy or fabricate a legacy Run. Decide the finite operational review-reserve policy explicitly during implementation rather than inventing it through an owner alias.

Native coverage is recorded as unknown/opaque, not zero. Managed reported usage may still be partial; provider `finish` is not goal acceptance. No exact whole-run API-request or money guarantee is claimed for mixed opaque clients. Future quota editing changes only policy revision/CAS, never endpoint, tool revision, owner, scope or pending effect identity.

## All current transaction call sites and migration owners

| Current sites | New narrow reads/writes | Suggested code owner |
| --- | --- | --- |
| `core/services.ts` 4: goal create/update/delete, role save | Parent run/material refs, busy result query, goal CAS, append role, public event/receipt | Application state agent |
| `core/execution.ts` 4: start/resume/update/cancel | Active/unresolved indexed queries, run+goal admission, captured grants/materials/roles/workflow, finite account create, per-agent/attempt/timeline deltas, cancel marker | Root execution integration |
| `core/project-application.ts` 6: initial head, profile save, verification save, apply prepare/settle/dispatch | Head/profile CAS, research reference, verification owner, original apply identity and dispatch nonce, applied projection | Application state agent |
| `core/project-research.ts` 2: admission/update | Source/profile CAS, active work query, immutable analysis/resources/materials/role grant, research owner, journal/effects, status/history | Research/result operation agent |
| `core/results.ts` 2: update helper, delivery command receipt | Completed result identity, operation-bound context/role/resources, preparation attempt owner, preview/delivery projection and command receipt | Research/result operation agent |
| `adapters/files/context-materials.ts` 2: import/remove | Transactional content dedup/reactivation, material metadata/reference, event and receipt | Materials/storage agent |
| `adapters/files/project-run-budgets.ts` 1 generic mutate | Replaced by transaction-bound incremental accounting called by journal; no whole-ledger fallback or random command receipt per usage write | Journal/accounting agent |

The private migration additionally touches `core/{managed-host-effects,managed-session-authority,managed-runtime,managed-loop-host,managed-coding-context,managed-worker-checks,runtime-router}.ts`, application ports/factory/composition, `FileManagedSessions`, `FileRuntimeRoutes`, public query projection and SQLite tests. These are not completed by changing the 21 callers alone.

Machine configuration is a separate later 5A slice: resources/link-project config revisions and receipts use one machine SQLite authority, no cross-project transaction/cap. `project.json` becomes an export/import proposal; it cannot silently win authoritative state at open. No production legacy aliases/readers or JSON dual-write. Prior state remains a read-only archive, not an executable recovery input.

## First implementation sequence and tests

1. Commit contracts plus pure incremental accounting over finite policies. Tests: exact replay/conflict, work/review reserve, malformed/overrun observed usage persists a poison result, unknown vs missing usage, no history enumeration, owner mismatch.
2. Implement project SQLite transaction primitives with no service wiring: receipt/CAS/event sequence/foreign-key owners/touched validators, two-connection contention and rollback/reopen. An injected callback Promise must roll back. Prove failed transaction publishes no event and command replay publishes none.
3. Migrate application state callers on a fresh project authority; indexed admission tests must include older unresolved runs outside the UI page, concurrent material import/remove and user role-version races. Do not run a live JSON project plus SQL journal.
4. Move actual managed and native effect boundaries, routes, session/artifact/history and accounts together. Kill/reopen at reservation+intent commit, dispatch claim, observed response+usage commit, whole-batch admission and each child command receipt. After a durable response and later settlement error, no second HTTP request occurs. Pending/unknown writes/start/processes remain blocked.
5. Wire research/result/environment owners and preparation attempts; fail/reopen after runtime start and after model completion. Accepted coding Run remains accepted while preparation is unknown. Original role/material/resource and cleanup leases survive catalog changes.

Unresolved implementation decisions to settle before code: exact bounded `RunCurrent`/agent/history DTO split; stored finite policy for newly accounted research/preparation; service lease takeover evidence; maximum transaction payload/latency for large private responses and artifact chunks. None justifies a default unlimited switch or generic DAG/framework in 5A1.
