import type {
  DomainEvent,
  Project,
  ProjectProfile,
  ProjectResearch,
  ProjectVerification,
  ResearchAcknowledgement,
} from '../protocol/domain.ts';
import {
  ProjectSchema,
  ProjectVerificationSchema,
  ResearchProposalSchema,
  ResearchAcknowledgementSchema,
} from '../protocol/schema.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import { ExecutionPolicySchema } from '../protocol/execution-policy.ts';
import { DomainError } from './ports.ts';
import type { ExecutionPolicy } from './execution-ports.ts';

export type SettingsCommand = { id: string; fingerprint: string };
export type ResearchProposal = Pick<
  ProjectResearch,
  | 'id'
  | 'status'
  | 'analysis'
  | 'sourceHead'
  | 'profileRevision'
  | 'context'
  | 'components'
  | 'checks'
  | 'reviewedProfileRevision'
  | 'appliedProfileRevision'
>;
export type { ResearchAcknowledgement } from '../protocol/domain.ts';
export type ProjectSettingsChange = Extract<
  DomainEvent['change'],
  { type: 'project.configured' | 'project.verified' }
>;
export interface SettingsTransaction {
  profile(): ProjectProfile | undefined;
  verification(): ProjectVerification | undefined;
  researchProposal(): ResearchProposal | undefined;
  hasActiveRun(): boolean;
  initializeBaseBranch(input: { expectedRevision: number; baseBranch: string }): ProjectProfile;
  configure(input: {
    expectedRevision: number;
    profile: ProjectProfile;
    expectedResearch?: ResearchProposal;
  }): ProjectProfile;
  saveVerification(verification: ProjectVerification): ProjectVerification;
}
export interface ProjectSettings {
  readonly projectId: string;
  profile(): Promise<ProjectProfile | undefined>;
  verification(): Promise<ProjectVerification | undefined>;
  researchProposal(): Promise<ResearchProposal | undefined>;
  hasActiveRun(): Promise<boolean>;
  receipt(command: SettingsCommand): Promise<{ result: unknown } | undefined>;
  transaction<T>(command: SettingsCommand, apply: (tx: SettingsTransaction) => T): Promise<T>;
}
/** Trusted adapter-only current rows; writes use the same authority transaction and event sequence. */
export interface SettingsTransactionStorage {
  profile(): ProjectProfile | undefined;
  verification(): ProjectVerification | undefined;
  researchProposal(): ResearchProposal | undefined;
  hasActiveRun(): boolean;
  replaceProfile(previous: ProjectProfile, next: ProjectProfile): void;
  acknowledgeResearch(expected: ResearchProposal, next: ResearchAcknowledgement): void;
  saveVerification(verification: ProjectVerification): void;
  appendChange(change: ProjectSettingsChange): void;
}
const invalid = () =>
  new DomainError('INVALID_PROJECT_SETTINGS', 'The project settings record is invalid.');
const canonical = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const proposalFields = [
  'id',
  'status',
  'analysis',
  'sourceHead',
  'profileRevision',
  'context',
  'components',
  'checks',
  'reviewedProfileRevision',
  'appliedProfileRevision',
] as const;
export function validateProjectIdentity(value: unknown): Project {
  const result = ProjectSchema.strict().safeParse(value);
  if (!result.success || !result.data.id.length || !result.data.root.length) throw invalid();
  return canonical(result.data);
}
export function validateProjectProfile(value: unknown): ProjectProfile {
  const result = ProjectProfileSchema.safeParse(value);
  if (!result.success) throw invalid();
  return canonical(result.data);
}
export function validateProjectVerification(value: unknown): ProjectVerification {
  const result = ProjectVerificationSchema.strict().safeParse(value);
  if (!result.success) throw invalid();
  return canonical(result.data);
}
export function validateResearchProposal(value: unknown): ResearchProposal {
  const result = ResearchProposalSchema.strict().safeParse(value);
  if (!result.success) throw invalid();
  return canonical(result.data);
}
export function validateResearchAcknowledgement(value: unknown): ResearchAcknowledgement {
  const result = ResearchAcknowledgementSchema.strict().safeParse(value);
  if (!result.success) throw invalid();
  return canonical(result.data);
}
/** Reads only bounded proposal fields, never the full research transcript, grants or resources. */
export function projectResearchProposal(value: unknown): ResearchProposal | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const selected: Record<string, unknown> = {};
  for (const key of proposalFields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!('value' in descriptor)) throw invalid();
    if (descriptor.value !== undefined) selected[key] = descriptor.value;
  }
  return validateResearchProposal(selected);
}
export function executionPolicy(profile: ProjectProfile): ExecutionPolicy {
  return {
    scope: structuredClone(profile.scope),
    checks: profile.checks.map(({ id, title }) => ({ id, title })),
    defaultCheckIds: [...profile.defaultCheckIds],
    maxWorkers: profile.maxWorkers,
    turnTimeoutMs: profile.turnTimeoutMs,
    context: profile.context,
    profile: structuredClone(profile),
  };
}
export function policyView(profile: ProjectProfile) {
  const {
    profile: _profile,
    context: _context,
    turnTimeoutMs: _timeout,
    ...view
  } = executionPolicy(profile);
  return view;
}
export function validateProjectSettingsChange(value: unknown): ProjectSettingsChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(input);
  if (
    input.type === 'project.verified' &&
    keys.length === 2 &&
    Object.hasOwn(input, 'verification')
  )
    return {
      type: 'project.verified',
      verification: validateProjectVerification(input.verification),
    };
  if (
    input.type === 'project.configured' &&
    keys.length >= 3 &&
    keys.length <= 4 &&
    keys.every((key) =>
      ['type', 'profile', 'executionPolicy', 'researchAcknowledgement'].includes(String(key)),
    ) &&
    Object.hasOwn(input, 'profile') &&
    Object.hasOwn(input, 'executionPolicy')
  ) {
    const profile = validateProjectProfile(input.profile);
    const expectedPolicy = policyView(profile);
    // Rebuild from the saved profile rather than trusting a separately supplied policy projection.
    const supplied = ExecutionPolicySchema.safeParse(input.executionPolicy);
    if (
      !supplied.success ||
      JSON.stringify(canonical(supplied.data)) !== JSON.stringify(expectedPolicy)
    )
      throw invalid();
    return {
      type: 'project.configured',
      profile,
      executionPolicy: expectedPolicy,
      ...(input.researchAcknowledgement !== undefined
        ? {
            researchAcknowledgement: validateResearchAcknowledgement(input.researchAcknowledgement),
          }
        : {}),
    };
  }
  throw invalid();
}
function sameProposal(left: ResearchProposal, right: ResearchProposal) {
  const withoutAcknowledgement = (value: ResearchProposal) => {
    const {
      reviewedProfileRevision: _reviewed,
      appliedProfileRevision: _applied,
      ...proposal
    } = validateResearchProposal(value);
    return JSON.stringify(proposal);
  };
  return withoutAcknowledgement(left) === withoutAcknowledgement(right);
}
export function createSettingsTransaction(options: {
  projectId: string;
  storage: SettingsTransactionStorage;
  assertActive(): void;
}): SettingsTransaction {
  const { projectId, storage, assertActive } = options;
  if (typeof projectId !== 'string' || !projectId.length)
    throw new DomainError('INVALID_PROJECT_ID', 'The project identity is invalid.');
  const profile = () => {
    assertActive();
    const value = storage.profile();
    return value === undefined ? undefined : validateProjectProfile(value);
  };
  const verification = () => {
    assertActive();
    const value = storage.verification();
    return value === undefined ? undefined : validateProjectVerification(value);
  };
  const researchProposal = () => {
    assertActive();
    const value = storage.researchProposal();
    return value === undefined ? undefined : validateResearchProposal(value);
  };
  const hasActiveRun = () => {
    assertActive();
    return storage.hasActiveRun();
  };
  return Object.freeze({
    profile,
    verification,
    researchProposal,
    hasActiveRun,
    initializeBaseBranch(input: { expectedRevision: number; baseBranch: string }) {
      assertActive();
      const previous = profile();
      if (
        !previous ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 ||
        previous.revision !== input.expectedRevision
      )
        throw new DomainError('CONFLICT', 'Settings changed. Reload the profile.');
      if (previous.baseBranch) return previous;
      if (!Number.isSafeInteger(input.expectedRevision + 1))
        throw new DomainError('CONFLICT', 'Settings changed. Reload the profile.');
      const next = validateProjectProfile({
        ...previous,
        baseBranch: input.baseBranch,
        revision: input.expectedRevision + 1,
      });
      // Internal normalization is not a user review or application of research suggestions.
      storage.replaceProfile(structuredClone(previous), structuredClone(next));
      storage.appendChange(
        validateProjectSettingsChange({
          type: 'project.configured',
          profile: next,
          executionPolicy: policyView(next),
        }),
      );
      return structuredClone(next);
    },
    configure(input: {
      expectedRevision: number;
      profile: ProjectProfile;
      expectedResearch?: ResearchProposal;
    }) {
      assertActive();
      if (hasActiveRun())
        throw new DomainError('PROJECT_BUSY', 'Settings can be changed after the goal finishes.');
      const previous = profile();
      if (
        !previous ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 ||
        previous.revision !== input.expectedRevision ||
        !Number.isSafeInteger(input.expectedRevision + 1)
      )
        throw new DomainError('CONFLICT', 'Settings changed. Reload the profile.');
      const next = validateProjectProfile({
        ...input.profile,
        revision: input.expectedRevision + 1,
      });
      const proposal = researchProposal();
      if (
        input.expectedResearch &&
        (!proposal ||
          proposal.status !== 'ready' ||
          !sameProposal(proposal, input.expectedResearch))
      )
        throw new DomainError('RESEARCH_STALE', 'Research has already been replaced.');
      let acknowledgement: ResearchAcknowledgement | undefined;
      if (proposal?.status === 'ready')
        acknowledgement = validateResearchAcknowledgement({
          id: proposal.id,
          reviewedProfileRevision: next.revision,
          ...(input.expectedResearch
            ? { appliedProfileRevision: next.revision }
            : proposal.appliedProfileRevision !== undefined
              ? { appliedProfileRevision: proposal.appliedProfileRevision }
              : {}),
        });
      storage.replaceProfile(structuredClone(previous), structuredClone(next));
      if (acknowledgement)
        storage.acknowledgeResearch(structuredClone(proposal!), structuredClone(acknowledgement));
      storage.appendChange(
        validateProjectSettingsChange({
          type: 'project.configured',
          profile: next,
          executionPolicy: policyView(next),
          ...(acknowledgement ? { researchAcknowledgement: acknowledgement } : {}),
        }),
      );
      return structuredClone(next);
    },
    saveVerification(input: ProjectVerification) {
      assertActive();
      const result = validateProjectVerification(input);
      storage.saveVerification(structuredClone(result));
      storage.appendChange({ type: 'project.verified', verification: structuredClone(result) });
      return structuredClone(result);
    },
  });
}
