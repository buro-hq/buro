import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ExecutionService } from '../core/execution.ts';
import { GoalService, RoleService } from '../core/services.ts';
import { applyEvent } from '../clients/socket-client.ts';
import {
  parseDomainEvent,
  parseSnapshot,
  RunCurrentSchema,
  RunAdmissionSchema,
} from '../protocol/schema.ts';
import { executionPolicy } from '../core/project-settings.ts';
import type { AgentRuntime, ProjectStore } from '../core/ports.ts';
import type { CheckPort, WorkspacePort } from '../core/execution-ports.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import type { ContextMaterial, DomainEvent, ProjectProfile } from '../protocol/domain.ts';
import {
  fixtureExecutionCapabilities,
  fixtureExecutionSelection,
} from './fixtures/execution-resources.ts';

const profile = (): ProjectProfile => ({
  version: 1,
  revision: 1,
  context: 'Project instructions',
  scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: ['AGENTS.md'] },
  checks: [{ id: 'test', title: 'Tests', command: 'synthetic-test', timeoutMs: 1000 }],
  defaultCheckIds: ['test'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 1,
  turnTimeoutMs: 10000,
  baseBranch: 'main',
});
const cmd = (id: string) => ({ id, fingerprint: 'fp:' + id });
function material(index: number, scope: ContextMaterial['scope']): ContextMaterial {
  const bytes = 'Synthetic material ' + index,
    hash = createHash('sha256').update(bytes).digest('hex');
  return {
    id: 'M-' + index.toString(16).padStart(6, '0'),
    name: 'Reference ' + index,
    mimeType: 'text/plain',
    size: bytes.length,
    hash,
    relativePath: 'local/context/' + hash + '.txt',
    scope,
    active: true,
    representation: 'text',
    loader: { id: 'text', revision: 'v1' },
    createdAt: '2026-01-01',
  };
}
async function fixture(t: any, kind: 'file' | 'sqlite', managedQueue = false) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-run-services-')));
  const directory = path.join(base, kind),
    root = path.join(base, 'source');
  await fs.mkdir(root);
  await fs.mkdir(directory);
  const project = { id: 'p', name: 'Synthetic queue project', root, managed: true };
  let current: FileProjectStore | SqliteProjectUsageAuthority;
  const queryRows: { operation: string; rows: number }[] = [];
  const open = async () => {
    current =
      kind === 'file'
        ? await FileProjectStore.open({ directory, project, profile: profile() })
        : await SqliteProjectUsageAuthority.open({
            directory,
            project,
            profile: profile(),
            onQuery: (q) => queryRows.push(q),
          });
  };
  await open();
  const store = {
    get project() {
      return current.project;
    },
    get settings() {
      return current.settings;
    },
    get entities() {
      return current.entities;
    },
    get materials() {
      return current.materials;
    },
    get runs() {
      return current.runs;
    },
    snapshot() {
      throw Error('Run admission/cancel must not hydrate legacy snapshots.');
    },
    transact() {
      throw Error('Run admission/cancel must not use legacy document callbacks.');
    },
    receipt() {
      throw Error('Run receipts belong to the narrow run authority.');
    },
    close: () => current.close(),
  } as ProjectStore;
  const projects = {
    get: (id: string) => {
      assert.equal(id, 'p');
      return store;
    },
    list: () => [structuredClone(project)],
  };
  let ids = 0,
    ticks = 0,
    effects = 0;
  const env = {
    projects,
    id: () => String(++ids),
    now: () => new Date(Date.UTC(2026, 0, 1) + ++ticks * 1000).toISOString(),
  };
  const blocked = async (): Promise<never> => {
    effects++;
    throw Error('Queue-only proof must not dispatch external effects.');
  };
  const runtime: AgentRuntime = {
    id: 'fake',
    start: blocked,
    submit: blocked,
    interrupt: blocked,
    turn: blocked,
    dispose: async () => {},
  };
  const choice = fixtureExecutionSelection(
    'fake',
    fixtureExecutionCapabilities({ hostToolLifecycle: managedQueue }),
  );
  const selection = {
    forProject: (projectId: string, captured?: { profile: ProjectProfile | undefined }) => {
      assert.equal(projectId, 'p');
      assert.ok(
        captured,
        'Admission must supply captured profile rather than consult a legacy snapshot.',
      );
      assert.equal(captured.profile?.revision, 1);
      return choice.forProject(projectId);
    },
  };
  const service = new ExecutionService({
    actions: createBuiltinExecutionActions(),
    ...env,
    policies: { p: executionPolicy(profile()) },
    selection,
    runtime,
    workflowRoles: createBuiltinWorkflowRoles(),
    workspaces: { prepare: blocked } as WorkspacePort,
    checks: { run: blocked } as CheckPort,
  });
  const scheduled: { projectId: string; runId: string }[] = [];
  service.schedule = (projectId, runId) => {
    scheduled.push({ projectId, runId });
  };
  t.after(async () => {
    await service.dispose();
    await current.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const events = async () => {
    if (kind === 'sqlite')
      return (await (current as SqliteProjectUsageAuthority).pagedEvents({ after: 0, limit: 1000 }))
        .events;
    const rows: DomainEvent[] = [];
    const stop = (current as FileProjectStore).subscribe(0, (event) => rows.push(event));
    stop();
    return rows.map((event) => ({
      sequence: event.seq,
      projectId: event.projectId,
      ...event.change,
    }));
  };
  return {
    kind,
    base,
    directory,
    project,
    store,
    service,
    scheduled,
    queryRows,
    events,
    goals: new GoalService(env),
    roles: new RoleService(env),
    effects: () => effects,
    runs: () => current.runs,
    async reopen() {
      await current.close();
      await open();
    },
  };
}

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: actual start freezes complete task, user role and material grants; cancel and canonical receipts survive reopen without dispatch`, async (t) => {
    const f = await fixture(t, kind);
    const projectMaterial = material(1, 'project'),
      selectedMaterial = material(2, 'goal'),
      excluded = material(3, 'project');
    await f.store.materials.transaction(cmd('materials'), (tx) =>
      tx.attach([projectMaterial, selectedMaterial, excluded]),
    );
    await f.store.materials.transaction(cmd('remove-selected'), (tx) =>
      tx.remove(selectedMaterial.id),
    );
    await f.store.materials.transaction(cmd('remove-excluded'), (tx) => tx.remove(excluded.id));
    const input = {
      projectId: 'p',
      title: 'Keep the complete task',
      body: 'Complete body. '.repeat(600),
      criteria: 'Exact criterion. '.repeat(600),
      materialIds: [selectedMaterial.id],
    };
    const goal = await f.goals.create('goal', 'goal', input);
    const coordinator = await f.roles.save('coordinator', 'coordinator', {
      projectId: 'p',
      id: 'coordinator',
      expectedVersion: 0,
      title: 'User coordinator',
      description: 'User-selected specialist',
      instructions: 'Keep the precise user instructions and model pin.',
      kind: 'coordination',
      model: 'User display preference',
      runtimePreference: { mode: 'fixed', runtimeId: 'fake' },
    });
    const first = await f.service.start('start', 'start', { projectId: 'p', goalId: goal.id });
    const current = await f.runs().current(first.runId);
    assert.equal(current?.status, 'queued');
    assert.equal(current?.phase, 'queued');
    assert.equal(current?.cancelRequested, false);
    assert.deepEqual(f.scheduled[0], { projectId: 'p', runId: first.runId });
    assert.equal((await f.store.entities.goal(goal.id))?.runId, first.runId);
    assert.equal((await f.store.entities.goal(goal.id))?.status, 'running');
    const admitted = (await f.events()).find((event) => event.type === 'run.admitted');
    assert.ok(admitted && admitted.type === 'run.admitted');
    const admission = admitted.admission;
    assert.equal(admission.goalText, input.body + '\n\nAcceptance criteria:\n' + input.criteria);
    assert.deepEqual(admission.goal, goal);
    assert.deepEqual(admission.policy.profile, profile());
    assert.deepEqual(
      admission.roleSnapshots.find((role) => role.id === 'coordinator'),
      coordinator,
    );
    assert.equal(admission.roleResources.coordinator.source, 'fixed');
    assert.equal(admission.roleResources.coordinator.resource.id, 'fake');
    assert.deepEqual(
      admission.contextMaterials.map((m) => m.id).sort(),
      [projectMaterial.id, selectedMaterial.id].sort(),
    );
    assert.equal(
      admission.contextMaterials.find((m) => m.id === selectedMaterial.id)?.active,
      false,
    );
    assert.equal(
      admitted.roles?.some((role) => role.id === 'coordinator'),
      false,
    );
    assert.equal(
      admitted.roles?.find((role) => role.id === 'reviewer')?.provenance.origin,
      'workflow',
    );
    assert.equal(Object.hasOwn(current!, 'agents'), false);
    assert.equal(Object.hasOwn(current!, 'events'), false);
    await f.store.materials.transaction(cmd('remove-project'), (tx) =>
      tx.remove(projectMaterial.id),
    );
    await f.roles.save('coordinator-v2', 'coordinator-v2', {
      ...coordinator,
      projectId: 'p',
      expectedVersion: 1,
      instructions: 'New instructions only for future admissions.',
    });
    const controller = new AbortController();
    f.service.jobs.set(first.runId, { controller, promise: Promise.resolve() });
    await f.service.cancel('cancel', 'cancel', { projectId: 'p', runId: first.runId });
    assert.equal(controller.signal.aborted, true);
    assert.equal((await f.runs().current(first.runId))?.status, 'canceling');
    const before = await f.events();
    assert.equal(before.filter((e) => e.type === 'run.admitted').length, 1);
    assert.equal(before.filter((e) => e.type === 'run.cancel-requested').length, 1);
    await f.reopen();
    assert.deepEqual(
      await f.service.start('start', 'start', { projectId: 'p', goalId: goal.id }),
      first,
    );
    assert.deepEqual(
      await f.service.cancel('cancel', 'cancel', { projectId: 'p', runId: first.runId }),
      first,
    );
    assert.deepEqual(await f.events(), before);
    assert.equal((await f.runs().current(first.runId))?.cancelRequested, true);
    const persisted = (await f.events()).find((event) => event.type === 'run.admitted');
    assert.ok(persisted?.type === 'run.admitted');
    assert.deepEqual(persisted.admission, admission);
    assert.equal(
      (await f.store.entities.role('coordinator', 1))?.instructions,
      coordinator.instructions,
    );
    await assert.rejects(
      f.service.start('start', 'different', { projectId: 'p', goalId: goal.id }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    await assert.rejects(
      f.service.cancel('cancel', 'different', { projectId: 'p', runId: first.runId }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    f.queryRows.length = 0;
    const page = await f.runs().timeline({ runId: first.runId, limit: 1 });
    assert.deepEqual(
      page.entries.map((e) => [e.sequence, e.type]),
      [[1, 'run.queued']],
    );
    assert.equal(page.watermark, 2);
    assert.ok(page.next);
    const rest = await f.runs().timeline({ runId: first.runId, limit: 1, cursor: page.next });
    assert.deepEqual(
      rest.entries.map((e) => [e.sequence, e.type]),
      [[2, 'run.cancel-requested']],
    );
    assert.equal(rest.next, undefined);
    if (kind === 'sqlite') {
      const reads = f.queryRows.filter((query) => query.operation === 'run.timeline.page');
      assert.equal(reads.length, 2);
      assert.ok(reads.every((query) => query.rows <= 2));
      assert.equal(
        f.queryRows.some((query) => query.operation === 'event.page'),
        false,
      );
    }
    await assert.rejects(
      f
        .runs()
        .timeline({ runId: first.runId, limit: 1, cursor: { ...page.next, projectId: 'foreign' } }),
      { code: 'INVALID_RUN_CURSOR' },
    );
    assert.equal(f.effects(), 0);
  });
  test(`${kind}: concurrent actual starts authorize one active run and failed admission leaves no run, goal link or command receipt`, async (t) => {
    const f = await fixture(t, kind);
    const left = await f.goals.create('left-goal', 'left-goal', {
      projectId: 'p',
      title: 'Left',
      body: 'Left task',
      criteria: '',
    });
    const right = await f.goals.create('right-goal', 'right-goal', {
      projectId: 'p',
      title: 'Right',
      body: 'Right task',
      criteria: '',
    });
    const results = await Promise.allSettled([
      f.service.start('left', 'left', { projectId: 'p', goalId: left.id }),
      f.service.start('right', 'right', { projectId: 'p', goalId: right.id }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'PROJECT_BUSY');
    const admitted = (await f.events()).filter((event) => event.type === 'run.admitted');
    assert.equal(admitted.length, 1);
    const winner = admitted[0];
    assert.equal(winner.type, 'run.admitted');
    const loserId = winner.current.goalId === left.id ? right.id : left.id;
    const loserCommand = loserId === left.id ? 'left' : 'right';
    assert.equal((await f.store.entities.goal(loserId))?.status, 'draft');
    assert.equal((await f.store.entities.goal(loserId))?.runId, undefined);
    assert.equal(
      await f.runs().receipt({ id: loserCommand, fingerprint: loserCommand }),
      undefined,
    );
    assert.equal(f.scheduled.length, 1);
    assert.equal(f.effects(), 0);
  });
}

for (const kind of ['file', 'sqlite'] as const) {
  test(`${kind}: actual bounded queue/cancel events project complete task and preserve displayed worker history without granting acceptance`, async (t) => {
    const f = await fixture(t, kind, true);
    await f.goals.create('goal', 'goal', {
      projectId: 'p',
      title: 'UI projection',
      body: 'The complete original task',
      criteria: 'Do not invent check evidence.',
    });
    const initial = parseSnapshot({
      version: 1,
      project: f.project,
      revision: 0,
      sequence: 0,
      roles: [],
      goals: [],
      runs: [],
      capabilities: [],
      profile: profile(),
    });
    const wire = (event: any): DomainEvent => {
      const { sequence, projectId, ...change } = event;
      return parseDomainEvent({
        version: 1,
        id: 'event-' + sequence,
        projectId,
        seq: sequence,
        at: 'synthetic',
        change,
      });
    };
    let view = initial;
    for (const event of await f.events()) view = applyEvent(view, wire(event));
    const started = await f.service.start('start', 'start', {
      projectId: 'p',
      goalId: view.goals[0].id,
    });
    const admitted = (await f.events()).find((e) => e.type === 'run.admitted');
    assert.ok(admitted?.type === 'run.admitted');
    const message = wire(admitted);
    view = applyEvent(view, message);
    const queued = view.runs.find((run) => run.id === started.runId)!;
    assert.equal(
      queued.goalText,
      'The complete original task\n\nAcceptance criteria:\nDo not invent check evidence.',
    );
    assert.deepEqual(
      queued.events.map((event) => event.type),
      ['run.queued'],
    );
    assert.deepEqual(queued.agents, []);
    assert.deepEqual(queued.commands, []);
    assert.deepEqual(queued.plan, []);
    assert.deepEqual(queued.acceptance, { passed: 0, total: 0, results: [] });
    assert.equal(queued.independentReviewer, false);
    assert.equal(RunCurrentSchema.safeParse({ ...admitted.current, agents: [] }).success, false);
    assert.equal(
      RunAdmissionSchema.safeParse({ ...admitted.admission, events: [] }).success,
      false,
    );
    assert.throws(() =>
      parseDomainEvent({
        ...message,
        change: { ...message.change, view: { resources: admitted.admission.resources } },
      }),
    );
    assert.throws(() =>
      parseDomainEvent({
        ...message,
        change: { ...message.change, current: { ...admitted.current, status: 'completed' } },
      }),
    );
    if (kind === 'sqlite') {
      assert.equal(admitted.view, undefined);
      assert.equal(queued.managedBudget, undefined);
    } else {
      assert.ok(queued.managedBudget, 'The File queue view reflects its real sole managed ledger.');
      assert.deepEqual(queued.managedBudget, admitted.view?.managedBudget);
      assert.deepEqual(queued.effectivePolicy, admitted.view?.effectivePolicy);
    }
    const history = {
      ...queued,
      agents: [
        {
          threadId: 'display-session',
          name: 'Worker',
          agentPath: '/root/worker',
          startedAt: 'now',
          completedAt: '',
          status: 'running',
          commands: 1,
          messages: ['Previously displayed work message'],
        },
      ],
      commands: [
        {
          id: 'display-command',
          threadId: 'display-session',
          command: 'synthetic-display-command',
          startedAt: 'now',
          output: 'Previously displayed output',
        },
      ],
      events: [
        ...queued.events,
        { at: 'now', type: 'agent.message', text: 'Previously displayed work message' },
      ],
    };
    view = { ...view, runs: [history] };
    await f.service.cancel('cancel', 'cancel', { projectId: 'p', runId: started.runId });
    const cancelled = (await f.events()).find((e) => e.type === 'run.cancel-requested');
    assert.ok(cancelled);
    const cancelMessage = wire(cancelled),
      stopped = applyEvent(view, cancelMessage);
    assert.equal(stopped.runs[0].status, 'canceling');
    assert.equal(stopped.runs[0].cancelRequested, true);
    assert.equal(stopped.runs[0].agents, history.agents);
    assert.equal(stopped.runs[0].commands, history.commands);
    assert.deepEqual(
      stopped.runs[0].events.map((event) => event.type),
      ['run.queued', 'agent.message', 'run.cancel-requested'],
    );
    assert.equal(stopped.runs[0].acceptance, history.acceptance);
    assert.equal(applyEvent(stopped, cancelMessage), stopped);
    assert.equal(f.effects(), 0);
  });
}
