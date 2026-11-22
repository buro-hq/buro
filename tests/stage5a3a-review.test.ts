import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GoalService, RoleService } from '../core/services.ts';
import type { ProjectRegistry, ProjectStore } from '../core/ports.ts';
import type { ProjectEntities } from '../core/project-entities.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';

const now = '2026-11-22T00:00:00Z';
async function fixture(t: any, kind: 'file' | 'sqlite') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-entity-review-')));
  const opened: { close(): Promise<void> }[] = [];
  t.after(async () => {
    await Promise.all(opened.map((item) => item.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const authorities = new Map<string, { entities: ProjectEntities; directory: string }>();
  for (const id of ['p', 'q']) {
    const directory = path.join(root, id);
    const authority =
      kind === 'file'
        ? await FileProjectStore.open({ directory, project: { id, name: id, root } })
        : await SqliteProjectUsageAuthority.open({ directory, projectId: id });
    opened.push(authority);
    authorities.set(id, { entities: authority.entities, directory });
  }
  let wrongFacet = false,
    sequence = 0;
  const registry: ProjectRegistry = {
    get(id) {
      const actual = authorities.get(wrongFacet && id === 'p' ? 'q' : id)!;
      return {
        entities: actual.entities,
        snapshot() {
          throw Error('Entity services must not consult document snapshots.');
        },
        transact() {
          throw Error('Entity services must not mutate document transactions.');
        },
        receipt() {
          throw Error('Entity authority owns receipts.');
        },
      } as unknown as ProjectStore;
    },
    list() {
      throw Error('Entity services must not enumerate projects.');
    },
  };
  const environment = { projects: registry, now: () => now, id: () => String(++sequence) };
  const receiptIds = async (id: string) => {
    const directory = authorities.get(id)!.directory;
    if (kind === 'file') {
      const doc = JSON.parse(await fs.readFile(path.join(directory, 'control-state.json'), 'utf8'));
      return Object.keys(doc.receipts).sort();
    }
    const database = new DatabaseSync(path.join(directory, 'authority.sqlite'), { readOnly: true });
    try {
      return database
        .prepare('SELECT command_id FROM command_receipts ORDER BY command_id')
        .all()
        .map((row) => String(row.command_id));
    } finally {
      database.close();
    }
  };
  return {
    authorities,
    receiptIds,
    goals: new GoalService(environment),
    roles: new RoleService(environment),
    mismatch: () => {
      wrongFacet = true;
    },
  };
}

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: a registry store cannot route a requested project into another project's entity facet`, async (t) => {
    const f = await fixture(t, kind);
    const goal = await f.goals.create('q-goal', 'q-goal', {
      projectId: 'q',
      title: 'Foreign goal',
      body: 'Keep this text',
      criteria: '',
    });
    const role = await f.roles.save('q-role', 'q-role', {
      projectId: 'q',
      id: 'specialist',
      expectedVersion: 0,
      title: 'Foreign role',
      description: 'Keep',
      instructions: 'Keep these instructions',
      kind: 'general',
    });
    const beforeReceipts = await f.receiptIds('q');
    f.mismatch();
    const calls = [
      () =>
        f.goals.create('wrong-create', 'wrong-create', {
          projectId: 'p',
          title: 'Wrong',
          body: '',
          criteria: '',
        }),
      () =>
        f.goals.update('wrong-update', 'wrong-update', {
          projectId: 'p',
          id: goal.id,
          expectedRevision: 1,
          title: 'Wrong',
          body: '',
          criteria: '',
        }),
      () => f.goals.delete('wrong-delete', 'wrong-delete', { projectId: 'p', id: goal.id }),
      () =>
        f.roles.save('wrong-edit-role', 'wrong-edit-role', {
          projectId: 'p',
          id: role.id,
          expectedVersion: 1,
          title: 'Wrong',
          description: '',
          instructions: 'Wrong',
          kind: 'general',
        }),
      () =>
        f.roles.save('wrong-create-role', 'wrong-create-role', {
          projectId: 'p',
          id: 'new_role',
          expectedVersion: 0,
          title: 'Wrong',
          description: '',
          instructions: 'Wrong',
          kind: 'general',
        }),
    ];
    for (const call of calls)
      await assert.rejects(Promise.resolve().then(call), { code: 'INVALID_PROJECT_ENTITY' });
    assert.deepEqual(await f.authorities.get('q')!.entities.goal(goal.id), goal);
    assert.deepEqual(await f.authorities.get('q')!.entities.role(role.id), role);
    assert.equal(await f.authorities.get('q')!.entities.role('new_role'), undefined);
    assert.deepEqual(await f.receiptIds('q'), beforeReceipts);
    assert.equal(await f.authorities.get('p')!.entities.goal(goal.id), undefined);
    assert.equal(await f.authorities.get('p')!.entities.role(role.id), undefined);
  });

  test(`${kind}: actual entity-backed use cases whitelist user fields instead of copying forged state and provenance`, async (t) => {
    const f = await fixture(t, kind);
    const goal = await f.goals.create('goal', 'goal', {
      projectId: 'p',
      title: 'User title',
      body: 'User body',
      criteria: 'User criteria',
      id: 'G-forged',
      revision: 999,
      createdAt: 'forged',
      status: 'running',
      runId: 'R-forged',
      provenance: { origin: 'coordinator' },
    } as any);
    assert.notEqual(goal.id, 'G-forged');
    assert.equal(goal.status, 'draft');
    assert.equal(goal.revision, 1);
    assert.equal(goal.createdAt, now);
    assert.equal(goal.runId, undefined);
    assert.equal('provenance' in goal, false);
    const edited = await f.goals.update('edit-goal', 'edit-goal', {
      projectId: 'p',
      id: goal.id,
      expectedRevision: 1,
      title: 'Edited',
      body: 'Edited body',
      criteria: '',
      status: 'completed',
      runId: 'R-forged',
      revision: 999,
      createdAt: 'forged',
    } as any);
    assert.equal(edited.status, 'draft');
    assert.equal(edited.revision, 2);
    assert.equal(edited.createdAt, now);
    assert.equal(edited.runId, undefined);
    const role = await f.roles.save('role', 'role', {
      projectId: 'p',
      id: 'specialist',
      expectedVersion: 0,
      title: 'User specialist',
      description: 'User description',
      instructions: 'User instructions',
      kind: 'general',
      runtimePreference: { mode: 'fixed', runtimeId: 'user-choice' },
      provenance: {
        origin: 'workflow',
        workflow: { id: 'forged', revision: 'v1' },
        template: { id: 'forged', revision: 'v1' },
      },
      version: 99,
      createdAt: 'forged',
      updatedAt: 'forged',
      capabilities: { immutableReview: true },
    } as any);
    assert.equal(role.version, 1);
    assert.deepEqual(role.provenance, { origin: 'user' });
    assert.equal(role.createdAt, now);
    assert.equal(role.updatedAt, now);
    assert.equal('capabilities' in role, false);
    assert.deepEqual(role.runtimePreference, { mode: 'fixed', runtimeId: 'user-choice' });
    assert.deepEqual(await f.authorities.get('p')!.entities.role(role.id), role);
  });
}
