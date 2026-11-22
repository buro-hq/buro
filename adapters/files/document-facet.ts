import { DomainError, type ProjectDocument } from '../../core/ports.ts';
import { commandCopy, decodeResult, encodeResult, thenable } from '../state/transaction-values.ts';

type Command = { id: string; fingerprint: string };
export type DocumentFacetHost<Change> = {
  projectId: string;
  read<T>(query: (doc: ProjectDocument) => T): Promise<T>;
  transaction<T>(
    command: Command,
    apply: (doc: ProjectDocument) => {
      result: T;
      changes: Change[];
    },
  ): Promise<T>;
};
type Access<Change> = {
  assertActive(): void;
  write<T>(action: () => T): T;
  appendChange(change: Change): void;
};

/** Temporary facets share the sole document commit queue, lifecycle and canonical receipts. */
export function createDocumentFacet<Change, Transaction>(
  host: DocumentFacetHost<Change>,
  bind: (doc: ProjectDocument, access: Access<Change>) => Transaction,
) {
  const { read, transaction } = host;
  const closed = () => new DomainError('ENTITY_TRANSACTION_CLOSED', 'This capability is closed.');
  return {
    transaction<T>(command: Command, apply: (tx: Transaction) => T): Promise<T> {
      const captured = commandCopy(command);
      return transaction(captured, (doc) => {
        let active = true;
        let failed = false;
        let failure: unknown;
        const changes: Change[] = [];
        const assertActive = () => {
          if (!active) throw closed();
        };
        const write = <T>(action: () => T): T => {
          assertActive();
          try {
            return action();
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
            throw error;
          }
        };
        try {
          const tx = bind(doc, {
            assertActive,
            write,
            appendChange: (change) =>
              write(() => {
                changes.push(structuredClone(change));
              }),
          });
          const result = apply(tx);
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
          if (failed) throw failure;
          return { result: decodeResult(encodeResult(result)) as T, changes };
        } finally {
          active = false;
        }
      });
    },
    query<T>(apply: (tx: Transaction) => T): Promise<T> {
      return read((doc) => {
        let active = true;
        const assertActive = () => {
          if (!active) throw closed();
        };
        const readonly = (): never => {
          assertActive();
          throw new DomainError('ENTITY_QUERY_READ_ONLY', 'This query cannot write.');
        };
        try {
          return apply(bind(doc, { assertActive, write: readonly, appendChange: readonly }));
        } finally {
          active = false;
        }
      });
    },
  };
}
