import type { CreateGoal, SaveRole, Role } from '../protocol/domain.ts';
import { DomainError, type ProjectRegistry } from './ports.ts';
export type Services = { projects: ProjectRegistry; now: () => string; id: () => string };
function projectEntities(env: Services, projectId: string) {
  const entities = env.projects.get(projectId).entities;
  if (!entities || entities.projectId !== projectId)
    throw new DomainError(
      'INVALID_PROJECT_ENTITY',
      'The entity authority does not belong to the requested project.',
    );
  return entities;
}
export class GoalService {
  env: Services;
  constructor(env: Services) {
    this.env = env;
  }
  create(requestId: string, fingerprint: string, input: CreateGoal) {
    return projectEntities(this.env, input.projectId).transaction(
      { id: requestId, fingerprint },
      (tx) =>
        tx.createGoal({
          projectId: input.projectId,
          title: input.title,
          body: input.body,
          criteria: input.criteria,
          ...(input.materialIds !== undefined ? { materialIds: input.materialIds } : {}),
          ...(input.repairEnvironment !== undefined
            ? { repairEnvironment: input.repairEnvironment }
            : {}),
          ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
          ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
          id: 'G-' + this.env.id(),
          status: 'draft',
          revision: 1,
          createdAt: this.env.now(),
        }),
    );
  }
  update(
    requestId: string,
    fingerprint: string,
    input: CreateGoal & { id: string; expectedRevision: number },
  ) {
    return projectEntities(this.env, input.projectId).transaction(
      { id: requestId, fingerprint },
      (tx) =>
        tx.updateGoal(input.id, input.expectedRevision, {
          title: input.title,
          body: input.body,
          criteria: input.criteria,
          repairEnvironment: input.repairEnvironment,
          parentRunId: input.parentRunId,
          outcome: input.outcome,
          materialIds: input.materialIds,
        }),
    );
  }
  delete(requestId: string, fingerprint: string, input: { projectId: string; id: string }) {
    return projectEntities(this.env, input.projectId).transaction(
      { id: requestId, fingerprint },
      (tx) => {
        const goal = tx.goal(input.id);
        if (!goal) throw new DomainError('NOT_FOUND', 'Goal not found.');
        return tx.deleteGoal(input.id, goal.revision || 1);
      },
    );
  }
}
export class RoleService {
  env: Services;
  constructor(env: Services) {
    this.env = env;
  }
  save(requestId: string, fingerprint: string, input: SaveRole) {
    return projectEntities(this.env, input.projectId).transaction(
      { id: requestId, fingerprint },
      (tx) => {
        const current = tx.role(input.id);
        if ((current?.version || 0) !== input.expectedVersion)
          throw new DomainError('CONFLICT', 'The role changed. Refresh it before saving.');
        const { expectedVersion } = input;
        const runtimePreference = input.runtimePreference ?? current?.runtimePreference;
        const role: Role = {
          id: input.id,
          title: input.title,
          description: input.description,
          instructions: input.instructions,
          kind: input.kind,
          ...(input.model !== undefined ? { model: input.model } : {}),
          provenance: {
            origin: 'user',
            ...(current?.provenance.workflow
              ? { workflow: structuredClone(current.provenance.workflow) }
              : {}),
            ...(current?.provenance &&
            'template' in current.provenance &&
            current.provenance.template
              ? { template: structuredClone(current.provenance.template) }
              : {}),
          },
          ...(runtimePreference ? { runtimePreference: structuredClone(runtimePreference) } : {}),
          version: expectedVersion + 1,
          createdAt: current?.createdAt || this.env.now(),
          updatedAt: this.env.now(),
        };
        return tx.appendRole(role, expectedVersion);
      },
    );
  }
}
export type ReviewResult = { verdict: 'approved' | 'changes_requested'; blockingFindings: number };
export function canAccept(input: {
  testsPassed: boolean;
  scopePreserved: boolean;
  specsUnchanged: boolean;
  review?: ReviewResult;
}) {
  return (
    input.testsPassed &&
    input.scopePreserved &&
    input.specsUnchanged &&
    input.review?.verdict === 'approved' &&
    input.review.blockingFindings === 0
  );
}
