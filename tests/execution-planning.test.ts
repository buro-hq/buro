import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionService } from '../core/execution.ts';
import { GoalService } from '../core/services.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { FileProjectRegistry } from '../adapters/files/registry.ts';
import type { AgentRuntime } from '../core/ports.ts';
import type { ResourceSnapshot } from '../protocol/resources.ts';

async function fixture(
  t: any,
  options: {
    client?: 'managed' | 'codex';
    mode?: 'bounded' | 'legacy';
    invalidPlans?: number;
  } = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-planning-'));
  const store = await FileProjectStore.open({
    directory,
    project: { id: 'p', name: 'Planning fixture', root: directory },
  });
  const projects = new FileProjectRegistry([store]);
  let sequence = 0,
    plans = 0;
  const turns: { text: string; toolPolicy?: 'none'; threadId: string }[] = [];
  const resource = {
    id: options.client === 'codex' ? 'codex' : 'local-qwen',
    client: options.client || 'managed',
    configurationRevision: 'frozen-resource',
    local: true,
  };
  const resources: ResourceSnapshot = {
    profileId: 'local',
    policy: 'local-only',
    coordinator: resource,
    worker: resource,
    reviewer: resource,
  };
  const runtime: AgentRuntime = {
    id: 'fake',
    async start() {
      return { threadId: 'thread-' + ++sequence };
    },
    async resume(input) {
      return { threadId: input.threadId };
    },
    async submit() {
      return { turnId: 't' };
    },
    async interrupt() {},
    async dispose() {},
    async turn(threadId, text, turnOptions) {
      turns.push({ threadId, text, toolPolicy: turnOptions?.toolPolicy });
      const answer = text.startsWith('First,')
        ? {
            summary: 'One coherent edit',
            steps: [
              {
                step: 'Implement and inspect as needed',
                owner: ++plans <= (options.invalidPlans || 0) ? 'missing-role' : 'coordinator',
              },
              { step: 'Verify the outcome', owner: 'reviewer' },
            ],
            team: [],
          }
        : text.startsWith('Review goal')
          ? { verdict: 'approved', blockingFindings: [], summary: 'Verified' }
          : {
              status: 'success',
              summary: 'Done',
              artifacts: ['src/value.ts'],
              notesForNextAgent: '',
            };
      return { turnId: 't', text: JSON.stringify(answer) };
    },
  };
  const environment = {
    projects,
    runtime,
    planningMode: options.mode,
    selection: {
      forProject() {
        return resources;
      },
    },
    now: () => new Date().toISOString(),
    id: () => crypto.randomUUID(),
    policies: {
      p: {
        allowedPaths: ['src/'],
        protectedPaths: ['checks/'],
        context: 'Preserve the public API.',
        checks: [{ id: 'suite', title: 'Suite' }],
        defaultCheckIds: ['suite'],
        maxWorkers: 2,
        maxRepairs: 0,
        turnTimeoutMs: 1000,
      },
    },
    workspaces: {
      async prepare() {
        return { path: directory, base: 'initial' };
      },
      async changes() {
        return [{ path: 'src/value.ts', before: 'one', after: 'two' }];
      },
      async checkpoint() {
        return 'a'.repeat(40);
      },
    },
    checks: {
      async run() {
        return { passed: 1, total: 1, results: [{ name: 'Suite', passed: true }] };
      },
    },
  };
  const engine = new ExecutionService(environment);
  t.after(async () => {
    await engine.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const goal = await new GoalService(environment).create('goal', 'goal', {
    projectId: 'p',
    title: 'Update value',
    body: 'Set value to two.',
    criteria: 'Preserve exports.',
  });
  async function run() {
    const result = await engine.start('start', 'start', { projectId: 'p', goalId: goal.id });
    await engine.jobs.get(result.runId)?.promise;
    return engine.get('p', result.runId);
  }
  return { engine, store, environment, turns, run, directory };
}

test('new managed planning saves bounded policy and only planning turns disable tools', async (t) => {
  const f = await fixture(t, { invalidPlans: 1 });
  const run = await f.run();
  assert.equal(run.status, 'completed', run.result);
  assert.equal(run.planningPolicy?.mode, 'bounded');
  const planning = f.turns.filter(({ text }) => text.startsWith('First,'));
  assert.equal(planning.length, 2);
  assert.ok(planning.every(({ toolPolicy }) => toolPolicy === 'none'));
  assert.match(planning[1].text, /steps.owner must exactly match/);
  const integration = f.turns.find(({ text }) => text.startsWith('Plan accepted.'))!;
  assert.equal(integration.toolPolicy, undefined);
  assert.equal(integration.threadId, planning[0].threadId);
  assert.equal(f.turns.find(({ text }) => text.startsWith('Review goal'))?.toolPolicy, undefined);
  assert.equal(run.independentReviewer, true);
});

test('legacy comparison mode and native Codex retain existing planning authority', async (t) => {
  for (const options of [{ mode: 'legacy' as const }, { client: 'codex' as const }]) {
    const f = await fixture(t, options);
    const run = await f.run();
    assert.equal(run.status, 'completed', run.result);
    assert.equal(run.planningPolicy?.mode, 'legacy');
    const planning = f.turns.find(({ text }) => text.startsWith('First,'))!;
    assert.equal(planning.toolPolicy, undefined);
    assert.match(planning.text, /only inspect the project/);
  }
});

test('invalid bounded planning still stops after the existing two attempts', async (t) => {
  const f = await fixture(t, { invalidPlans: 2 });
  const run = await f.run();
  assert.equal(run.status, 'failed');
  assert.equal(f.turns.length, 2);
  assert.ok(f.turns.every(({ toolPolicy }) => toolPolicy === 'none'));
  assert.equal(run.planSavedAt, undefined);
  assert.equal(run.commit, undefined);
});

test('historical missing planning policy remains legacy even when current environment enables bounded', async (t) => {
  const f = await fixture(t);
  const original = await f.run();
  await f.store.transact('historical', 'historical', (doc) => {
    const historical = {
      ...structuredClone(original),
      id: 'R-historical',
      planningPolicy: undefined,
      managedBudget: undefined,
    };
    doc.runs.push(historical);
    return { result: null, change: { type: 'run.changed', run: historical, goal: doc.goals[0] } };
  });
  f.turns.length = 0;
  await f.engine.planAndImplement(
    'p',
    'R-historical',
    { path: f.directory, base: 'initial' },
    f.environment.policies.p,
    new AbortController().signal,
    [],
    true,
  );
  const planning = f.turns.find(({ text }) => text.startsWith('First,'))!;
  assert.equal(planning.toolPolicy, undefined);
  assert.match(planning.text, /only inspect the project/);
});
