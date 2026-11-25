import type { RecordStore } from '../storage/record-store.ts';

/** A user-requested process in one run's workspace, independent of agent completion. */
export interface Preview {
  id: string;
  runId: string;
  command: string;
  port: number;
  status: string;
  createdAt: string;
  url?: string;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  exitCode?: number;
  interrupted?: boolean;
  error?: string;
}

/** Preview metadata has its own storage; live process handles stay private. */
export interface PreviewStore extends RecordStore<Preview> {}

/** Starting a preview can fail normally, without changing its run's result. */
export interface PreviewOutcome {
  ok: boolean;
  preview?: Preview;
  error?: string;
}

/** Optional previews outlive a model turn and are stopped by their owner or the application. */
export interface Previews {
  /** Lists saved process observations, including current output. */
  list(input?: { runId?: string }): Promise<Preview[]>;
  /** Reads one process observation. */
  get(input: { id: string }): Promise<Preview | undefined>;
  /** Runs a foreground server command with an allocated PORT and loopback HOST. */
  start(input: {
    runId: string;
    command: string;
    env?: Record<string, string>;
    port?: number;
  }): Promise<PreviewOutcome>;
  /** Stops and joins one preview. */
  stop(input: { id: string }): Promise<void>;
  /** Marks processes lost during a previous application exit without restarting them. */
  recover(): Promise<void>;
  /** Stops and joins all previews. */
  close(): Promise<void>;
}
