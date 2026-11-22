import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  ExecutionActionCatalog,
  type ExecutionActionOperations,
} from '../core/execution-actions.ts';
import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import { UnresolvedEffectError } from '../core/run-reconciliation.ts';

const configured = () => {
  const catalog = new ExecutionActionCatalog();
  let effects = 0;
  catalog.register({
    id: 'inspect_quality',
    revision: 'quality-v1',
    description: 'Inspect independently observed quality.',
    schema: z.strictObject({ reason: z.string().min(1) }),
    async execute(input, operations) {
      assert.equal(Object.isFrozen(input), true);
      effects++;
      return operations.check({});
    },
  });
  return { catalog, effects: () => effects };
};
const decision = (input: unknown = { reason: 'Inspect the changed revision.' }) => ({
  decision: { action: 'inspect_quality', input },
});
const operations = (check: ExecutionActionOperations['check']) =>
  ({ check }) as ExecutionActionOperations;

test('action contributions require sealing, reject unknown decisions before effects and use only supplied semantic operations', async () => {
  const f = configured();
  const portCalls: unknown[] = [];
  const ports = operations(async (input) => {
    portCalls.push(input);
    return { content: 'Observed check receipt.' };
  });
  await assert.rejects(f.catalog.invoke(decision(), ports), { code: 'EXECUTION_ACTIONS_UNSEALED' });
  f.catalog.seal();
  for (const [raw, code] of [
    [{ ...decision(), terminal: true }, 'INVALID_EXECUTION_DECISION'],
    [{ decision: { ...decision().decision, extra: true } }, 'INVALID_EXECUTION_DECISION'],
    [{ decision: { action: 'finish', input: {} } }, 'EXECUTION_ACTION_UNAVAILABLE'],
    [decision({ reason: '', permission: 'write-anywhere' }), 'EXECUTION_ACTION_ARGUMENTS'],
    [decision({ reason: 1 }), 'EXECUTION_ACTION_ARGUMENTS'],
    [decision({}), 'EXECUTION_ACTION_ARGUMENTS'],
  ] as const)
    await assert.rejects(f.catalog.invoke(raw, ports), { code });
  assert.equal(f.effects(), 0);
  assert.deepEqual(portCalls, []);
  assert.deepEqual(await f.catalog.invoke(decision(), ports), {
    content: 'Observed check receipt.',
  });
  assert.deepEqual(portCalls, [{}]);
  assert.equal(f.effects(), 1);
  assert.throws(() => f.catalog.register({} as never), { code: 'EXECUTION_ACTIONS_SEALED' });
});

test('the generated native envelope is strict and every action field is required or explicitly nullable', () => {
  const catalog = createBuiltinExecutionActions();
  const schema = catalog.outputSchema();
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['decision']);
  const branches = (schema.properties as any).decision.anyOf;
  assert.equal(branches.length, 6);
  for (const branch of branches) {
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(branch.required, ['action', 'input']);
    const input = branch.properties.input;
    assert.equal(input.additionalProperties, false);
    assert.deepEqual(input.required || [], Object.keys(input.properties));
  }
  const worker = branches.find((branch: any) => branch.properties.action.const === 'delegate')
    .properties.input.properties.worker;
  for (const key of ['runtimeId', 'runtimeReason', 'assignment'])
    assert.ok(worker.required.includes(key));
  const detached = catalog.definitions();
  detached[0].description = 'Caller changed its copy';
  assert.notEqual(catalog.definitions()[0].description, detached[0].description);
  const before = catalog.outputSchema();
  (schema.properties as any).decision = {};
  assert.deepEqual(catalog.outputSchema(), before);
});

test('optional and open object argument grammars are rejected instead of inventing native defaults', () => {
  for (const schema of [
    z.strictObject({ maybe: z.string().optional() }),
    z.strictObject({ data: z.record(z.string(), z.string()) }),
    z.strictObject({ nested: z.strictObject({ maybe: z.number().optional() }) }),
  ]) {
    const catalog = new ExecutionActionCatalog();
    assert.throws(
      () =>
        catalog.register({
          id: 'invalid',
          revision: 'v1',
          description: 'Invalid structured arguments.',
          schema,
          execute: async () => ({ content: 'Must never execute.' }),
        }),
      { code: 'INVALID_EXECUTION_ACTION' },
    );
  }
});

test('a contribution cannot alter its published argument grammar after sealing', async () => {
  const nested = z.string().min(1);
  const catalog = new ExecutionActionCatalog();
  let effects = 0;
  catalog.register({
    id: 'custom',
    revision: 'v1',
    description: 'Configured arguments are immutable.',
    schema: z.strictObject({ input: nested }),
    execute: async () => {
      effects++;
      return { content: 'Must not dispatch after configuration changes.' };
    },
  });
  catalog.seal();
  nested._zod.def.checks!.push(z.minLength(2));
  for (const read of [
    () => catalog.revision,
    () => catalog.outputSchema(),
    () => catalog.definitions(),
  ])
    assert.throws(read, { code: 'EXECUTION_ACTIONS_CHANGED' });
  await assert.rejects(
    catalog.invoke({ decision: { action: 'custom', input: { input: 'value' } } }, {} as never),
    { code: 'EXECUTION_ACTIONS_CHANGED' },
  );
  assert.equal(effects, 0);
});

test('invalid post-handler output cannot disguise a completed host operation as argument rejection', async () => {
  const catalog = new ExecutionActionCatalog();
  let effects = 0;
  catalog.register({
    id: 'custom',
    revision: 'v1',
    description: 'Result validation happens after the bounded operation.',
    schema: z.strictObject({}),
    async execute(_input, operations) {
      await operations.check({});
      return { content: 'Invalid authority claim', accepted: true } as any;
    },
  });
  catalog.seal();
  await assert.rejects(
    catalog.invoke(
      { decision: { action: 'custom', input: {} } },
      operations(async () => {
        effects++;
        return { content: 'Observed receipt' };
      }),
    ),
    (error: unknown) => error instanceof z.ZodError,
  );
  assert.equal(effects, 1);
});

test('working-plan and acceptance capabilities forward proposals without manufacturing evidence', async () => {
  const catalog = createBuiltinExecutionActions();
  const calls: { name: string; input: unknown }[] = [];
  const ports = Object.fromEntries(
    ['delegate', 'check', 'review', 'finish', 'askUser', 'plan'].map((name) => [
      name,
      async (input: unknown) => {
        calls.push({ name, input });
        return { content: 'The host owns this operation and its receipt.' };
      },
    ]),
  ) as unknown as ExecutionActionOperations;
  const result = { status: 'success', summary: 'Candidate', artifacts: [], notesForNextAgent: '' };
  const workPlan = { summary: 'Investigate the observed failure', steps: [] };
  for (const [action, input] of [
    ['plan', workPlan],
    ['check', {}],
    ['review', { result }],
    ['finish', { result }],
    ['ask_user', { question: 'Which requirement should take precedence?' }],
  ] as const)
    await catalog.invoke({ decision: { action, input } }, ports);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['plan', 'check', 'review', 'finish', 'askUser'],
  );
  assert.deepEqual(calls[0].input, workPlan);
  assert.deepEqual(calls[3].input, { result });
  assert.equal(Object.hasOwn(calls[3].input as object, 'accepted'), false);
});

test('an unawaited host operation is drained while retained ports are revoked as soon as the handler returns', async () => {
  const catalog = new ExecutionActionCatalog();
  let retained: ExecutionActionOperations | undefined;
  let start!: () => void, complete!: () => void;
  const started = new Promise<void>((resolve) => (start = resolve));
  const completing = new Promise<void>((resolve) => (complete = resolve));
  let effects = 0,
    laterEffects = 0,
    settled = false;
  catalog.register({
    id: 'custom',
    revision: 'v1',
    description: 'The host operation owns its lifetime even if the handler forgets await.',
    schema: z.strictObject({}),
    execute: async (_input, ports) => {
      retained = ports;
      void ports.check({});
      return { content: 'Handler returned before its check completed.' };
    },
  });
  catalog.seal();
  const invocation = catalog.invoke({ decision: { action: 'custom', input: {} } }, {
    async check() {
      start();
      await completing;
      effects++;
      return { content: 'Settled check receipt.' };
    },
    async plan() {
      laterEffects++;
      return { content: 'Must not start through retained ports.' };
    },
  } as unknown as ExecutionActionOperations);
  void invocation.then(() => (settled = true));
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(effects, 0);
  assert.equal(Object.isFrozen(retained), true);
  await assert.rejects(retained!.plan({ summary: 'Late action', steps: [] }), {
    code: 'EXECUTION_ACTION_CLOSED',
  });
  assert.equal(laterEffects, 0);
  complete();
  assert.deepEqual(await invocation, { content: 'Handler returned before its check completed.' });
  assert.equal(effects, 1);
  await assert.rejects(retained!.check({}), { code: 'EXECUTION_ACTION_CLOSED' });
  assert.equal(effects, 1);
});

test('a swallowed unknown host outcome remains latched and prevents the next operation', async () => {
  const catalog = new ExecutionActionCatalog();
  const failure = new UnresolvedEffectError('WORKER_CHECK_RECONCILIATION_REQUIRED', {
    operationId: 'unknown-check',
  });
  let checks = 0,
    plans = 0;
  catalog.register({
    id: 'custom',
    revision: 'v1',
    description: 'A handler cannot turn an unknown operation into success.',
    schema: z.strictObject({}),
    async execute(_input, ports) {
      await ports.check({}).catch(() => {});
      await ports
        .plan({ summary: 'Try another operation after the error', steps: [] })
        .catch(() => {});
      return { content: 'The handler swallowed both rejections.' };
    },
  });
  catalog.seal();
  await assert.rejects(
    catalog.invoke({ decision: { action: 'custom', input: {} } }, {
      async check() {
        checks++;
        throw failure;
      },
      async plan() {
        plans++;
        return { content: 'Must not execute.' };
      },
    } as unknown as ExecutionActionOperations),
    (error: unknown) => error === failure,
  );
  assert.equal(checks, 1);
  assert.equal(plans, 0);
});

test('parallel handler requests execute serially using arguments captured before caller mutation', async () => {
  const catalog = new ExecutionActionCatalog();
  let start!: () => void, complete!: () => void;
  const started = new Promise<void>((resolve) => (start = resolve));
  const completing = new Promise<void>((resolve) => (complete = resolve));
  const calls: string[] = [];
  let active = 0,
    maximumActive = 0;
  const enter = (name: string) => {
    calls.push(name + ':start');
    maximumActive = Math.max(maximumActive, ++active);
  };
  const leave = (name: string) => {
    calls.push(name + ':end');
    active--;
    return { content: name + ' receipt' };
  };
  catalog.register({
    id: 'custom',
    revision: 'v1',
    description: 'A plugin may compose capabilities without overlapping host effects.',
    schema: z.strictObject({}),
    async execute(_input, ports) {
      const plan = { summary: 'Original decision', steps: [] };
      const first = ports.plan(plan);
      plan.summary = 'Mutated after dispatch';
      const second = ports.check({});
      const third = ports.review({
        result: { status: 'success', summary: 'Candidate', artifacts: [], notesForNextAgent: '' },
      });
      await Promise.all([first, second, third]);
      return { content: 'The ordered capabilities settled.' };
    },
  });
  catalog.seal();
  const invocation = catalog.invoke({ decision: { action: 'custom', input: {} } }, {
    async plan(input) {
      enter('plan');
      assert.equal(input.summary, 'Original decision');
      start();
      await completing;
      return leave('plan');
    },
    async check() {
      enter('check');
      return leave('check');
    },
    async review() {
      enter('review');
      return leave('review');
    },
  } as ExecutionActionOperations);
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['plan:start']);
  complete();
  await invocation;
  assert.equal(maximumActive, 1);
  assert.deepEqual(calls, [
    'plan:start',
    'plan:end',
    'check:start',
    'check:end',
    'review:start',
    'review:end',
  ]);
});

test('a throwing handler still waits for its already-started host operation to settle', async () => {
  const catalog = new ExecutionActionCatalog();
  const handlerError = new Error('Handler failed after launching a check.');
  let complete!: () => void, start!: () => void;
  const completing = new Promise<void>((resolve) => (complete = resolve));
  const started = new Promise<void>((resolve) => (start = resolve));
  let finished = false;
  catalog.register({
    id: 'custom',
    revision: 'v1',
    description: 'Throwing does not abandon an in-flight host effect.',
    schema: z.strictObject({}),
    async execute(_input, ports) {
      void ports.check({});
      throw handlerError;
    },
  });
  catalog.seal();
  const invocation = catalog.invoke(
    { decision: { action: 'custom', input: {} } },
    operations(async () => {
      start();
      await completing;
      finished = true;
      return { content: 'Actual completed check.' };
    }),
  );
  let settled = false;
  const rejected = assert.rejects(invocation, (error: unknown) => {
    settled = true;
    assert.equal(finished, true);
    return error === handlerError;
  });
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  complete();
  await rejected;
});
