import { spawn } from 'node:child_process';
import { NativeSandbox } from './native-sandbox.ts';
import type { CommandInput, CommandResult, Commands } from './command.ts';
import type { CommandSandbox } from './sandbox.ts';

/** Runs processes using a replaceable environment implementation. */
export class SandboxedCommands implements Commands {
  private sandbox: CommandSandbox;
  private active = new Set<{ controller: AbortController; settled: Promise<void> }>();
  private closing = false;

  /** Protects application-private files in addition to the sandbox's credential exclusions. */
  constructor(input: { privatePaths?: string[]; sandbox?: CommandSandbox } = {}) {
    this.sandbox = input.sandbox ?? new NativeSandbox({ privatePaths: input.privatePaths });
  }

  /** Executes an argv vector; process trees are stopped on cancellation or timeout. */
  async run(input: CommandInput): Promise<CommandResult> {
    if (this.closing) return { stdout: '', stderr: '', error: 'Command execution is closed.' };
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    let resolveSettled!: () => void;
    const entry = {
      controller,
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
    };
    this.active.add(entry);
    try {
      return await this.execute({ ...input, signal: controller.signal });
    } finally {
      input.signal.removeEventListener('abort', abort);
      this.active.delete(entry);
      resolveSettled();
    }
  }

  private async execute(input: CommandInput): Promise<CommandResult> {
    input.signal.throwIfAborted();
    const launch = await this.sandbox.prepare(input);
    return new Promise<CommandResult>((resolve) => {
      const child = spawn(launch.executable, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const maximum = input.maxOutputBytes ?? 256 * 1024;
      let stdout: Buffer = Buffer.alloc(0),
        stderr: Buffer = Buffer.alloc(0),
        truncated = false;
      let error: string | undefined,
        interrupted = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== 'ESRCH')
            error ??= 'Could not terminate the command process group.';
        }
      };
      const stop = () => {
        kill('SIGTERM');
        escalation ??= setTimeout(() => kill('SIGKILL'), 1000);
      };
      const abort = () => {
        interrupted = true;
        stop();
      };
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) abort();
      const timeout =
        input.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              error = 'Command timed out.';
              stop();
            }, input.timeoutMs);
      const capture = (previous: Buffer, chunk: Buffer): Buffer => {
        const remaining = Math.max(0, maximum - stdout.length - stderr.length);
        if (chunk.length > remaining) truncated = true;
        return Buffer.concat([previous, chunk.subarray(0, remaining)]);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = capture(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = capture(stderr, chunk);
      });
      child.once('error', (failure) => {
        error = failure.message;
      });
      child.stdin.on('error', (failure) => {
        if ((failure as NodeJS.ErrnoException).code !== 'EPIPE') error = failure.message;
      });
      child.stdin.end(input.stdin);
      // A shell may exit while a background child still owns its output handles.
      child.once('exit', () => kill('SIGKILL'));
      child.once('close', (code, signal) => {
        input.signal.removeEventListener('abort', abort);
        clearTimeout(timeout);
        clearTimeout(escalation);
        resolve({
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          exitCode: code ?? (signal ? 128 : undefined),
          error,
          interrupted,
          truncated,
        });
      });
    });
  }

  /** Releases prepared environments after the owning application has joined its sessions. */
  async close(): Promise<void> {
    this.closing = true;
    for (const entry of this.active) entry.controller.abort();
    await Promise.all([...this.active].map((entry) => entry.settled));
    await this.sandbox.close?.();
  }
}
