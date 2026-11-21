import type { ProjectRegistry } from './ports.ts';
import type { ManagedSessionStore, ToolBroker } from './model-ports.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import type { AgentLoopRunner } from '../agent/contracts/loop.ts';
import type { ManagedRequestPolicy } from './request-policy.ts';
import type { ManagedRunBudgetPort } from './run-budget.ts';
import type { WorkerStepCheckPort } from './worker-step-checks.ts';
import type { SegmentEvidencePort, WorkSegmentPolicy } from './work-segments.ts';

export type ManagedRuntimeOptions = {
  id: string;
  model: string;
  provider: ModelProvider;
  loopRunner: AgentLoopRunner;
  sessions: ManagedSessionStore;
  tools: ToolBroker;
  projects: ProjectRegistry;
  idGenerator: () => string;
  requestPolicy?: ManagedRequestPolicy;
  budgets?: ManagedRunBudgetPort;
  segmentPolicy?: WorkSegmentPolicy;
  segmentEvidence?: SegmentEvidencePort;
  workerStepChecks?: WorkerStepCheckPort;
  limits: {
    contextTokens: number;
    maxOutputTokens: number;
    maxRequestsPerTurn: number;
    maxToolCallsPerTurn: number;
    maxSessionRequests: number;
  };
};
