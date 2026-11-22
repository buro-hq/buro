import test from 'node:test';
import assert from 'node:assert/strict';
import type { Goal, ProjectProfile, Role, ContextMaterial } from '../protocol/domain.ts';
import type {
  RunAdmission,
  RunAttempt,
  RunCurrent,
  RunTimelineEntry,
} from '../protocol/run-state.ts';
import {
  createRunTransaction,
  type ProjectRunChange,
  type RunTransactionStorage,
  type RunAdmissionProposal,
} from '../core/project-runs.ts';
import { executionPolicy } from '../core/project-settings.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import {
  fixtureExecutionSelection,
  fixtureExecutionCapabilities,
} from './fixtures/execution-resources.ts';

const profile: ProjectProfile = {
  version: 1,
  revision: 1,
  context: '',
  scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
  checks: [{ id: 'test', title: 'Tests', command: 'synthetic test', timeoutMs: 1000 }],
  defaultCheckIds: ['test'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 2,
  turnTimeoutMs: 10000,
};
const initialGoal: Goal = {
  id: 'goal',
  projectId: 'project',
  title: 'Goal',
  body: 'Full original task',
  criteria: 'Full original criteria',
  status: 'draft',
  revision: 1,
  createdAt: 'before',
};
function fixture() {
  const resolver = createBuiltinWorkflowRoles();
  let goal = structuredClone(initialGoal),
    storedProfile: ProjectProfile | undefined = structuredClone(profile),
    active = false,
    unresolved = false,
    live = true;
  const roles = new Map<string, Role>(),
    materials = new Map<string, ContextMaterial>(),
    currents = new Map<string, RunCurrent>(),
    admissions = new Map<string, RunAdmission>(),
    attempts = new Map<string, RunAttempt>();
  const timeline: RunTimelineEntry[] = [],
    events: ProjectRunChange[] = [];
  let writes = 0;
  const storage: RunTransactionStorage = {
    current: (id) => currents.get(id),
    goal: (id) => (id === goal.id ? goal : undefined),
    profile: () => storedProfile,
    role: (id) => roles.get(id),
    material: (id) => materials.get(id),
    activeProjectMaterials: () =>
      [...materials.values()].filter((m) => m.active && m.scope === 'project'),
    hasActiveRun: () => active,
    unresolvedForGoal: () => unresolved,
    parentRun: () => undefined,
    timeline: (query) => {
      const watermark = query.cursor?.watermark ?? timeline.length,
        filtered = timeline.filter(
          (item) =>
            item.runId === query.runId &&
            item.sequence > (query.cursor?.after ?? 0) &&
            item.sequence <= watermark,
        ),
        entries = filtered.slice(0, query.limit);
      return {
        entries,
        watermark,
        ...(filtered.length > entries.length
          ? {
              next: {
                version: 1 as const,
                projectId: 'project',
                runId: query.runId,
                after: entries.at(-1)!.sequence,
                watermark,
              },
            }
          : {}),
      };
    },
    insertCurrent: (current) => {
      currents.set(current.id, current);
      active = true;
      writes++;
    },
    insertAdmission: (admission) => {
      admissions.set(admission.id, admission);
      writes++;
    },
    insertAttempt: (attempt) => {
      attempts.set(attempt.id, attempt);
      writes++;
    },
    appendTimeline: (entry) => {
      timeline.push({ ...entry, sequence: timeline.length + 1 });
      writes++;
    },
    linkGoal: (previous, next) => {
      assert.deepEqual(goal, previous);
      goal = next;
      writes++;
    },
    appendRole: (role, expected) => {
      assert.equal(expected, 0);
      assert.equal(roles.has(role.id), false);
      roles.set(role.id, role);
      writes++;
    },
    replaceCurrent: (previous, next) => {
      assert.deepEqual(currents.get(previous.id), previous);
      currents.set(next.id, next);
      writes++;
    },
    appendChange: (change) => {
      events.push(change);
      writes++;
    },
  };
  const tx = createRunTransaction({
    projectId: 'project',
    storage,
    assertActive() {
      if (!live) throw Error('closed');
    },
  });
  const proposal = (): RunAdmissionProposal => ({
    runId: 'R-run',
    admissionId: 'admission',
    attemptId: 'attempt',
    goalId: goal.id,
    now: 'now',
    expectedGoalRevision: 1,
    expectedProfileRevision: 1,
    policy: executionPolicy(profile),
    resources: fixtureExecutionSelection('fixture', fixtureExecutionCapabilities()).forProject(
      'project',
    ),
    workflow: resolver.workflow,
    repairCapabilities: { managedEnvironment: false, synchronizeDependencies: false },
  });
  return {
    tx,
    resolver,
    proposal,
    roles,
    materials,
    currents,
    admissions,
    attempts,
    timeline,
    events,
    writes: () => writes,
    goal: () => goal,
    setGoal: (value: Goal) => {
      goal = value;
    },
    setProfile: (value: ProjectProfile | undefined) => {
      storedProfile = value;
    },
    busy: (value: boolean) => {
      active = value;
    },
    unknown: (value: boolean) => {
      unresolved = value;
    },
    close: () => {
      live = false;
    },
  };
}

test('actual queue admission captures full task, current roles and grants before the first write', () => {
  const f = fixture();
  assert.deepEqual(f.tx.admit(f.proposal(), f.resolver), { runId: 'R-run' });
  const admission = f.admissions.get('admission')!;
  assert.equal(
    admission.goalText,
    'Full original task\n\nAcceptance criteria:\nFull original criteria',
  );
  assert.equal(admission.planningPolicy.runtimeId, 'fixture');
  assert.equal(f.goal().status, 'running');
  assert.equal(f.goal().runId, 'R-run');
  assert.equal(f.roles.size, 2);
  assert.equal(f.attempts.get('attempt')?.reason, 'initial');
  assert.equal(f.events[0].type, 'run.admitted');
  assert.equal('events' in f.currents.get('R-run')!, false);
  assert.equal('agents' in f.currents.get('R-run')!, false);
  assert.equal(f.timeline[0].type, 'run.queued');
});

test('indexed unresolved work, profile/goal changes and resource ineligibility reject with zero side effects', () => {
  for (const prepare of [
    (f: ReturnType<typeof fixture>) => f.unknown(true),
    (f: ReturnType<typeof fixture>) => f.busy(true),
    (f: ReturnType<typeof fixture>) => f.setGoal({ ...initialGoal, revision: 2 }),
    (f: ReturnType<typeof fixture>) => f.setProfile({ ...profile, revision: 2 }),
  ]) {
    const f = fixture();
    prepare(f);
    assert.throws(() => f.tx.admit(f.proposal(), f.resolver));
    assert.equal(f.writes(), 0);
    assert.equal(f.roles.size, 0);
  }
  const f = fixture(),
    proposal = f.proposal();
  proposal.resources.coordinator.capabilities.toolsFreeTurns = false;
  proposal.resources.coordinator.capabilities.readOnlySessions = false;
  assert.throws(() => f.tx.admit(proposal, f.resolver));
  assert.equal(f.writes(), 0);
  assert.equal(f.roles.size, 0);
});

test('the latest user role preference and inactive selected material are captured without rewriting them', () => {
  const f = fixture();
  const coordinator = f.resolver.resolveRole(
    undefined,
    {
      id: 'goal.coordination',
      label: 'Coordination',
      purpose: 'coordination',
      roles: { kind: 'fixed', roleId: 'coordinator' },
      requirements: { structuredTurns: true },
    } as never,
    'before',
  ).role;
  const user = {
    ...coordinator,
    version: 2,
    instructions: 'Exact user instructions',
    provenance: { origin: 'user' as const },
    runtimePreference: { mode: 'fixed' as const, runtimeId: 'fixture' },
  };
  f.roles.set('coordinator', user);
  const hash = 'a'.repeat(64),
    material: ContextMaterial = {
      id: 'M-abcd',
      name: 'Removed reference',
      size: 1,
      mimeType: 'text/plain',
      hash,
      relativePath: `local/context/${hash}.txt`,
      scope: 'goal',
      active: false,
      createdAt: 'before',
    };
  f.materials.set(material.id, material);
  f.setGoal({ ...initialGoal, materialIds: [material.id] });
  f.tx.admit(f.proposal(), f.resolver);
  const admission = f.admissions.get('admission')!;
  assert.deepEqual(
    admission.roleSnapshots.find((role) => role.id === 'coordinator'),
    user,
  );
  assert.deepEqual(admission.contextMaterials, [material]);
  assert.deepEqual(f.roles.get('coordinator'), user);
  assert.equal(admission.roleResources.coordinator.source, 'fixed');
});

test('cancel is a single state transition and timeline cursors are bound before any row read', () => {
  const f = fixture();
  f.tx.admit(f.proposal(), f.resolver);
  f.tx.requestCancel({ runId: 'R-run', now: 'cancel-now' });
  const count = f.writes();
  f.tx.requestCancel({ runId: 'R-run', now: 'again' });
  assert.equal(f.writes(), count);
  assert.equal(f.tx.current('R-run')?.status, 'canceling');
  const first = f.tx.timeline({ runId: 'R-run', limit: 1 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.next?.watermark, 2);
  const second = f.tx.timeline({ runId: 'R-run', limit: 1, cursor: first.next });
  assert.equal(second.entries[0].type, 'run.cancel-requested');
  assert.throws(() => f.tx.timeline({ runId: 'other', limit: 1, cursor: first.next }), {
    code: 'INVALID_RUN_CURSOR',
  });
  assert.throws(
    () =>
      f.tx.timeline({ runId: 'R-run', limit: 1, cursor: { ...first.next!, projectId: 'foreign' } }),
    { code: 'INVALID_RUN_CURSOR' },
  );
  f.close();
  assert.throws(() => f.tx.current('R-run'), /closed/);
  assert.throws(() => f.tx.admit(f.proposal(), f.resolver), /closed/);
});

test('a matching embedded profile cannot hide relaxed top-level execution rules', () => {
  const strict: ProjectProfile = {
    ...profile,
    scope: { mode: 'strict', plannedPaths: ['src/'], protectedPaths: ['AGENTS.md'] },
  };
  const changes: ((policy: RunAdmissionProposal['policy']) => void)[] = [
    (policy) => {
      policy.scope.mode = 'advisory';
    },
    (policy) => {
      policy.scope.protectedPaths = [];
    },
    (policy) => {
      policy.checks = [{ id: 'replacement', title: 'Replacement check' }];
      policy.defaultCheckIds = ['replacement'];
    },
    (policy) => {
      policy.defaultCheckIds = [];
    },
    (policy) => {
      policy.maxWorkers = 20;
    },
    (policy) => {
      Reflect.set(policy, 'unsupportedRepairLimit', 20);
    },
    (policy) => {
      policy.context = 'Different instructions';
    },
    (policy) => {
      policy.turnTimeoutMs = 999999;
    },
  ];
  for (const change of changes) {
    const f = fixture();
    f.setProfile(strict);
    const candidate = f.proposal();
    candidate.policy = executionPolicy(strict);
    change(candidate.policy);
    assert.deepEqual(candidate.policy.profile, strict);
    assert.throws(() => f.tx.admit(candidate, f.resolver), {
      code: Object.hasOwn(candidate.policy, 'unsupportedRepairLimit')
        ? 'INVALID_RUN_STATE'
        : 'CONFLICT',
    });
    assert.equal(f.writes(), 0);
    assert.equal(f.roles.size, 0);
    assert.equal(f.currents.size, 0);
  }
  const injected = fixture();
  injected.setProfile(undefined);
  const candidate = injected.proposal();
  candidate.expectedProfileRevision = null;
  candidate.policy.maxWorkers = 20;
  assert.deepEqual(injected.tx.admit(candidate, injected.resolver), { runId: candidate.runId });
});
