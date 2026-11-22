import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '../../core/ports.ts';
import {
  createMaterialTransaction,
  projectMaterialIdentity,
  validateProjectMaterial,
  type MaterialCommand,
  type ProjectMaterialChange,
  type ProjectMaterials,
} from '../../core/project-materials.ts';
import { commandCopy } from '../state/transaction-values.ts';
import { createDocumentFacet, type DocumentFacetHost } from './document-facet.ts';

/** Temporary material view over the sole JSON authority; no independently committing metadata store. */
export function createDocumentProjectMaterials(
  host: DocumentFacetHost<ProjectMaterialChange>,
): ProjectMaterials {
  const { projectId, read } = host;
  const facet = createDocumentFacet(host, (doc, access) => {
    const material = (id: string) => doc.contextMaterials?.find((value) => value.id === id);
    return createMaterialTransaction({
      projectId,
      assertActive: access.assertActive,
      storage: {
        material,
        byIdentity: (candidate) =>
          doc.contextMaterials?.find(
            (value) => projectMaterialIdentity(value) === projectMaterialIdentity(candidate),
          ),
        count: () => doc.contextMaterials?.length ?? 0,
        activeProjectCount: () =>
          doc.contextMaterials?.filter((value) => value.active && value.scope === 'project')
            .length ?? 0,
        insert: (value) =>
          access.write(() => {
            if (
              material(value.id) ||
              doc.contextMaterials?.some(
                (saved) => projectMaterialIdentity(saved) === projectMaterialIdentity(value),
              )
            )
              throw new DomainError('CONTEXT_CONFLICT', 'The material already exists.');
            (doc.contextMaterials ??= []).push(structuredClone(value));
          }),
        replace: (previous, next) =>
          access.write(() => {
            const index =
              doc.contextMaterials?.findIndex((saved) => saved.id === previous.id) ?? -1;
            if (
              index < 0 ||
              !isDeepStrictEqual(validateProjectMaterial(doc.contextMaterials![index]), previous)
            )
              throw new DomainError(
                'CONTEXT_CONFLICT',
                'The material changed. Refresh before saving.',
              );
            doc.contextMaterials![index] = structuredClone(next);
          }),
        appendChange: access.appendChange,
      },
    });
  });
  return Object.freeze({
    projectId,
    transaction: facet.transaction,
    material: (id: string) => facet.query((tx) => tx.material(id)),
    receipt(command: MaterialCommand) {
      const captured = commandCopy(command);
      return read((doc) => {
        const found = Object.hasOwn(doc.receipts, captured.id)
          ? doc.receipts[captured.id]
          : undefined;
        if (found && found.fingerprint !== captured.fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'This ID was used for another command.');
        return found ? { result: structuredClone(found.result) } : undefined;
      });
    },
  });
}
