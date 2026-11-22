import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUsageAccount,
  admitGeneration,
  admitTools,
  observeUsage,
  type UsageAccount,
  type UsagePolicy,
  type UsageOperation,
  type UsageTransition,
} from '../core/usage-accounting.ts';
import { referenceUsageTotals, type ReferenceUsageOperation } from './fixtures/usage-reference.ts';

function policy(patch: Partial<UsagePolicy> = {}): UsagePolicy {
  return {
    version: 1,
    maxRequests: 100000,
    maxReservedOutputTokens: 1000000,
    maxToolCalls: 100000,
    reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
    ...patch,
  };
}
function account(value = policy()) {
  return createUsageAccount({ id: 'host-owned-account', policy: value });
}
function proposal(operationId: string, patch: Partial<Parameters<typeof admitGeneration>[2]> = {}) {
  return {
    accountId: 'host-owned-account',
    operationId,
    phase: 'work' as const,
    requestedOutputTokens: 10,
    minimumOutputTokens: 1,
    ...patch,
  };
}
function admitted<G>(transition: UsageTransition<G>, kind: 'applied' | 'replayed' = 'applied') {
  assert.equal(transition.kind, kind, JSON.stringify(transition));
  if (transition.kind === 'denied') throw Error(transition.code);
  return transition;
}
function denied(transition: UsageTransition<unknown>, code: string) {
  assert.equal(transition.kind, 'denied', JSON.stringify(transition));
  if (transition.kind !== 'denied') throw Error('Unexpected grant');
  assert.equal(transition.code, code);
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function totals(value: UsageAccount) {
  return {
    work: {
      requests: value.admitted.work.requests,
      outputTokens: value.admitted.work.reservedOutputTokens,
      toolCalls: value.admitted.work.toolCalls,
    },
    review: {
      requests: value.admitted.review.requests,
      outputTokens: value.admitted.review.reservedOutputTokens,
      toolCalls: value.admitted.review.toolCalls,
    },
    knownInputTokens: value.observed.inputTokens,
    knownOutputTokens: value.observed.outputTokens,
    completeUsageRequests: value.observed.completeUsageRequests,
    unknownUsageRequests: value.observed.unknownUsageRequests,
    outstandingOutputTokens: value.outstandingOutputTokens,
  };
}

test('finite accounting requires an explicit policy and preserves caller-owned inputs', () => {
  assert.throws(() => createUsageAccount({ id: 'host-owned-account' } as any), {
    code: 'INVALID_USAGE_POLICY',
  });
  for (const invalid of [Infinity, NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => account(policy({ maxRequests: invalid })), {
      code: 'INVALID_USAGE_POLICY',
    });
  }
  const suppliedPolicy = frozen(policy());
  const initial = frozen(account(suppliedPolicy));
  const input = frozen(proposal('first'));
  const grant = admitted(admitGeneration(initial, undefined, input));
  assert.equal(initial.revision, 0);
  assert.equal(initial.admitted.work.requests, 0);
  assert.equal(grant.account.revision, 1);
  assert.notEqual(grant.account, initial);
  assert.notEqual(grant.account.policy, suppliedPolicy);
  grant.account.policy.maxRequests = 5;
  grant.operation.operationId = 'changed-returned-copy';
  assert.equal(suppliedPolicy.maxRequests, 100000);
  assert.equal(input.operationId, 'first');
});

test('work cannot consume protected request or tool admissions while review can use them', () => {
  const limited = policy({
    maxRequests: 6,
    maxToolCalls: 8,
    reviewReserve: { requests: 2, outputTokens: 0, toolCalls: 3 },
  });
  let state = account(limited);
  for (let index = 0; index < 4; index++)
    state = admitted(admitGeneration(state, undefined, proposal(`work-${index}`))).account;
  denied(admitGeneration(state, undefined, proposal('fifth-work')), 'USAGE_LIMIT_EXHAUSTED');
  for (let index = 0; index < 2; index++)
    state = admitted(
      admitGeneration(state, undefined, proposal(`review-${index}`, { phase: 'review' })),
    ).account;
  denied(
    admitGeneration(state, undefined, proposal('third-review', { phase: 'review' })),
    'USAGE_LIMIT_EXHAUSTED',
  );
  const tool = { accountId: state.id, operationId: 'work-tools', phase: 'work' as const, count: 5 };
  state = admitted(admitTools(state, undefined, tool)).account;
  denied(
    admitTools(state, undefined, { ...tool, operationId: 'extra-work', count: 1 }),
    'USAGE_LIMIT_EXHAUSTED',
  );
  state = admitted(
    admitTools(state, undefined, {
      ...tool,
      operationId: 'review-tools',
      phase: 'review',
      count: 3,
    }),
  ).account;
  assert.equal(state.admitted.review.toolCalls, 3);
  denied(
    admitTools(state, undefined, {
      ...tool,
      operationId: 'extra-review',
      phase: 'review',
      count: 1,
    }),
    'USAGE_LIMIT_EXHAUSTED',
  );
});

test('generation allowances shrink above the required minimum and preserve the output review reserve', () => {
  let state = account(
    policy({
      maxReservedOutputTokens: 100,
      reviewReserve: { requests: 0, outputTokens: 20, toolCalls: 0 },
    }),
  );
  const first = admitted(
    admitGeneration(
      state,
      undefined,
      proposal('large', { requestedOutputTokens: 70, minimumOutputTokens: 10 }),
    ),
  );
  state = first.account;
  const shrunk = admitted(
    admitGeneration(
      state,
      undefined,
      proposal('shrunk', { requestedOutputTokens: 50, minimumOutputTokens: 10 }),
    ),
  );
  assert.equal(shrunk.grant?.maxOutputTokens, 10);
  state = shrunk.account;
  denied(admitGeneration(state, undefined, proposal('below-minimum')), 'USAGE_LIMIT_EXHAUSTED');
  const review = admitted(
    admitGeneration(
      state,
      undefined,
      proposal('review', { phase: 'review', requestedOutputTokens: 50, minimumOutputTokens: 20 }),
    ),
  );
  assert.equal(review.grant?.maxOutputTokens, 20);
  assert.equal(review.account.outstandingOutputTokens, 100);
  const untouched = account(policy({ maxReservedOutputTokens: 5 }));
  denied(
    admitGeneration(untouched, undefined, proposal('cannot-fit', { minimumOutputTokens: 6 })),
    'USAGE_LIMIT_EXHAUSTED',
  );
  assert.equal(untouched.revision, 0);
});

test('identical generation, tool and observation replays have zero counter and revision delta', () => {
  const first = admitted(admitGeneration(account(), undefined, proposal('generation')));
  const replay = admitted(
    admitGeneration(frozen(first.account), frozen(first.operation), frozen(proposal('generation'))),
    'replayed',
  );
  assert.deepEqual(replay.account, first.account);
  assert.deepEqual(replay.grant, first.grant);
  const observation = {
    accountId: first.account.id,
    operationId: 'generation',
    outcome: 'observed' as const,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const settled = admitted(observeUsage(first.account, first.operation, observation));
  const repeated = admitted(
    observeUsage(frozen(settled.account), frozen(settled.operation), frozen(observation)),
    'replayed',
  );
  assert.deepEqual(repeated.account, settled.account);
  const toolProposal = {
    accountId: settled.account.id,
    operationId: 'tool',
    phase: 'work' as const,
    count: 2,
  };
  const tool = admitted(admitTools(settled.account, undefined, toolProposal));
  assert.deepEqual(
    admitted(admitTools(tool.account, tool.operation, toolProposal), 'replayed').account,
    tool.account,
  );
  denied(
    admitGeneration(first.account, first.operation, proposal('generation', { phase: 'review' })),
    'USAGE_RECEIPT_CONFLICT',
  );
  denied(
    admitGeneration(
      first.account,
      first.operation,
      proposal('generation', { requestedOutputTokens: 11 }),
    ),
    'USAGE_RECEIPT_CONFLICT',
  );
  denied(
    admitTools(tool.account, tool.operation, { ...toolProposal, count: 3 }),
    'USAGE_RECEIPT_CONFLICT',
  );
  denied(
    observeUsage(settled.account, settled.operation, {
      ...observation,
      usage: { inputTokens: 1, outputTokens: 0 },
    }),
    'USAGE_RECEIPT_CONFLICT',
  );
});

test('account and operation ownership cannot be rebound through a replay or settlement', () => {
  const first = admitted(admitGeneration(account(), undefined, proposal('owned')));
  denied(
    admitGeneration(first.account, undefined, proposal('new', { accountId: 'another' })),
    'USAGE_OWNER_MISMATCH',
  );
  denied(
    admitGeneration(first.account, { ...first.operation, accountId: 'another' }, proposal('owned')),
    'USAGE_RECEIPT_CONFLICT',
  );
  denied(
    admitGeneration(first.account, first.operation, proposal('different-operation')),
    'USAGE_RECEIPT_CONFLICT',
  );
  denied(
    observeUsage(first.account, first.operation, {
      accountId: 'another',
      operationId: 'owned',
      outcome: 'unknown',
    }),
    'USAGE_OWNER_MISMATCH',
  );
  denied(
    observeUsage(first.account, first.operation, {
      accountId: first.account.id,
      operationId: 'different-operation',
      outcome: 'unknown',
    }),
    'USAGE_RECEIPT_CONFLICT',
  );
});

test('known usage releases exposure without replenishing the finite cumulative output allowance', () => {
  const first = admitted(
    admitGeneration(
      account(policy({ maxReservedOutputTokens: 100 })),
      undefined,
      proposal('finite', { requestedOutputTokens: 100 }),
    ),
  );
  const settled = admitted(
    observeUsage(first.account, first.operation, {
      accountId: first.account.id,
      operationId: 'finite',
      outcome: 'observed',
      usage: { inputTokens: 20, outputTokens: 5 },
    }),
  );
  assert.equal(settled.account.outstandingOutputTokens, 0);
  assert.equal(settled.account.admitted.work.reservedOutputTokens, 100);
  assert.equal(settled.account.observed.outputTokens, 5);
  denied(
    admitGeneration(settled.account, undefined, proposal('not-a-refund')),
    'USAGE_LIMIT_EXHAUSTED',
  );
});

test('zero observed usage, partial usage and unknown outcomes retain different evidence', () => {
  const scenarios = [
    {
      outcome: 'observed' as const,
      usage: { inputTokens: 0, outputTokens: 0 },
      knownInput: 1,
      knownOutput: 1,
      complete: 1,
      partial: 0,
      outstanding: 0,
    },
    {
      outcome: 'observed' as const,
      usage: { inputTokens: 0 },
      knownInput: 1,
      knownOutput: 0,
      complete: 0,
      partial: 1,
      outstanding: 10,
    },
    {
      outcome: 'observed' as const,
      usage: { outputTokens: 0 },
      knownInput: 0,
      knownOutput: 1,
      complete: 0,
      partial: 1,
      outstanding: 0,
    },
    {
      outcome: 'observed' as const,
      knownInput: 0,
      knownOutput: 0,
      complete: 0,
      partial: 0,
      outstanding: 10,
    },
    {
      outcome: 'unknown' as const,
      knownInput: 0,
      knownOutput: 0,
      complete: 0,
      partial: 0,
      outstanding: 10,
    },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const first = admitted(admitGeneration(account(), undefined, proposal(`scenario-${index}`)));
    const settled = admitted(
      observeUsage(first.account, first.operation, {
        accountId: first.account.id,
        operationId: first.operation.operationId,
        outcome: scenario.outcome,
        ...('usage' in scenario ? { usage: scenario.usage } : {}),
      }),
    );
    assert.equal(settled.account.observed.knownInputRequests, scenario.knownInput);
    assert.equal(settled.account.observed.knownOutputRequests, scenario.knownOutput);
    assert.equal(settled.account.observed.completeUsageRequests, scenario.complete);
    assert.equal(settled.account.observed.partialUsageRequests, scenario.partial);
    assert.equal(settled.account.observed.unknownUsageRequests, 1 - scenario.complete);
    assert.equal(settled.account.outstandingOutputTokens, scenario.outstanding);
    assert.equal(settled.account.observed.inputTokens, 0);
    assert.equal(settled.account.observed.outputTokens, 0);
    assert.equal(settled.account.status, 'open');
    if (scenario.outcome === 'unknown') {
      const replay = admitted(
        observeUsage(settled.account, settled.operation, {
          accountId: first.account.id,
          operationId: first.operation.operationId,
          outcome: 'unknown',
        }),
        'replayed',
      );
      assert.deepEqual(replay.account, settled.account);
      denied(
        observeUsage(settled.account, settled.operation, {
          accountId: first.account.id,
          operationId: first.operation.operationId,
          outcome: 'observed',
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
        'USAGE_RECEIPT_CONFLICT',
      );
    }
  }
});

test('incremental summaries match an independent whole-history oracle through interleaved phases and observations', () => {
  let state = account();
  const reference = new Map<string, ReferenceUsageOperation>();
  const receipts = new Map<string, UsageOperation>();
  for (let index = 0; index < 200; index++) {
    const phase = index % 4 === 0 ? 'review' : 'work';
    const id = `operation-${index}`;
    const next =
      index % 3 === 0
        ? admitted(
            admitTools(state, receipts.get(id), {
              accountId: state.id,
              operationId: id,
              phase,
              count: 1 + (index % 3),
            }),
          )
        : admitted(
            admitGeneration(
              state,
              receipts.get(id),
              proposal(id, { phase, requestedOutputTokens: 5 + (index % 6) }),
            ),
          );
    state = next.account;
    receipts.set(id, next.operation);
    reference.set(
      id,
      next.operation.kind === 'tools'
        ? { kind: 'tools', phase, count: next.operation.count }
        : {
            kind: 'generation',
            phase,
            allowance: next.operation.maxOutputTokens,
            outcome: 'pending',
          },
    );
    assert.deepEqual(totals(state), referenceUsageTotals(reference.values()));
    if (next.operation.kind !== 'generation') continue;
    const usage =
      index % 7 === 0
        ? undefined
        : index % 5 === 0
          ? { inputTokens: 0 }
          : index % 2 === 0
            ? { outputTokens: 1 }
            : { inputTokens: index, outputTokens: 2 };
    const outcome = index % 11 === 0 ? 'unknown' : 'observed';
    const observation = {
      accountId: state.id,
      operationId: id,
      outcome,
      ...(outcome === 'observed' && usage !== undefined ? { usage } : {}),
    } as const;
    const settled = admitted(observeUsage(state, receipts.get(id), observation));
    state = settled.account;
    receipts.set(id, settled.operation);
    reference.set(id, {
      kind: 'generation',
      phase,
      allowance: next.operation.maxOutputTokens,
      outcome,
      ...(outcome === 'observed' && usage !== undefined ? { usage } : {}),
    });
    assert.deepEqual(totals(state), referenceUsageTotals(reference.values()));
    assert.deepEqual(
      admitted(observeUsage(state, receipts.get(id), observation), 'replayed').account,
      state,
    );
  }
});

for (const size of [1000, 10000, 17409])
  test(`indexed accounting crosses ${size} operations without a historical ledger input or count ceiling`, () => {
    let state = account(policy({ maxRequests: size + 1, maxReservedOutputTokens: size + 1 }));
    const receipts = new Map<string, UsageOperation>();
    let reads = 0;
    let writes = 0;
    const index = {
      get(id: string) {
        reads++;
        return receipts.get(id);
      },
      set(id: string, value: UsageOperation) {
        writes++;
        receipts.set(id, value);
      },
      [Symbol.iterator]() {
        throw Error('Historical receipt enumeration is not an admission input.');
      },
    };
    for (let position = 0; position < size; position++) {
      const input = proposal(`op-${position}`, { requestedOutputTokens: 1 });
      const next = admitted(admitGeneration(state, index.get(input.operationId), input));
      state = next.account;
      index.set(input.operationId, next.operation);
    }
    assert.equal(reads, size);
    assert.equal(writes, size);
    assert.equal(state.admitted.work.requests, size);
    assert.equal(state.admitted.work.reservedOutputTokens, size);
    assert.equal(state.observed.unknownUsageRequests, size);
    assert.equal(state.outstandingOutputTokens, size);
    assert.ok(
      JSON.stringify(state).length < 2000,
      'Current account is bounded rather than a historical operation map.',
    );
    for (const position of [0, Math.floor(size / 2), size - 1]) {
      const input = proposal(`op-${position}`, { requestedOutputTokens: 1 });
      assert.deepEqual(
        admitted(admitGeneration(state, index.get(input.operationId), input), 'replayed').account,
        state,
      );
    }
    assert.equal(reads, size + 3);
    assert.equal(writes, size);
  });

test('safe integer exhaustion cannot wrap revision or observed usage into a fresh allowance', () => {
  const initial = account();
  initial.revision = Number.MAX_SAFE_INTEGER;
  denied(admitGeneration(initial, undefined, proposal('overflow')), 'USAGE_ARITHMETIC_OVERFLOW');
  assert.equal(initial.admitted.work.requests, 0);
  const first = admitted(admitGeneration(account(), undefined, proposal('first')));
  const one = admitted(
    observeUsage(first.account, first.operation, {
      accountId: first.account.id,
      operationId: 'first',
      outcome: 'observed',
      usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
    }),
  );
  const second = admitted(admitGeneration(one.account, undefined, proposal('second')));
  const overflowed = admitted(
    observeUsage(second.account, second.operation, {
      accountId: second.account.id,
      operationId: 'second',
      outcome: 'observed',
      usage: { inputTokens: 1, outputTokens: 0 },
    }),
  );
  assert.equal(overflowed.account.status, 'poisoned');
  assert.equal(overflowed.account.violation, 'USAGE_ARITHMETIC_OVERFLOW');
  assert.equal(overflowed.account.observed.inputTokens, null);
  assert.ok(overflowed.error);
  denied(
    admitGeneration(overflowed.account, undefined, proposal('after-overflow')),
    'USAGE_ACCOUNT_POISONED',
  );
  assert.equal(one.account.observed.inputTokens, Number.MAX_SAFE_INTEGER);
});

test('accidental historical containers cannot enter a fixed-size account through unchecked extra fields', () => {
  const initial = account();
  Object.defineProperty(initial, 'history', {
    enumerable: true,
    get() {
      throw Error('Historical container was read.');
    },
  });
  assert.throws(() => admitGeneration(initial, undefined, proposal('no-history')), {
    code: 'INVALID_USAGE_ACCOUNT',
  });
});
