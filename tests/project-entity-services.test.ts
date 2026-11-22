import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoalService, RoleService } from '../core/services.ts';
import type { ProjectStore, ProjectRegistry } from '../core/ports.ts';
import type { CreateGoal, Goal, Role, Run, ContextMaterial } from '../protocol/domain.ts';
import type { ProjectEntities } from '../core/project-entities.ts';
import type { UsageAuthorityTransaction } from '../core/usage-authority.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { sampleRun } from './fixtures/sample-run.ts';
import {
  seedEntityIndexes,
  failRoleHeadInsert,
  type RunReferenceFixture,
} from './fixtures/sqlite-entity-index.ts';

const command = (id: string) => ({ id, fingerprint: 'fp:' + id });
const request = (input: Partial<CreateGoal> = {}): CreateGoal => ({
  projectId: 'project',
  title: 'Improve the API',
  body: 'Preserve existing behavior.',
  criteria: 'Registered checks pass.',
  ...input,
});
const role = (id = 'specialist'): Role => ({
  id,
  version: 1,
  title: 'Project specialist',
  description: 'Understands the component.',
  instructions: 'Respect the user’s precise project instructions.',
  kind: 'implementation',
  runtimePreference: { mode: 'fixed', runtimeId: 'chosen-model' },
  provenance: {
    origin: 'workflow',
    workflow: { id: 'custom', revision: 'workflow-v1' },
    template: { id: 'specialist', revision: 'template-v3' },
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const goal = (id: string): Goal => ({
  ...request(),
  id,
  status: 'draft',
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const material = (id: string, active: boolean): ContextMaterial => ({
  id,
  active,
  scope: 'goal',
  name: id + '.txt',
  mimeType: 'text/plain',
  size: 1,
  hash: 'a'.repeat(64),
  relativePath: 'local/context/' + 'a'.repeat(64) + '.txt',
  createdAt: '2026-01-01T00:00:00.000Z',
});

async function fixture(t: any, kind: 'file' | 'sqlite') {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-entity-ports-')));
  const directory = path.join(base, kind),
    root = path.join(base, 'source');
  await fs.mkdir(root);
  await fs.mkdir(directory);
  if (kind === 'sqlite')
    await fs.writeFile(path.join(directory, '.entity-index-fixture'), 'synthetic-only');
  const project = { id: 'project', name: 'Entity fixture', root };
  const queryRows: { operation: string; rows: number }[] = [];
  let file: FileProjectStore | undefined, sql: SqliteProjectUsageAuthority | undefined;
  const open = async () => {
    if (kind === 'file') file = await FileProjectStore.open({ directory, project });
    else
      sql = await SqliteProjectUsageAuthority.open({
        directory,
        project,
        onQuery: (query) => queryRows.push(query),
      });
  };
  const close = () => (kind === 'file' ? file!.close() : sql!.close());
  await open();
  t.after(async () => {
    await close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const entities = (): ProjectEntities => (kind === 'file' ? file!.entities : sql!.entities);
  const registry: ProjectRegistry = {
    get(id) {
      assert.equal(id, project.id);
      return {
        get entities() {
          return entities();
        },
        snapshot() {
          throw Error('Goal/Role services must not load legacy snapshots.');
        },
        transact() {
          throw Error('Goal/Role services must consume the entity port.');
        },
        receipt() {
          throw Error('The entity authority owns command receipts.');
        },
        subscribe() {
          throw Error('No legacy subscription is required by these services.');
        },
        close,
      } as ProjectStore;
    },
    list() {
      throw Error('These use cases do not enumerate projects.');
    },
  };
  let ids = 0,
    ticks = 0,
    seeds = 0;
  const env = {
    projects: registry,
    id: () => 'goal-' + ++ids,
    now: () => new Date(Date.UTC(2026, 0, 1) + ++ticks * 1000).toISOString(),
  };
  async function history(input: {
    materialIds?: { id: string; active: boolean }[];
    runs?: RunReferenceFixture[];
  }) {
    if (sql)
      await seedEntityIndexes(directory, {
        materialIds: input.materialIds?.map((item) => item.id),
        runs: input.runs,
      });
    else
      await file!.transact('seed:' + ++seeds, 'seed:' + seeds, (doc) => {
        if (input.materialIds)
          doc.contextMaterials = input.materialIds.map((item) => material(item.id, item.active));
        if (input.runs) {
          const rows = input.runs.map((reference): Run => {
            const row = sampleRun();
            row.id = reference.id;
            row.goalId = reference.goalId;
            row.status = reference.status;
            row.commit = reference.commit;
            // These fixtures establish reference/busy lookup facts, not private code acceptance.
            row.agents = [];
            row.events = [];
            row.independentReviewer = false;
            row.baseline = { passed: 0, total: 0, results: [] };
            row.acceptance = { passed: 0, total: 0, results: [] };
            delete row.review;
            row.delivery = reference.deliveryBusy
              ? {
                  kind: 'pull-request',
                  status: 'pending',
                  commit: reference.commit || '',
                  summary: 'Pending reference fixture',
                  updatedAt: row.createdAt,
                }
              : undefined;
            row.preview = reference.previewBusy
              ? { status: 'running', components: [], updatedAt: row.createdAt }
              : undefined;
            return row;
          });
          const changed = new Set(rows.map((row) => row.id));
          doc.runs = [...rows.reverse(), ...doc.runs.filter((row) => !changed.has(row.id))];
          const goal = doc.goals.find((item) => item.id === doc.runs[0]?.goalId);
          if (goal)
            return { result: null, change: { type: 'run.changed', run: doc.runs[0], goal } };
          // Reference-only fixtures have no current goal; do not fabricate a goal/acceptance event.
          return { result: null, change: { type: 'context.materials.added', materials: [] } };
        }
        return {
          result: null,
          change: { type: 'context.materials.added', materials: doc.contextMaterials || [] },
        };
      });
  }
  return {
    kind,
    directory,
    env,
    goals: new GoalService(env),
    roles: new RoleService(env),
    entities,
    get file() {
      return file;
    },
    get sql() {
      return sql;
    },
    queryRows,
    history,
    calls: () => ({ ids, ticks }),
    async reopen() {
      await close();
      await open();
    },
  };
}

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: actual goal use cases preserve material references, request replay and revision CAS through the narrow port`, async (t) => {
    const f = await fixture(t, kind);
    await f.history({
      materialIds: [
        { id: 'M-aa', active: true },
        { id: 'M-bb', active: false },
      ],
    });
    const input = request({ materialIds: ['M-aa', 'M-bb'] });
    const created = await f.goals.create('create', 'fp:create', input);
    assert.equal(created.revision, 1);
    assert.equal(created.status, 'draft');
    assert.deepEqual(created.materialIds, ['M-aa', 'M-bb']);
    const calls = f.calls();
    assert.deepEqual(await f.goals.create('create', 'fp:create', input), created);
    assert.deepEqual(f.calls(), calls);
    await assert.rejects(f.goals.create('create', 'different-fingerprint', input));
    await assert.rejects(
      f.goals.create('unknown-material', 'unknown-material', request({ materialIds: ['M-cc'] })),
      { code: 'CONTEXT_NOT_FOUND' },
    );
    const edited = await f.goals.update('edit', 'fp:edit', {
      ...request({ title: 'Edited title' }),
      id: created.id,
      expectedRevision: 1,
    });
    assert.equal(edited.revision, 2);
    assert.deepEqual(edited.materialIds, created.materialIds);
    await assert.rejects(
      f.goals.update('stale', 'fp:stale', { ...input, id: created.id, expectedRevision: 1 }),
      { code: 'CONFLICT' },
    );
    const detached = await f.entities().goal(created.id);
    detached!.title = 'Changed by the caller';
    assert.equal((await f.entities().goal(created.id))!.title, 'Edited title');
    const updated = await f.goals.update('materials', 'fp:materials', {
      ...request({ materialIds: ['M-bb', 'M-bb'] }),
      id: created.id,
      expectedRevision: 2,
    });
    assert.deepEqual(updated.materialIds, ['M-bb']);
    const cleared = await f.goals.update('clear-materials', 'fp:clear-materials', {
      ...request({ materialIds: [] }),
      id: created.id,
      expectedRevision: 3,
    });
    assert.deepEqual(cleared.materialIds, []);
    await f.reopen();
    assert.deepEqual(await f.entities().goal(created.id), cleared);
    const deleted = await f.goals.delete('delete', 'fp:delete', {
      projectId: 'project',
      id: created.id,
    });
    assert.deepEqual(deleted, { id: created.id });
    assert.equal(await f.entities().goal(created.id), undefined);
    assert.deepEqual(await f.goals.create('create', 'fp:create', input), created);
    assert.equal(
      await f.entities().goal(created.id),
      undefined,
      'Old request replay must not resurrect a deleted goal.',
    );
  });

  test(`${kind}: user edits preserve model preferences, generated lineage and immutable historical role versions`, async (t) => {
    const f = await fixture(t, kind);
    const original = role();
    await f.entities().transaction(command('template-role'), (tx) => tx.appendRole(original, 0));
    const edited = await f.roles.save('user-edit', 'fp:user-edit', {
      projectId: 'project',
      id: original.id,
      expectedVersion: 1,
      title: 'My specialist',
      description: 'Custom use case.',
      instructions: 'Only these exact user instructions.',
      kind: 'implementation',
    });
    assert.equal(edited.version, 2);
    assert.equal(edited.provenance.origin, 'user');
    assert.deepEqual(edited.provenance.workflow, original.provenance.workflow);
    assert.deepEqual(
      'template' in edited.provenance && edited.provenance.template,
      'template' in original.provenance && original.provenance.template,
    );
    assert.equal(edited.instructions, 'Only these exact user instructions.');
    assert.deepEqual(edited.runtimePreference, original.runtimePreference);
    assert.equal(edited.createdAt, original.createdAt);
    const beforeReplay = f.calls();
    assert.deepEqual(
      await f.roles.save('user-edit', 'fp:user-edit', {
        projectId: 'project',
        id: original.id,
        expectedVersion: 1,
        title: 'My specialist',
        description: 'Custom use case.',
        instructions: 'Only these exact user instructions.',
        kind: 'implementation',
      }),
      edited,
    );
    assert.deepEqual(f.calls(), beforeReplay);
    await assert.rejects(
      f.roles.save('stale-role', 'stale-role', {
        projectId: 'project',
        id: original.id,
        expectedVersion: 1,
        title: 'Stale overwrite',
        description: 'Stale.',
        instructions: 'Must not replace v2.',
        kind: 'general',
      }),
      { code: 'CONFLICT' },
    );
    const preferred = await f.roles.save('prefer-model', 'prefer-model', {
      projectId: 'project',
      id: original.id,
      expectedVersion: 2,
      title: edited.title,
      description: edited.description,
      instructions: edited.instructions,
      kind: edited.kind,
      runtimePreference: { mode: 'prefer', runtimeId: 'another-model' },
    });
    assert.deepEqual(preferred.runtimePreference, { mode: 'prefer', runtimeId: 'another-model' });
    const automatic = await f.roles.save('clear-pin', 'clear-pin', {
      projectId: 'project',
      id: original.id,
      expectedVersion: 3,
      title: edited.title,
      description: edited.description,
      instructions: edited.instructions,
      kind: edited.kind,
      runtimePreference: { mode: 'auto' },
    });
    assert.deepEqual(automatic.runtimePreference, { mode: 'auto' });
    await f.reopen();
    assert.deepEqual(await f.entities().role(original.id, 1), original);
    assert.deepEqual(await f.entities().role(original.id, 2), edited);
    assert.deepEqual(await f.entities().role(original.id, 3), preferred);
    const current = await f.entities().role(original.id);
    current!.instructions = 'Caller mutation';
    assert.deepEqual(await f.entities().role(original.id), automatic);
    await assert.rejects(
      f
        .entities()
        .transaction(command('rewrite-old'), (tx) =>
          tx.appendRole({ ...original, instructions: 'Tampered original' }, 0),
        ),
      { code: 'CONFLICT' },
    );
    assert.deepEqual(await f.entities().role(original.id, 1), original);
  });

  test(`${kind}: concurrent user saves with one expected version cannot overwrite the winning instructions`, async (t) => {
    const f = await fixture(t, kind);
    const base = {
      projectId: 'project',
      id: 'user_role',
      expectedVersion: 0,
      title: 'User role',
      description: 'User authored.',
      kind: 'general' as const,
    };
    const results = await Promise.allSettled([
      f.roles.save('left', 'left', {
        ...base,
        instructions: 'Left instructions',
        runtimePreference: { mode: 'fixed', runtimeId: 'left-model' },
      }),
      f.roles.save('right', 'right', {
        ...base,
        instructions: 'Right instructions',
        runtimePreference: { mode: 'prefer', runtimeId: 'right-model' },
      }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const winner = results.find((result) => result.status === 'fulfilled')!;
    if (winner.status !== 'fulfilled') assert.fail('A role save must win.');
    assert.deepEqual(await f.entities().role(base.id), winner.value);
    assert.equal(await f.entities().role(base.id, 2), undefined);
  });

  test(`${kind}: parent references require a completed stored status and commit, not merely an existing run ID`, async (t) => {
    const f = await fixture(t, kind);
    await f.history({
      runs: [
        { id: 'R-no-commit', status: 'completed' },
        { id: 'R-failed', status: 'failed', commit: 'b'.repeat(40) },
        { id: 'R-parent', status: 'completed', commit: 'c'.repeat(40) },
      ],
    });
    for (const parent of ['R-missing', 'R-no-commit', 'R-failed'])
      await assert.rejects(
        f.goals.create('bad:' + parent, parent, request({ parentRunId: parent })),
        { code: 'INVALID_PARENT' },
      );
    const child = await f.goals.create('child', 'child', request({ parentRunId: 'R-parent' }));
    assert.equal(child.parentRunId, 'R-parent');
    assert.equal(child.status, 'draft');
    await assert.rejects(
      f.goals.update('bad-update', 'bad-update', {
        ...request({ parentRunId: 'R-no-commit' }),
        id: child.id,
        expectedRevision: 1,
      }),
      { code: 'INVALID_PARENT' },
    );
    assert.deepEqual(await f.entities().goal(child.id), child);
  });

  test(`${kind}: an older busy result behind 1000 later history rows blocks deletion while settled results do not`, async (t) => {
    const f = await fixture(t, kind);
    const target = await f.goals.create('target', 'target', request());
    const oldest: RunReferenceFixture = {
      id: 'R-old-busy',
      goalId: target.id,
      status: 'completed',
      commit: 'd'.repeat(40),
      deliveryBusy: true,
    };
    await f.history({
      runs: [
        oldest,
        ...Array.from({ length: 1000 }, (_value, index) => ({
          id: 'R-new-' + index,
          goalId: target.id,
          status: 'completed' as const,
          commit: 'e'.repeat(40),
        })),
      ],
    });
    if (f.file)
      assert.equal(
        f.file
          .snapshot()
          .runs.slice(0, 50)
          .some((row) => row.id === oldest.id),
        false,
      );
    f.queryRows.length = 0;
    await assert.rejects(
      f.goals.delete('busy-delivery', 'busy-delivery', { projectId: 'project', id: target.id }),
      { code: 'RESULT_BUSY' },
    );
    if (f.sql) {
      const queried = f.queryRows.filter((query) => query.operation === 'goal.busy-result');
      assert.ok(queried.length > 0);
      assert.ok(queried.every((query) => query.rows === 1));
    }
    await f.history({ runs: [{ ...oldest, deliveryBusy: false, previewBusy: true }] });
    await assert.rejects(
      f.goals.delete('busy-preview', 'busy-preview', { projectId: 'project', id: target.id }),
      { code: 'RESULT_BUSY' },
    );
    await f.history({ runs: [{ ...oldest, deliveryBusy: false, previewBusy: false }] });
    assert.deepEqual(
      await f.goals.delete('settled', 'settled', { projectId: 'project', id: target.id }),
      { id: target.id },
    );
    assert.equal(await f.entities().goal(target.id), undefined);
  });
}

test('SQL entity and usage facets commit or roll back together, retain one receipt namespace and publish one ordered event stream', async (t) => {
  const f = await fixture(t, 'sqlite');
  const selected = { kind: 'run' as const, runId: 'usage-owner' };
  const policy = {
    version: 1 as const,
    maxRequests: 5,
    maxReservedOutputTokens: 100,
    maxToolCalls: 5,
    reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
  };
  const change = (tx: UsageAuthorityTransaction) => {
    tx.entities.createGoal(goal('G-atomic'));
    tx.entities.appendRole(role('atomic_role'), 0);
    tx.usage.createAccount(selected, { id: 'usage-account', policy });
    tx.usage.admitGeneration(selected, {
      accountId: 'usage-account',
      operationId: 'generation',
      phase: 'work',
      requestedOutputTokens: 10,
      minimumOutputTokens: 1,
    });
    return { id: 'G-atomic' };
  };
  await assert.rejects(
    f.sql!.transaction(command('atomic'), (tx) => {
      change(tx);
      throw Error('Rollback all facets.');
    }),
    /Rollback all facets/,
  );
  assert.equal(await f.entities().goal('G-atomic'), undefined);
  assert.equal(await f.entities().role('atomic_role'), undefined);
  assert.equal(await f.sql!.account(selected), undefined);
  assert.deepEqual((await f.sql!.pagedEvents({ after: 0, limit: 10 })).events, []);
  const committed = await f.sql!.transaction(command('atomic'), change);
  await f.reopen();
  assert.equal((await f.entities().goal('G-atomic'))!.revision, 1);
  assert.equal((await f.entities().role('atomic_role'))!.version, 1);
  assert.equal((await f.sql!.account(selected))!.admitted.work.requests, 1);
  const page = await f.sql!.pagedEvents({ after: 0, limit: 10 });
  assert.deepEqual(
    page.events.map((event) => event.type),
    ['goal.created', 'role.saved', 'usage.changed', 'usage.changed'],
  );
  assert.deepEqual(
    page.events.map((event) => event.sequence),
    [1, 2, 3, 4],
  );
  const replay = await f.entities().transaction(command('atomic'), () => {
    throw Error('A facet must replay the same outer receipt.');
  });
  assert.deepEqual(replay, committed);
  assert.equal((await f.sql!.pagedEvents({ after: 0, limit: 10 })).watermark, page.watermark);
});

test('a caught physical role-head failure cannot commit orphan role versions, entity changes, usage charges or its command receipt', async (t) => {
  const f = await fixture(t, 'sqlite');
  const owner = { kind: 'run' as const, runId: 'owner' };
  await f.sql!.transaction(command('account'), (tx) =>
    tx.usage.createAccount(owner, {
      id: 'account',
      policy: {
        version: 1,
        maxRequests: 5,
        maxReservedOutputTokens: 100,
        maxToolCalls: 5,
        reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
      },
    }),
  );
  const before = await f.sql!.account(owner),
    watermark = (await f.sql!.pagedEvents({ after: 0, limit: 10 })).watermark;
  const attempt = () =>
    f.sql!.transaction(command('caught-failure'), (tx) => {
      tx.entities.createGoal(goal('G-before-fault'));
      tx.usage.admitGeneration(owner, {
        accountId: 'account',
        operationId: 'generation',
        phase: 'work',
        requestedOutputTokens: 10,
        minimumOutputTokens: 1,
      });
      try {
        tx.entities.appendRole(role('fault_role'), 0);
      } catch {}
      return 'caught';
    });
  await failRoleHeadInsert(f.directory, true);
  await assert.rejects(attempt());
  assert.equal(await f.entities().goal('G-before-fault'), undefined);
  assert.equal(await f.entities().role('fault_role', 1), undefined);
  assert.equal(await f.entities().role('fault_role'), undefined);
  assert.equal(await f.sql!.operation(owner, 'generation'), undefined);
  assert.deepEqual(await f.sql!.account(owner), before);
  assert.deepEqual((await f.sql!.pagedEvents({ after: watermark, limit: 10 })).events, []);
  await failRoleHeadInsert(f.directory, false);
  assert.equal(await attempt(), 'caught');
  await f.reopen();
  assert.equal((await f.entities().role('fault_role', 1))!.version, 1);
  assert.equal((await f.entities().goal('G-before-fault'))!.revision, 1);
  assert.equal((await f.sql!.account(owner))!.admitted.work.requests, 1);
  assert.equal((await f.sql!.pagedEvents({ after: watermark, limit: 10 })).events.length, 3);
});
