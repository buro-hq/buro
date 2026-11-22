# 5A3b independent material integration and importer races

Parent: `36f2643`. Scope: material metadata through the actual File bridge and SQLite facet, plus the real `ContextMaterials` importer. Existing execution/runtime/journal/default-quota adoption remains separate.

`node --test tests/project-material-services.test.ts`: **14/14 passed**, no skips. Log: `/private/tmp/buro-stage5a3b-material-services.log`. Scoped formatting and `git diff --check` passed.

Both adapters return the committed canonical identity for repeated batch inputs. Removal preserves known references used by actual GoalService; reactivation retains the original ID, creation date and paths. Historical command replay returns its original result without reactivating a later-removed record. Only actual new/reactivated records appear in events; active duplicates and repeated inactive removals produce no fabricated change. Returned metadata is detached before and after reopen. Conflicting payloads, reused IDs and callback failures roll back metadata, reference indexes and events. Existing 64-active-project and 1,000-record library policies remain unchanged; duplicate inputs do not consume additional canonical slots.

The actual importer runs against a registry whose legacy snapshot, document transaction and receipt methods throw. It uses narrow facets and project metadata. Three deterministic races run on each adapter using two importer instances and controlled loader barriers:

- Fresh-directory imports of the same bytes converge on one canonical metadata record and one change event, with a verified immutable copy.
- An import paused during loading observes a concurrent removal at commit, reactivates the original canonical record and returns its actual active metadata.
- Two copies of the same command read different source versions. The later-prepared version commits first; both callers receive that winning receipt. The losing prepared bytes may remain as an orphan blob, but create no metadata/event authority. Reopen and retry still return the committed result after the original source is deleted.

A guarded physical SQLite trigger interrupts insertion into `material_refs` after metadata insertion. Even a callback that catches the error cannot commit partial metadata, reference, counters, event or receipt. The same command succeeds after removing the test trigger, and the remaining project-library slots are correct. A separate guarded fault removes the counter row from an existing temporary library; reopening rejects it without silently replacing totals with zero.

These are temporary databases/files and deterministic loaders. No live model, RTX endpoint, credential or original user repository was accessed. The tests do not claim SQL runtime adoption, complete run/history paging, default-none quotas or authorization from orphan filesystem bytes.
