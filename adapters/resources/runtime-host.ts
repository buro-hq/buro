import path from 'node:path';
import type { ProjectRegistry } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import { conservativeRequestPolicy, type ManagedRequestPolicy } from '../../core/request-policy.ts';
import type { ManagedRunBudgetPort } from '../../core/run-budget.ts';
import type { CheckPort, WorkspacePort } from '../../core/execution-ports.ts';
import type { WorkerStepCheckPort } from '../../core/worker-step-checks.ts';
import {
  boundedWorkSegmentPolicy,
  validateSegmentLimits,
  type SegmentEvidencePort,
  type WorkSegmentPolicy,
} from '../../core/work-segments.ts';
import { FileManagedSessions } from '../files/managed-sessions.ts';
import { RepositoryTools } from '../tools/repository-tools.ts';
import { ProjectRunBudgets } from '../files/project-run-budgets.ts';
import { RepositorySegmentEvidence } from '../tools/segment-evidence.ts';
import { WorkerStepChecks } from '../checks/worker-step-checks.ts';
import type { EnvironmentExecutors } from '../environments/executors.ts';

/** Explicit services captured by trusted first-party backend registrations. */
export type RuntimeHostOptions = {
  directory: string;
  projects: ProjectRegistry;
  executors: EnvironmentExecutors;
  fetch?: typeof fetch;
  codex?: {
    executable?: string;
    args?: string[];
    model?: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    networkAccess?: boolean;
    onEvent?: (event: { method: string; params: unknown }) => void;
  };
  credentials?: (reference: string) => string | undefined;
  requestPolicy?: ManagedRequestPolicy;
  budgets?: ManagedRunBudgetPort;
  workspaces?: Pick<WorkspacePort, 'changes'>;
  segmentPolicy?: WorkSegmentPolicy;
  segmentEvidence?: SegmentEvidencePort;
  checks?: CheckPort;
  workerStepChecks?: WorkerStepCheckPort;
};

export function prepareRuntimeHost(options: RuntimeHostOptions) {
  const local = path.join(options.directory, 'local');
  options.executors.protectPrivatePaths([local]);
  const sessions = new FileManagedSessions(path.join(local, 'managed-sessions'));
  const tools = new RepositoryTools(options.executors);
  const budgets = options.budgets || new ProjectRunBudgets(options.projects);
  const requestPolicy = options.requestPolicy || conservativeRequestPolicy;
  const segmentEvidence =
    options.segmentEvidence ||
    (options.workspaces ? new RepositorySegmentEvidence(options.workspaces) : undefined);
  const segmentPolicy =
    options.segmentPolicy || (segmentEvidence ? boundedWorkSegmentPolicy : undefined);
  if (segmentPolicy) {
    validateSegmentLimits(segmentPolicy.limits);
    if (!segmentEvidence || segmentPolicy.revision !== segmentPolicy.limits.revision)
      throw new DomainError('INVALID_SEGMENT_POLICY', 'The work segment policy is incomplete.');
  }
  const workerStepChecks =
    options.workerStepChecks ||
    (segmentEvidence && options.checks
      ? new WorkerStepChecks({
          projects: options.projects,
          checks: options.checks,
          evidence: segmentEvidence,
          executors: options.executors,
        })
      : undefined);
  if (
    typeof requestPolicy.revision !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(requestPolicy.revision) ||
    typeof requestPolicy.prepare !== 'function'
  )
    throw new DomainError('INVALID_REQUEST_POLICY', 'The request policy needs a stable revision.');
  return {
    local,
    sessions,
    tools,
    budgets,
    requestPolicy,
    segmentPolicy,
    segmentEvidence,
    workerStepChecks,
  };
}
export type RuntimeHost = ReturnType<typeof prepareRuntimeHost>;
