import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createHost } from '../plugins/host.ts';
import {
  ExecutionActionCatalog,
  type ExecutionActionOperations,
} from '../core/execution-actions.ts';

test('actual host seals an explicit action catalog without adding default action names or opening projects', async (t) => {
  const actions = new ExecutionActionCatalog();
  actions.register({
    id: 'inspect_evidence',
    revision: 'inspection-v3',
    description: 'Inspect the service evidence through a custom capability.',
    schema: z.strictObject({}),
    execute: (input, operations) => operations.check(input),
  });
  const host = await createHost({ projectContributions: { actions } });
  t.after(() => host.dispose());
  assert.equal(host.ctx.projectContributions.actions, actions);
  assert.equal(actions.sealed, true);
  assert.deepEqual(
    actions.definitions().map((action) => action.id),
    ['inspect_evidence'],
  );
  assert.deepEqual(host.ctx.projects.registry.list(), []);
  let calls = 0;
  assert.deepEqual(
    await actions.invoke({ decision: { action: 'inspect_evidence', input: {} } }, {
      async check(input) {
        assert.deepEqual(input, {});
        calls++;
        return { content: 'Actual host operation receipt' };
      },
    } as ExecutionActionOperations),
    { content: 'Actual host operation receipt' },
  );
  assert.equal(calls, 1);
  assert.throws(() => actions.register({} as never), { code: 'EXECUTION_ACTIONS_SEALED' });
});

test('an explicit empty catalog stays empty and reports unavailable execution capabilities', async (t) => {
  const actions = new ExecutionActionCatalog();
  const host = await createHost({ projectContributions: { actions } });
  t.after(() => host.dispose());
  assert.deepEqual(actions.definitions(), []);
  assert.throws(() => actions.outputSchema(), { code: 'EXECUTION_ACTIONS_EMPTY' });
});
