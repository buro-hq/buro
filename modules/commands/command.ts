/** One process invocation in an isolated run workspace. */
export interface CommandInput {
  workspace: string;
  source?: string;
  argv: string[];
  env?: Record<string, string>;
  stdin?: string;
  readOnly?: boolean;
  allowNetwork?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Best-effort output observation; it never changes process execution. */
  onOutput?: (output: { stdout: string; stderr: string; truncated: boolean }) => void;
  signal: AbortSignal;
}

/** A process observation; nonzero exits are normal feedback to its caller. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
  error?: string;
  interrupted?: boolean;
  truncated?: boolean;
}

/** Process execution is independent of model transports and agent descriptions. */
export interface Commands {
  /** Runs a process with workspace and private-data isolation. */
  run(input: CommandInput): Promise<CommandResult>;
  /** Releases environment resources after active commands have stopped. */
  close(): Promise<void>;
}
