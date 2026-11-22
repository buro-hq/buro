import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import { executionPolicy } from '../core/project-settings.ts';
import {
  RUN_TIMELINE_PAGE_MAX,
  type RunAdmissionProposal,
  type RunTransaction,
} from '../core/project-runs.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';
import type { Role } from '../protocol/domain.ts';

const command = (id: string) => ({ id, fingerprint: id });
const now = '2026-11-22T00:00:00Z';
async function fixture(t: any) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-sql-runs-')));
  const project = { id: 'p', name: 'Synthetic run project', root: directory };
  const profile = ProjectProfileSchema.parse({
    version: 1,
    revision: 1,
    context: 'No runtime dispatch in this test',
    scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: [] },
    checks: [{ id: 'suite', title: 'Suite', command: 'must-not-run', timeoutMs: 1000 }],
    defaultCheckIds: ['suite'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    turnTimeoutMs: 10000,
  });
  const authority = await SqliteProjectUsageAuthority.open({ directory, project, profile });
  t.after(async () => {
    await authority.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const goal = await authority.entities.transaction(command('goal'), (tx) =>
    tx.createGoal({
      id: 'G-one',
      projectId: 'p',
      title: 'Complete task',
      body: 'Original requirement. '.repeat(400),
      criteria: 'Keep every criterion. '.repeat(100),
      status: 'draft',
      revision: 1,
      createdAt: now,
    }),
  );
  const workflow = createBuiltinWorkflowRoles();
  const proposal: RunAdmissionProposal = {
    runId: 'R-one',
    admissionId: 'A-one',
    attemptId: 'T-one',
    goalId: goal.id,
    now,
    expectedGoalRevision: 1,
    expectedProfileRevision: 1,
    policy: executionPolicy(profile),
    resources: fixtureExecutionSelection('fake', fixtureExecutionCapabilities()).forProject('p'),
    workflow: workflow.workflow,
    repairCapabilities: { managedEnvironment: false, synchronizeDependencies: false },
  };
  const admit = () =>
    authority.runs.transaction(command('admit'), (tx) => tx.admit(proposal, workflow));
  return { directory, project, profile, goal, authority, workflow, proposal, admit };
}

test('real queue admission links the goal, freezes complete grants and creates only missing roles', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.admit(), { runId: 'R-one' });
  const current = await f.authority.runs.current('R-one');
  assert.equal(current?.status, 'queued');
  assert.equal(current?.admissionId, 'A-one');
  assert.equal(current?.attemptId, 'T-one');
  assert.equal(current?.cancelRequested, false);
  assert.equal(Object.values(current!).some(Array.isArray), false);
  assert.equal((await f.authority.entities.goal('G-one'))?.runId, 'R-one');
  assert.equal((await f.authority.entities.goal('G-one'))?.status, 'running');
  assert.equal(await f.authority.settings.hasActiveRun(), true);
  assert.equal(
    await f.authority.account({ kind: 'run', runId: 'R-one' }),
    undefined,
    'Queue-only admission does not initialize a second accounting owner.',
  );
  const event = (await f.authority.pagedEvents({ after: 0, limit: 20 })).events.find(
    (entry) => entry.type === 'run.admitted',
  );
  assert.equal(event?.type, 'run.admitted');
  if (event?.type !== 'run.admitted') throw Error('Missing admission event');
  assert.equal(event.admission.goal.body, f.goal.body);
  assert.equal(
    event.admission.goalText,
    f.goal.body + '\n\nAcceptance criteria:\n' + f.goal.criteria,
  );
  assert.equal(event.roles?.length, 2);
  assert.equal((await f.authority.entities.role('coordinator'))?.provenance.origin, 'workflow');
  assert.equal((await f.authority.entities.role('reviewer'))?.version, 1);
  await assert.rejects(
    f.authority.settings.transaction(command('busy-settings'), (tx) =>
      tx.configure({ expectedRevision: 1, profile: f.profile }),
    ),
    { code: 'PROJECT_BUSY' },
  );
});

test('queue command replay neither reruns its callback nor creates another attempt or timeline entry', async (t) => {
  const f = await fixture(t);
  await f.admit();
  const before = await f.authority.pagedEvents({ after: 0, limit: 20 });
  assert.deepEqual(
    await f.authority.runs.transaction(command('admit'), () => {
      throw Error('Already queued');
    }),
    { runId: 'R-one' },
  );
  assert.deepEqual((await f.authority.runs.receipt(command('admit')))?.result, { runId: 'R-one' });
  assert.equal((await f.authority.runs.timeline({ runId: 'R-one', limit: 20 })).entries.length, 1);
  assert.deepEqual(await f.authority.pagedEvents({ after: 0, limit: 20 }), before);
  await assert.rejects(
    f.authority.runs.transaction({ id: 'admit', fingerprint: 'different' }, () => null),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('cancellation updates current and active indexes once while preserving the original admission', async (t) => {
  const f = await fixture(t);
  await f.admit();
  await f.authority.runs.transaction(command('cancel'), (tx) =>
    tx.requestCancel({ runId: 'R-one', now: 'later' }),
  );
  const current = await f.authority.runs.current('R-one');
  assert.equal(current?.status, 'canceling');
  assert.equal(current?.cancelRequested, true);
  assert.equal(current?.revision, 2);
  assert.equal(current?.admissionId, 'A-one');
  assert.equal(
    await f.authority.settings.hasActiveRun(),
    true,
    'A request to stop is not evidence that execution stopped.',
  );
  await f.authority.runs.transaction(command('cancel-again'), (tx) =>
    tx.requestCancel({ runId: 'R-one', now: 'even-later' }),
  );
  assert.equal((await f.authority.runs.current('R-one'))?.revision, 2);
  assert.equal((await f.authority.runs.timeline({ runId: 'R-one', limit: 20 })).entries.length, 2);
  assert.equal(
    (await f.authority.pagedEvents({ after: 0, limit: 20 })).events.filter(
      (event) => event.type === 'run.cancel-requested',
    ).length,
    1,
  );
});

test('timeline cursors bind project, run and immutable watermark before querying rows', async (t) => {
  const f = await fixture(t);
  await f.admit();
  const frozen = await f.authority.runs.timeline({ runId: 'R-one', limit: 1 });
  await f.authority.runs.transaction(command('cancel'), (tx) =>
    tx.requestCancel({ runId: 'R-one', now: 'later' }),
  );
  const oldPage = await f.authority.runs.timeline({
    runId: 'R-one',
    limit: 1,
    cursor: { version: 1, projectId: 'p', runId: 'R-one', after: 0, watermark: frozen.watermark },
  });
  assert.equal(oldPage.entries.length, 1);
  assert.equal(oldPage.entries[0].type, 'run.queued');
  assert.equal(oldPage.next, undefined);
  const first = await f.authority.runs.timeline({ runId: 'R-one', limit: 1 });
  assert.ok(first.next);
  const second = await f.authority.runs.timeline({ runId: 'R-one', limit: 1, cursor: first.next });
  assert.equal(second.entries[0].type, 'run.cancel-requested');
  assert.equal(second.watermark, first.watermark);
  await assert.rejects(
    f.authority.runs.timeline({ runId: 'R-other', limit: 1, cursor: first.next }),
    { code: 'INVALID_RUN_CURSOR' },
  );
  await assert.rejects(
    f.authority.runs.timeline({
      runId: 'R-one',
      limit: 1,
      cursor: { ...first.next!, projectId: 'another-project' },
    }),
    { code: 'INVALID_RUN_CURSOR' },
  );
  await assert.rejects(
    f.authority.runs.timeline({ runId: 'R-one', limit: RUN_TIMELINE_PAGE_MAX + 1 }),
    { code: 'INVALID_RUN_CURSOR' },
  );
});

test('a failed admission transaction rolls back goal links, missing roles, current, timeline and receipt', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.authority.runs.transaction(command('admit'), (tx) => {
      tx.admit(f.proposal, f.workflow);
      throw Error('Injected rollback');
    }),
    /Injected rollback/,
  );
  assert.equal((await f.authority.entities.goal('G-one'))?.status, 'draft');
  assert.equal(await f.authority.entities.role('coordinator'), undefined);
  assert.equal(await f.authority.entities.role('reviewer'), undefined);
  assert.equal(await f.authority.runs.current('R-one'), undefined);
  assert.equal(await f.authority.runs.receipt(command('admit')), undefined);
  assert.equal(await f.authority.settings.hasActiveRun(), false);
  await assert.rejects(f.authority.runs.timeline({ runId: 'R-one', limit: 10 }), {
    code: 'NOT_FOUND',
  });
  assert.equal(
    (await f.authority.pagedEvents({ after: 0, limit: 20 })).events.length,
    1,
    'Only the prior goal creation was committed.',
  );
  await f.admit();
  assert.equal((await f.authority.runs.current('R-one'))?.status, 'queued');
});

test('saved user roles and model preferences stay frozen in admission after later team edits', async (t) => {
  const f = await fixture(t);
  const custom: Role = {
    id: 'coordinator',
    version: 1,
    title: 'My coordinator',
    description: 'User role',
    instructions: 'Preserve my exact instructions',
    kind: 'coordination',
    provenance: { origin: 'user' },
    runtimePreference: { mode: 'fixed', runtimeId: 'fake' },
    createdAt: now,
    updatedAt: now,
  };
  await f.authority.entities.transaction(command('user-role'), (tx) => tx.appendRole(custom, 0));
  await f.admit();
  await f.authority.entities.transaction(command('new-role-version'), (tx) =>
    tx.appendRole({ ...custom, version: 2, instructions: 'Future instructions' }, 1),
  );
  const event = (await f.authority.pagedEvents({ after: 0, limit: 20 })).events.find(
    (entry) => entry.type === 'run.admitted',
  );
  if (event?.type !== 'run.admitted') throw Error('Missing admission');
  const saved = event.admission.roleSnapshots.find((role) => role.id === 'coordinator')!;
  assert.equal(saved.version, 1);
  assert.equal(saved.instructions, custom.instructions);
  assert.deepEqual(saved.runtimePreference, custom.runtimePreference);
  assert.equal(event.admission.roleResources.coordinator.source, 'fixed');
  assert.deepEqual(
    event.roles?.map((role) => role.id),
    ['reviewer'],
  );
  let retained!: RunTransaction;
  await f.authority.runs.transaction(command('capture'), (tx) => {
    retained = tx;
    return tx.current('R-one');
  });
  assert.throws(() => retained.requestCancel({ runId: 'R-one', now }), {
    code: 'USAGE_TRANSACTION_CLOSED',
  });
});
