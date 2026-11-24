import type { RecordStore } from '../storage/record-store.ts';

/** One isolated attempt at a task. A restart creates a new run linked to this one. */
export interface Run {
  id: string;
  taskId: string;
  projectId: string;
  sessionId: string;
  workspace: string;
  base: string;
  status: string;
  createdAt: string;
  finishedAt?: string;
  previousRunId?: string;
  result?: string;
  error?: string;
  options?: RunOptions;
}

/** Owns attempts independently of task definitions and conversation history. */
export interface RunStore extends RecordStore<Run> {}

/** Explicit overrides of application defaults for one attempt. */
export interface RunOptions {
  modelId?: string;
  instructions?: string;
  tools?: string[];
  readOnly?: boolean;
  base?: string;
}

/** Expected inability to start work is returned to the caller. */
export interface RunResult {
  ok: boolean;
  run?: Run;
  error?: string;
}

/** Each attempt has its own identity, files and conversation. */
export interface Runs {
  /** Lists attempts by task or project. */
  list(input?: { taskId?: string; projectId?: string }): Promise<Run[]>;
  /** Returns a saved attempt. */
  get(input: { id: string }): Promise<Run | undefined>;
  /** Starts independent work. */
  start(input: { taskId: string; options?: RunOptions; previousRunId?: string }): Promise<RunResult>;
  /** Continues saved work in a new attempt. */
  retry(input: { id: string; options?: RunOptions }): Promise<RunResult>;
  /** Requests cancellation. */
  cancel(input: { id: string }): void;
  /** Waits for current work and reads its result. */
  wait(input: { id: string }): Promise<Run | undefined>;
  /** Marks abandoned attempts interrupted without replaying actions. */
  recover(): Promise<void>;
  /** Cancels and joins active work. */
  close(): Promise<void>;
}
