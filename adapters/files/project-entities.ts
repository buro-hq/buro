import { isDeepStrictEqual } from 'node:util';
import { DomainError, type ProjectDocument } from '../../core/ports.ts';
import {
  createEntityTransaction,
  validateProjectGoal,
  type EntityTransactionStorage,
  type ProjectEntities,
  type ProjectEntityChange,
} from '../../core/project-entities.ts';
import { createDocumentFacet, type DocumentFacetHost } from './document-facet.ts';

type DocumentWithEntityHistory = ProjectDocument & { entityGoalTombstones?: string[] };
export type DocumentEntityHost = DocumentFacetHost<ProjectEntityChange>;
const conflict = () =>
  new DomainError('CONFLICT', 'The project entity changed. Refresh before saving.');

/** Transitional facade over the sole file authority; removed when the full project SQL cutover is ready. */
export function createDocumentProjectEntities(host: DocumentEntityHost): ProjectEntities {
  const { projectId } = host;
  const rows = (
    source: ProjectDocument,
    appendChange: (change: ProjectEntityChange) => void,
    write: <T>(action: () => T) => T,
  ): EntityTransactionStorage => {
    const doc = source as DocumentWithEntityHistory;
    return {
      goal: (id) => doc.goals.find((goal) => goal.id === id),
      role: (id, version) =>
        doc.roleVersions
          .filter((role) => role.id === id && (version === undefined || role.version === version))
          .at(-1),
      materialExists: (id) => !!doc.contextMaterials?.some((material) => material.id === id),
      parentRun: (id) => {
        const run = doc.runs.find((run) => run.id === id);
        return run
          ? { id: run.id, status: run.status, ...(run.commit ? { commit: run.commit } : {}) }
          : undefined;
      },
      hasBusyResult: (goalId) =>
        doc.runs.some(
          (run) =>
            run.goalId === goalId &&
            (['pending', 'running'].includes(run.delivery?.status || '') ||
              ['starting', 'running'].includes(run.preview?.status || '')),
        ),
      insertGoal: (goal) =>
        write(() => {
          if (
            doc.goals.some((saved) => saved.id === goal.id) ||
            doc.entityGoalTombstones?.includes(goal.id)
          )
            throw conflict();
          doc.goals.push(structuredClone(goal));
        }),
      replaceGoal: (previous, next) =>
        write(() => {
          const index = doc.goals.findIndex((goal) => goal.id === previous.id);
          if (
            index < 0 ||
            !isDeepStrictEqual(validateProjectGoal(doc.goals[index], projectId), previous)
          )
            throw conflict();
          doc.goals[index] = structuredClone(next);
        }),
      deleteGoal: (previous) =>
        write(() => {
          const index = doc.goals.findIndex((goal) => goal.id === previous.id);
          if (
            index < 0 ||
            !isDeepStrictEqual(validateProjectGoal(doc.goals[index], projectId), previous)
          )
            throw conflict();
          doc.goals.splice(index, 1);
          doc.entityGoalTombstones = [...(doc.entityGoalTombstones ?? []), previous.id];
        }),
      insertRole: (role, expectedPreviousVersion) =>
        write(() => {
          const current = doc.roleVersions.filter((saved) => saved.id === role.id).at(-1);
          if (
            (current?.version || 0) !== expectedPreviousVersion ||
            role.version !== expectedPreviousVersion + 1
          )
            throw conflict();
          doc.roleVersions.push(structuredClone(role));
        }),
      appendChange: (change) => write(() => appendChange(structuredClone(change))),
    };
  };
  const facet = createDocumentFacet(host, (doc, access) =>
    createEntityTransaction({
      projectId,
      storage: rows(doc, access.appendChange, access.write),
      assertActive: access.assertActive,
    }),
  );
  return Object.freeze({
    projectId,
    transaction: facet.transaction,
    goal: (id: string) => facet.query((tx) => tx.goal(id)),
    role: (id: string, version?: number) => facet.query((tx) => tx.role(id, version)),
  });
}
