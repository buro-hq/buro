import type { WorkScope } from '../protocol/work-scope.ts';
import type {
  Project,
  Role,
  Goal,
  Run,
  Snapshot,
  DomainEvent,
  ProjectProfile,
  ProjectVerification,
  ProjectStorageInfo,
  ProjectResearch,
  ContextMaterial,
} from '../protocol/domain.ts';
import type { RuntimeEvent } from './runtime-events.ts';
import type { ResourceSnapshot, RuntimePurpose } from '../protocol/resources.ts';
import type { BackendCapabilities } from '../agent/contracts/capabilities.ts';
export type { RuntimeEvent } from './runtime-events.ts';
export type Receipt = { fingerprint: string; result: unknown };
export type ProjectDocument = {
  /** Private source-branch intents; not exposed in snapshots or model context. */
  resultApplyIntents?: Record<string, import('./result-apply.ts').ResultApplyIntent>;
  /** Private reservations; public snapshots contain only the run's bounded summary. */
  managedRunBudgets?: Record<string, import('./run-budget.ts').ManagedRunBudgetLedger>;
  contextMaterials?: ContextMaterial[];
  version: 1;
  revision: number;
  sequence: number;
  project: Project;
  roleVersions: Role[];
  goals: Goal[];
  runs: Run[];
  receipts: Record<string, Receipt>;
  executionHead?: string;
  profile?: ProjectProfile;
  verification?: ProjectVerification;
  research?: ProjectResearch;
};
export interface ProjectStore {
  readonly materials: import('./project-materials.ts').ProjectMaterials;
  readonly entities: import('./project-entities.ts').ProjectEntities;
  snapshot(): Snapshot;
  receipt(id: string, fingerprint: string): unknown | undefined;
  transact<T>(
    requestId: string,
    fingerprint: string,
    apply: (draft: ProjectDocument) => { result: T; change: DomainEvent['change'] },
  ): Promise<T>;
  subscribe(after: number, listener: (event: DomainEvent) => void): () => void;
  storageInfo?(): Promise<ProjectStorageInfo>;
  collectGarbage?(): Promise<ProjectStorageInfo>;
  close(): Promise<void>;
}
export interface ProjectRegistry {
  get(id: string): ProjectStore;
  list(): Project[];
}
/** Application-level storage address; each factory interprets it without leaking storage options. */
export type ProjectStoreOpenSpec = {
  storageAddress: string;
  project: Project;
  profile?: ProjectProfile;
  roles?: Role[];
  runs?: Run[];
};
export interface ProjectStoreFactory {
  open(spec: ProjectStoreOpenSpec): Promise<ProjectStore>;
}
export interface MutableProjectRegistry extends ProjectRegistry {
  add(store: ProjectStore): void;
  close(): Promise<void>;
}
export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
/** The runtime is replaceable; no agent framework or transport leaks into use cases. */
export interface AgentRuntime {
  readonly id: string;
  start(input: {
    projectId: string;
    instructions: string;
    workspace?: string;
    readOnly?: boolean;
    runId?: string;
    ownerRunId?: string;
    purpose?: RuntimePurpose;
    operationId?: string;
    roleId?: string;
    assignment?: {
      sessionId: string;
      roleId: string;
      scope: WorkScope;
    };
  }): Promise<{ threadId: string }>;
  resume?(input: {
    projectId: string;
    threadId: string;
    instructions: string;
    workspace: string;
    runId: string;
    ownerRunId?: string;
    readOnly?: boolean;
    purpose?: RuntimePurpose;
    operationId?: string;
    roleId?: string;
  }): Promise<{ threadId: string }>;
  submit(threadId: string, text: string): Promise<{ turnId: string }>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  turn?(
    threadId: string,
    text: string,
    options: { schema: unknown; signal: AbortSignal; timeoutMs: number; toolPolicy?: 'none' },
  ): Promise<{ turnId: string; text: string; model?: string }>;
  subscribe?(listener: (event: RuntimeEvent) => void): () => void;
  release?(threadId: string): Promise<void>;
  dispose(): Promise<void>;
}
export type RegisteredRuntime = AgentRuntime & { readonly capabilities: BackendCapabilities };
/** Explicit selection only: an unavailable runtime never falls back to another route. */
export interface RuntimeRegistry {
  list(): string[];
  get(id: string): RegisteredRuntime;
}
export interface RuntimeSelection {
  forProject(projectId: string): ResourceSnapshot;
}
