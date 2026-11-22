import { AssignmentResourceSchema, SavedOperationContextSchema } from '../protocol/resources.ts';
import type { AssignmentResource } from '../protocol/resources.ts';
import type { Role } from '../protocol/domain.ts';
import type { ProjectDocument } from './ports.ts';
import { DomainError } from './ports.ts';
import { serviceOperationContext } from './operation-catalog.ts';
import { validateRoleResource } from './role-routing.ts';

const decisionAuthority = (decision: AssignmentResource | undefined) => {
  const parsed = AssignmentResourceSchema.safeParse(decision);
  if (!parsed.success) return undefined;
  const { resource, roleVersion, preference, source } = parsed.data;
  // Explanatory text can change without reopening selection or its original authority.
  return JSON.stringify([resource, roleVersion, preference, source]);
};
const roleAuthority = (role: Role) =>
  JSON.stringify([
    role.id,
    role.version,
    role.instructions,
    role.runtimePreference || { mode: 'auto' },
    role.model,
  ]);

/** Captured operation identity survives later project, role and delivery-setting changes. */
export function validateProjectOperationContexts(
  next: ProjectDocument,
  previous?: ProjectDocument,
) {
  for (const before of previous?.runs || []) {
    for (const [id, context] of Object.entries(before.operationContexts || {})) {
      const afterRun = next.runs.find((run) => run.id === before.id);
      const after = afterRun?.operationContexts?.[id];
      const parsedAfter = SavedOperationContextSchema.safeParse(after);
      if (
        !parsedAfter.success ||
        JSON.stringify(parsedAfter.data) !==
          JSON.stringify(SavedOperationContextSchema.parse(context))
      )
        throw new DomainError(
          'OPERATION_CONTEXT_CHANGED',
          'A captured operation context cannot be removed or retargeted.',
        );
      const roleId = context.roles.roleId;
      const beforeDecision = before.operationResources?.[id]?.[roleId];
      const afterDecision = afterRun?.operationResources?.[id]?.[roleId];
      const authority = decisionAuthority(beforeDecision);
      if (!authority || authority !== decisionAuthority(afterDecision))
        throw new DomainError(
          'OPERATION_CONTEXT_CHANGED',
          'A captured operation resource decision cannot be removed or retargeted.',
        );
      const beforeRoles =
        before.roleSnapshots?.filter(
          (role) => role.id === roleId && role.version === beforeDecision!.roleVersion,
        ) || [];
      const afterRoles =
        afterRun?.roleSnapshots?.filter(
          (role) => role.id === roleId && role.version === beforeDecision!.roleVersion,
        ) || [];
      if (
        beforeRoles.length !== 1 ||
        afterRoles.length !== 1 ||
        roleAuthority(beforeRoles[0]) !== roleAuthority(afterRoles[0])
      )
        throw new DomainError(
          'OPERATION_CONTEXT_CHANGED',
          'A captured operation role and its instructions cannot be removed or changed.',
        );
    }
  }
  for (const run of next.runs) {
    if (Object.keys(run.operationResources || {}).some((id) => !run.operationContexts?.[id]))
      throw new DomainError(
        'INVALID_ASSIGNMENT',
        'An operation resource decision requires its captured service context.',
      );
    for (const [id, context] of Object.entries(run.operationContexts || {})) {
      const parsed = SavedOperationContextSchema.parse(context);
      const decisions = run.operationResources?.[id];
      if (
        id !== parsed.id ||
        !decisions?.[parsed.roles.roleId] ||
        Object.keys(decisions).some((roleId) => roleId !== parsed.roles.roleId)
      )
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'An operation context requires its exact role resource decision.',
        );
      const decision = decisions[parsed.roles.roleId];
      const roles =
        run.roleSnapshots?.filter(
          (role) => role.id === parsed.roles.roleId && role.version === decision.roleVersion,
        ) || [];
      if (roles.length !== 1 || !run.resources)
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'An operation decision requires its frozen role and resource profile.',
        );
      validateRoleResource(run.resources, roles[0], decision, parsed);
      if (
        !previous ||
        previous.runs.find((before) => before.id === run.id)?.operationContexts?.[id]
      )
        continue;
      const profile = next.profile || run.executionPolicySnapshot?.profile;
      const configured =
        profile && run.delivery?.config ? { ...profile, delivery: run.delivery.config } : profile;
      const actual = SavedOperationContextSchema.parse(
        serviceOperationContext(
          id,
          configured,
          run.executionPolicySnapshot?.scope.mode === 'strict',
        ),
      );
      if (JSON.stringify(actual) !== JSON.stringify(parsed))
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'The operation context does not match its configured service entrypoint.',
        );
    }
  }
}
