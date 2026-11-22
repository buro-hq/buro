import {
  validateProjectEntityChange,
  type ProjectEntityChange,
  type ProjectEntities,
  type EntityTransaction,
} from './project-entities.ts';
import {
  validateProjectMaterialChange,
  type ProjectMaterialChange,
  type ProjectMaterials,
  type MaterialTransaction,
} from './project-materials.ts';
import {
  validateProjectSettingsChange,
  type ProjectSettingsChange,
  type ProjectSettings,
  type SettingsTransaction,
} from './project-settings.ts';
import {
  validateProjectRunChange,
  type ProjectRunChange,
  type ProjectRuns,
  type RunTransaction,
} from './project-runs.ts';
import type { Project } from '../protocol/domain.ts';
import { DomainError } from './ports.ts';
import {
  admitGeneration,
  admitTools,
  createUsageAccount,
  observeUsage,
  validateUsageAccount,
  validateUsageOperation,
  type GenerationAllowance,
  type GenerationProposal,
  type ToolAllowance,
  type ToolProposal,
  type UsageAccount,
  type UsageObservation,
  type UsageOperation,
  type UsagePolicy,
  type UsageTransition,
} from './usage-accounting.ts';

/** Kernel registration only; this slice does not validate a corresponding Run/entity row. */
export type ProjectUsageOwner =
  | { kind: 'run'; runId: string }
  | { kind: 'research'; researchId: string }
  | { kind: 'result-preparation'; preparationId: string; runId: string; operationId: string }
  | { kind: 'environment-verification'; verificationId: string }
  | { kind: 'result-application'; applicationId: string; runId: string };
export type UsageCommand = { id: string; fingerprint: string };
export type ProjectUsageSummary = Omit<UsageAccount, 'id'> & {
  coverage: {
    admissions: 'recorded-operations-only';
    providerUsage: 'known-subset';
    opaqueBackendUsage: 'unknown';
  };
};
export type ProjectUsageChange = {
  type: 'usage.changed';
  projectId: string;
  owner: ProjectUsageOwner;
  summary: ProjectUsageSummary;
};
export type ProjectAuthorityChange =
  | ProjectUsageChange
  | ((ProjectEntityChange | ProjectMaterialChange | ProjectSettingsChange | ProjectRunChange) & {
      projectId: string;
    });
export type UsageAuthorityEvent = ProjectAuthorityChange & { sequence: number };
export type UsageEventPage = {
  events: UsageAuthorityEvent[];
  watermark: number;
  nextAfter?: number;
};
export type UsageEventQuery = { after: number; limit: number; watermark?: number };
export interface UsageTransaction {
  createAccount(owner: ProjectUsageOwner, input: { id: string; policy: UsagePolicy }): UsageAccount;
  account(owner: ProjectUsageOwner): UsageAccount | undefined;
  operation(owner: ProjectUsageOwner, operationId: string): UsageOperation | undefined;
  admitGeneration(
    owner: ProjectUsageOwner,
    proposal: GenerationProposal,
  ): UsageTransition<GenerationAllowance>;
  admitTools(owner: ProjectUsageOwner, proposal: ToolProposal): UsageTransition<ToolAllowance>;
  observeUsage(owner: ProjectUsageOwner, observation: UsageObservation): UsageTransition;
}
export type UsageAuthorityTransaction = { readonly usage: UsageTransaction };
export type ProjectAuthorityTransaction = UsageAuthorityTransaction & {
  readonly entities: EntityTransaction;
  readonly materials: MaterialTransaction;
  readonly settings: SettingsTransaction;
  readonly runs: RunTransaction;
};
export interface ProjectUsageAuthority {
  readonly project: Project;
  readonly projectId: string;
  readonly entities: ProjectEntities;
  readonly materials: ProjectMaterials;
  readonly settings: ProjectSettings;
  readonly runs: ProjectRuns;
  /** Callback is synchronous and its result must be JSON-safe; neither permits external effects. */
  transaction<T>(command: UsageCommand, apply: (tx: ProjectAuthorityTransaction) => T): Promise<T>;
  account(owner: ProjectUsageOwner): Promise<UsageAccount | undefined>;
  operation(owner: ProjectUsageOwner, operationId: string): Promise<UsageOperation | undefined>;
  pagedEvents(query: UsageEventQuery): Promise<UsageEventPage>;
  close(): Promise<void>;
}

/**
 * Trusted adapter-only row port inside an existing transaction. Never exposed to the
 * application callback. Account IDs are unique per project; owner bindings are immutable.
 */
export interface UsageTransactionStorage {
  /** Must reject a known primary owner ID with a different frozen binding. */
  account(owner: ProjectUsageOwner): UsageAccount | undefined;
  operation(owner: ProjectUsageOwner, operationId: string): UsageOperation | undefined;
  insertAccount(owner: ProjectUsageOwner, account: UsageAccount): void;
  /** CAS both original account and specific operation, including saturated-revision settlement. */
  applyTransition(
    owner: ProjectUsageOwner,
    input: {
      previousAccount: UsageAccount;
      previousOperation?: UsageOperation;
      account: UsageAccount;
      operation: UsageOperation;
    },
  ): void;
  appendChange(change: ProjectUsageChange): void;
}

const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const ownerFields = {
  run: ['kind', 'runId'],
  research: ['kind', 'researchId'],
  'result-preparation': ['kind', 'preparationId', 'runId', 'operationId'],
  'environment-verification': ['kind', 'verificationId'],
  'result-application': ['kind', 'applicationId', 'runId'],
} as const;

export function validateUsageOwner(value: unknown): ProjectUsageOwner {
  const invalid = () => new DomainError('INVALID_USAGE_OWNER', 'The usage owner is invalid.');
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  if (
    !kind ||
    !('value' in kind) ||
    typeof kind.value !== 'string' ||
    !Object.hasOwn(ownerFields, kind.value)
  )
    throw invalid();
  const fields = ownerFields[kind.value as keyof typeof ownerFields] as readonly string[];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  )
    throw invalid();
  const copied: Record<string, string> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !('value' in descriptor) || !identity(descriptor.value)) throw invalid();
    copied[field] = descriptor.value;
  }
  return copied as ProjectUsageOwner;
}

/** Additional owner fields are immutable binding data, not another owner namespace. */
export function usageOwnerKey(value: ProjectUsageOwner): string {
  const owner = validateUsageOwner(value);
  const primary =
    owner.kind === 'run'
      ? owner.runId
      : owner.kind === 'research'
        ? owner.researchId
        : owner.kind === 'result-preparation'
          ? owner.preparationId
          : owner.kind === 'environment-verification'
            ? owner.verificationId
            : owner.applicationId;
  return JSON.stringify([owner.kind, primary]);
}

/** No private account ID, operation ID, raw usage error input or observation identity is projected. */
export function projectUsageSummary(value: UsageAccount): ProjectUsageSummary {
  const account = validateUsageAccount(value);
  const { id: _privateAccountId, ...summary } = account;
  return {
    ...summary,
    coverage: {
      admissions: 'recorded-operations-only',
      providerUsage: 'known-subset',
      opaqueBackendUsage: 'unknown',
    },
  };
}
export function projectUsageChange(
  projectId: string,
  owner: ProjectUsageOwner,
  account: UsageAccount,
): ProjectUsageChange {
  if (!identity(projectId))
    throw new DomainError('INVALID_PROJECT_ID', 'The project identity is invalid.');
  return {
    type: 'usage.changed',
    projectId,
    owner: validateUsageOwner(owner),
    summary: projectUsageSummary(account),
  };
}
const samePolicy = (left: UsagePolicy, right: UsagePolicy) =>
  left.version === right.version &&
  left.maxRequests === right.maxRequests &&
  left.maxReservedOutputTokens === right.maxReservedOutputTokens &&
  left.maxToolCalls === right.maxToolCalls &&
  left.reviewReserve.requests === right.reviewReserve.requests &&
  left.reviewReserve.outputTokens === right.reviewReserve.outputTokens &&
  left.reviewReserve.toolCalls === right.reviewReserve.toolCalls;

/** Actual finite-engine consumer; all row mutations and events remain in the adapter's open transaction. */
export function createUsageAuthorityTransaction(options: {
  projectId: string;
  storage: UsageTransactionStorage;
  assertActive(): void;
}): UsageAuthorityTransaction {
  const { projectId, storage, assertActive } = options;
  if (!identity(projectId))
    throw new DomainError('INVALID_PROJECT_ID', 'The project identity is invalid.');
  const owner = (input: ProjectUsageOwner) => {
    assertActive();
    return validateUsageOwner(input);
  };
  const account = (binding: ProjectUsageOwner) => {
    const value = storage.account(binding);
    return value === undefined ? undefined : validateUsageAccount(value);
  };
  const operation = (
    binding: ProjectUsageOwner,
    operationId: string,
    owningAccount?: UsageAccount,
  ) => {
    if (!identity(operationId))
      throw new DomainError('INVALID_USAGE_OPERATION', 'The usage operation identity is invalid.');
    const existing = owningAccount ?? account(binding);
    const value = storage.operation(binding, operationId);
    if (value === undefined) return undefined;
    if (!existing)
      throw new DomainError(
        'INVALID_USAGE_ACCOUNT',
        'A saved operation requires its owning account.',
      );
    return validateUsageOperation(value, existing);
  };
  const apply = <G>(
    input: ProjectUsageOwner,
    operationId: string,
    decide: (account: UsageAccount, prior: UsageOperation | undefined) => UsageTransition<G>,
  ): UsageTransition<G> => {
    const binding = owner(input);
    const previousAccount = account(binding);
    if (!previousAccount)
      throw new DomainError(
        'USAGE_ACCOUNT_REQUIRED',
        'Create an explicit usage account for this owner first.',
      );
    const previousOperation = operation(binding, operationId, previousAccount);
    const result = decide(previousAccount, previousOperation);
    if (result.kind === 'applied') {
      storage.applyTransition(
        binding,
        structuredClone({
          previousAccount,
          ...(previousOperation ? { previousOperation } : {}),
          account: result.account,
          operation: result.operation,
        }),
      );
      storage.appendChange(projectUsageChange(projectId, binding, result.account));
    }
    return structuredClone(result);
  };
  return Object.freeze({
    usage: Object.freeze({
      createAccount(input: ProjectUsageOwner, spec: { id: string; policy: UsagePolicy }) {
        const binding = owner(input);
        const candidate = createUsageAccount(spec);
        const existing = account(binding);
        if (existing) {
          if (existing.id !== candidate.id || !samePolicy(existing.policy, candidate.policy))
            throw new DomainError(
              'USAGE_ACCOUNT_CONFLICT',
              'This owner already has a different usage account or policy.',
            );
          return existing;
        }
        storage.insertAccount(binding, structuredClone(candidate));
        storage.appendChange(projectUsageChange(projectId, binding, candidate));
        return structuredClone(candidate);
      },
      account(input: ProjectUsageOwner) {
        return account(owner(input));
      },
      operation(input: ProjectUsageOwner, operationId: string) {
        return operation(owner(input), operationId);
      },
      admitGeneration(input: ProjectUsageOwner, proposal: GenerationProposal) {
        return apply(input, proposal.operationId, (current, prior) =>
          admitGeneration(current, prior, proposal),
        );
      },
      admitTools(input: ProjectUsageOwner, proposal: ToolProposal) {
        return apply(input, proposal.operationId, (current, prior) =>
          admitTools(current, prior, proposal),
        );
      },
      observeUsage(input: ProjectUsageOwner, observation: UsageObservation) {
        return apply(input, observation.operationId, (current, prior) =>
          observeUsage(current, prior, observation),
        );
      },
    }),
  });
}

/** Decode a stored public projection; the validation identity is never persisted or granted. */
export function validateProjectUsageChange(
  value: unknown,
  expectedProjectId?: string,
): ProjectUsageChange {
  const invalid = () => new DomainError('INVALID_USAGE_EVENT', 'The saved usage event is invalid.');
  const record = (
    input: unknown,
    fields: string[],
    optional: string[] = [],
  ): input is Record<string, unknown> => {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      return false;
    return (
      fields.every((key) => Object.hasOwn(input, key)) &&
      Reflect.ownKeys(input).every(
        (key) =>
          typeof key === 'string' &&
          (fields.includes(key) || optional.includes(key)) &&
          'value' in Object.getOwnPropertyDescriptor(input, key)!,
      )
    );
  };
  if (
    !record(value, ['type', 'projectId', 'owner', 'summary']) ||
    value.type !== 'usage.changed' ||
    !identity(value.projectId) ||
    (expectedProjectId !== undefined && value.projectId !== expectedProjectId) ||
    !record(
      value.summary,
      [
        'version',
        'revision',
        'policy',
        'status',
        'admitted',
        'observed',
        'outstandingOutputTokens',
        'coverage',
      ],
      ['violation'],
    )
  )
    throw invalid();
  const { coverage, ...summary } = value.summary;
  if (
    !record(coverage, ['admissions', 'providerUsage', 'opaqueBackendUsage']) ||
    coverage.admissions !== 'recorded-operations-only' ||
    coverage.providerUsage !== 'known-subset' ||
    coverage.opaqueBackendUsage !== 'unknown'
  )
    throw invalid();
  try {
    return projectUsageChange(
      value.projectId,
      validateUsageOwner(value.owner),
      validateUsageAccount({ ...summary, id: 'public-summary-validation' }),
    );
  } catch {
    throw invalid();
  }
}

/** Shared event stream: entity changes and usage changes consume the same authority sequence. */
export function validateProjectAuthorityChange(
  value: unknown,
  expectedProjectId?: string,
): ProjectAuthorityChange {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DomainError('INVALID_AUTHORITY_EVENT', 'The saved project event is invalid.');
  const input = value as Record<string, unknown>;
  if (input.type === 'usage.changed') return validateProjectUsageChange(value, expectedProjectId);
  if (
    !identity(input.projectId) ||
    (expectedProjectId !== undefined && input.projectId !== expectedProjectId)
  )
    throw new DomainError('INVALID_AUTHORITY_EVENT', 'The saved project event is invalid.');
  const { projectId, ...change } = input;
  if (
    change.type === 'run.admitted' ||
    change.type === 'run.cancel-requested' ||
    change.type === 'run.lifecycle-changed' ||
    change.type === 'run.workspace-bound'
  )
    return { ...validateProjectRunChange(change, projectId), projectId };
  if (change.type === 'project.configured' || change.type === 'project.verified')
    return { ...validateProjectSettingsChange(change), projectId };
  if (change.type === 'context.materials.added' || change.type === 'context.material.removed')
    return { ...validateProjectMaterialChange(change), projectId };
  return { ...validateProjectEntityChange(change, projectId), projectId };
}
