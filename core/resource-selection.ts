import type { ResourceProfile, RuntimeResource, ResourceSnapshot } from '../protocol/resources.ts';
import { DomainError, type ProjectRegistry, type RuntimeSelection } from './ports.ts';

export class ResourceSelection implements RuntimeSelection {
  private options: {
    projects: ProjectRegistry;
    profiles: ResourceProfile[];
    runtimes: RuntimeResource[];
    defaultProfile: () => string;
  };
  constructor(options: ResourceSelection['options']) {
    this.options = options;
  }
  forProject(projectId: string): ResourceSnapshot {
    const id =
      this.options.projects.get(projectId).snapshot().profile?.resourceProfile ||
      this.options.defaultProfile();
    const profile = this.options.profiles.find((item) => item.id === id);
    if (!profile)
      throw new DomainError('RESOURCE_PROFILE_UNAVAILABLE', `Resource profile unavailable: ${id}`);
    const get = (runtimeId: string) => {
      const runtime = this.options.runtimes.find((item) => item.id === runtimeId);
      if (!runtime)
        throw new DomainError('RUNTIME_UNAVAILABLE', `Runtime unavailable: ${runtimeId}`);
      if (profile.policy === 'local-only' && !runtime.local)
        throw new DomainError('DATA_POLICY_BLOCKED', `Local-only profile cannot use ${runtimeId}.`);
      return structuredClone(runtime);
    };
    return {
      profileId: profile.id,
      policy: profile.policy,
      coordinator: get(profile.coordinator),
      worker: get(profile.worker),
      reviewer: get(profile.reviewer),
    };
  }
}
