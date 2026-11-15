import type { CreateGoal, SaveRole, Goal, Role } from '../protocol/domain.ts';
import { DomainError, type ProjectRegistry } from './ports.ts';
import { validateMaterialIds } from './context.ts';
export type Services = { projects: ProjectRegistry; now: () => string; id: () => string };
export class GoalService {
  env: Services;
  constructor(env: Services) {
    this.env = env;
  }
  create(requestId: string, fingerprint: string, input: CreateGoal) {
    return this.env.projects.get(input.projectId).transact(requestId, fingerprint, (doc) => {
      validateMaterialIds(doc, input.materialIds);
      const goal: Goal = {
        ...input,
        id: 'G-' + this.env.id(),
        status: 'draft',
        revision: 1,
        createdAt: this.env.now(),
      };
      if (
        goal.parentRunId &&
        !doc.runs.some((r) => r.id === goal.parentRunId && r.status === 'completed' && r.commit)
      )
        throw new DomainError(
          'INVALID_PARENT',
          'A parent must be a completed run in this project with a saved commit.',
        );
      doc.goals.push(goal);
      return { result: goal, change: { type: 'goal.created', goal } };
    });
  }
  update(
    requestId: string,
    fingerprint: string,
    input: CreateGoal & { id: string; expectedRevision: number },
  ) {
    return this.env.projects.get(input.projectId).transact(requestId, fingerprint, (doc) => {
      const goal = doc.goals.find((g) => g.id === input.id);
      if (!goal) throw new DomainError('NOT_FOUND', 'Goal not found.');
      if (goal.status === 'running')
        throw new DomainError('GOAL_RUNNING', 'Stop the run before editing the goal.');
      if ((goal.revision || 1) !== input.expectedRevision)
        throw new DomainError('CONFLICT', 'The goal changed. Refresh the data before saving.');
      goal.title = input.title;
      goal.body = input.body;
      goal.criteria = input.criteria;
      goal.repairEnvironment = !!input.repairEnvironment;
      if (
        input.parentRunId &&
        !doc.runs.some((r) => r.id === input.parentRunId && r.status === 'completed' && r.commit)
      )
        throw new DomainError(
          'INVALID_PARENT',
          'A parent must be a completed run in this project with a saved commit.',
        );
      goal.parentRunId = input.parentRunId;
      goal.outcome = input.outcome;
      validateMaterialIds(doc, input.materialIds);
      if (input.materialIds !== undefined) goal.materialIds = [...new Set(input.materialIds)];
      goal.revision = input.expectedRevision + 1;
      return { result: goal, change: { type: 'goal.updated', goal } };
    });
  }
  delete(requestId: string, fingerprint: string, input: { projectId: string; id: string }) {
    return this.env.projects.get(input.projectId).transact(requestId, fingerprint, (doc) => {
      const i = doc.goals.findIndex((g) => g.id === input.id);
      if (i < 0) throw new DomainError('NOT_FOUND', 'Goal not found.');
      if (doc.goals[i].status === 'running')
        throw new DomainError('GOAL_RUNNING', 'Stop the current run first.');
      if (
        doc.runs.some(
          (r) =>
            r.goalId === input.id &&
            (['pending', 'running'].includes(r.delivery?.status || '') ||
              ['starting', 'running'].includes(r.preview?.status || '')),
        )
      )
        throw new DomainError(
          'RESULT_BUSY',
          'Wait for delivery or stop local preview before deleting the goal.',
        );
      doc.goals.splice(i, 1);
      return { result: { id: input.id }, change: { type: 'goal.deleted', id: input.id } };
    });
  }
}
export class RoleService {
  env: Services;
  constructor(env: Services) {
    this.env = env;
  }
  save(requestId: string, fingerprint: string, input: SaveRole) {
    return this.env.projects.get(input.projectId).transact(requestId, fingerprint, (doc) => {
      const current = doc.roleVersions.filter((r) => r.id === input.id).at(-1);
      if ((current?.version || 0) !== input.expectedVersion)
        throw new DomainError('CONFLICT', 'The role changed. Refresh it before saving.');
      const { expectedVersion, projectId, ...fields } = input;
      const role: Role = {
        ...fields,
        version: expectedVersion + 1,
        createdAt: current?.createdAt || this.env.now(),
        updatedAt: this.env.now(),
      };
      doc.roleVersions.push(role);
      return { result: role, change: { type: 'role.saved', role } };
    });
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
