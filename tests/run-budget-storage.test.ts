import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ProjectRunBudgets } from '../adapters/files/project-run-budgets.ts';
import {
  createManagedRunBudget,
  managedBudgetSummary,
  type ManagedRunBudgetLedger,
} from '../core/run-budget.ts';
import { DomainError, type ProjectRegistry } from '../core/ports.ts';
import type { DomainEvent, Goal } from '../protocol/domain.ts';
import type { ManagedRunBudgetPolicy } from '../protocol/run-budget.ts';
import { parseDomainEvent, parseSnapshot } from '../protocol/schema.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import { sampleRun } from './fixtures/sample-run.ts';

const policy: ManagedRunBudgetPolicy = {
  version: 1,
  maxRequests: 4,
  maxReservedOutputTokens: 4096,
  maxToolCalls: 4,
  reviewReserve: { requests: 1, outputTokens: 1024, toolCalls: 1 },
};
const owner = { projectId: 'p', ownerRunId: 'R-budget' };
const generation = (operationId: string, phase: 'work' | 'review' = 'work') => ({
  ...owner,
  operationId,
  phase,
  requestedOutputTokens: 1024,
  minimumOutputTokens: 128,
});

async function fixture(t: any, options: { missingLedger?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-budget-storage-'));
  const project = { id: 'p', name: 'Budget fixture', root: directory };
  let store = await FileProjectStore.open({ directory, project });
  const projects: ProjectRegistry = {
    get(id) {
      if (id !== project.id) throw new DomainError('PROJECT_NOT_FOUND', 'Unknown fixture project.');
      return store;
    },
    list: () => [project],
  };
  const run = sampleRun();
  run.id = owner.ownerRunId;
  run.goalId = 'G-budget';
  run.status = 'running';
  delete run.completedAt;
  const goal: Goal = {
    id: run.goalId,
    projectId: project.id,
    title: run.title,
    body: run.goalText,
    criteria: 'Preserve the public contract.',
    status: 'running',
    createdAt: run.createdAt,
  };
  await store.transact('initial', 'initial', (draft) => {
    draft.runs.push(run);
    draft.goals.push(goal);
    if (!options.missingLedger) {
      const ledger = createManagedRunBudget({ ...owner, policy, coverage: 'managed-api' });
      draft.managedRunBudgets = { [run.id]: ledger };
      run.managedBudget = managedBudgetSummary(ledger);
    }
    return { result: null, change: { type: 'run.changed', run, goal } };
  });
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    project,
    projects,
    get store() {
      return store;
    },
    budgets: new ProjectRunBudgets(projects),
    async reopen() {
      await store.close();
      store = await FileProjectStore.open({ directory, project });
    },
    async raw() {
      return JSON.parse(await fs.readFile(path.join(directory, 'control-state.json'), 'utf8'));
    },
  };
}

test('concurrent coordinator and workers share one durable allowance with review capacity protected', async (t) => {
  const f = await fixture(t);
  const work = await Promise.allSettled(
    ['coordinator', 'worker-a', 'worker-b', 'replacement'].map((id) =>
      f.budgets.reserveGeneration(generation(id)),
    ),
  );
  assert.equal(work.filter((result) => result.status === 'fulfilled').length, 3);
  assert.equal(work.filter((result) => result.status === 'rejected').length, 1);
  const rejected = work.find((result) => result.status === 'rejected');
  assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'RUN_BUDGET_EXHAUSTED');
  await f.budgets.reserveTools({ ...owner, operationId: 'work-tools', phase: 'work', count: 3 });
  await assert.rejects(
    f.budgets.reserveTools({ ...owner, operationId: 'extra-work-tools', phase: 'work', count: 1 }),
    { code: 'RUN_BUDGET_EXHAUSTED' },
  );
  await f.reopen();
  await f.budgets.reserveGeneration(generation('reviewer', 'review'));
  await f.budgets.reserveTools({
    ...owner,
    operationId: 'review-tools',
    phase: 'review',
    count: 1,
  });
  const summary = f.store.snapshot().runs[0].managedBudget!;
  assert.deepEqual(summary.used, { requests: 4, reservedOutputTokens: 4096, toolCalls: 4 });
  assert.deepEqual(summary.reviewUsed, { requests: 1, reservedOutputTokens: 1024, toolCalls: 1 });
  await assert.rejects(f.budgets.reserveGeneration(generation('after-all')), {
    code: 'RUN_BUDGET_EXHAUSTED',
  });
  await f.reopen();
  assert.deepEqual(f.store.snapshot().runs[0].managedBudget, summary);
});

test('reservation retries are idempotent across reopen and conflicting reuse cannot spend twice', async (t) => {
  const f = await fixture(t);
  const first = await f.budgets.reserveGeneration(generation('same-operation'));
  await f.reopen();
  const reordered = {
    minimumOutputTokens: 128,
    requestedOutputTokens: 1024,
    phase: 'work' as const,
    operationId: 'same-operation',
    ...owner,
  };
  assert.deepEqual(await f.budgets.reserveGeneration(reordered), first);
  assert.equal(f.store.snapshot().runs[0].managedBudget?.used.requests, 1);
  await assert.rejects(
    f.budgets.reserveGeneration({ ...generation('same-operation'), requestedOutputTokens: 2048 }),
    { code: 'BUDGET_RECEIPT_CONFLICT' },
  );
  await f.budgets.recordUsage({
    ...owner,
    operationId: 'same-operation',
    outcome: 'observed',
    usage: { outputTokens: 7, inputTokens: 10 },
  });
  await f.budgets.recordUsage({
    ...owner,
    operationId: 'same-operation',
    outcome: 'observed',
    usage: { inputTokens: 10, outputTokens: 7 },
  });
  const summary = f.store.snapshot().runs[0].managedBudget!;
  assert.equal(summary.observed.completeUsageRequests, 1);
  assert.equal(summary.observed.outputTokens, 7);
  assert.equal(summary.used.reservedOutputTokens, 1024);
});

test('unknown usage remains charged and budget policy survives continuation or default edits', async (t) => {
  const f = await fixture(t);
  await f.budgets.reserveGeneration(generation('unknown'));
  await f.budgets.recordUsage({ ...owner, operationId: 'unknown', outcome: 'unknown' });
  await f.store.transact('continue', 'continue', (draft) => {
    const run = draft.runs[0];
    run.continuation = {
      mode: 'repair',
      instructions: 'Continue existing work.',
      requestedAt: run.createdAt,
    };
    run.workerTasks = {};
    const changedProfile = ProjectProfileSchema.parse({
      version: 1,
      revision: 2,
      context: '',
      scope: { mode: 'advisory', plannedPaths: ['src/'], protectedPaths: [] },
      checks: [],
      defaultCheckIds: [],
      setup: [],
      dependencies: 'none',
      maxWorkers: 1,
      turnTimeoutMs: 10000,
      managedBudget: { ...policy, maxRequests: 8, maxReservedOutputTokens: 8192 },
    });
    draft.profile = changedProfile;
    run.executionPolicySnapshot = {
      scope: structuredClone(changedProfile.scope),
      checks: [],
      defaultCheckIds: [],
      maxWorkers: 1,
      turnTimeoutMs: 10000,
      profile: changedProfile,
    };
    return { result: null, change: { type: 'run.changed', run, goal: draft.goals[0] } };
  });
  await f.reopen();
  await f.budgets.reserveGeneration(generation('next-a'));
  await f.budgets.reserveGeneration(generation('next-b'));
  await assert.rejects(f.budgets.reserveGeneration(generation('cannot-refund-unknown')), {
    code: 'RUN_BUDGET_EXHAUSTED',
  });
  const summary = f.store.snapshot().runs[0].managedBudget!;
  assert.deepEqual(summary.policy, policy);
  assert.equal(summary.observed.unknownUsageRequests, 3);
  assert.equal(summary.used.reservedOutputTokens, 3072);
});

test('a failed project write grants nothing and publishes no budget update', async (t) => {
  const f = await fixture(t);
  const before = f.store.snapshot();
  const originalBytes = await fs.readFile(f.store.file);
  const events: DomainEvent[] = [];
  f.store.subscribe(before.sequence, (event) => events.push(event));
  const replace = f.store.replace;
  f.store.replace = async () => {
    throw Error('Synthetic atomic replace failure');
  };
  await assert.rejects(f.budgets.reserveGeneration(generation('failed-persist')), /atomic replace/);
  assert.deepEqual(f.store.snapshot(), before);
  assert.deepEqual(await fs.readFile(f.store.file), originalBytes);
  assert.deepEqual(events, []);
  f.store.replace = replace;
  await f.budgets.reserveGeneration(generation('failed-persist'));
  assert.equal(f.store.snapshot().runs[0].managedBudget?.used.requests, 1);
});

test('observed overage is durable before error and cannot replay an earlier grant after poisoning', async (t) => {
  const f = await fixture(t);
  await f.budgets.reserveGeneration(generation('over-limit'));
  await assert.rejects(
    f.budgets.recordUsage({
      ...owner,
      operationId: 'over-limit',
      outcome: 'observed',
      usage: { inputTokens: 10, outputTokens: 1025 },
    }),
    { code: 'RUN_BUDGET_USAGE_EXCEEDED' },
  );
  assert.equal(f.store.snapshot().runs[0].managedBudget?.status, 'exceeded');
  assert.equal(f.store.snapshot().runs[0].managedBudget?.observed.outputTokens, 1025);
  await f.reopen();
  await assert.rejects(f.budgets.reserveGeneration(generation('over-limit')), {
    code: 'RUN_BUDGET_USAGE_EXCEEDED',
  });
  await assert.rejects(f.budgets.reserveGeneration(generation('fresh')), {
    code: 'RUN_BUDGET_USAGE_EXCEEDED',
  });
  await assert.rejects(
    f.budgets.reserveTools({
      ...owner,
      operationId: 'tools-after-overage',
      phase: 'review',
      count: 1,
    }),
    { code: 'RUN_BUDGET_USAGE_EXCEEDED' },
  );
});

test('public snapshots and event replay contain only the budget summary, never private receipts', async (t) => {
  const f = await fixture(t);
  await f.budgets.reserveGeneration(generation('private-budget-correlation'));
  const raw = await f.raw();
  assert.ok(raw.managedRunBudgets['R-budget'].operations['private-budget-correlation']);
  const wire = parseSnapshot(JSON.parse(JSON.stringify(f.store.snapshot())));
  const events: DomainEvent[] = [];
  f.store.subscribe(0, (event) => events.push(parseDomainEvent(JSON.parse(JSON.stringify(event)))));
  const publicBytes = JSON.stringify({ wire, events });
  assert.equal(publicBytes.includes('private-budget-correlation'), false);
  assert.equal(publicBytes.includes('managedRunBudgets'), false);
  assert.equal(publicBytes.includes('operations'), false);
  assert.deepEqual(wire.runs[0].managedBudget, f.store.snapshot().runs[0].managedBudget);
  assert.equal((await fs.stat(f.store.file)).mode & 0o077, 0);
});

test('invalid provider accounting poisons the ledger without persisting raw unexpected data', async (t) => {
  const f = await fixture(t);
  await f.budgets.reserveGeneration(generation('invalid-usage'));
  const marker = 'private-provider-accounting-marker';
  await assert.rejects(
    f.budgets.recordUsage({
      ...owner,
      operationId: 'invalid-usage',
      outcome: 'observed',
      usage: { outputTokens: marker as unknown as number },
    }),
    { code: 'RUN_BUDGET_USAGE_EXCEEDED' },
  );
  assert.equal(f.store.snapshot().runs[0].managedBudget?.status, 'exceeded');
  assert.equal((await fs.readFile(f.store.file, 'utf8')).includes(marker), false);
  await assert.rejects(
    f.store.transact('clear-poison', 'clear-poison', (draft) => {
      const ledger = draft.managedRunBudgets![owner.ownerRunId];
      delete ledger.violation;
      draft.runs[0].managedBudget = managedBudgetSummary(ledger);
      return {
        result: null,
        change: { type: 'run.changed', run: draft.runs[0], goal: draft.goals[0] },
      };
    }),
    { code: 'INVALID_RUN_BUDGET' },
  );
  await f.reopen();
  await assert.rejects(f.budgets.reserveGeneration(generation('after-invalid')), {
    code: 'RUN_BUDGET_USAGE_EXCEEDED',
  });
});

test('project transactions cannot expand frozen policy or rewrite earlier reservations and observations', async (t) => {
  const f = await fixture(t);
  await f.budgets.reserveGeneration(generation('permanent'));
  await f.budgets.recordUsage({
    ...owner,
    operationId: 'permanent',
    outcome: 'observed',
    usage: { inputTokens: 10, outputTokens: 7 },
  });
  await f.budgets.reserveTools({
    ...owner,
    operationId: 'permanent-tools',
    phase: 'work',
    count: 3,
  });
  const before = f.store.snapshot();
  const mutations: ((ledger: ManagedRunBudgetLedger) => void)[] = [
    (ledger) => {
      ledger.policy.maxRequests++;
    },
    (ledger) => {
      Reflect.set(ledger, 'coverage', 'unsupported-coverage');
    },
    (ledger) => {
      delete ledger.operations.permanent;
    },
    (ledger) => {
      ledger.operations.permanent.phase = 'review';
    },
    (ledger) => {
      const op = ledger.operations.permanent;
      if (op.kind === 'generation') op.reservedOutputTokens = 512;
    },
    (ledger) => {
      const op = ledger.operations.permanent;
      if (op.kind === 'generation') {
        op.outcome = 'reserved';
        delete op.usage;
      }
    },
    (ledger) => {
      const op = ledger.operations.permanent;
      if (op.kind === 'generation') op.usage!.outputTokens = 1;
    },
    (ledger) => {
      const op = ledger.operations['permanent-tools'];
      if (op.kind === 'tools') op.count = 1;
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    await assert.rejects(
      f.store.transact('rewrite-' + index, 'rewrite-' + index, (draft) => {
        const ledger = draft.managedRunBudgets![owner.ownerRunId];
        mutate(ledger);
        draft.runs[0].managedBudget = managedBudgetSummary(ledger);
        return {
          result: null,
          change: { type: 'run.changed', run: draft.runs[0], goal: draft.goals[0] },
        };
      }),
      { code: 'INVALID_RUN_BUDGET' },
    );
    assert.deepEqual(f.store.snapshot(), before);
  }
  await f.reopen();
  assert.deepEqual(f.store.snapshot(), before);
});

test('missing owners and absent admission accounting fail closed without creating a replacement ledger', async (t) => {
  const f = await fixture(t, { missingLedger: true });
  await assert.rejects(
    f.budgets.reserveGeneration({ ...generation('missing-run'), ownerRunId: 'R-absent' }),
    { code: 'RUN_BUDGET_OWNER_UNKNOWN' },
  );
  const wrongRegistry = { get: () => f.store, list: () => [f.project] };
  await assert.rejects(
    new ProjectRunBudgets(wrongRegistry).reserveGeneration({
      ...generation('wrong-project'),
      projectId: 'other',
    }),
    { code: 'RUN_BUDGET_OWNER_UNKNOWN' },
  );
  assert.equal(f.store.snapshot().runs[0].managedBudget, undefined);
  const before = f.store.snapshot();
  await assert.rejects(f.budgets.reserveGeneration(generation('missing-ledger')), {
    code: 'INVALID_RUN_BUDGET',
  });
  assert.deepEqual(f.store.snapshot(), before);
  await f.reopen();
  assert.deepEqual(f.store.snapshot(), before);
});

test('malformed or unpaired private budget data cannot replace state or reopen as a reset budget', async (t) => {
  const f = await fixture(t);
  const before = f.store.snapshot();
  await assert.rejects(
    f.store.transact('remove-private', 'remove-private', (draft) => {
      delete draft.managedRunBudgets;
      return {
        result: null,
        change: { type: 'run.changed', run: draft.runs[0], goal: draft.goals[0] },
      };
    }),
    { code: 'INVALID_RUN_BUDGET' },
  );
  assert.deepEqual(f.store.snapshot(), before);
  await assert.rejects(
    f.store.transact('clear-both', 'clear-both', (draft) => {
      delete draft.managedRunBudgets;
      delete draft.runs[0].managedBudget;
      return {
        result: null,
        change: { type: 'run.changed', run: draft.runs[0], goal: draft.goals[0] },
      };
    }),
    { code: 'INVALID_RUN_BUDGET' },
  );
  assert.deepEqual(f.store.snapshot(), before);
  await assert.rejects(
    f.store.transact('invalid-container', 'invalid-container', (draft) => {
      draft.managedRunBudgets = [] as unknown as typeof draft.managedRunBudgets;
      return {
        result: null,
        change: { type: 'run.changed', run: draft.runs[0], goal: draft.goals[0] },
      };
    }),
    { code: 'INVALID_RUN_BUDGET' },
  );
  assert.deepEqual(f.store.snapshot(), before);
  const raw = await f.raw();
  raw.managedRunBudgets['R-budget'].ownerRunId = 'R-other';
  await f.store.close();
  await fs.writeFile(f.store.file, JSON.stringify(raw));
  await assert.rejects(f.reopen(), { code: 'INVALID_RUN_BUDGET' });
});
