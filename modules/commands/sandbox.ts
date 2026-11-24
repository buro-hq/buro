import type { CommandInput } from './command.ts';

/** An OS-confined process launch, without model or workflow state. */
export interface CommandLaunch {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Platforms and external environments can supply their own confinement implementation. */
export interface CommandSandbox {
  /** Prepares an isolated process launch or reports an unavailable environment. */
  prepare(input: CommandInput): Promise<CommandLaunch>;
  /** Releases private environment directories after commands have stopped. */
  close?(): Promise<void>;
}
