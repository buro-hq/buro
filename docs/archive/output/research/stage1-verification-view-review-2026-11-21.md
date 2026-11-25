# Stage 1A boundary review and the remaining verification-view contract

Date: 2026-11-21. Independent working-tree review. No production edits, model/API calls, RTX queries or user repository changes by this reviewer. The parent owns full-suite verification and the stage commit.

## Bounded verdict

The stage 1A direction is sound: a host-captured immutable Git tree is carried from verification through review and checkpoint; checkpoint commits that tree rather than staging later live files; owning-run pending/unknown operations cannot be bypassed through another worker; applying an accepted result records an intent before the source-branch effect and reconciles the original receipt afterwards.

This closes the reproduced **persistent** check/review mutation path and the explicit worker-replacement bypass. It does **not** establish that live check/reviewer reads always saw the captured source. Before/after equality samples cannot exclude transient A→B→A changes. Do not label stage 1A as immutable verification input or mark the complete first step finished until stage 1B addresses that boundary.

The user's advisory planned-file scope remains independent: additional edits may be permitted, but any accepted commit must have truthful check/review provenance. A stricter path list does not solve the transient-read problem.

## Controlled remaining reproduction

Run `node --test output/research/verification-aba-repro-2026-11-21.ts`.

The script uses an adapted existing test fixture, fake agent sessions, a real disposable Git worktree, and a real child Node assertion. The final check temporarily writes `export const value=3`, executes a child test requiring3, then restores the original `export const value=2`. Before/after source-tree snapshots agree. The fake reviewer approves. The current run completes and commits value2; executing the same value3 check against the accepted workspace fails.

Observed output:

```json
{"case":"verification-source-ABA","status":"completed","checkedSource":"export const value=3;","acceptedSource":"export const value=2;","identicalBeforeAfterSnapshots":true,"acceptedSourceFailsCheck":true}
```

One PASS assertion reproduced this limitation in approximately2.45seconds. PASS is not a correctness result. The source repository used by the test is temporary and cleaned afterwards; this does not demonstrate a live model exploit.

## Minimal stage 1B boundary

Introduce a service-issued verification view, rather than silently reusing the writable agent workspace:

```ts
type VerificationView = {
  id: string;
  source: { base: string; tree: string; manifestRef: string };
  readRoot: string;
  outputRoot: string;
  environmentFingerprint: string;
  authorityRef: string;
};
```

Names are provisional. The required semantics matter more than the shape:

- `WorkspacePort.openVerificationView` materializes the exact captured tree and freezes its tracked source bytes/modes. A model cannot choose its tree, authority or output roots.
- `CheckPort` receives that issued view explicitly. Acceptance checks execute against its immutable source and a prepared environment, with permitted build/cache/temp outputs separated from source. A callback claiming read-only is insufficient; the host environment must enforce the promised boundary.
- Reviewer sessions read the same source identity through their own read-only tools. They do not rediscover mutable implementation files at a different path with the same display name.
- View receipts bind tree, check recipe/configuration, environment and observed exit to the owning run. Reviewer verdict binds the same tree. Final checkpoint takes that tree and expected implementation-workspace identity as a separate precondition.
- Closing or cancelling a view stops and observes owned check processes before releasing mounts/paths. Unknown outcomes stay unknown. A view failure cannot trigger execution in the ordinary host directory.

This port belongs to the Buro application/environment boundary. Generic model/agent packages receive an opaque host authority or allowed context, not a dependency on Git/project checks. Cordis composes the view provider; it is not another durable state authority.

## Preserve legitimate build behavior

Read-only input does not mean all commands must run in a directory that forbids every write. Builds and tests commonly require ignored output directories, temporary fixtures, dependency caches and diagnostics. The implementation must make these outputs writable without permitting replacement/rename of verified source bytes or dependencies/instructions used as trusted inputs.

Options include a read-only source mount plus explicitly writable output mounts, or a host sandbox enforcing immutable input paths with declared output paths. A plain copy followed by another before/after hash remains vulnerable to the same ABA sequence. An overlay that permits overwriting source in its writable layer also fails the promised guarantee.

Recipes intentionally modifying source (format-write, regenerate, update snapshots) are preparatory work: execute under an explicit mutable authority, capture the resulting new revision, and then run the acceptance recipe against immutable input. Do not pretend a mutating formatter checked the old tree. Dependency/environment preparation similarly precedes the frozen verification identity.

## Tests before completing stage 1B

1. The preserved ABA reproducer becomes a proper regression: source mutation is denied or makes verification unavailable; it cannot produce an accepted source that fails the executed test.
2. A late/background writer on the implementation workspace cannot change what the frozen check/reviewer sees.
3. Declared build outputs remain writable; attempts to rename/replace an input via a parent directory, symlink or writable overlay do not alter the view.
4. View environment/configuration or check-recipe changes invalidate evidence; no host fallback runs an unsupported view.
5. Cancellation, crash, missing/corrupt view artifacts and delayed completion preserve operation identity and do not publish stale success.
6. Advisory/strict planned scope each use the same immutable verification semantics. The scope checkbox changes allowed implementation edits, not evidence truthfulness.

## Other review corrections coordinated during stage 1A

The native adapter initially allowed a stale same-thread terminal event before the start acknowledgement to resolve the new turn. The implementation owner added per-turn terminal buffering and agent-message correlation, with stale-message/terminal regressions. The managed adapter initially risked marking a not-yet-dispatched generation unknown on cancellation; the owner added per-generation dispatch tracking and first/later-round cancellation tests. Observed response/rejection fields also require same-operation immutability.

The parent added canonical transition validation for required owning-run reconciliation markers. That is appropriate: a future profile or application transition must not erase an unresolved operation merely by omitting the field. Pending-turn settlement remains a separate observed-outcome transition. A future trusted reconciliation command needs an explicit verified settlement contract; it must not bypass this validator.

The final stage 1A review is limited to the bounded changes above. Full-suite success, formatting, build and final source freeze are reported by the parent; this reviewer did not run the full suite.
