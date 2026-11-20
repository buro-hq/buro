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
export type { RuntimeEvent } from './runtime-events.ts';
export type Receipt = { fingerprint: string; result: unknown };
export type ProjectDocument = {
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
  }): Promise<{ threadId: string }>;
  resume?(input: {
    projectId: string;
    threadId: string;
    instructions: string;
    workspace: string;
    runId: string;
  }): Promise<{ threadId: string }>;
  submit(threadId: string, text: string): Promise<{ turnId: string }>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  turn?(
    threadId: string,
    text: string,
    options: { schema: unknown; signal: AbortSignal; timeoutMs: number },
  ): Promise<{ turnId: string; text: string }>;
  subscribe?(listener: (event: RuntimeEvent) => void): () => void;
  release?(threadId: string): Promise<void>;
  dispose(): Promise<void>;
}
/** Explicit selection only: an unavailable runtime never falls back to another route. */
export interface RuntimeRegistry {
  list(): string[];
  get(id: string): AgentRuntime;
}
