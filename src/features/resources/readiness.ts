import type { ResourceCatalog } from '../../../protocol/resources.ts';

/** Eligibility comes from the service's actual operation catalog, never model or backend names. */
export function operationResourceReady(
  catalog: ResourceCatalog | null | undefined,
  operationId: string,
) {
  return (
    !!catalog?.selected &&
    !!catalog.roleChoices?.some(
      (operation) =>
        operation.operationId === operationId &&
        operation.choices.some((choice) => choice.eligible),
    )
  );
}
