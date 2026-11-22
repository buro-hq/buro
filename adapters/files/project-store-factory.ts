import {
  DomainError,
  type ProjectStoreFactory,
  type ProjectStoreOpenSpec,
} from '../../core/ports.ts';
import { FileProjectStore } from './project-store.ts';

/** Default filesystem composition; application services see only the generic factory port. */
export class FileProjectStoreFactory implements ProjectStoreFactory {
  open(spec: ProjectStoreOpenSpec) {
    if (!spec.storageAddress.trim())
      throw new DomainError(
        'INVALID_STORAGE_ADDRESS',
        'Project storage needs an explicit address.',
      );
    const input = structuredClone(spec);
    return FileProjectStore.open({
      directory: input.storageAddress,
      project: input.project,
      profile: input.profile,
      roles: input.roles ?? [],
      runs: input.runs,
    });
  }
}
