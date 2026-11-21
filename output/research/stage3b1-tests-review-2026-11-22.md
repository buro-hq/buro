# Stage 3B1 independent host/context test review

Reviewed on 2026-11-22 against `9339110` plus the current private host-seam extraction. Disposition: **clear within the existing single Buro execution loop**. The split is exercised by production ManagedAgentRuntime; it does not yet switch the scheduler to an SDK or establish a public neutral AgentBackend.

## Independent validation

**115/115** tests passed across `managed-context-boundaries`, `managed-host-effects`, `managed-session-authority`, `provider-outcome-recovery`, `run-reconciliation`, `managed-resume`, `managed-segments`, `managed-worker-checks`, `request-policy`, `run-budget-runtime` and `boundaries`. Full repository typecheck passed, including the separately compiled portable contract/provider layers. `git diff --check` and formatting of the added test file passed. Counts overlap the owner's full suite and are not additive.

The local receipts are `/private/tmp/buro-stage3b1-independent-tests.log` and `/private/tmp/buro-stage3b1-independent-typecheck.log`. Those are temporary review logs, not an application ledger.

## Added independent regressions

`tests/managed-context-boundaries.test.ts` adds three passing tests at the new seams:

1. The context stage rejects a missing generation/batch, pending full batch, partially receipted batch and in-flight action before it advances. The rejected calls leave the actual FileManagedSessions checkpoint unchanged. Only after both tool receipts are committed can it return continue; a fresh file-store reader observes both completed results. The provider and broker are explicit fakes, so this proves journal/context sequencing rather than the correctness of real source-file reads.
2. A provider's retained response reference, the detached returned response and the returned action-ID array are all mutated after generation. Clearing their tool lists cannot manufacture completion while canonical actions remain pending. After dispatching the actual saved actions, context still follows the canonical tool-bearing response. A separate tools-free final case returns the original canonical text/model despite a detached response claiming different final text and finish. A fresh file reader retains the observed original response.
3. A deliberately deferred permissive session-store port holds a detached final-context replacement while an interrupt marks the old loaded session cancelled. Releasing the save cannot erase that cancellation during replacement adoption. The final checkpoint is interrupted and cancel-requested, the already observed generation remains completed, and no final generation or message.completed event follows. This is an owner/cache-adoption race test. It intentionally does not claim a FileManagedSessions crash proof: that adapter's additional transition validation could reject the stale clone first and mask a missing owner cancellation latch.

## Existing test strength retained

Existing integration assertions were preserved. The request-view regression now asserts deep equality of the guarded packet and a distinct object identity at the provider boundary. It retains the exact semantic request-size contract while adding protection against provider mutation; it does not replace a value assertion with a weaker shape check. Other touched test lines only import the newly separated options type.

The host-effects tests exercise real private files and a real temporary effect log. They cover whole-batch rejection before any action, provider/scheduler/broker mutation attempts, ordered dispatch with a held first receipt, denial of a next generation while a receipt is pending, invalid/repeated/foreign IDs, preserved normalized response on usage-ledger failure and permanently lost post-effect receipt recovery. The latter remains unresolved across reopening and public continuation does not replay the effect. Foreign pending generations/actions are retained by failure cleanup rather than incorrectly branded undispatched because this new helper invocation made no call.

Session-authority tests show detached start/resume revisions and zero persistence/model/tool effects from preparation itself. Existing segment/check tests retain full task/scope/history, protected path rules, context provenance, cumulative accounting, exact private response/continuation and unknown check/effect boundaries through the extraction. Existing provider recovery still distinguishes metadata preflight from unknown generation and a mid-stream familiar rejection code from an observed negative HTTP response.

## Review boundary and next-stage requirements

The runtime still owns the only loop, phase ordering, round advancement, active-turn exclusion, cancellation and lifecycle. Context processing reads canonical host generation data, while the private active-batch cursor provides ordered, once-only tool dispatch and receipt barriers. The context stage itself is not an independently callable public scheduler state machine: the present owner calls it once per completed batch. The SDK bridge must explicitly consume each response once and require coding checks/context processing before another generation. It must also drain any already-started broker call/receipt when a generic scheduler fails, rather than racing cleanup against an abandoned callback promise.

No second transcript, retry loop or effect authority was introduced in this substep. The new private state/options types intentionally contain Buro policy and service ports; they are not presented as portable package exports. Pi integration, neutral AgentBackend contracts, independently installable packages, SQLite authority, default-none quotas, operational preparation receipts and concurrent goals remain later work.

No live provider, offline RTX host, original user repository, credential, external message, delivery operation or Git commit was accessed by this reviewer. These synthetic checks provide no live-model speed or coding-quality evidence.
