import type { ContextMaterial, Goal } from '../protocol/domain.ts';
import { DomainError, type ProjectDocument } from './ports.ts';
export function validateMaterialIds(doc: ProjectDocument, ids: string[] = []) {
  if (ids.some((id) => !doc.contextMaterials?.some((m) => m.id === id)))
    throw new DomainError(
      'CONTEXT_NOT_FOUND',
      'An attached material could not be found in this project.',
    );
}
export function goalMaterials(doc: ProjectDocument, goal: Goal): ContextMaterial[] {
  validateMaterialIds(doc, goal.materialIds);
  const ids = new Set(goal.materialIds || []);
  return structuredClone(
    (doc.contextMaterials || []).filter(
      (m) => (m.active && m.scope === 'project') || ids.has(m.id),
    ),
  );
}
