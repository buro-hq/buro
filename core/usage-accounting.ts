import { DomainError } from './ports.ts';

/** Finite 5A policy: cumulative admissions, not outstanding exposure, enforce these caps. */
export type UsagePolicy = {
  version: 1;
  maxRequests: number;
  maxReservedOutputTokens: number;
  maxToolCalls: number;
  reviewReserve: { requests: number; outputTokens: number; toolCalls: number };
};
export type UsagePhase = 'work' | 'review';
export type UsageCounters = { requests: number; reservedOutputTokens: number; toolCalls: number };
export type UsageAccount = {
  version: 1;
  id: string;
  revision: number;
  policy: UsagePolicy;
  status: 'open' | 'poisoned';
  admitted: { work: UsageCounters; review: UsageCounters };
  observed: {
    /** Known subset only. Null means arithmetic overflow, never a measured zero. */
    inputTokens: number | null;
    outputTokens: number | null;
    knownInputRequests: number;
    knownOutputRequests: number;
    completeUsageRequests: number;
    /** A subset of unknownUsageRequests; these counters are not additive. */
    partialUsageRequests: number;
    /** Admitted generations minus complete usage, including pending and partial receipts. */
    unknownUsageRequests: number;
  };
  outstandingOutputTokens: number;
  violation?: 'INVALID_USAGE' | 'OUTPUT_ALLOWANCE_EXCEEDED' | 'USAGE_ARITHMETIC_OVERFLOW';
};
export type Usage = { inputTokens?: number; outputTokens?: number };
export type GenerationProposal = {
  accountId: string;
  operationId: string;
  phase: UsagePhase;
  requestedOutputTokens: number;
  minimumOutputTokens: number;
};
export type ToolProposal = {
  accountId: string;
  operationId: string;
  phase: UsagePhase;
  count: number;
};
export type UsageObservation = {
  accountId: string;
  operationId: string;
  outcome: 'observed' | 'unknown';
  usage?: Usage;
};
export type GenerationOperation = GenerationProposal & {
  kind: 'generation';
  maxOutputTokens: number;
  status: 'pending' | 'observed' | 'unknown';
  usage?: Usage;
  /** Private, JSON-safe exact observation identity; not a public diagnostic. */
  observationKey?: string;
  invalidUsage?: true;
  error?: UsageFailure;
};
export type ToolOperation = ToolProposal & { kind: 'tools' };
export type UsageOperation = GenerationOperation | ToolOperation;
/** Historical allowance on replay; only a future journal dispatch claim can authorize an effect. */
export type GenerationAllowance = { operationId: string; maxOutputTokens: number };
export type ToolAllowance = { operationId: string; count: number };
export type UsageFailure = { code: string; message: string };
export type UsageTransition<G = undefined> =
  | ({ kind: 'denied' } & UsageFailure)
  | {
      kind: 'applied' | 'replayed';
      account: UsageAccount;
      operation: UsageOperation;
      grant?: G;
      /** Applied poison must be committed before this error is raised by an outer caller. */
      error?: UsageFailure;
    };

const safe = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number => safe(value) && value > 0;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const denied = (code: string, message: string): UsageTransition<never> => ({
  kind: 'denied',
  code,
  message,
});
const invalid = () => new DomainError('INVALID_USAGE_ACCOUNT', 'The usage account is invalid.');
const empty = (): UsageCounters => ({ requests: 0, reservedOutputTokens: 0, toolCalls: 0 });

function closed(value: unknown, required: string[], optional: string[] = []): boolean {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every(
      (key) =>
        typeof key === 'string' &&
        (required.includes(key) || optional.includes(key)) &&
        'value' in Object.getOwnPropertyDescriptor(value, key)!,
    )
  );
}
function validPolicy(value: UsagePolicy) {
  return (
    closed(value, [
      'version',
      'maxRequests',
      'maxReservedOutputTokens',
      'maxToolCalls',
      'reviewReserve',
    ]) &&
    value.version === 1 &&
    [value.maxRequests, value.maxReservedOutputTokens, value.maxToolCalls].every(safe) &&
    closed(value.reviewReserve, ['requests', 'outputTokens', 'toolCalls']) &&
    safe(value.reviewReserve.requests) &&
    safe(value.reviewReserve.outputTokens) &&
    safe(value.reviewReserve.toolCalls) &&
    value.reviewReserve.requests <= value.maxRequests &&
    value.reviewReserve.outputTokens <= value.maxReservedOutputTokens &&
    value.reviewReserve.toolCalls <= value.maxToolCalls
  );
}

export function createUsageAccount(input: { id: string; policy: UsagePolicy }): UsageAccount {
  if (!closed(input, ['id', 'policy']) || !id(input.id) || !validPolicy(input.policy))
    throw new DomainError(
      'INVALID_USAGE_POLICY',
      'An explicit finite usage policy and account identity are required.',
    );
  return {
    version: 1,
    id: input.id,
    revision: 0,
    policy: structuredClone(input.policy),
    status: 'open',
    admitted: { work: empty(), review: empty() },
    observed: {
      inputTokens: 0,
      outputTokens: 0,
      knownInputRequests: 0,
      knownOutputRequests: 0,
      completeUsageRequests: 0,
      partialUsageRequests: 0,
      unknownUsageRequests: 0,
    },
    outstandingOutputTokens: 0,
  };
}

function accountCopy(account: UsageAccount): UsageAccount {
  if (
    !closed(
      account,
      [
        'version',
        'id',
        'revision',
        'policy',
        'status',
        'admitted',
        'observed',
        'outstandingOutputTokens',
      ],
      ['violation'],
    ) ||
    account.version !== 1 ||
    !id(account.id) ||
    !safe(account.revision) ||
    !validPolicy(account.policy) ||
    !['open', 'poisoned'].includes(account.status) ||
    (account.status === 'poisoned') !== (account.violation !== undefined) ||
    (account.violation !== undefined &&
      !['INVALID_USAGE', 'OUTPUT_ALLOWANCE_EXCEEDED', 'USAGE_ARITHMETIC_OVERFLOW'].includes(
        account.violation,
      ))
  )
    throw invalid();
  const work = account.admitted?.work,
    review = account.admitted?.review,
    observed = account.observed;
  if (
    !closed(account.admitted, ['work', 'review']) ||
    !closed(work, ['requests', 'reservedOutputTokens', 'toolCalls']) ||
    !closed(review, ['requests', 'reservedOutputTokens', 'toolCalls']) ||
    !closed(observed, [
      'inputTokens',
      'outputTokens',
      'knownInputRequests',
      'knownOutputRequests',
      'completeUsageRequests',
      'partialUsageRequests',
      'unknownUsageRequests',
    ]) ||
    !safe(account.outstandingOutputTokens)
  )
    throw invalid();
  for (const key of ['requests', 'reservedOutputTokens', 'toolCalls'] as const)
    if (!safe(work[key]) || !safe(review[key]) || !safe(work[key] + review[key])) throw invalid();
  const requests = work.requests + review.requests;
  if (
    [
      observed.knownInputRequests,
      observed.knownOutputRequests,
      observed.completeUsageRequests,
      observed.partialUsageRequests,
      observed.unknownUsageRequests,
    ].some((value) => !safe(value) || value > requests) ||
    observed.completeUsageRequests !== requests - observed.unknownUsageRequests ||
    observed.partialUsageRequests > observed.unknownUsageRequests ||
    observed.knownInputRequests < observed.completeUsageRequests ||
    observed.knownOutputRequests < observed.completeUsageRequests ||
    observed.knownInputRequests - observed.completeUsageRequests !==
      observed.partialUsageRequests -
        (observed.knownOutputRequests - observed.completeUsageRequests) ||
    [observed.inputTokens, observed.outputTokens].some((value) => value !== null && !safe(value)) ||
    ((observed.inputTokens === null || observed.outputTokens === null) &&
      account.status !== 'poisoned') ||
    account.outstandingOutputTokens > work.reservedOutputTokens + review.reservedOutputTokens ||
    work.requests + review.requests > account.policy.maxRequests ||
    work.reservedOutputTokens + review.reservedOutputTokens >
      account.policy.maxReservedOutputTokens ||
    work.toolCalls + review.toolCalls > account.policy.maxToolCalls ||
    work.requests > account.policy.maxRequests - account.policy.reviewReserve.requests ||
    work.reservedOutputTokens >
      account.policy.maxReservedOutputTokens - account.policy.reviewReserve.outputTokens ||
    work.toolCalls > account.policy.maxToolCalls - account.policy.reviewReserve.toolCalls
  )
    throw invalid();
  return structuredClone(account);
}
const conflict = () =>
  denied(
    'USAGE_RECEIPT_CONFLICT',
    'This usage operation belongs to a different admission or observation.',
  );
const exhausted = () => denied('USAGE_LIMIT_EXHAUSTED', 'The finite usage allowance is exhausted.');
const poisoned = () =>
  denied('USAGE_ACCOUNT_POISONED', 'Observed usage requires attention before further dispatch.');
const overflow = () =>
  denied('USAGE_ARITHMETIC_OVERFLOW', 'Usage counters cannot safely represent another admission.');
function owner(account: UsageAccount, proposal: { accountId: string; operationId: string }) {
  return id(proposal?.accountId) && id(proposal?.operationId) && proposal.accountId === account.id;
}
function replay<G>(
  account: UsageAccount,
  operation: UsageOperation,
  grant?: G,
): UsageTransition<G> {
  return {
    kind: 'replayed',
    account,
    operation: structuredClone(operation),
    ...(grant ? { grant: structuredClone(grant) } : {}),
    ...('error' in operation && operation.error
      ? { error: structuredClone(operation.error) }
      : account.status === 'poisoned'
        ? {
            error: {
              code: 'USAGE_ACCOUNT_POISONED',
              message: 'Observed usage requires attention before further dispatch.',
            },
          }
        : {}),
  };
}
function priorOwner(
  account: UsageAccount,
  proposal: { accountId: string; operationId: string },
  prior: UsageOperation,
) {
  return prior.accountId === account.id && prior.operationId === proposal.operationId;
}

export function admitGeneration(
  account: UsageAccount,
  prior: UsageOperation | undefined,
  proposal: GenerationProposal,
): UsageTransition<GenerationAllowance> {
  const next = accountCopy(account);
  if (!owner(next, proposal))
    return denied('USAGE_OWNER_MISMATCH', 'The usage operation owner does not match this account.');
  if (
    !closed(proposal, [
      'accountId',
      'operationId',
      'phase',
      'requestedOutputTokens',
      'minimumOutputTokens',
    ]) ||
    !['work', 'review'].includes(proposal.phase) ||
    !positive(proposal.requestedOutputTokens) ||
    !positive(proposal.minimumOutputTokens) ||
    proposal.minimumOutputTokens > proposal.requestedOutputTokens
  )
    return denied('INVALID_USAGE_PROPOSAL', 'The generation allowance request is invalid.');
  if (prior) {
    if (
      !priorOwner(next, proposal, prior) ||
      prior.kind !== 'generation' ||
      prior.phase !== proposal.phase ||
      prior.requestedOutputTokens !== proposal.requestedOutputTokens ||
      prior.minimumOutputTokens !== proposal.minimumOutputTokens
    )
      return conflict();
    if (!validOperation(prior, next))
      return denied('INVALID_USAGE_OPERATION', 'The saved usage operation is invalid.');
    return replay(next, prior, {
      operationId: prior.operationId,
      maxOutputTokens: prior.maxOutputTokens,
    });
  }
  if (next.status === 'poisoned') return poisoned();
  const used = next.admitted,
    policy = next.policy;
  if (
    used.work.requests + used.review.requests >= policy.maxRequests ||
    (proposal.phase === 'work' &&
      used.work.requests >= policy.maxRequests - policy.reviewReserve.requests)
  )
    return exhausted();
  const remaining = Math.min(
    policy.maxReservedOutputTokens -
      used.work.reservedOutputTokens -
      used.review.reservedOutputTokens,
    proposal.phase === 'work'
      ? policy.maxReservedOutputTokens -
          policy.reviewReserve.outputTokens -
          used.work.reservedOutputTokens
      : policy.maxReservedOutputTokens,
  );
  const amount = Math.min(proposal.requestedOutputTokens, remaining);
  if (amount < proposal.minimumOutputTokens) return exhausted();
  if (!safe(next.revision + 1) || !safe(next.outstandingOutputTokens + amount)) return overflow();
  next.revision++;
  used[proposal.phase].requests++;
  used[proposal.phase].reservedOutputTokens += amount;
  next.observed.unknownUsageRequests++;
  next.outstandingOutputTokens += amount;
  const operation: GenerationOperation = {
    ...structuredClone(proposal),
    kind: 'generation',
    maxOutputTokens: amount,
    status: 'pending',
  };
  return {
    kind: 'applied',
    account: next,
    operation,
    grant: { operationId: proposal.operationId, maxOutputTokens: amount },
  };
}

export function admitTools(
  account: UsageAccount,
  prior: UsageOperation | undefined,
  proposal: ToolProposal,
): UsageTransition<ToolAllowance> {
  const next = accountCopy(account);
  if (!owner(next, proposal))
    return denied('USAGE_OWNER_MISMATCH', 'The usage operation owner does not match this account.');
  if (
    !closed(proposal, ['accountId', 'operationId', 'phase', 'count']) ||
    !['work', 'review'].includes(proposal.phase) ||
    !positive(proposal.count)
  )
    return denied('INVALID_USAGE_PROPOSAL', 'The tool allowance request is invalid.');
  if (prior) {
    if (
      !priorOwner(next, proposal, prior) ||
      prior.kind !== 'tools' ||
      prior.phase !== proposal.phase ||
      prior.count !== proposal.count
    )
      return conflict();
    if (!validOperation(prior, next))
      return denied('INVALID_USAGE_OPERATION', 'The saved usage operation is invalid.');
    return replay(next, prior, { operationId: prior.operationId, count: prior.count });
  }
  if (next.status === 'poisoned') return poisoned();
  const used = next.admitted,
    policy = next.policy;
  if (
    proposal.count > policy.maxToolCalls - used.work.toolCalls - used.review.toolCalls ||
    (proposal.phase === 'work' &&
      proposal.count > policy.maxToolCalls - policy.reviewReserve.toolCalls - used.work.toolCalls)
  )
    return exhausted();
  if (!safe(next.revision + 1)) return overflow();
  next.revision++;
  used[proposal.phase].toolCalls += proposal.count;
  return {
    kind: 'applied',
    account: next,
    operation: { ...structuredClone(proposal), kind: 'tools' },
    grant: { operationId: proposal.operationId, count: proposal.count },
  };
}

/**
 * Only the flat scalar usage protocol is replayable here. Complex malformed payloads
 * still produce durable poison, but their exact payload belongs to the future private
 * generation artifact, not an unbounded codec in the accounting hot path.
 */
function observationIdentity(observation: UsageObservation): string | undefined {
  const scalar = (item: unknown): unknown[] | undefined => {
    if (item === null) return ['null'];
    if (typeof item === 'number')
      return [
        'number',
        Number.isNaN(item)
          ? 'NaN'
          : item === Infinity
            ? '+Infinity'
            : item === -Infinity
              ? '-Infinity'
              : String(item),
      ];
    // Malformed provider bodies belong in private artifacts, never an oversized hot receipt.
    if (typeof item === 'string') return item.length <= 128 ? ['string', item] : undefined;
    if (typeof item === 'boolean') return ['boolean', item];
    if (typeof item === 'undefined') return ['undefined'];
    return undefined;
  };
  const usage = observation.usage;
  let identity = scalar(usage);
  if (identity === undefined) {
    if (
      !usage ||
      typeof usage !== 'object' ||
      Array.isArray(usage) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(usage))
    )
      return undefined;
    const keys = Reflect.ownKeys(usage);
    // A valid usage record has at most two scalar properties; no legitimate receipt is bounded here.
    if (keys.length > 2 || keys.some((key) => typeof key !== 'string' || key.length > 64))
      return undefined;
    const entries: unknown[] = [];
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(usage, key)!;
      if (!('value' in descriptor)) return undefined;
      if ((key === 'inputTokens' || key === 'outputTokens') && descriptor.value === undefined)
        continue;
      const value = scalar(descriptor.value);
      if (value === undefined) return undefined;
      entries.push([key, value]);
    }
    identity = ['object', entries];
  }
  return JSON.stringify([observation.outcome, identity]);
}
function validUsage(value: unknown): value is Usage {
  if (value === undefined) return true;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  return Reflect.ownKeys(value).every((key) => {
    if (key !== 'inputTokens' && key !== 'outputTokens') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return 'value' in descriptor && (descriptor.value === undefined || safe(descriptor.value));
  });
}

export function observeUsage(
  account: UsageAccount,
  prior: UsageOperation | undefined,
  observation: UsageObservation,
): UsageTransition {
  const next = accountCopy(account);
  if (!owner(next, observation))
    return denied('USAGE_OWNER_MISMATCH', 'The usage operation owner does not match this account.');
  if (!prior || !priorOwner(next, observation, prior) || prior.kind !== 'generation')
    return conflict();
  if (!validOperation(prior, next))
    return denied('INVALID_USAGE_OPERATION', 'The saved usage operation is invalid.');
  if (
    !closed(observation, ['accountId', 'operationId', 'outcome'], ['usage']) ||
    !['observed', 'unknown'].includes(observation.outcome)
  )
    return denied('INVALID_USAGE_OBSERVATION', 'The usage observation outcome is invalid.');
  const observationKey = observationIdentity(observation);
  if (prior.status !== 'pending')
    return observationKey !== undefined && prior.observationKey === observationKey
      ? replay(next, prior)
      : conflict();
  // Settlement must retain observed evidence even if the account revision has reached representable capacity.
  const operation: GenerationOperation = {
    ...structuredClone(prior),
    status: observation.outcome,
    ...(observationKey !== undefined ? { observationKey } : {}),
  };
  const malformed =
    !validUsage(observation.usage) ||
    (observation.outcome === 'unknown' && observation.usage !== undefined);
  let violation: UsageAccount['violation'];
  if (malformed) {
    operation.invalidUsage = true;
    violation = 'INVALID_USAGE';
  } else if (observation.outcome === 'observed') {
    const usage = observation.usage;
    if (usage !== undefined) operation.usage = structuredClone(usage);
    const inputKnown = usage?.inputTokens !== undefined,
      outputKnown = usage?.outputTokens !== undefined;
    if (inputKnown) {
      next.observed.knownInputRequests++;
      const sum =
        next.observed.inputTokens === null ? null : next.observed.inputTokens + usage!.inputTokens!;
      next.observed.inputTokens = sum !== null && safe(sum) ? sum : null;
      if (next.observed.inputTokens === null) violation = 'USAGE_ARITHMETIC_OVERFLOW';
    }
    if (outputKnown) {
      next.observed.knownOutputRequests++;
      const sum =
        next.observed.outputTokens === null
          ? null
          : next.observed.outputTokens + usage!.outputTokens!;
      next.observed.outputTokens = sum !== null && safe(sum) ? sum : null;
      next.outstandingOutputTokens -= operation.maxOutputTokens;
      if (usage!.outputTokens! > operation.maxOutputTokens) violation = 'OUTPUT_ALLOWANCE_EXCEEDED';
      if (next.observed.outputTokens === null) violation = 'USAGE_ARITHMETIC_OVERFLOW';
    }
    if (inputKnown && outputKnown) {
      next.observed.completeUsageRequests++;
      next.observed.unknownUsageRequests--;
    } else if (inputKnown || outputKnown) next.observed.partialUsageRequests++;
  }
  if (safe(next.revision + 1)) next.revision++;
  else violation = 'USAGE_ARITHMETIC_OVERFLOW';
  if (violation) {
    next.status = 'poisoned';
    next.violation ??= violation;
    operation.error = {
      code: 'USAGE_OBSERVATION_INVALID',
      message:
        violation === 'INVALID_USAGE'
          ? 'The provider returned malformed usage accounting.'
          : violation === 'OUTPUT_ALLOWANCE_EXCEEDED'
            ? 'Observed output exceeded its admitted allowance.'
            : 'Observed usage exceeded representable accounting capacity.',
    };
  }
  return {
    kind: 'applied',
    account: next,
    operation,
    ...(operation.error ? { error: structuredClone(operation.error) } : {}),
  };
}

function validOperation(operation: UsageOperation, account: UsageAccount): boolean {
  if (
    !id(operation.accountId) ||
    operation.accountId !== account.id ||
    !id(operation.operationId) ||
    !['work', 'review'].includes(operation.phase)
  )
    return false;
  if (operation.kind === 'tools')
    return (
      closed(operation, ['accountId', 'operationId', 'phase', 'kind', 'count']) &&
      positive(operation.count) &&
      operation.count <= account.admitted[operation.phase].toolCalls
    );
  if (
    !closed(
      operation,
      [
        'accountId',
        'operationId',
        'phase',
        'kind',
        'requestedOutputTokens',
        'minimumOutputTokens',
        'maxOutputTokens',
        'status',
      ],
      ['usage', 'observationKey', 'invalidUsage', 'error'],
    ) ||
    operation.kind !== 'generation' ||
    !positive(operation.requestedOutputTokens) ||
    !positive(operation.minimumOutputTokens) ||
    !positive(operation.maxOutputTokens) ||
    operation.minimumOutputTokens > operation.maxOutputTokens ||
    operation.maxOutputTokens > operation.requestedOutputTokens ||
    operation.maxOutputTokens > account.admitted[operation.phase].reservedOutputTokens ||
    account.admitted[operation.phase].requests === 0 ||
    !['pending', 'observed', 'unknown'].includes(operation.status)
  )
    return false;
  if (operation.status === 'pending')
    return (
      operation.maxOutputTokens <= account.outstandingOutputTokens &&
      operation.usage === undefined &&
      operation.observationKey === undefined &&
      operation.invalidUsage === undefined &&
      operation.error === undefined
    );
  const validTerminal =
    (operation.usage === undefined || validUsage(operation.usage)) &&
    (operation.observationKey === undefined || typeof operation.observationKey === 'string') &&
    (operation.invalidUsage === undefined || operation.invalidUsage === true) &&
    (operation.error === undefined ||
      (closed(operation.error, ['code', 'message']) &&
        id(operation.error.code) &&
        id(operation.error.message))) &&
    (operation.status !== 'unknown' || operation.usage === undefined) &&
    (operation.invalidUsage !== true || operation.usage === undefined);
  if (!validTerminal) return false;
  if (operation.invalidUsage === true) return true;
  return (
    operation.observationKey ===
    observationIdentity({
      accountId: operation.accountId,
      operationId: operation.operationId,
      outcome: operation.status,
      ...(operation.usage !== undefined ? { usage: operation.usage } : {}),
    })
  );
}
