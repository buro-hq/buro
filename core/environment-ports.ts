import type { Check, ProjectProfile } from '../protocol/domain.ts';
export interface ExecutionEnvironmentPort {
  /** Creates or restores the run's execution world, then verifies project readiness. */
  prepare(input: {
    projectId: string;
    runId: string;
    workspace: string;
    base: string;
    profile: ProjectProfile;
    signal: AbortSignal;
    report: (check: Check) => Promise<void>;
  }): Promise<Check>;
  /** Forget live handles; retained filesystem state remains available for resume. */
  release(workspace: string): Promise<void>;
}
