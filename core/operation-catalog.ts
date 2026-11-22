import type { BackendRequirements } from '../agent/contracts/capabilities.ts';
import type { ProjectProfile, Role, Run } from '../protocol/domain.ts';
import { SavedOperationContextSchema } from '../protocol/resources.ts';
import type {
  ResourceSnapshot,
  RoleResourceChoices,
  RuntimePurpose,
} from '../protocol/resources.ts';
import { DomainError } from './ports.ts';
import { roleResourceEligibility } from './role-routing.ts';
import { isWorkerRoleId } from './execution-ports.ts';

export const operationIds = {
  coordination: 'goal.coordination',
  implementation: 'goal.implementation',
  review: 'goal.review',
  research: 'project.research',
  environment: 'environment.repair',
  preview: 'result.preview',
  pullRequest: 'result.pull-request',
  deploy: (environmentId: string) => 'result.deploy.' + environmentId,
} as const;
export type ServiceOperation = {
  id: string;
  label: string;
  purpose: RuntimePurpose;
  requirements: BackendRequirements;
  /** A host operation binds a role explicitly; implementation accepts any allocated team role. */
  roles: { kind: 'fixed'; roleId: string } | { kind: 'team' } | { kind: 'none' };
  readOnly?: true;
};

/** Describes operations actually entered by application services, not descriptive role kinds. */
export class OperationCatalog {
  #operations = new Map<string, ServiceOperation>();
  constructor(operations: ServiceOperation[]) {
    for (const operation of operations) {
      if (this.#operations.has(operation.id))
        throw new DomainError(
          'OPERATION_EXISTS',
          'An operation with this ID is already registered.',
        );
      const captured = structuredClone(operation);
      Object.freeze(captured.requirements);
      Object.freeze(captured.roles);
      Object.freeze(captured);
      this.#operations.set(captured.id, captured);
    }
  }
  get(id: string): ServiceOperation {
    const operation = this.#operations.get(id);
    if (!operation)
      throw new DomainError('OPERATION_UNAVAILABLE', 'This service operation is not configured.');
    return operation;
  }
  list(): ServiceOperation[] {
    return [...this.#operations.values()];
  }
}
export function projectOperationCatalog(
  profile?: ProjectProfile,
  strict = profile?.scope?.mode === 'strict',
) {
  const writable: BackendRequirements = {
    structuredTurns: true,
    ...(strict ? { strictPlannedWrites: true } : {}),
  };
  const inspection: BackendRequirements = { structuredTurns: true, readOnlySessions: true };
  const operations: ServiceOperation[] = [
    {
      id: operationIds.coordination,
      label: 'Plan and coordinate',
      purpose: 'coordination',
      requirements: writable,
      roles: { kind: 'fixed', roleId: 'coordinator' },
    },
    {
      id: operationIds.implementation,
      label: 'Implement changes',
      purpose: 'implementation',
      requirements: writable,
      roles: { kind: 'team' },
    },
    {
      id: operationIds.review,
      label: 'Review accepted changes',
      purpose: 'review',
      requirements: { ...inspection, immutableReview: true },
      roles: { kind: 'fixed', roleId: 'reviewer' },
      readOnly: true,
    },
    {
      id: operationIds.research,
      label: 'Research project',
      purpose: 'research',
      requirements: inspection,
      roles: { kind: 'none' },
      readOnly: true,
    },
    {
      id: operationIds.environment,
      label: 'Inspect environment setup',
      purpose: 'environment',
      requirements: inspection,
      roles: { kind: 'none' },
      readOnly: true,
    },
    {
      id: operationIds.preview,
      label: 'Prepare local preview',
      purpose: 'delivery',
      requirements: inspection,
      roles: { kind: 'fixed', roleId: 'local_preview' },
      readOnly: true,
    },
    {
      id: operationIds.pullRequest,
      label: 'Prepare pull request',
      purpose: 'delivery',
      requirements: inspection,
      roles: { kind: 'fixed', roleId: 'delivery_pr' },
      readOnly: true,
    },
    ...(profile?.delivery?.environments || []).map(
      (environment): ServiceOperation => ({
        id: operationIds.deploy(environment.id),
        label: `Prepare deployment: ${environment.name}`,
        purpose: 'delivery',
        requirements: inspection,
        roles: { kind: 'fixed', roleId: environment.roleId },
        readOnly: true,
      }),
    ),
  ];
  return new OperationCatalog(operations);
}
export function serviceOperationContext(
  operationId: string,
  profile?: ProjectProfile,
  strict?: boolean,
) {
  return projectOperationCatalog(profile, strict).get(operationId);
}
export function savedOperationContext(
  run: Pick<Run, 'operationContexts'> | undefined,
  operationId: string,
) {
  const value = run?.operationContexts?.[operationId];
  if (value === undefined) return undefined;
  const parsed = SavedOperationContextSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== operationId)
    throw new DomainError(
      'INVALID_ASSIGNMENT',
      'The captured context belongs to another service operation.',
    );
  return parsed.data;
}
/** Only contexts backed by a real role-aware dispatch produce role model selectors. */
export function projectRoleResourceChoices(input: {
  profile?: ProjectProfile;
  roles: Role[];
  resources: ResourceSnapshot;
  strict?: boolean;
}): RoleResourceChoices[] {
  const rows: RoleResourceChoices[] = [];
  for (const operation of projectOperationCatalog(input.profile, input.strict)
    .list()
    .sort((a, b) => Number(a.roles.kind === 'team') - Number(b.roles.kind === 'team'))) {
    const roles =
      operation.roles.kind === 'none'
        ? []
        : operation.roles.kind === 'fixed'
          ? [
              {
                id: operation.roles.roleId,
                version: input.roles.find(
                  (role) => role.id === (operation.roles as { roleId: string }).roleId,
                )?.version,
              },
            ]
          : [
              ...input.roles
                .filter((role) => isWorkerRoleId(role.id))
                .map(({ id, version }) => ({ id, version })),
              { id: '*', version: undefined },
            ];
    for (const role of roles)
      rows.push({
        operationId: operation.id,
        operationLabel: operation.label,
        roleId: role.id,
        ...(role.version === undefined ? {} : { roleVersion: role.version }),
        purpose: operation.purpose,
        requirements: structuredClone(operation.requirements),
        choices: roleResourceEligibility(
          input.resources,
          operation.requirements,
          operation.purpose,
        ),
      });
  }
  return rows;
}
