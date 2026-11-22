import { projectRoleResourceChoices } from '../../core/operation-catalog.ts';
import type { Snapshot } from '../../protocol/domain.ts';
import type { ResourceCatalog, ResourceSnapshot } from '../../protocol/resources.ts';

/** A synthetic runtime still exposes the same server-authored operation eligibility as a real host. */
export function fixtureResourceCatalog(
  selected: ResourceSnapshot,
  snapshot?: Snapshot,
): ResourceCatalog {
  const runtimes = [
    ...new Map(
      [
        selected.coordinator,
        selected.worker,
        selected.reviewer,
        ...(selected.workerPool ?? []),
      ].map((runtime) => [runtime.id, runtime]),
    ).values(),
  ];
  return {
    providers: [],
    backends: [],
    connections: [],
    probes: [],
    defaultProfile: selected.profileId,
    profiles: [
      {
        id: selected.profileId,
        name: 'Synthetic model profile',
        policy: selected.policy,
        coordinator: selected.coordinator.id,
        worker: selected.worker.id,
        reviewer: selected.reviewer.id,
        ...(selected.workerPool
          ? { workerPool: selected.workerPool.map((runtime) => runtime.id) }
          : {}),
      },
    ],
    runtimes,
    selected,
    roleChoices: projectRoleResourceChoices({
      resources: selected,
      roles: snapshot?.roles ?? [],
      profile: snapshot?.profile,
    }),
  };
}
