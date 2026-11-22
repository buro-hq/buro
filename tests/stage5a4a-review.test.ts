import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import { ExecutionService } from '../core/execution.ts';
import { executionPolicy } from '../core/project-settings.ts';
import type { RunAdmissionProposal } from '../core/project-runs.ts';
import type { ProjectStore, AgentRuntime } from '../core/ports.ts';
import type { WorkspacePort, CheckPort } from '../core/execution-ports.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

const now = '2026-11-22T00:00:00Z';
const command = (id: string) => ({ id, fingerprint: id });
async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-stage5a4a-review-')),
  );
  const marker = path.join(directory, '.synthetic-only');
  await fs.writeFile(marker, 'synthetic-only');
  const project = { id: 'p', name: 'Independent queue review', root: directory };
  const profile = ProjectProfileSchema.parse({
    version: 1,
    revision: 1,
    context: 'Synthetic queue-only proof',
    scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
    checks: [{ id: 'test', title: 'Tests', command: 'must-not-execute', timeoutMs: 1000 }],
    defaultCheckIds: ['test'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    maxRepairs: 0,
    turnTimeoutMs: 10000,
  });
  const reads: { operation: string; rows: number }[] = [];
  const authority = await SqliteProjectUsageAuthority.open({
    directory,
    project,
    profile,
    onQuery: (q) => {
      reads.push(q);
    },
  });
  const goal = await authority.entities.transaction(command('goal'), (tx) =>
    tx.createGoal({
      id: 'G-one',
      projectId: 'p',
      title: 'Synthetic task',
      body: 'Complete body',
      criteria: 'Exact criteria',
      status: 'draft',
      revision: 1,
      createdAt: now,
    }),
  );
  const workflow = createBuiltinWorkflowRoles();
  const selection = fixtureExecutionSelection('fake', fixtureExecutionCapabilities());
  const proposal: RunAdmissionProposal = {
    runId: 'R-one',
    admissionId: 'A-one',
    attemptId: 'T-one',
    goalId: goal.id,
    now,
    expectedGoalRevision: 1,
    expectedProfileRevision: 1,
    policy: executionPolicy(profile),
    resources: selection.forProject('p'),
    workflow: workflow.workflow,
    repairCapabilities: { managedEnvironment: false, synchronizeDependencies: false },
  };
  let effects = 0,
    scheduled = 0;
  const forbidden = async (): Promise<never> => {
    effects++;
    throw Error('No external dispatch in queue proof');
  };
  const store = {
    project: authority.project,
    runs: authority.runs,
    entities: authority.entities,
    settings: authority.settings,
    snapshot() {
      throw Error('No history hydration');
    },
    transact() {
      throw Error('No legacy transaction');
    },
    receipt() {
      throw Error('No legacy receipt');
    },
  } as ProjectStore;
  const service = new ExecutionService({
    projects: {
      get: (id) => {
        assert.equal(id, 'p');
        return store;
      },
      list: () => [project],
    },
    policies: { p: executionPolicy(profile) },
    selection,
    workflowRoles: workflow,
    runtime: {
      id: 'fake',
      start: forbidden,
      submit: forbidden,
      interrupt: forbidden,
      dispose: async () => {},
    } as AgentRuntime,
    workspaces: { prepare: forbidden } as WorkspacePort,
    checks: { run: forbidden } as CheckPort,
    now: () => now,
    id: () => 'core',
  });
  service.schedule = () => {
    scheduled++;
  };
  t.after(async () => {
    await service.dispose();
    await authority.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const database = async <T>(use: (db: DatabaseSync) => T): Promise<T> => {
    assert.ok(path.basename(directory).startsWith('buro-stage5a4a-review-'));
    assert.equal(await fs.realpath(directory), directory);
    assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic-only');
    const file = path.join(directory, 'authority.sqlite');
    assert.equal(await fs.realpath(file), file);
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA foreign_keys=ON;');
      return use(db);
    } finally {
      db.close();
    }
  };
  return {
    authority,
    goal,
    workflow,
    proposal,
    reads,
    database,
    service,
    effects: () => effects,
    scheduled: () => scheduled,
    admit: () => authority.runs.transaction(command('admit'), (tx) => tx.admit(proposal, workflow)),
    events: () => authority.pagedEvents({ after: 0, limit: 100 }),
  };
}

for (const location of ['run_timeline', 'usage_events'] as const) {
  test(`SQL caught ${location} failure after goal link rolls back every admission row, role and receipt`, async (t) => {
    const f = await fixture(t);
    const before = await f.events();
    await f.database((db) =>
      db.exec(`CREATE TRIGGER fixture_write_failure BEFORE INSERT ON ${location}
      BEGIN SELECT RAISE(ABORT, 'synthetic late admission failure'); END;`),
    );
    let caught = false;
    await assert.rejects(
      f.authority.runs.transaction(command('admit'), (tx) => {
        try {
          tx.admit(f.proposal, f.workflow);
        } catch (error) {
          caught = true;
          assert.match(String(error), /synthetic late admission failure/);
        }
        return { runId: 'Must-not-be-a-success' };
      }),
      /synthetic late admission failure/,
    );
    assert.equal(caught, true);
    assert.deepEqual(await f.authority.entities.goal(f.goal.id), f.goal);
    assert.equal(await f.authority.entities.role('coordinator'), undefined);
    assert.equal(await f.authority.entities.role('reviewer'), undefined);
    assert.equal(await f.authority.runs.current('R-one'), undefined);
    assert.equal(await f.authority.runs.receipt(command('admit')), undefined);
    assert.equal(await f.authority.settings.hasActiveRun(), false);
    assert.deepEqual(await f.events(), before);
    await f.database((db) => {
      for (const table of [
        'run_current',
        'run_admissions',
        'run_attempts',
        'run_timeline',
        'project_run_index',
      ])
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
      db.exec('DROP TRIGGER fixture_write_failure');
    });
    await f.admit();
    assert.equal((await f.authority.runs.current('R-one'))?.status, 'queued');
    assert.equal((await f.events()).events.length, before.events.length + 1);
    assert.equal(f.effects(), 0);
  });
}

test('SQL caught cancellation index failure cannot leave a changed current row or stop receipt', async (t) => {
  const f = await fixture(t);
  await f.admit();
  const before = await f.events(),
    current = await f.authority.runs.current('R-one');
  await f.database((db) =>
    db.exec(`CREATE TRIGGER fixture_cancel_failure BEFORE UPDATE OF status ON project_run_index
    BEGIN SELECT RAISE(ABORT, 'synthetic cancel index failure'); END;`),
  );
  await assert.rejects(
    f.authority.runs.transaction(command('cancel'), (tx) => {
      try {
        tx.requestCancel({ runId: 'R-one', now: 'later' });
      } catch {
        /* Attempt to suppress storage failure. */
      }
      return { runId: 'R-one' };
    }),
    /synthetic cancel index failure/,
  );
  assert.deepEqual(await f.authority.runs.current('R-one'), current);
  assert.equal(await f.authority.runs.receipt(command('cancel')), undefined);
  assert.deepEqual(await f.events(), before);
  assert.equal((await f.authority.runs.timeline({ runId: 'R-one', limit: 10 })).entries.length, 1);
  await f.database((db) => {
    assert.equal(
      db.prepare('SELECT status FROM project_run_index WHERE run_id=?').get('R-one')!.status,
      'queued',
    );
    db.exec('DROP TRIGGER fixture_cancel_failure');
  });
  await f.authority.runs.transaction(command('cancel'), (tx) =>
    tx.requestCancel({ runId: 'R-one', now: 'later' }),
  );
  assert.equal((await f.authority.runs.current('R-one'))?.status, 'canceling');
  assert.equal(await f.authority.settings.hasActiveRun(), true);
  assert.equal(f.effects(), 0);
});

test('old unresolved index fact beyond 17409 newer facts blocks actual Core admission without loading history or dispatching', async (t) => {
  const f = await fixture(t);
  await f.database((db) => {
    // The operational writer is a later stage: seed only historical guard facts, never accepted Run aggregates.
    db.exec('BEGIN');
    const insert = db.prepare(
      'INSERT INTO project_run_index(run_id,goal_id,status,unresolved) VALUES (?,?,?,?)',
    );
    insert.run('old-unknown', f.goal.id, 'needs-attention', 1);
    for (let i = 0; i < 17409; i++) insert.run('newer-failed-' + i, null, 'failed', 0);
    db.exec('COMMIT');
    const detail = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT run_id FROM project_run_index WHERE goal_id=? AND unresolved=1 LIMIT 1',
      )
      .all(f.goal.id)
      .map((row) => row.detail)
      .join(' ');
    assert.match(detail, /SEARCH.*project_runs_unresolved.*goal_id=/);
  });
  const before = await f.events();
  f.reads.length = 0;
  await assert.rejects(f.service.start('start', 'start', { projectId: 'p', goalId: f.goal.id }), {
    code: 'RUN_RECONCILIATION_REQUIRED',
  });
  assert.deepEqual(await f.authority.entities.goal(f.goal.id), f.goal);
  assert.equal(await f.authority.entities.role('coordinator'), undefined);
  assert.equal(await f.authority.runs.current('R-core'), undefined);
  assert.equal(await f.authority.runs.receipt(command('start')), undefined);
  assert.deepEqual(await f.events(), before);
  assert.equal(f.scheduled(), 0);
  assert.equal(f.effects(), 0);
  assert.deepEqual(
    f.reads.filter((q) => q.operation === 'run.unresolved').map((q) => q.rows),
    [1],
  );
  assert.equal(
    f.reads.some((q) => q.operation === 'run.timeline.page'),
    false,
  );
  await f.database((db) =>
    db.prepare('UPDATE project_run_index SET unresolved=0 WHERE run_id=?').run('old-unknown'),
  );
  assert.deepEqual(await f.service.start('start', 'start', { projectId: 'p', goalId: f.goal.id }), {
    runId: 'R-core',
  });
  assert.equal(f.scheduled(), 1);
  assert.equal(f.effects(), 0);
});

test('large SQL timeline uses indexed late keyset pages and a frozen watermark with bounded returned rows', async (t) => {
  const f = await fixture(t);
  await f.admit();
  await f.database((db) => {
    db.exec('BEGIN');
    const insert = db.prepare(
      'INSERT INTO run_timeline(run_id,sequence,at,type,text) VALUES (?,?,?,?,?)',
    );
    for (let sequence = 2; sequence <= 17410; sequence++)
      insert.run('R-one', sequence, now, 'fixture.observation', 'Synthetic history');
    db.exec('COMMIT');
    const detail = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT sequence,at,type,text,thread_id,command_id,duration_ms FROM run_timeline WHERE run_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?',
      )
      .all('R-one', 17400, 17410, 8)
      .map((row) => row.detail)
      .join(' ');
    assert.match(detail, /SEARCH.*run_timeline.*run_id=.*sequence>/);
    assert.doesNotMatch(detail, /TEMP B-TREE/);
  });
  const frozen = await f.authority.runs.timeline({ runId: 'R-one', limit: 1 });
  assert.equal(frozen.watermark, 17410);
  await f.authority.runs.transaction(command('cancel'), (tx) =>
    tx.requestCancel({ runId: 'R-one', now: 'later' }),
  );
  f.reads.length = 0;
  const late = await f.authority.runs.timeline({
    runId: 'R-one',
    limit: 7,
    cursor: {
      version: 1,
      projectId: 'p',
      runId: 'R-one',
      after: 17400,
      watermark: frozen.watermark,
    },
  });
  assert.deepEqual(
    late.entries.map((entry) => entry.sequence),
    [17401, 17402, 17403, 17404, 17405, 17406, 17407],
  );
  const tail = await f.authority.runs.timeline({ runId: 'R-one', limit: 7, cursor: late.next });
  assert.deepEqual(
    tail.entries.map((entry) => entry.sequence),
    [17408, 17409, 17410],
  );
  assert.equal(tail.watermark, frozen.watermark);
  assert.equal(tail.next, undefined);
  assert.deepEqual(
    f.reads.filter((q) => q.operation === 'run.timeline.page').map((q) => q.rows),
    [8, 3],
  );
  assert.equal(
    f.reads.some((q) => q.operation === 'event.page'),
    false,
  );
  const latest = await f.authority.runs.timeline({
    runId: 'R-one',
    limit: 7,
    cursor: { version: 1, projectId: 'p', runId: 'R-one', after: 17410, watermark: 17411 },
  });
  assert.equal(latest.entries[0].type, 'run.cancel-requested');
  assert.equal(f.effects(), 0);
});
