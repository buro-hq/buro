# Synthetic live harness immutable-view correction

Date: 2026-11-22. Follow-up to the first current-version live matrix and its native review failure. This change is limited to `scripts/lib/model-comparison.cjs` and the new deterministic `tests/model-comparison-verification.test.ts`; it changes no production Core, adapter, quota or native permission policy. No live request, RTX contact or original-project change was made by this implementation agent.

## Defect and correction

The synthetic fixture's custom check port ignored the shared `EnvironmentExecutors`, the issued `verificationView` options and view-release lifecycle. It ran its own canonical oracle against the mutable workspace. Native immutable review correctly requires the host's issued view to be registered with that same shared executor; without the registration its policy lookup rejects `VERIFICATION_VIEW_CHANGED` with “The verification view is not registered.” The native guard must remain intact.

The fixture now delegates its actual protected public command to the standard `ProjectChecks(projects, forbiddenFallback, sharedExecutors)`. It forwards the existing run options and its release hook, so normal owner/source/tree/output/config validation and shared view registration/revocation apply. There is no host fallback.

The parent-controlled public oracle is retained in addition to the actual public command. For immutable verification it evaluates the issued readRoot through `sharedExecutors.launchVerification(view, argv, true)`, never by registering an ordinary writable workspace world inside that immutable tree. The combined service check passes only for exactly one passing public command and the independent public oracle. For standalone external final-oracle checks, the existing isolated workspace path is unchanged. External holdout verification remains mandatory.

Fixture files, task, public/holdout expectations, IDENTITY hashes, profile, routes, planning selection and limits are unchanged. The check execution path has intentionally changed: a follow-up trial must be reported separately from the first matrix, without rewriting a failed original trial into success or treating timings as identical-path measurements.

## Regression evidence

`tests/model-comparison-verification.test.ts` creates the real frozen Git fixture, an actual GitWorkspaces worktree/revision/issued view, a shared prepared executor and its owner projection. It does not start native Codex, a managed model or a network request. The registry owner is a minimal test projection, not a complete routed execution proof.

The regression first rejects native policy access for an unregistered issued view, then calls the fixture's real checks. On the old harness it fails after that call because the shared view is still unregistered. Before-fix evidence: `/private/tmp/buro-comparison-verification-before.log` (failure at nativeAccess after checks, not at the initial expected rejection). An earlier assertion used the wrong expected typed code; that was corrected and rerun before changing the harness, and is not counted as defect evidence.

After the correction, the same test proves:

- baseline check remains 0/1; the two-file correction passes 1/1;
- shared native policy grants the actual issued source and denies mutable/original roots;
- a substituted tree or source workspace rejects;
- no `.buro/environment` is created under baseline, fixed or deceptive issued readRoot;
- releasing the view revokes native policy access;
- a candidate that monkeypatches Node's public assertions can make the protected public script exit successfully, but the independent parent oracle still rejects the candidate;
- the unmodified external public/holdout oracle and fixture identities remain valid for the genuine fix.

Executed `node --test tests/model-comparison-verification.test.ts tests/model-comparison.test.ts tests/live-evaluation-budget.test.ts tests/codex-verification.test.ts`: **40/40 passed**, no skips, 2567.233709 ms. Log: `/private/tmp/buro-comparison-verification-focused.log`. Earlier corrected-regression-only after-fix run passed 1/1. Changed-file formatting and `git diff --check` passed. These tests overlap existing parent counts and must not be summed with them.

Full integrated/typecheck and independent reviews belong to the parent. A fresh real native trial after these gates is separate live evidence. The correction does not claim that the existing CLI planning-argument or failure-classifier limitations were fixed, that managed model quality improved, or that real post-release transport replay/crash recovery is complete.
