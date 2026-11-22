import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionService } from '../core/execution.ts';
import { DomainError, type AgentRuntime } from '../core/ports.ts';
import { observedTurnFailure } from '../core/run-reconciliation.ts';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { sampleRun } from './fixtures/sample-run.ts';

async function fixture(t: any, turn: NonNullable<AgentRuntime['turn']>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-host-contract-'));
  const project = { id: 'p', name: 'Host contract fixture', root: directory };
  let store = await FileProjectStore.open({ directory, project });
  const run = { ...sampleRun(), status: 'running' as const, completedAt: undefined };
  await store.transact('seed', 'seed', (doc) => {
    const goal = {
      id: run.goalId!,
      projectId: project.id,
      title: run.title,
      body: run.goalText,
      criteria: '',
      status: 'running' as const,
      createdAt: run.createdAt,
    };
    doc.goals.push(goal);
    doc.runs.push(run);
    return { result: null, change: { type: 'run.changed', run, goal } };
  });
  const runtime: AgentRuntime = {
    id: 'contract-backend',
    async start() {
      throw Error('Unexpected session creation');
    },
    async submit() {
      throw Error('Unexpected submit');
    },
    async interrupt() {},
    async dispose() {},
    turn,
  };
  const engine = new ExecutionService({
    actions: createBuiltinExecutionActions(),
    workflowRoles: createBuiltinWorkflowRoles(),
    projects: { get: () => store, list: () => [project] },
    runtime,
    policies: {},
    now: () => new Date().toISOString(),
    id: () => crypto.randomUUID(),
    workspaces: {
      async prepare() {
        throw Error('Unexpected workspace preparation');
      },
      async changes() {
        throw Error('Unexpected workspace inspection');
      },
      async captureRevision() {
        throw Error('Unexpected revision capture');
      },
      async checkpoint() {
        throw Error('Unexpected checkpoint');
      },
    },
    checks: {
      async run() {
        throw Error('Unexpected check');
      },
    },
  });
  t.after(async () => {
    await engine.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    engine,
    run,
    project,
    get store() {
      return store;
    },
    async reopen() {
      await store.close();
      store = await FileProjectStore.open({ directory, project });
    },
    call() {
      return engine.completedTurn(
        'p',
        run.id,
        run.threadId,
        'Contract request',
        {},
        new AbortController().signal,
        1000,
      );
    },
  };
}

test('host persists turn intent before dispatch and known rejection does not poison later work', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    const pending = f.store.snapshot().runs[0].pendingTurn;
    assert.ok(pending, 'An adapter must never run before the host intent is durable');
    assert.equal(pending.threadId, f.run.threadId);
    if (calls === 1) throw new DomainError('MODEL_RATE_LIMITED', 'Observed HTTP 429');
    return { turnId: 'observed', text: '{"answer":42}' };
  });
  await assert.rejects(f.call(), { code: 'MODEL_RATE_LIMITED' });
  assert.equal(f.store.snapshot().runs[0].pendingTurn, undefined);
  assert.equal(f.store.snapshot().runs[0].reconciliation, undefined);
  await f.reopen();
  assert.deepEqual(await f.call(), { answer: 42 });
  assert.equal(calls, 2);
  assert.equal(f.store.snapshot().runs[0].pendingTurn, undefined);
});

test('an uncommitted host intent never reaches the backend and a deliberate retry remains possible', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return { turnId: 'observed', text: '{}' };
  });
  const replace = f.store.replace;
  f.store.replace = async (from, to) => {
    const state = JSON.parse(await fs.readFile(from, 'utf8'));
    if (state.runs.some((run: any) => run.pendingTurn))
      throw Error('Intent persistence failed before commit');
    return replace(from, to);
  };
  await assert.rejects(f.call(), /Intent persistence failed/);
  assert.equal(calls, 0);
  assert.equal(f.store.snapshot().runs[0].pendingTurn, undefined);
  assert.equal(f.store.snapshot().runs[0].reconciliation, undefined);
  f.store.replace = replace;
  assert.deepEqual(await f.call(), {});
  assert.equal(calls, 1);
});

test('host treats malformed observed JSON as recoverable formatting after settling the turn', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => ({
    turnId: 'observed-' + ++calls,
    text: calls === 1 ? '{"answer":' : '{"answer":42}',
  }));
  await assert.rejects(f.call(), { code: 'INVALID_AGENT_OUTPUT' });
  const saved = f.store.snapshot().runs[0];
  assert.equal(saved.pendingTurn, undefined);
  assert.equal(saved.reconciliation, undefined);
  assert.deepEqual(await f.call(), { answer: 42 });
  assert.equal(calls, 2);
});

test('host confirmed cancellation is settled, but a lost outcome blocks even after reopening', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    if (calls === 1)
      throw observedTurnFailure(new DOMException('Backend confirmed termination', 'AbortError'));
    throw Error('The transport disappeared without an outcome');
  });
  await assert.rejects(f.call(), { name: 'AbortError' });
  assert.equal(f.store.snapshot().runs[0].pendingTurn, undefined);
  assert.equal(f.store.snapshot().runs[0].reconciliation, undefined);
  await assert.rejects(f.call(), /transport disappeared/);
  const stopped = f.store.snapshot().runs[0];
  assert.equal(stopped.reconciliation?.code, 'SESSION_RECONCILIATION_REQUIRED');
  assert.equal(stopped.reconciliation?.operationId, stopped.pendingTurn?.id);
  await f.reopen();
  await assert.rejects(f.call(), { code: 'RUN_RECONCILIATION_REQUIRED' });
  assert.equal(calls, 2, 'Reopening must not dispatch a replacement request');
});

test('a required owner-run reconciliation cannot be cleared, replaced or deleted by an unrelated transaction', async (t) => {
  const f = await fixture(t, async () => {
    throw Error('Lost outcome');
  });
  await assert.rejects(f.call(), /Lost outcome/);
  const before = f.store.snapshot();
  const marker = before.runs[0].reconciliation;
  assert.ok(marker);
  for (const mutation of ['clear', 'replace', 'delete-run'] as const) {
    await assert.rejects(
      f.store.transact('forbidden-' + mutation, mutation, (doc) => {
        const run = doc.runs.find((candidate) => candidate.id === f.run.id)!;
        if (mutation === 'clear') {
          run.reconciliation = undefined;
          run.issue = undefined;
        } else if (mutation === 'replace') {
          run.reconciliation = { ...run.reconciliation!, operationId: 'replacement-operation' };
        } else {
          doc.runs = doc.runs.filter((candidate) => candidate.id !== f.run.id);
        }
        return { result: null, change: { type: 'goal.updated', goal: doc.goals[0] } };
      }),
      { code: 'RUN_RECONCILIATION_REQUIRED' },
    );
    assert.deepEqual(f.store.snapshot().runs[0].reconciliation, marker);
    assert.equal(f.store.snapshot().sequence, before.sequence);
    assert.equal(f.store.receipt('forbidden-' + mutation, mutation), undefined);
  }
  await f.reopen();
  assert.deepEqual(f.store.snapshot().runs[0].reconciliation, marker);
});

test('private result-apply intent never enters the snapshot or published/replayed events', async (t) => {
  const f = await fixture(t, async () => ({ turnId: 'unused', text: '{}' }));
  const events: unknown[] = [];
  const unsubscribe = f.store.subscribe(f.store.snapshot().sequence, (event) => events.push(event));
  await f.store.transact('private-apply-intent', 'private-receipt-fingerprint', (doc) => {
    doc.resultApplyIntents = {
      'apply-private': {
        version: 1,
        requestId: 'apply-private',
        fingerprint: 'PRIVATE_APPLY_FINGERPRINT_NOT_PUBLIC',
        projectId: 'p',
        runId: f.run.id,
        root: f.project.root,
        branch: 'main',
        baseHead: 'a'.repeat(40),
        targetCommit: 'b'.repeat(40),
        startedAt: new Date().toISOString(),
        status: 'prepared',
      },
    };
    return { result: null, change: { type: 'goal.updated', goal: doc.goals[0] } };
  });
  unsubscribe();
  assert.equal(Object.hasOwn(f.store.snapshot(), 'resultApplyIntents'), false);
  assert.doesNotMatch(
    JSON.stringify([f.store.snapshot(), events]),
    /PRIVATE_APPLY_FINGERPRINT_NOT_PUBLIC/,
  );
  await f.reopen();
  const replayed: unknown[] = [];
  f.store.subscribe(0, (event) => replayed.push(event))();
  assert.ok(replayed.length);
  assert.doesNotMatch(
    JSON.stringify([f.store.snapshot(), replayed]),
    /PRIVATE_APPLY_FINGERPRINT_NOT_PUBLIC/,
  );
});
