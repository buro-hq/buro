import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import type { EnvironmentExecutors, Launch } from '../environments/executors.ts';
const exec = promisify(execFile);
import readline from 'node:readline';
import type { AgentRuntime, ProjectRegistry, RuntimeEvent } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import { normalizeCodexEvent } from './events.ts';
import { observedTurnFailure, UnresolvedEffectError } from '../../core/run-reconciliation.ts';

export type RuntimeOptions = {
  projects: ProjectRegistry;
  executors?: EnvironmentExecutors;
  executable?: string;
  args?: string[];
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Explicit false confines native benchmark turns even in a configured environment. */
  networkAccess?: boolean;
  onEvent?: (event: { method: string; params: unknown }) => void;
};
/** Native Codex JSONL is contained here. Constructing the adapter launches no processes. */
export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex';
  options: RuntimeOptions;
  connections = new Map<string, Connection>();
  active = new Set<Connection>();
  disposed = false;
  listeners = new Set<(event: RuntimeEvent) => void>();
  eventSequence = 0;
  constructor(options: RuntimeOptions) {
    this.options = options;
  }
  async start(input: {
    projectId: string;
    instructions: string;
    workspace?: string;
    readOnly?: boolean;
    runId?: string;
    threadId?: string;
  }) {
    if (this.disposed) throw new DomainError('RUNTIME_CLOSED', 'The runtime stopped.');
    const root =
      input.workspace || this.options.projects.get(input.projectId).snapshot().project.root;
    const world = this.options.executors?.get(root);
    const launch = (argv: string[]): Launch =>
      world
        ? this.options.executors!.launch(root, argv, { agent: true })
        : { executable: argv[0], args: argv.slice(1), cwd: root, env: process.env };
    const args = this.options.args
      ? [...codexModelArguments(this.options), ...this.options.args]
      : await hardenedCodexArguments(
          this.options.executable || 'codex',
          root,
          launch,
          world?.variables,
          !!world?.container,
          this.options,
        );
    if (this.disposed) throw new DomainError('RUNTIME_CLOSED', 'The runtime stopped.');
    const specification = launch([this.options.executable || 'codex', ...args]);
    const connection = new Connection(
      specification,
      root,
      (event) => {
        this.options.onEvent?.(event);
        for (const normalized of normalizeCodexEvent(
          event,
          input.runId || '',
          ++this.eventSequence,
        ))
          for (const listener of this.listeners) {
            try {
              listener(normalized);
            } catch {}
          }
      },
      !!input.readOnly,
      world ? [world.cacheRoot] : [],
      this.options.networkAccess,
    );
    this.active.add(connection);
    try {
      await connection.call('initialize', {
        clientInfo: { name: 'project_core', title: 'Project Core', version: '0.2.0' },
        capabilities: { experimentalApi: true },
      });
      connection.send({ method: 'initialized', params: {} });
      const result = (await connection.call(input.threadId ? 'thread/resume' : 'thread/start', {
        cwd: root,
        sandbox: input.readOnly ? 'read-only' : 'workspace-write',
        approvalPolicy: 'never',
        ...(!input.threadId
          ? { ephemeral: false }
          : { threadId: input.threadId, excludeTurns: true }),
        developerInstructions: input.instructions,
      })) as { thread: { id: string } };
      if (this.disposed) {
        await connection.close();
        throw new DomainError('RUNTIME_CLOSED', 'The runtime stopped.');
      }
      connection.attached.add(result.thread.id);
      this.connections.set(result.thread.id, connection);
      return { threadId: result.thread.id };
    } catch (error) {
      this.active.delete(connection);
      await connection.close();
      throw error;
    }
  }
  resume(input: {
    projectId: string;
    threadId: string;
    instructions: string;
    workspace: string;
    runId: string;
  }) {
    return this.start(input);
  }
  get(threadId: string) {
    const connection = this.connections.get(threadId);
    if (!connection) throw new DomainError('THREAD_NOT_FOUND', 'Runtime session not found.');
    return connection;
  }
  async submit(threadId: string, text: string) {
    const connection = this.get(threadId);
    const result = (await connection.call('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      sandboxPolicy: connection.sandboxPolicy(),
    })) as { turn: { id: string } };
    return { turnId: result.turn.id };
  }
  async interrupt(threadId: string, turnId: string) {
    await this.get(threadId).call('turn/interrupt', { threadId, turnId });
  }
  turn(
    threadId: string,
    text: string,
    options: { schema: unknown; signal: AbortSignal; timeoutMs: number; toolPolicy?: 'none' },
  ) {
    if (options.toolPolicy === 'none')
      throw new DomainError(
        'TOOL_POLICY_UNSUPPORTED',
        'Native Codex cannot guarantee a tools-free turn. Use the frozen legacy planning policy.',
      );
    return this.get(threadId).turn(threadId, text, options);
  }
  subscribe(listener: (event: RuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async release(threadId: string) {
    const connection = this.connections.get(threadId);
    if (connection) {
      await connection.close();
      this.active.delete(connection);
      this.connections.delete(threadId);
    }
  }
  async dispose() {
    this.disposed = true;
    await Promise.all([...this.active].map((c) => c.close()));
    this.active.clear();
    this.connections.clear();
  }
}
class Connection {
  process: ChildProcessWithoutNullStreams;
  lines: readline.Interface;
  nextId = 0;
  closed = false;
  closePromise: Promise<void> | undefined;
  pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  stderr = '';
  turnListeners = new Set<(event: any) => void>();
  attached = new Set<string>();
  readOnly: boolean;
  cwd: string;
  environmentRoots: string[];
  networkAccess?: boolean;
  sandboxPolicy() {
    return this.readOnly
      ? { type: 'readOnly', networkAccess: false }
      : {
          type: 'workspaceWrite',
          writableRoots: [this.cwd, ...this.environmentRoots],
          networkAccess: this.networkAccess ?? this.environmentRoots.length > 0,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        };
  }
  constructor(
    launch: Launch,
    cwd: string,
    onEvent?: RuntimeOptions['onEvent'],
    readOnly = false,
    environmentRoots: string[] = [],
    networkAccess?: boolean,
  ) {
    this.readOnly = readOnly;
    this.cwd = cwd;
    this.environmentRoots = environmentRoots;
    this.networkAccess = networkAccess;
    this.process = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = readline.createInterface({ input: this.process.stdout });
    this.process.stderr.on('data', (b) => {
      this.stderr = (this.stderr + String(b)).slice(-4000);
    });
    this.lines.on('line', (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && !message.method) {
        const item = this.pending.get(message.id);
        if (!item) return;
        clearTimeout(item.timer);
        this.pending.delete(message.id);
        message.error
          ? item.reject(Error(message.error.message || 'Codex RPC error'))
          : item.resolve(message.result);
      } else if (message.id !== undefined && message.method)
        this.send({
          id: message.id,
          error: {
            code: -32601,
            message: 'Interactive server requests are not supported by this headless adapter.',
          },
        });
      else if (message.method) {
        const item = message.params?.item;
        const children =
          item?.type === 'subAgentActivity'
            ? [item.agentThreadId]
            : item?.type === 'collabAgentToolCall'
              ? item.receiverThreadIds || []
              : [];
        for (const child of children)
          if (child && !this.attached.has(child)) {
            this.attached.add(child);
            void this.call('thread/resume', { threadId: child, excludeTurns: true }).catch(
              () => {},
            );
          }
        for (const listener of this.turnListeners) listener(message);
        onEvent?.({ method: message.method, params: message.params });
      }
    });
    this.process.on('error', (e) => this.reject(e));
    this.process.on('exit', () => {
      this.closed = true;
      this.reject(Error('Codex app-server exited. ' + this.stderr.trim()));
      for (const listener of this.turnListeners) listener({ method: 'runtime/closed' });
    });
  }
  reject(error: Error) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
  send(value: unknown) {
    if (!this.closed) this.process.stdin.write(JSON.stringify(value) + '\n');
  }
  call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new DOMException('Interrupted', 'AbortError'));
    if (this.closed || this.closePromise)
      return Promise.reject(Error('Codex app-server is closed.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(new DOMException('Interrupted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(Error(`Codex timeout: ${method}`));
      }, 45000);
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer,
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      this.send({ id, method, params });
    });
  }
  async turn(
    threadId: string,
    text: string,
    options: { schema: unknown; signal: AbortSignal; timeoutMs: number },
  ): Promise<{ turnId: string; text: string }> {
    if (options.signal.aborted)
      throw observedTurnFailure(new DOMException('Interrupted', 'AbortError'));
    if (this.closed || this.closePromise)
      throw observedTurnFailure(Error('Codex app-server is closed.'));
    let turnId = '',
      answer = '';
    let terminalObserved = false;
    let cancellationRequested = false;
    const earlyTerminals = new Map<string, any>();
    const turnAnswers = new Map<string, string>();
    let settle: (m: any) => void = () => {};
    const done = new Promise<any>((resolve) => (settle = resolve));
    let touch = () => {};
    const listener = (message: any) => {
      if (message.method === 'runtime/closed') {
        settle({
          status: 'failed',
          error: { message: 'Codex app-server exited. ' + this.stderr.trim() },
        });
        return;
      }
      const p = message.params;
      if (
        (p?.threadId === threadId || this.attached.has(p?.threadId)) &&
        /^(item\/|turn\/started|thread\/tokenUsage\/updated)/.test(message.method || '')
      )
        touch();
      if (p?.threadId !== threadId) return;
      if (
        message.method === 'item/completed' &&
        p.item?.type === 'agentMessage' &&
        typeof p.turnId === 'string'
      ) {
        if (!turnId) turnAnswers.set(p.turnId, p.item.text || '');
        else if (p.turnId === turnId) answer = p.item.text || '';
      }
      if (
        message.method === 'turn/completed' &&
        typeof p.turn?.id === 'string' &&
        ['completed', 'failed', 'interrupted'].includes(p.turn.status) &&
        (!turnId || p.turn.id === turnId)
      ) {
        if (!turnId) earlyTerminals.set(p.turn.id, p.turn);
        else {
          terminalObserved = true;
          settle(p.turn);
        }
      }
    };
    this.turnListeners.add(listener);
    const abort = () => {
      if (cancellationRequested || terminalObserved) return;
      cancellationRequested = true;
      if (turnId) {
        void this.call('turn/interrupt', { threadId, turnId }).catch(() =>
          settle({ status: 'unknown' }),
        );
        cancelTimer = setTimeout(() => settle({ status: 'unknown' }), 1000);
      }
      // The server may have accepted the request before replying with an ID. Close this
      // owned transport rather than retrying an operation with an unknown native outcome.
      else
        void this.close()
          .finally(() => settle({ status: 'unknown' }))
          .catch(() => {});
    };
    options.signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = (await this.call(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text, text_elements: [] }],
          outputSchema: options.schema,
          sandboxPolicy: this.sandboxPolicy(),
        },
        options.signal,
      )) as { turn: { id: string } };
      turnId = result.turn.id;
      answer = turnAnswers.get(turnId) || '';
      turnAnswers.clear();
      if (earlyTerminals.has(turnId)) {
        terminalObserved = true;
        settle(earlyTerminals.get(turnId));
      }
      earlyTerminals.clear();
      if (options.signal.aborted) abort();
      const ended = await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          touch = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              void this.call('turn/interrupt', { threadId, turnId }).catch(() => {});
              reject(
                Error(
                  `No coordinator or agent progress for ${Math.round(options.timeoutMs / 1000)} seconds. The run stopped on inactivity timeout; the workspace is preserved.`,
                ),
              );
            }, options.timeoutMs);
          };
          touch();
        }),
      ]);
      if (options.signal.aborted || ended.status === 'interrupted')
        throw new DOMException('Interrupted', 'AbortError');
      if (ended.status !== 'completed')
        throw Error(ended.error?.message || 'The Codex phase failed.');
      return { turnId, text: answer };
    } catch (error) {
      if (terminalObserved) throw observedTurnFailure(error);
      throw new UnresolvedEffectError(
        'SESSION_RECONCILIATION_REQUIRED',
        { backendSessionId: threadId, ...(turnId ? { operationId: turnId } : {}) },
        error,
      );
    } finally {
      clearTimeout(timer);
      clearTimeout(cancelTimer);
      this.turnListeners.delete(listener);
      options.signal.removeEventListener('abort', abort);
    }
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
          this.process.kill('SIGTERM');
          killTimer = setTimeout(() => this.process.kill('SIGKILL'), 1000);
        }, 1000);
        this.process.once('close', () => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          resolve();
        });
        this.process.stdin.end();
      });
      this.closed = true;
      this.reject(Error('The runtime is closed.'));
      this.lines.close();
    })();
    return this.closePromise;
  }
}
function codexModelArguments(options: Pick<RuntimeOptions, 'model' | 'reasoningEffort'>) {
  if (options.model !== undefined && (!options.model.trim() || /[\r\n\0]/.test(options.model)))
    throw new DomainError('INVALID_MODEL_CONFIGURATION', 'Invalid native Codex model.');
  if (
    options.reasoningEffort !== undefined &&
    !['low', 'medium', 'high', 'xhigh'].includes(options.reasoningEffort)
  )
    throw new DomainError('INVALID_MODEL_CONFIGURATION', 'Invalid native Codex reasoning effort.');
  return [
    ...(options.model ? ['-c', `model=${JSON.stringify(options.model)}`] : []),
    ...(options.reasoningEffort
      ? ['-c', `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`]
      : []),
  ];
}

/** Shared native CLI hardening and explicit model pin for direct and orchestrated runs. */
export async function hardenedCodexArguments(
  executable: string,
  cwd: string,
  launch: (argv: string[]) => Launch,
  variables?: Record<string, string>,
  container = false,
  modelOptions: Pick<RuntimeOptions, 'model' | 'reasoningEffort'> = {},
) {
  const modelArguments = codexModelArguments(modelOptions);
  const config: Record<string, unknown> = {
    'features.multi_agent': false,
    'agents.enabled': false,
    'features.apps': false,
    'apps._default.enabled': false,
    'features.remote_plugin': false,
    'features.plugins': false,
    'features.plugin_discovery_prefetch': false,
    'features.in_app_browser': false,
    'features.hooks': false,
    'features.memories': false,
    'features.goals': false,
    web_search: 'disabled',
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.set.PATH': container
      ? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      : process.env.PATH || '/usr/bin:/bin',
    ...Object.fromEntries(
      Object.entries(variables || {}).map(([key, value]) => [
        `shell_environment_policy.set.${key}`,
        value,
      ]),
    ),
  };
  const flags = () => [
    ...modelArguments,
    ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
  ];
  const list = async () => {
    const spec = launch([executable, ...flags(), 'mcp', 'list', '--json']);
    const result = await exec(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  };
  const servers = await list();
  if (!Array.isArray(servers)) throw Error('Could not verify MCP configuration.');
  for (const server of servers) {
    if (typeof server.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(server.name))
      throw Error('Unsupported MCP server name.');
    config[`mcp_servers.${server.name}.enabled`] = false;
  }
  if (!(await list()).every((server: any) => server.enabled === false))
    throw Error('Could not disable MCP for isolated execution.');
  return [...flags(), 'app-server'];
}
