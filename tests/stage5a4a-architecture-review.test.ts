import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import { executionPolicy } from '../core/project-settings.ts';
import { DomainError } from '../core/ports.ts';
import type { AgentRuntime, ProjectStore } from '../core/ports.ts';
import { ExecutionService } from '../core/execution.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

async function fixture(t: test.TestContext) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-run-boundary-')),
  );
  const project = { id: 'p', name: 'Synthetic', root: directory, managed: true };
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: 'Saved instructions',
    scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['AGENTS.md'] },
    checks: [{ id: 'test', title: 'Required tests', command: 'synthetic test', timeoutMs: 1000 }],
    defaultCheckIds: ['test'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    turnTimeoutMs: 10000,
    baseBranch: 'main',
  };
  let store = await FileProjectStore.open({ directory, project, profile });
  const dependents: { close(): Promise<void> }[] = [];
  t.after(async () => {
    await Promise.all(dependents.map((resource) => resource.close()));
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await store.entities.transaction({ id: 'goal', fingerprint: 'goal' }, (tx) =>
    tx.createGoal({
      id: 'G-one',
      projectId: 'p',
      title: 'Synthetic goal',
      body: 'Original task',
      criteria: 'Original criteria',
      status: 'draft',
      revision: 1,
      createdAt: 'now',
    }),
  );
  const workflow = createBuiltinWorkflowRoles();
  const proposal = {
    runId: 'R-one',
    admissionId: 'admission-R-one',
    attemptId: 'initial-R-one',
    goalId: 'G-one',
    now: 'now',
    expectedGoalRevision: 1,
    expectedProfileRevision: 1,
    policy: executionPolicy(profile),
    resources: fixtureExecutionSelection(
      'fake',
      fixtureExecutionCapabilities({ strictPlannedWrites: true }),
    ).forProject('p'),
    workflow: workflow.workflow,
    repairCapabilities: { managedEnvironment: false, synchronizeDependencies: false },
  };
  return {
    get store() {
      return store;
    },
    proposal,
    workflow,
    own(resource: { close(): Promise<void> }) {
      dependents.push(resource);
    },
    async reopen() {
      await store.close();
      store = await FileProjectStore.open({ directory, project, profile });
    },
  };
}

test('a saved profile cannot be paired with a relaxed derived admission policy', async (t) => {
  const f = await fixture(t);
  const proposal = structuredClone(f.proposal);
  proposal.policy.scope = { mode: 'advisory', plannedPaths: [], protectedPaths: [] };
  proposal.policy.checks = [{ id: 'unchecked', title: 'Unrelated' }];
  proposal.policy.defaultCheckIds = ['unchecked'];
  const before = f.store.snapshot();
  await assert.rejects(
    f.store.runs.transaction({ id: 'relaxed-policy', fingerprint: 'relaxed-policy' }, (tx) =>
      tx.admit(proposal, f.workflow),
    ),
    (error: unknown) => error instanceof DomainError,
  );
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(
    await f.store.runs.receipt({ id: 'relaxed-policy', fingerprint: 'relaxed-policy' }),
    undefined,
  );
});

test('SQL refuses relaxed top-level policy even when the nested saved profile is exact', async (t) => {
  const f = await fixture(t);
  const authority = await SqliteProjectUsageAuthority.open({
    directory: path.join(f.store.directory, 'isolated-sql-proof'),
    project: f.store.project,
    profile: f.proposal.policy.profile,
  });
  f.own(authority);
  await authority.entities.transaction({ id: 'goal', fingerprint: 'goal' }, (tx) =>
    tx.createGoal(f.store.snapshot().goals[0]),
  );
  const proposal = structuredClone(f.proposal);
  proposal.policy.scope = { mode: 'advisory', plannedPaths: [], protectedPaths: [] };
  proposal.policy.checks = [{ id: 'unchecked', title: 'Unrelated' }];
  proposal.policy.defaultCheckIds = ['unchecked'];
  proposal.resources = fixtureExecutionSelection('fake', fixtureExecutionCapabilities()).forProject(
    'p',
  );
  const command = { id: 'relaxed-policy', fingerprint: 'relaxed-policy' };
  const before = await authority.pagedEvents({ after: 0, limit: 10 });
  await assert.rejects(
    authority.runs.transaction(command, (tx) => tx.admit(proposal, f.workflow)),
    { code: 'CONFLICT' },
  );
  assert.equal(await authority.runs.current(proposal.runId), undefined);
  assert.equal(await authority.entities.role('coordinator'), undefined);
  assert.equal(await authority.entities.role('reviewer'), undefined);
  assert.equal((await authority.entities.goal('G-one'))?.status, 'draft');
  assert.equal(await authority.runs.receipt(command), undefined);
  assert.deepEqual(await authority.pagedEvents({ after: 0, limit: 10 }), before);
});

test('actual start and cancel reject a foreign run facet before receipt, resource selection or dispatch', async (t) => {
  const f = await fixture(t);
  const foreign = await FileProjectStore.open({
    directory: path.join(f.store.directory, 'foreign'),
    project: { id: 'q', name: 'Foreign', root: f.store.directory },
    profile: f.proposal.policy.profile,
  });
  f.own(foreign);
  let receiptReads = 0,
    transactions = 0,
    effects = 0;
  const store = {
    project: f.store.project,
    settings: f.store.settings,
    entities: f.store.entities,
    runs: {
      ...foreign.runs,
      receipt(command) {
        receiptReads++;
        return foreign.runs.receipt(command);
      },
      transaction(command, apply) {
        transactions++;
        return foreign.runs.transaction(command, apply);
      },
    },
  } as ProjectStore;
  const blocked = async (): Promise<never> => {
    effects++;
    throw Error('No execution effect is authorized by a foreign facet.');
  };
  const service = new ExecutionService({
    actions: createBuiltinExecutionActions(),
    projects: { get: () => store, list: () => [f.store.project] },
    policies: { p: f.proposal.policy },
    workflowRoles: f.workflow,
    selection: {
      forProject() {
        effects++;
        throw Error('No resource selection before facet identity admission.');
      },
    },
    runtime: { id: 'fake', start: blocked, submit: blocked, interrupt: blocked } as AgentRuntime,
    workspaces: { prepare: blocked } as WorkspacePort,
    checks: { run: blocked } as CheckPort,
    id: () => 'unused',
    now: () => 'now',
  });
  t.after(() => service.dispose());
  await assert.rejects(
    service.start('foreign-start', 'foreign-start', { projectId: 'p', goalId: 'G-one' }),
    { code: 'PROJECT_STORAGE_MISMATCH' },
  );
  await assert.rejects(
    service.cancel('foreign-cancel', 'foreign-cancel', { projectId: 'p', runId: 'R-one' }),
    { code: 'PROJECT_STORAGE_MISMATCH' },
  );
  assert.equal(receiptReads, 0);
  assert.equal(transactions, 0);
  assert.equal(effects, 0);
  assert.deepEqual(foreign.snapshot().runs, []);
  assert.equal(
    await foreign.runs.receipt({ id: 'foreign-start', fingerprint: 'foreign-start' }),
    undefined,
  );
});

test('file admission and first-attempt packets remain immutable across legacy commits and reopen', async (t) => {
  const f = await fixture(t);
  await f.store.runs.transaction({ id: 'start', fingerprint: 'start' }, (tx) =>
    tx.admit(f.proposal, f.workflow),
  );
  await f.reopen();
  const before = f.store.snapshot();
  const edits = [
    (doc: any) => {
      doc.runAdmissions['admission-R-one'].goal.body = 'Rewritten task';
    },
    (doc: any) => {
      doc.runAdmissions['admission-R-one'].policy.context = 'Rewritten policy';
    },
    (doc: any) => {
      doc.runAdmissions['admission-R-one'].roleSnapshots[0].instructions = 'Rewritten role';
    },
    (doc: any) => {
      doc.runInitialAttempts['initial-R-one'].createdAt = 'Rewritten attempt';
    },
    (doc: any) => {
      delete doc.runAdmissions['admission-R-one'];
    },
    (doc: any) => {
      delete doc.runInitialAttempts['initial-R-one'];
    },
    (doc: any) => {
      doc.runHeads['R-one'].admissionId = 'foreign-admission';
    },
  ];
  for (const [index, edit] of edits.entries()) {
    const id = 'rewrite-' + index;
    await assert.rejects(
      f.store.transact(id, id, (doc) => {
        edit(doc);
        return { result: null, change: { type: 'goal.deleted', id: 'unused' } };
      }),
      (error: unknown) => error instanceof DomainError,
    );
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(f.store.receipt(id, id), undefined);
  }
  await f.store.transact('legacy-progress', 'legacy-progress', (doc) => {
    const run = doc.runs.find((item) => item.id === 'R-one')!;
    run.status = 'running';
    run.phase = 'planning';
    run.summary = 'Actual legacy executor progress';
    return { result: null, change: { type: 'run.changed', run, goal: doc.goals[0] } };
  });
  assert.equal((await f.store.runs.current('R-one'))?.summary, 'Actual legacy executor progress');
  await f.store.runs.transaction({ id: 'cancel', fingerprint: 'cancel' }, (tx) =>
    tx.requestCancel({ runId: 'R-one', now: 'later' }),
  );
  assert.equal((await f.store.runs.current('R-one'))?.status, 'canceling');
});
