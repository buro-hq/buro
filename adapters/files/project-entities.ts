import { isDeepStrictEqual } from 'node:util';
import { DomainError, type ProjectDocument } from '../../core/ports.ts';
import {
  createEntityTransaction,
  validateProjectGoal,
  type EntityCommand,
  type EntityTransaction,
  type EntityTransactionStorage,
  type ProjectEntities,
  type ProjectEntityChange,
} from '../../core/project-entities.ts';
import { commandCopy, decodeResult, encodeResult, thenable } from '../state/transaction-values.ts';

type DocumentWithEntityHistory = ProjectDocument & { entityGoalTombstones?: string[] };
export type DocumentEntityHost = {
  projectId: string;
  read<T>(query: (doc: ProjectDocument) => T): Promise<T>;
  transaction<T>(
    command: EntityCommand,
    apply: (doc: ProjectDocument) => {
      result: T;
      changes: ProjectEntityChange[];
    },
  ): Promise<T>;
};
const conflict = () =>
  new DomainError('CONFLICT', 'The project entity changed. Refresh before saving.');

/** Transitional facade over the sole file authority; removed when the full project SQL cutover is ready. */
export function createDocumentProjectEntities(host: DocumentEntityHost): ProjectEntities {
  const { projectId, read, transaction } = host;
  const rows = (
    source: ProjectDocument,
    appendChange: (change: ProjectEntityChange) => void,
    assertWritable: () => void,
    writeFailed: (error: unknown) => void,
  ): EntityTransactionStorage => {
    const doc = source as DocumentWithEntityHistory;
    const write = <T>(action: () => T): T => {
      assertWritable();
      try {
        return action();
      } catch (error) {
        writeFailed(error);
        throw error;
      }
    };
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
  const query = <T>(doc: ProjectDocument, apply: (tx: EntityTransaction) => T): T => {
    let active = true;
    const assertActive = () => {
      if (!active)
        throw new DomainError('ENTITY_TRANSACTION_CLOSED', 'This query capability is closed.');
    };
    const readonly = () => {
      throw new DomainError('ENTITY_QUERY_READ_ONLY', 'This entity query cannot write.');
    };
    const storage = rows(doc, readonly, readonly, () => {});
    try {
      return apply(createEntityTransaction({ projectId, storage, assertActive }));
    } finally {
      active = false;
    }
  };
  return Object.freeze({
    projectId,
    transaction<T>(command: EntityCommand, apply: (tx: EntityTransaction) => T): Promise<T> {
      const captured = commandCopy(command);
      return transaction(captured, (doc) => {
        let active = true;
        let storageFailure: unknown;
        let storageFailed = false;
        const changes: ProjectEntityChange[] = [];
        const assertActive = () => {
          if (!active)
            throw new DomainError(
              'ENTITY_TRANSACTION_CLOSED',
              'This transaction capability is closed.',
            );
        };
        const storage = rows(
          doc,
          (change) => changes.push(change),
          assertActive,
          (error) => {
            if (!storageFailed) storageFailure = error;
            storageFailed = true;
          },
        );
        try {
          const result = apply(createEntityTransaction({ projectId, storage, assertActive }));
          active = false;
          if (thenable(result)) {
            if (result instanceof Promise)
              void Promise.prototype.then.call(
                result,
                () => {},
                () => {},
              );
            throw new DomainError(
              'ASYNC_ENTITY_TRANSACTION',
              'Project transaction callbacks must be synchronous.',
            );
          }
          if (storageFailed) throw storageFailure;
          return { result: decodeResult(encodeResult(result)) as T, changes };
        } finally {
          active = false;
        }
      });
    },
    goal: (id: string) => read((doc) => query(doc, (tx) => tx.goal(id))),
    role: (id: string, version?: number) => read((doc) => query(doc, (tx) => tx.role(id, version))),
  });
}
