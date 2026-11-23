import type { ModelMessage, ModelCompletion, ToolDefinition } from '../agent/contracts/model.ts';
import type { ManagedSession, ToolScope } from './model-ports.ts';
import type { ManagedRuntimeOptions } from './managed-runtime-options.ts';
import type { RuntimeEvent } from './runtime-events.ts';
import type { prepareManagedRequest } from './request-policy.ts';

/** Application-owned state for one logical turn, never an SDK transcript/checkpoint. */
export type ManagedTurnState = {
  session: ManagedSession;
  threadId: string;
  turnId: string;
  schema: unknown;
  noTools: boolean;
  separate: boolean;
  finalizing: boolean;
  closing: boolean;
  segmentCompleteEmitted: boolean;
  responseSettled: boolean;
  effectDispatched: boolean;
  generationDispatched: boolean;
  dispatchedActions: Set<string>;
  round: number;
  calls: number;
  activeBatch?: {
    requestId: string;
    actionIds: string[];
    nextAction: number;
    inFlight?: string;
    disposition?: 'tools-rejected';
  };
};

export type ManagedPreparedRequest = {
  messages: ModelMessage[];
  definitions: ToolDefinition[];
  schema: unknown;
  budget: ReturnType<typeof prepareManagedRequest>;
};
export type ManagedModelCompletion = ModelCompletion;
export type ManagedTurnResult = { turnId: string; text: string; model?: string };
export type ManagedResponseDecision =
  | { kind: 'continue' }
  | { kind: 'complete'; result: ManagedTurnResult };
export type ManagedEventBody<T = RuntimeEvent> = T extends RuntimeEvent
  ? Omit<T, 'id' | 'threadId' | 'runId'>
  : never;

/** Buro authority/effect/context services; SDK adapters never receive this application port. */
export type ManagedTurnHost = {
  runtimeId: string;
  options: ManagedRuntimeOptions;
  signal: AbortSignal;
  budgetOwner?: { projectId: string; ownerRunId: string };
  budgetPhase: 'work' | 'review';
  check(): void;
  touch(): void;
  emit(event: ManagedEventBody): void;
  /** Save first, then adopt the replacement session in the owning state and cache. */
  commit(next: ManagedSession): Promise<void>;
  toolDefinitions(scope: ToolScope): ToolDefinition[];
  assertReconciled(session: ManagedSession): void;
};
