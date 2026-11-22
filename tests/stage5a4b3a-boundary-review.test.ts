import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import { executionPolicy } from '../core/project-settings.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import { applyEvent } from '../clients/socket-client.ts';
import { parseDomainEvent } from '../protocol/schema.ts';
import { validateProjectAuthorityChange } from '../core/usage-authority.ts';
import type { DomainEvent, ProjectProfile, Snapshot } from '../protocol/domain.ts';
import type { AgentRuntime } from '../core/ports.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import { sessionResource } from '../protocol/resources.ts';
import type { TeamPlan } from '../protocol/execution.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

async function fixture(t: any, readonly = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-plan-boundary-'));
  const project = { id: 'p', name: 'Plan boundary fixture', root: directory };
  const profile: ProjectProfile = {
    version: 1,
    revision: 1,
    context: '',
    scope: { mode: 'advisory', plannedPaths: [], protectedPaths: ['AGENTS.md'] },
    checks: [{ id: 'test', title: 'Test', command: 'never', timeoutMs: 1000 }],
    defaultCheckIds: ['test'],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    maxRepairs: 0,
    turnTimeoutMs: 10000,
  };
  const store = await FileProjectStore.open({ directory, project, profile });
  let id = 0;
  const env = {
    projects: { get: () => store, list: () => [project] },
    id: () => String(++id),
    now: () => new Date(Date.UTC(2026, 0, 1) + id * 1000).toISOString(),
  };
  const forbidden = async (): Promise<never> => {
    throw Error('No external dispatch in boundary review.');
  };
  const service = new ExecutionService({
    ...env,
    policies: { p: executionPolicy(profile) },
    workflowRoles: createBuiltinWorkflowRoles(),
    selection: fixtureExecutionSelection(
      'fake',
      fixtureExecutionCapabilities({ toolsFreeTurns: !readonly }),
    ),
    workspaces: { prepare: forbidden } as WorkspacePort,
    checks: { run: forbidden } as CheckPort,
    runtime: {
      id: 'fake',
      start: forbidden,
      submit: forbidden,
      turn: forbidden,
      interrupt: forbidden,
      dispose: async () => {},
    } as AgentRuntime,
  });
  service.schedule = () => {};
  t.after(async () => {
    await service.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const goal = await new GoalService(env).create('goal', 'goal', {
    projectId: 'p',
    title: 'Retain immutable plan',
    body: 'Complete synthetic task',
    criteria: 'Preserve exact replay.',
  });
  const { runId } = await service.start('queue', 'queue', { projectId: 'p', goalId: goal.id });
  await service.beginExecution('p', runId);
  await service.phase('p', runId, 'preparing', 'Prepare synthetic input');
  await service.bindPreparedWorkspace('p', runId, {
    path: path.join(directory, 'workspace'),
    base: 'a'.repeat(40),
  });
  await service.phase('p', runId, 'planning', 'Plan synthetic work');
  if (readonly)
    await service.update('p', runId, (run) => {
      run.threadId = 'planner-thread';
      run.coordinatorSession = {
        id: 'planner-session',
        roleId: 'coordinator',
        roleVersion: run.roleSnapshots!.find((role) => role.id === 'coordinator')!.version,
        ...sessionResource(run.resources, 'coordination', 'fake', run.roleResources!.coordinator),
        parentId: 'bound-parent',
      };
    });
  const candidate: TeamPlan = {
    summary: 'Retain the original task and scope',
    steps: [
      { step: 'Implement requested change', owner: readonly ? 'coordinator' : 'builder' },
      { step: 'Review immutable result', owner: 'reviewer' },
    ],
    team: readonly
      ? []
      : [
          {
            roleId: 'builder',
            action: 'create',
            title: 'Builder',
            description: 'Implement requested change',
            instructions: 'Preserve complete task',
            kind: 'implementation',
            paths: ['src/value.ts'],
            runtimeId: null,
            runtimeReason: '',
            assignment: null,
          },
        ],
  };
  const before = store.snapshot();
  const live: DomainEvent[] = [];
  store.subscribe(before.sequence, (event) => live.push(event));
  await service.acceptPlan('p', runId, candidate, readonly ? {} : { builder: null });
  assert.equal(live.length, 1);
  const event = parseDomainEvent(live[0]);
  assert.equal(event.change.type, 'run.plan-accepted');
  if (event.change.type !== 'run.plan-accepted') assert.fail();
  return {
    store,
    service,
    runId,
    before,
    event,
    change: event.change,
    directory,
    project,
    profile,
  };
}

test('actual plan event updates created role catalog and preserves mixed legacy replay without result acceptance', async (t) => {
  const f = await fixture(t);
  const after = applyEvent(f.before, f.event);
  const current = after.runs.find((run) => run.id === f.runId)!;
  assert.equal(after.roles.find((role) => role.id === 'builder')?.version, 1);
  assert.equal(current.status, 'running');
  assert.equal(current.commit, undefined);
  assert.equal(current.planSavedAt, f.change.plan.createdAt);
  assert.deepEqual(current.roleAssignments?.builder, ['src/value.ts']);
  assert.deepEqual(current.assignmentResources?.builder, f.change.assignments[0].resource);
  assert.equal(applyEvent(after, f.event), after);
  await f.service.update('p', f.runId, (run) => {
    run.summary = 'Later observation';
  });
  const replay: DomainEvent[] = [];
  f.store.subscribe(0, (event) => replay.push(parseDomainEvent(event)))();
  let view = { ...f.before, sequence: 0, revision: 0, runs: [], goals: [], roles: [] } as Snapshot;
  for (const event of replay) view = applyEvent(view, event);
  assert.deepEqual(view.runs, f.store.snapshot().runs);
  assert.deepEqual(view.roles, f.store.snapshot().roles);
  assert.equal(view.runs[0].events.filter((entry) => entry.type === 'plan.saved').length, 1);
});

test('actual plan wire and authority validators reject foreign identity, hidden fields and malformed assignment ownership', async (t) => {
  const f = await fixture(t);
  const packet = f.change;
  assert.deepEqual(
    validateProjectAuthorityChange({ projectId: 'p', ...packet }, 'p'),
    packetWithProject(packet),
  );
  const invalid = [
    { ...packet, current: { ...packet.current, cancelRequested: true } },
    { ...packet, plan: { ...packet.plan, admissionId: 'foreign' } },
    { ...packet, plan: { ...packet.plan, privateContinuation: 'hidden' } },
    { ...packet, assignments: [{ ...packet.assignments[0], attemptId: 'foreign' }] },
    { ...packet, assignments: [...packet.assignments, packet.assignments[0]] },
    { ...packet, entries: packet.entries.slice(1) },
    {
      ...packet,
      entries: packet.entries.map((entry, index) =>
        index === 0 ? { ...entry, type: 'goal.completed' } : entry,
      ),
    },
    {
      ...packet,
      entries: packet.entries.map((entry, index) =>
        index === 1 ? { ...entry, text: 'foreign worker: foreign resource' } : entry,
      ),
    },
    {
      ...packet,
      entries: packet.entries.map((entry, index) =>
        index === packet.entries.length - 1 ? { ...entry, type: 'goal.completed' } : entry,
      ),
    },
    { ...packet, view: { privateSession: 'hidden' } },
  ];
  for (const value of invalid) {
    assert.throws(() => parseDomainEvent({ ...f.event, change: value }));
    assert.throws(() => validateProjectAuthorityChange({ projectId: 'p', ...value }, 'p'));
  }
});

const packetWithProject = (change: DomainEvent['change']) => ({ ...change, projectId: 'p' });

test('read-only handoff is mandatory in wire and authority and client verifies the complete same-id planner grant', async (t) => {
  const f = await fixture(t, true);
  assert.ok(f.change.plan.readOnlyPlanner);
  const view = applyEvent(f.before, f.event);
  assert.equal(view.runs[0].threadId, '');
  assert.equal(view.runs[0].coordinatorSession, undefined);
  assert.equal(view.runs[0].planningSession?.id, 'planner-session');
  const missing = structuredClone(f.change);
  delete missing.plan.readOnlyPlanner;
  delete missing.plan.context.readOnlyPlanner;
  assert.throws(() => parseDomainEvent({ ...f.event, change: missing }));
  assert.throws(() => validateProjectAuthorityChange({ projectId: 'p', ...missing }, 'p'));
  for (const key of ['model', 'runtimeId', 'configurationRevision', 'parentId'] as const) {
    const source = structuredClone(f.before);
    source.runs[0].coordinatorSession![key] = 'foreign-same-id';
    assert.throws(() => applyEvent(source, f.event), /handoff mismatch/);
  }
  const observed = structuredClone(f.before);
  observed.runs[0].coordinatorSession!.reportedModel = 'observed-model';
  assert.doesNotThrow(() => applyEvent(observed, f.event));
});

test('File OPEN rejects drifted initial plan context behind an unchanged immutable admission', async (t) => {
  const f = await fixture(t);
  await f.store.close();
  const file = path.join(f.directory, 'control-state.json');
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const relabel of [false, true]) {
    const saved = structuredClone(original);
    const plan = saved.runPlans[saved.runPlanHeads[f.runId]];
    assert.equal(plan.context.contextSource, 'initial-admission');
    plan.context.goalText = 'Substituted original task';
    if (relabel) Reflect.set(plan.context, 'contextSource', 'unsupported-source');
    await fs.writeFile(file, JSON.stringify(saved));
    let reopened: FileProjectStore | undefined;
    try {
      await assert.rejects(async () => {
        reopened = await FileProjectStore.open({
          directory: f.directory,
          project: f.project,
          profile: f.profile,
        });
      });
    } finally {
      await reopened?.close();
    }
  }
});
