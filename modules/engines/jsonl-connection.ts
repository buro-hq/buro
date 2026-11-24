import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

/** One private RPC frame from an owned native process. */
export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

/** Contains native stdio without importing sessions, roles or workflow decisions. */
export class JsonlConnection {
  private process: ChildProcessWithoutNullStreams;
  private lines: readline.Interface;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private observers = new Set<(message: RpcMessage) => void>();
  private request?: (message: RpcMessage) => Promise<unknown>;
  private closing?: Promise<void>;
  private closed = false;
  private diagnostics = '';

  /** Starts one trusted controller; its tools receive their own explicit access boundary. */
  constructor(input: {
    executable: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    request?: (message: RpcMessage) => Promise<unknown>;
  }) {
    this.request = input.request;
    this.process = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = readline.createInterface({ input: this.process.stdout });
    this.process.stderr.on('data', (chunk: Buffer) => {
      this.diagnostics = (this.diagnostics + chunk.toString('utf8')).slice(-65536);
    });
    this.process.stdin.on('error', (error) => this.fail(error));
    this.process.on('error', (error) => this.fail(error));
    this.process.on('close', () => {
      this.closed = true;
      this.fail(
        Object.assign(new Error('The native controller closed.'), {
          diagnostics: this.diagnostics,
        }),
      );
      this.notify({ method: 'process/closed' });
    });
    this.lines.on('line', (line) => {
      let message: RpcMessage;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Invalid frame');
        message = value as RpcMessage;
      } catch {
        this.fail(new Error('Invalid native RPC frame.'));
        void this.close();
        return;
      }
      if (message.id !== undefined && !message.method) {
        const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
        if (!pending) return;
        this.pending.delete(message.id as number);
        if (message.error)
          pending.reject(new Error(message.error.message ?? 'Native RPC request failed.'));
        else pending.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        if (!this.request) {
          this.send({ id: message.id, error: { message: 'This server request is unsupported.' } });
          return;
        }
        void this.request(message).then(
          (result) => this.send({ id: message.id, result }),
          () =>
            this.send({
              id: message.id,
              error: { message: 'The host could not execute this tool.' },
            }),
        );
      } else this.notify(message);
    });
  }

  /** Observes native notifications until unsubscribed. */
  subscribe(observer: (message: RpcMessage) => void): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  /** Sends a notification or tool result to the owned process. */
  send(message: RpcMessage): void {
    if (!this.closed) this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  /** Calls a native method; cancellation is owned by the surrounding backend request. */
  call(method: string, params: unknown): Promise<unknown> {
    if (this.closed || this.closing)
      return Promise.reject(new Error('The native controller is closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Closes this process tree and rejects outstanding RPCs before returning. */
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      if (!this.closed) {
        const kill = (signal: NodeJS.Signals) => {
          try {
            if (this.process.pid && process.platform !== 'win32')
              process.kill(-this.process.pid, signal);
            else this.process.kill(signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
              this.fail(new Error('Native process termination failed.'));
          }
        };
        await new Promise<void>((resolve) => {
          const terminate = setTimeout(() => kill('SIGTERM'), 500);
          const force = setTimeout(() => kill('SIGKILL'), 1500);
          this.process.once('close', () => {
            clearTimeout(terminate);
            clearTimeout(force);
            kill('SIGKILL');
            resolve();
          });
          this.process.stdin.end();
        });
      }
      this.lines.close();
      this.fail(new Error('The native controller is closed.'));
    })());
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private notify(message: RpcMessage): void {
    for (const observer of this.observers) {
      try {
        observer(message);
      } catch {
        this.fail(new Error('The native notification was invalid.'));
        void this.close();
      }
    }
  }
}
