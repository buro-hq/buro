import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionService, type ExecutionContext, type CheckedRun } from '../core/execution.ts';
import type { WorkspaceRevision } from '../core/workspace-revision.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import { GoalService } from '../core/services.ts';
import { executionPolicy } from '../core/project-settings.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

const envelope = {
  status: 'success' as const,
  summary: 'Requested change',
  artifacts: [],
  notesForNextAgent: '',
};

async function fixture(t: { after(action: () => Promise<void>): void }) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-action-checks-')),
  );
  const root = path.join(directory, 'source');
  const workspace = { path: path.join(directory, 'worktree'), base: 'a'.repeat(40) };
  await fs.mkdir(root);
  await fs.mkdir(workspace.path);
  const project = { id: 'p', name: 'Action verification', root, managed: true };
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: '',
    scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['AGENTS.md'] },
    checks: [{ id: 'test', title: 'Tests', command: 'controlled-check', timeoutMs: 1000 }],
    defaultCheckIds: ['test'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 2,
    turnTimeoutMs: 10000,
  };
  const policy = executionPolicy(profile);
  const store = await FileProjectStore.open({
    directory: path.join(directory, 'state'),
    project,
    profile,
  });
  const projects = { get: () => store, list: () => [project] };
  let ids = 0,
    reviewStarts = 0,
    reviewTurns = 0,
    checkpoints = 0,
    releases = 0;
  let verdict: 'approved' | 'changes_requested' = 'approved';
  const revision: WorkspaceRevision = {
    version: 1,
    base: workspace.base,
    head: workspace.base,
    index: 'c'.repeat(64),
    tree: 'b'.repeat(40),
    changes: [{ path: 'src/value.ts', before: 'old', after: 'new' }],
  };
  const service = new ExecutionService({
    actions: createBuiltinExecutionActions(),
    projects,
    policies: { p: policy },
    workflowRoles: createBuiltinWorkflowRoles(),
    selection: fixtureExecutionSelection('controlled', fixtureExecutionCapabilities()),
    now: () => new Date(Date.UTC(2026, 0, 1) + ids * 1000).toISOString(),
    id: () => String(++ids),
    runtime: {
      id: 'controlled',
      async start(input) {
        reviewStarts++;
        assert.equal(input.purpose, 'review');
        assert.equal(input.readOnly, true);
        assert.notEqual(input.workspace, workspace.path);
        return { threadId: 'review-' + reviewStarts };
      },
      async turn() {
        reviewTurns++;
        return {
          turnId: 'turn-' + reviewTurns,
          text: JSON.stringify({
            verdict,
            blockingFindings: verdict === 'approved' ? [] : ['Missing edge case'],
            summary: verdict,
          }),
        };
      },
      async submit() {
        throw Error('No untracked turns');
      },
      async interrupt() {},
      async release() {},
      async dispose() {},
    },
    workspaces: {
      async prepare() {
        return workspace;
      },
      async changes() {
        return structuredClone(revision.changes);
      },
      async captureRevision() {
        return structuredClone(revision);
      },
      async openVerificationView(_workspace, checked, options) {
        const id = 'V-' + ++ids;
        return {
          version: 1,
          id,
          projectId: options.projectId,
          runId: options.runId,
          sourceWorkspace: workspace.path,
          readRoot: path.join(directory, id, 'read'),
          outputRoot: path.join(directory, id, 'output'),
          base: checked.base,
          tree: checked.tree,
          outputPaths: [],
        };
      },
      async releaseVerificationView() {
        releases++;
      },
      async checkpoint(_workspace, _runId, expected) {
        checkpoints++;
        assert.deepEqual(expected, revision);
        return 'd'.repeat(40);
      },
    },
    checks: {
      async run(_projectId, _workspace, _ids, _signal, _profile, options) {
        assert.equal(options?.verificationView?.tree, revision.tree);
        return {
          passed: 1,
          total: 1,
          results: [{ name: 'Controlled requirements', passed: true }],
        };
      },
    },
  });
  service.schedule = () => {};
  t.after(async () => {
    await service.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const goal = await new GoalService({
    projects,
    id: () => String(++ids),
    now: () => 'now',
  }).create('goal', 'goal', {
    projectId: 'p',
    title: 'Change value',
    body: 'Implement the value contract',
    criteria: 'Preserve the edge case',
  });
  const { runId } = await service.start('run', 'run', { projectId: 'p', goalId: goal.id });
  await service.beginExecution('p', runId);
  await service.phase('p', runId, 'preparing', 'Prepare controlled workspace');
  await service.bindPreparedWorkspace('p', runId, workspace);
  const ctx: ExecutionContext = {
    projectId: 'p',
    runId,
    workspace,
    policy,
    signal: new AbortController().signal,
    threads: [],
    attemptId: service.get('p', runId).attemptId,
  };
  return {
    service,
    store,
    ctx,
    revision,
    setVerdict(value: typeof verdict) {
      verdict = value;
    },
    counts: () => ({ reviewStarts, reviewTurns, checkpoints, releases }),
  };
}

test('checks, review and acceptance run only when requested, including a rejected review without automatic repair', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.acceptRun(f.ctx, {} as CheckedRun, envelope), {
    code: 'CHECKS_REQUIRED',
  });
  const checked = await f.service.checkRun(f.ctx);
  assert.equal(f.counts().reviewStarts, 0);
  await assert.rejects(f.service.acceptRun(f.ctx, checked, envelope), { code: 'REVIEW_REQUIRED' });
  f.setVerdict('changes_requested');
  const review = await f.service.reviewRun(f.ctx, checked, envelope);
  assert.equal(review.verdict, 'changes_requested');
  assert.equal(f.counts().reviewTurns, 1);
  await assert.rejects(f.service.acceptRun(f.ctx, checked, envelope), {
    code: 'ACCEPTANCE_NOT_READY',
  });
  assert.equal(f.service.get('p', f.ctx.runId).status, 'running');
  assert.equal(f.counts().checkpoints, 0);
  f.setVerdict('approved');
  const rechecked = await f.service.checkRun(f.ctx);
  await f.service.reviewRun(f.ctx, rechecked, envelope);
  const accepted = await f.service.acceptRun(f.ctx, rechecked, envelope);
  assert.equal(accepted.commit, 'd'.repeat(40));
  assert.equal(f.service.get('p', f.ctx.runId).status, 'completed');
  assert.equal(f.service.get('p', f.ctx.runId).planSavedAt, undefined);
});

test('a changed source revision invalidates checks before reviewer dispatch and can be explicitly checked again', async (t) => {
  const f = await fixture(t);
  const checked = await f.service.checkRun(f.ctx);
  f.revision.tree = 'e'.repeat(40);
  f.revision.changes[0].after = 'next';
  await assert.rejects(f.service.reviewRun(f.ctx, checked, envelope), {
    code: 'VERIFICATION_REVISION_CHANGED',
  });
  assert.equal(f.counts().reviewStarts, 0);
  assert.equal(f.counts().releases, 1);
  assert.equal(f.service.get('p', f.ctx.runId).verificationEvidence, undefined);
  const next = await f.service.checkRun(f.ctx);
  await f.service.reviewRun(f.ctx, next, envelope);
});

test('Git identity changes require intervention and are not treated as ordinary source edits', async (t) => {
  const f = await fixture(t);
  const checked = await f.service.checkRun(f.ctx);
  f.revision.index = 'f'.repeat(64);
  await assert.rejects(f.service.reviewRun(f.ctx, checked, envelope), {
    code: 'WORKSPACE_IDENTITY_CHANGED',
  });
  assert.equal(f.counts().reviewStarts, 0);
  assert.equal(f.counts().checkpoints, 0);
});

test('caller assertions and changed check-handle copies cannot become fresh host evidence', async (t) => {
  const f = await fixture(t);
  const checked = await f.service.checkRun(f.ctx);
  await assert.rejects(f.service.reviewRun(f.ctx, structuredClone(checked), envelope), {
    code: 'CHECKS_REQUIRED',
  });
  checked.revision!.head = 'f'.repeat(40);
  checked.checks.total = 0;
  await f.service.reviewRun(f.ctx, checked, envelope);
  await f.service.acceptRun(f.ctx, checked, envelope);
  assert.equal(f.counts().checkpoints, 1);
});

test('cancellation and an unknown effect still block finalization after genuine approval', async (t) => {
  for (const blocker of ['cancel', 'unknown'] as const) {
    const f = await fixture(t);
    const checked = await f.service.checkRun(f.ctx);
    await f.service.reviewRun(f.ctx, checked, envelope);
    if (blocker === 'cancel')
      await f.service.cancel('cancel', 'cancel', { projectId: 'p', runId: f.ctx.runId });
    else
      await f.service.update('p', f.ctx.runId, (run) => {
        run.reconciliation = {
          version: 1,
          status: 'required',
          code: 'ACTION_RECONCILIATION_REQUIRED',
          detectedAt: 'unknown-effect',
          operationId: 'unsettled-effect',
        };
      });
    await assert.rejects(
      f.service.acceptRun(f.ctx, checked, envelope),
      blocker === 'cancel' ? { name: 'AbortError' } : { code: 'RUN_RECONCILIATION_REQUIRED' },
    );
    assert.equal(f.counts().checkpoints, 0);
    assert.equal(f.service.get('p', f.ctx.runId).commit, undefined);
  }
});
