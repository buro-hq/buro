import { createBuiltinWorkflowRoles } from '../adapters/workflows/builtins.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkContext, changeContext, roleContext } from '../core/agent-context.ts';
import { runPerformance } from '../protocol/performance.ts';
import type { Run } from '../protocol/domain.ts';

test('prompts omit successful command logs and catalog instructions while retaining actionable failure evidence', () => {
  const checks = {
    passed: 1,
    total: 2,
    results: [
      { name: 'success', passed: true, output: 'success-output'.repeat(5000) },
      {
        name: 'failure',
        passed: false,
        output: 'FIRST\n' + 'middle\n'.repeat(5000) + '\nLAST',
        error: 'type error',
      },
    ],
  };
  const context = checkContext(checks);
  assert.equal('output' in context.results[0], false);
  assert.match(context.results[1].output!, /^FIRST/);
  assert.match(context.results[1].output!, /LAST$/);
  assert.ok(context.results[1].output!.length < 6200);
  assert.ok(JSON.stringify(context).length < 9000);
  assert.equal(checks.results[0].output.length, 'success-output'.length * 5000);
  assert.deepEqual(changeContext([{ path: 'src/file.ts', before: 'old', after: 'new' }]), [
    { path: 'src/file.ts', beforeCharacters: 3, afterCharacters: 3 },
  ]);
  assert.equal(
    'instructions' in
      roleContext([{ id: 'builder', instructions: 'large'.repeat(5000) } as any])[0],
    false,
  );
});
test('phase timings exclude stopped time and never double-count parallel workers', () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
  const run = {
    createdAt: at(0),
    completedAt: at(120),
    status: 'completed',
    events: [
      { type: 'run.queued', at: at(0) },
      { type: 'phase.preparing', at: at(1) },
      { type: 'phase.implementation', at: at(5) },
      { type: 'run.failed', at: at(20) },
      { type: 'run.resume-requested', at: at(100) },
      { type: 'phase.checking', at: at(103) },
      { type: 'performance.measured', at: at(110), text: 'agent.turn', durationMs: 7000 },
      { type: 'phase.review', at: at(110) },
      { type: 'goal.completed', at: at(120) },
    ],
  } as Run;
  const result = runPerformance(run);
  assert.equal(result.activeSeconds, 40);
  assert.equal(
    result.phases.reduce((sum, row) => sum + row.seconds, 0),
    40,
  );
  assert.equal(result.phases.find((row) => row.phase === 'implementation')?.seconds, 15);
  assert.equal(result.phases.find((row) => row.phase === 'restoring')?.seconds, 3);
  assert.deepEqual(result.operations, [
    { operation: 'agent.turn', calls: 1, totalMs: 7000, maxMs: 7000 },
  ]);
});

test('streaming deltas never copy project snapshots or enter the persistence queue', async () => {
  const { ExecutionService } = await import('../core/execution.ts');
  let subscriber: (event: any) => void = () => {},
    lookups = 0;
  const service = new ExecutionService({
    workflowRoles: createBuiltinWorkflowRoles(),
    projects: {
      list: () => {
        lookups++;
        return [];
      },
    } as any,
    runtime: {
      subscribe: (listener: any) => {
        subscriber = listener;
        return () => {};
      },
    } as any,
    workspaces: {} as any,
    checks: {} as any,
    policies: {},
    now: () => '',
    id: () => '',
  });
  for (let i = 0; i < 10000; i++)
    subscriber({ id: String(i), runId: 'r', threadId: 't', type: 'progress' });
  await service.eventQueue;
  assert.equal(lookups, 0);
  subscriber({ id: 'turn', runId: 'r', threadId: 't', type: 'turn.started' });
  await service.eventQueue;
  assert.equal(lookups, 1);
});
