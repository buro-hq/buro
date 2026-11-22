import test from 'node:test';
import assert from 'node:assert/strict';
import type { Goal, Role } from '../protocol/domain.ts';
import {
  createEntityTransaction,
  validateProjectEntityChange,
  type EntityTransactionStorage,
  type ProjectEntityChange,
  type ParentRunReference,
} from '../core/project-entities.ts';

const initial: Goal = {
  id: 'goal',
  projectId: 'project',
  title: 'First',
  body: 'Body',
  criteria: 'Criteria',
  createdAt: 'now',
  status: 'draft',
  revision: 1,
};
const role: Role = {
  id: 'builder',
  version: 1,
  title: 'Builder',
  description: '',
  instructions: 'Keep user text.',
  kind: 'implementation',
  provenance: { origin: 'user' },
  createdAt: 'now',
  updatedAt: 'now',
};
function fixture() {
  const goals = new Map<string, Goal>(),
    versions = new Map<string, Role[]>(),
    materials = new Set<string>(),
    parents = new Map<string, ParentRunReference>(),
    busy = new Set<string>();
  const events: ProjectEntityChange[] = [];
  let active = true;
  const storage: EntityTransactionStorage = {
    goal: (id) => goals.get(id),
    role: (id, version) =>
      version === undefined
        ? versions.get(id)?.at(-1)
        : versions.get(id)?.find((r) => r.version === version),
    materialExists: (id) => materials.has(id),
    parentRun: (id) => parents.get(id),
    hasBusyResult: (id) => busy.has(id),
    insertGoal: (goal) => {
      assert.equal(goals.has(goal.id), false);
      goals.set(goal.id, goal);
    },
    replaceGoal: (previous, next) => {
      assert.deepEqual(goals.get(previous.id), previous);
      goals.set(next.id, next);
    },
    deleteGoal: (previous) => {
      assert.deepEqual(goals.get(previous.id), previous);
      goals.delete(previous.id);
    },
    insertRole: (role, expected) => {
      assert.equal(versions.get(role.id)?.at(-1)?.version || 0, expected);
      versions.set(role.id, [...(versions.get(role.id) || []), role]);
    },
    appendChange: (change) => {
      events.push(change);
    },
  };
  const tx = createEntityTransaction({
    projectId: 'project',
    storage,
    assertActive() {
      if (!active) throw Error('closed');
    },
  });
  return {
    tx,
    goals,
    versions,
    materials,
    parents,
    busy,
    events,
    close: () => {
      active = false;
    },
  };
}

test('entity semantic writes preserve goal references, edit fields and CAS without exposing storage', () => {
  const f = fixture();
  f.materials.add('inactive-known');
  f.parents.set('accepted', { id: 'accepted', status: 'completed', commit: 'commit' });
  const created = f.tx.createGoal({
    ...initial,
    materialIds: ['inactive-known'],
    parentRunId: 'accepted',
  });
  created.title = 'caller mutation';
  assert.equal(f.tx.goal('goal')?.title, 'First');
  const updated = f.tx.updateGoal('goal', 1, {
    title: 'Second',
    body: 'Body2',
    criteria: 'Criteria2',
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.createdAt, 'now');
  assert.equal(updated.parentRunId, undefined);
  assert.deepEqual(updated.materialIds, ['inactive-known']);
  assert.equal(updated.repairEnvironment, false);
  assert.throws(() => f.tx.updateGoal('goal', 1, { title: 'Stale', body: '', criteria: '' }), {
    code: 'CONFLICT',
  });
  assert.equal(f.events.length, 2);
  assert.equal('storage' in f.tx, false);
  assert.throws(
    () =>
      f.tx.updateGoal('goal', 2, {
        title: 'Forged',
        body: '',
        criteria: '',
        status: 'completed',
      } as never),
    { code: 'INVALID_PROJECT_ENTITY' },
  );
});

test('goal creation rejects missing materials before invalid parent and deletion only rejects actual busy results', () => {
  const f = fixture();
  assert.throws(
    () => f.tx.createGoal({ ...initial, materialIds: ['missing'], parentRunId: 'missing' }),
    { code: 'CONTEXT_NOT_FOUND' },
  );
  assert.throws(() => f.tx.createGoal({ ...initial, parentRunId: 'missing' }), {
    code: 'INVALID_PARENT',
  });
  f.tx.createGoal(initial);
  f.busy.add('goal');
  assert.throws(() => f.tx.deleteGoal('goal', 1), { code: 'RESULT_BUSY' });
  f.busy.clear();
  assert.deepEqual(f.tx.deleteGoal('goal', 1), { id: 'goal' });
  assert.equal(f.tx.goal('goal'), undefined);
});

test('immutable role versions append with expected head and public entity events validate project bindings', () => {
  const f = fixture();
  const created = f.tx.appendRole(role, 0);
  created.instructions = 'caller mutation';
  assert.equal(f.tx.role(role.id)?.instructions, 'Keep user text.');
  assert.throws(() => f.tx.appendRole({ ...role, version: 2 }, 0), { code: 'CONFLICT' });
  f.tx.appendRole({ ...role, version: 2, instructions: 'Second' }, 1);
  assert.equal(f.tx.role(role.id, 1)?.instructions, 'Keep user text.');
  assert.equal(f.tx.role(role.id)?.instructions, 'Second');
  assert.deepEqual(validateProjectEntityChange(f.events[0]), f.events[0]);
  assert.throws(
    () =>
      validateProjectEntityChange(
        { type: 'goal.created', goal: { ...initial, projectId: 'other' } },
        'project',
      ),
    { code: 'INVALID_PROJECT_ENTITY' },
  );
  assert.throws(() => validateProjectEntityChange({ type: 'role.saved', role, private: 'extra' }), {
    code: 'INVALID_PROJECT_ENTITY',
  });
  f.close();
  assert.throws(() => f.tx.role(role.id), /closed/);
  assert.throws(() => f.tx.createGoal(initial), /closed/);
});

test('a stored goal without its revision cannot masquerade as revision one during edit or delete CAS', () => {
  const f = fixture();
  f.tx.createGoal(initial);
  const malformed = { ...initial } as Partial<Goal>;
  delete malformed.revision;
  f.goals.set(initial.id, malformed as Goal);
  const before = structuredClone(f.events);
  assert.throws(
    () =>
      f.tx.updateGoal(initial.id, 1, {
        title: 'Changed',
        body: initial.body,
        criteria: initial.criteria,
      }),
    { code: 'INVALID_PROJECT_ENTITY' },
  );
  assert.throws(() => f.tx.deleteGoal(initial.id, 1), { code: 'INVALID_PROJECT_ENTITY' });
  assert.throws(
    () => validateProjectEntityChange({ type: 'goal.created', goal: malformed }, initial.projectId),
    { code: 'INVALID_PROJECT_ENTITY' },
  );
  assert.deepEqual(f.events, before);
  assert.deepEqual(f.goals.get(initial.id), malformed);
});
