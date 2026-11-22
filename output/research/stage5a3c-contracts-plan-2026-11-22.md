# Stage 5A3c: project settings and verification contracts

Date: 2026-11-22. **Read-only proposal, not implementation.** Reviewed actual `ProjectApplication`, `FileProjectStore`, `FileProjectRepository`, registry and the SQLite kernel while 5A3b final gates run. No production sources, user stores, source repositories, models or endpoints were changed.

## Concrete problems in the current path

- `FileProjectStore.open` checks the supplied project ID, then unconditionally assigns `doc.project = options.project`. The saved root/managed/data-directory/name can therefore be replaced by reopening options. It also adopts `options.profile` whenever its revision is equal to or newer than saved state. Since repository load supplies `project.json`, an edited export can replace authoritative settings with no command/CAS/event/receipt.
- `ProjectStoreRegistry.add/list` call `store.snapshot()` just to read `project`. Every list request consequently clones all public goals, runs, material records and research along with the five metadata fields.
- `ProjectApplication.open/info/configure/applyResearch/verify/verification` use whole snapshots and document transactions. Configuration checks input, current research and Git HEAD before reaching the command receipt. A retry of an already committed command can fail on newer research/HEAD before returning its original result.
- Configuration export is external I/O after commit. Retry must return the original receipt but export the **current** authoritative profile, never the older receipt profile. A failed export is not a failed database save.
- Verification already returns a saved result without repeating checks when its receipt exists. Its actual process work is not yet durably journaled before execution. This slice must preserve completed-result replay without claiming crash-safe dispatch for checks; execution-journal ownership is a later slice.

## Small required facet

Add `core/project-settings.ts`, a required `ProjectStore.settings: ProjectSettings`, a required detached `readonly ProjectStore.project: Project` identity getter, and the shared synchronous semantic facade used by both adapters. No full ProjectState interface, no whole Run, no public whole research/history or runtime/session API is needed.

```ts
type SettingsCommand = { id: string; fingerprint: string };
type SettingsReceipt = { result: unknown };
type ResearchProposal = Pick<ProjectResearch,
  'id' | 'status' | 'analysis' | 'sourceHead' | 'profileRevision' |
  'context' | 'components' | 'checks' |
  'reviewedProfileRevision' | 'appliedProfileRevision'>;
type ResearchAcknowledgement = {
  id: string;
  reviewedProfileRevision: number;
  appliedProfileRevision?: number;
};

interface ProjectSettings {
  readonly projectId: string;
  profile(): Promise<ProjectProfile | undefined>;
  verification(): Promise<ProjectVerification | undefined>;
  researchProposal(): Promise<ResearchProposal | undefined>;
  hasActiveRun(): Promise<boolean>;
  receipt(command: SettingsCommand): Promise<SettingsReceipt | undefined>;
  transaction<T>(command: SettingsCommand,
    apply: (tx: SettingsTransaction) => T): Promise<T>;
}
interface SettingsTransaction {
  profile(): ProjectProfile | undefined;
  verification(): ProjectVerification | undefined;
  researchProposal(): ResearchProposal | undefined;
  hasActiveRun(): boolean;
  configure(input: {
    expectedRevision: number;
    profile: ProjectProfile;
    expectedResearch?: ResearchProposal;
  }): ProjectProfile;
  saveVerification(verification: ProjectVerification): ProjectVerification;
}
```

`ProjectStore.project` is deliberately synchronous, detached and constant-size: metadata is immutable in this slice, captured from validated authoritative metadata at open. Registry add/list use it, so listing never reads growing history. A future rename/relocation requires an explicit metadata command and refreshed metadata cache; reopening options are not that command. The async reads and synchronous transaction reads otherwise query only the current named record/index.

`ResearchProposal` is a bounded profile proposal projection, not `Pick` followed by cloning a full research object. Adapters must select/copy only its listed fields. It contains no events, prompts, resource pools, role grants, materials, session handles or intermediate model output. Its `analysis` is provenance, not execution permission. Refactor `profileWithResearch` to accept only the suggestion fields it actually consumes, rather than a whole `ProjectResearch` argument.

The facade owns schema validation, touched-field transitions and actual `project.configured` / `project.verified` events. `configure` checks the same transaction's `hasActiveRun`, then expected current profile revision, then any captured ready research proposal. Revision advances once; new profile must not replace project identity. The existing finite profile limits stay unchanged.

For an explicit research application, compare the captured ready proposal identity/content (excluding mutable acknowledgement fields) to the transaction's bounded current proposal. The comparison includes ID, ready status, source HEAD, original profile revision, analysis identity and the actual proposed context/components/checks. This avoids a new adapter-specific opaque hash/token and catches proposal replacement or mutation while Git HEAD is being awaited. `ProjectApplication` still reads/verifies repository HEAD outside the transaction. Git/SQL are not one atomic snapshot; do not claim otherwise.

A plain manual save acknowledges the current ready proposal seen **inside** the transaction. Research application additionally records `appliedProfileRevision`. Preserve the existing important behavior: after manual edits, the user can accept research against the **current form's** expected revision. Do not require that current profile revision equal the research's original `profileRevision`; that would break the approved manual-review flow.

`saveVerification` records the result with its actual captured `profileRevision`. A result produced on an older profile is not proof for the current profile; keep this explicit in projection/UI. Preserve current result replay semantics, rather than silently relabeling the result with the newest revision. Whether to reject a stale completion versus retain it as stale history can be decided explicitly; the minimum behavior-preserving implementation retains the captured revision and never marks current settings verified by it.

## Narrow storage port

```ts
interface SettingsTransactionStorage {
  profile(): ProjectProfile | undefined;
  verification(): ProjectVerification | undefined;
  researchProposal(): ResearchProposal | undefined;
  hasActiveRun(): boolean;
  replaceProfile(previous: ProjectProfile, next: ProjectProfile): void;
  acknowledgeResearch(expected: ResearchProposal,
    next: ResearchAcknowledgement): void;
  saveVerification(verification: ProjectVerification): void;
  appendChange(change: ProjectSettingsChange): void;
}
```

No raw put-profile, replace-research, document access, SQL callback or archive scan is exposed to application callbacks. Storage guards are sticky on failure so a callback cannot catch a partial SQL write and commit an inconsistent profile/ack/event. File bridge performs the same changes through the existing sole document commit queue; it is not a second writer. Shared command receipts and the existing single event sequence cover configuration, entities, materials and usage in SQLite.

Reuse/extract public `ProjectSchema` and `ProjectVerificationSchema` from current protocol schema instead of rebuilding validators. Keep known project/profile/verification optionals canonical and JSON-safe; do not silently coerce arbitrary callback results. A verification payload is a current result entity, not a Run/session history JSON column. Full process outputs/artifacts and verification dispatch journaling remain outside this slice.

## Research acknowledgement event without copying history

Current `project.configured` embeds `research?: ProjectResearch`. Replace that field with `researchAcknowledgement?: ResearchAcknowledgement`; profile and execution-policy fields remain. Socket/replay clients merge the acknowledgement only when its ID matches their current research record. A later research must never receive an older proposal's acknowledgement. Existing `project.research.changed` remains the separate research service projection until its own journal migration.

The File bridge may update only the two acknowledgement fields on its document research, while SQL stores a separate bounded proposal/ack row. No configure event or settings method should read/export the research event list just to change these fields. This requires small coherent changes in domain/schema, client merge and serialization tests; it is an actual consumer, not a generic event framework.

## Open, bootstrap and authoritative identity

Change SQLite open to require a full explicit `project: Project`, plus optional initial `profile`, replacing `projectId` rather than adding an optional legacy alias. Migrate synthetic fixtures cleanly. Its fresh database initializes immutable project metadata and the optional profile once in the same authority; reopen validates immutable storage binding and reads the saved metadata/profile. No SQL sidecar is wired into production's existing JSON project.

For `FileProjectStore.open`:

1. On a genuinely new authority, validate/copy the supplied project/profile once as bootstrap input. Existing explicit role/run test seeds are not production settings migration.
2. On existing state, retain saved `project` and profile. Reject a supplied ID/root/managed/data-directory binding mismatch with a typed error before persistence. Supplied name/profile are bootstrap/export proposals and cannot replace saved metadata/settings. No silent import based on revision comparison, including equal revision with different content.
3. `ProjectApplication.open` validates binding using `store.project`, uses that canonical project as the return value and registry identity, and installs policy from `settings.profile()`. It must not return the repository-export name while registering another stored identity.
4. If a base branch needs filling, do one settings CAS transaction from the saved profile using actual repository branch facts. A loaded export must not override an existing authoritative base branch. A fresh profile can receive its base branch before initial creation.
5. `info()` may inspect repository facts, but the returned profile is always the authoritative narrow profile. `inspect()` remains discovery of an unconnected repository/profile proposal; it does not become authoritative merely because a project is already registered.

The existing repository loader validates `project.json` before opening the authority. That means a malformed/missing export can still prevent discovery/open even after the overwrite defect is fixed. If availability through a damaged export is included now, split location/repository facts from optional bootstrap-file parsing; do not smuggle an invalid export into database initialization or invent a placeholder project. Otherwise document this bounded availability gap rather than claiming export-independent restore.

For a differing same/newer `project.json`, retain authoritative state and treat the file as a proposal. Do not silently import it. Avoid automatically destroying a manually edited proposal on open: either report the mismatch and require explicit import/export, or make the mirror/backup policy explicit. Existing automatic repair of a known stale older export can remain separately defined. A failed explicit configuration export retry is already authorization to export the current profile. No new import command is required for this slice; a later import must validate and use CAS like an ordinary settings command.

## Receipt-first configuration and verification

`configure` and `applyResearch` must query the shared receipt before validating current profile/research/HEAD, checking busy work or constructing a new candidate. On a found receipt:

- Preserve its original result, including after newer settings or research changes.
- Rebuild cached execution policy from the current authoritative profile.
- Retry export of that current profile, not the original receipt profile.
- Do not increment revision, acknowledge another proposal, append another event or rerun Git HEAD/research admission.

An absent receipt proceeds with bounded reads, external HEAD validation when needed, then settings transaction. The transaction independently checks the receipt first, so another writer committing between initial receipt lookup and callback still wins idempotently. Found void must remain distinguishable from absent (`{result}` envelope), as established for materials.

Verification uses receipt-first narrow lookup before inspection/workspace/check I/O and its existing in-flight request guard. `verification()` uses `store.project` and `settings.profile/hasActiveRun`, not `snapshot().runs`. `hasActiveRun` matches current `terminal`: statuses queued/running/canceling are active; missing status and completed/failed/interrupted/needs-attention are terminal. SQL uses indexed run facts outside any bounded UI page. No native Run writer is added merely to populate this lookup; temporary SQL test fixtures may seed facts only in synthetic authorities.

Configuration export remains post-commit external I/O; database receipt/profile are authoritative even when it fails. Multi-process exports can lag a newer profile and are not a cross-resource transaction. Do not claim durable export-effect/recovery journaling until it is implemented. Accepted Git result application (`apply`) remains on its existing separate prepared/dispatch/settle intent; do not casually migrate or regress it in 5A3c.

## Implementation owners and focused gates

- Core owner: new settings facade/validators, narrow ProjectApplication methods through verification, required port, small metadata-only registry changes, proposal-only helper type. Leave result application/document references there until its own slice.
- SQL owner: immutable metadata/current profile/verification/proposal+ack rows, actual settings facet, indexed active-run query, one transaction/receipt/event stream with existing usage/entities/materials. Fresh explicit Project initialization, no legacy optional-open alias.
- Root File bridge: same single document queue, authoritative reopen fix, metadata-only project getter, post-commit policy/export lifecycle and aggregate composition/fixture migration.
- Client/tests owner: acknowledgement event merge/serialization and actual cross-adapter ProjectApplication tests. Independent review should target reopen identity, receipt replay and export races, not just facade happy paths.

Required tests: equal/newer exported profile cannot change saved profile without a command; foreign root/data-directory options reject without rewriting state; caller-mutated open options cannot later alter metadata; registry list succeeds with `snapshot()` throwing. Fresh explicit Project metadata/profile survive SQL reopen and conflicting binding is rejected. Profile CAS/account/event/receipt/ack roll back together on injected storage failure. A committed configure retry succeeds after research replacement or source HEAD change and returns its exact old result while exporting current newer settings. A failed export does not roll back revision/receipt, and retry does not reapply research. Manual acknowledgement and later application preserve current-form revision semantics. An active Run older than the visible page still blocks configure/verify; no whole Run JSON or history enumeration is needed. Verification replay performs zero additional check/workspace calls; captured stale profile revision is never relabeled current. All changes retain user role/model preferences, material grants, finite quotas, original session journal and Git-apply recovery behavior.
