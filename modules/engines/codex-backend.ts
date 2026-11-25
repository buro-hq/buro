import type { ModelCompletion, ModelUsage, AvailableModel } from '../../agent/contracts/model.ts';
import os from 'node:os';
import { observer, RequestGate } from '../../agent/providers/http.ts';
import { codexArguments } from './codex-arguments.ts';
import { JsonlConnection, type RpcMessage } from './jsonl-connection.ts';
import type { BackendRequest, SessionBackend } from './backend.ts';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A native adapter owns its process, while sessions keep portable history and tool execution. */
export class CodexBackend implements SessionBackend {
  readonly id: string;
  readonly revision: string;
  private executable: string;
  private prefix: string[];
  private apiKey?: string;
  private effort?: string;
  private gate: RequestGate;
  private privatePaths: string[];

  /** Selects a native executable; constructing an adapter never launches a process. */
  constructor(input: {
    id: string;
    revision: string;
    executable?: string;
    args?: string[];
    apiKey?: string;
    reasoningEffort?: string;
    capacity?: number;
    privatePaths?: string[];
  }) {
    this.id = input.id;
    this.revision = input.revision;
    this.executable = input.executable ?? 'codex';
    this.prefix = [...(input.args ?? [])];
    this.apiKey = input.apiKey;
    this.effort = input.reasoningEffort;
    this.gate = new RequestGate(input.capacity ?? 2);
    this.privatePaths = [...(input.privatePaths ?? [])];
  }

  /** Uses a fresh native thread with portable history; no hidden native checkpoint becomes application state. */
  async complete(input: BackendRequest): Promise<ModelCompletion> {
    return this.gate.run(input.signal, () => this.request(input));
  }

  /** Reads the native catalogue without creating a model turn. */
  async listModels(input: { signal: AbortSignal }): Promise<AvailableModel[]> {
    input.signal.throwIfAborted();
    const specification = codexArguments({ prefix: this.prefix, deniedPaths: this.privatePaths });
    const connection = new JsonlConnection({
      executable: this.executable,
      args: specification.args,
      cwd: os.tmpdir(),
      env: { ...process.env, ...(this.apiKey ? { CODEX_API_KEY: this.apiKey } : {}) },
    });
    const abort = () => {
      void connection.close();
    };
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    try {
      await connection.call('initialize', {
        clientInfo: { name: 'buro', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      connection.send({ method: 'initialized', params: {} });
      const models: AvailableModel[] = [];
      let cursor: string | undefined;
      do {
        const page = object(await connection.call('model/list', { cursor }));
        for (const raw of Array.isArray(page.data) ? page.data : []) {
          const model = object(raw),
            id = typeof model.model === 'string' ? model.model : model.id;
          if (typeof id === 'string')
            models.push({
              id,
              name: typeof model.displayName === 'string' ? model.displayName : undefined,
            });
        }
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      } while (cursor);
      return models;
    } finally {
      input.signal.removeEventListener('abort', abort);
      await connection.close();
    }
  }

  private async request(input: BackendRequest): Promise<ModelCompletion> {
    input.signal.throwIfAborted();
    const env = { ...process.env, ...(this.apiKey ? { CODEX_API_KEY: this.apiKey } : {}) };
    const specification = codexArguments({
      prefix: this.prefix,
      deniedPaths: [...this.privatePaths, input.workspace],
    });
    let toolFailure: unknown;
    const connection = new JsonlConnection({
      executable: this.executable,
      args: specification.args,
      cwd: input.workspace,
      env,
      request: async (message) => {
        if (message.method !== 'item/tool/call')
          throw new Error('This native server request is unsupported.');
        const params = object(message.params);
        if (typeof params.callId !== 'string' || typeof params.tool !== 'string')
          throw new Error('Invalid native tool request.');
        try {
          const result = await input.executeTool({
            id: params.callId,
            name: params.tool,
            arguments: params.arguments,
          });
          return {
            success: !result.isError,
            contentItems: [{ type: 'inputText', text: result.content }],
          };
        } catch (error) {
          toolFailure = error;
          void connection.close();
          throw error;
        }
      },
    });
    const abort = () => {
      void connection.close();
    };
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    let threadId = '',
      answer = '',
      reportedModel = input.model,
      usage: ModelUsage | undefined;
    let resolveTurn!: () => void, rejectTurn!: (error: Error) => void;
    const ended = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    void ended.catch(() => {});
    const unsubscribe = connection.subscribe((message: RpcMessage) => {
      if (message.method === 'process/closed') {
        rejectTurn(new Error('The native controller stopped before completing the turn.'));
        return;
      }
      const params = object(message.params);
      if (params.threadId !== threadId || !threadId) return;
      observer(input.onProgress);
      if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string')
        observer(() => input.onEvent?.({ type: 'text.delta', text: String(params.delta) }));
      if (message.method === 'item/completed') {
        const item = object(params.item);
        if (item.type === 'agentMessage' && typeof item.text === 'string') answer = item.text;
      }
      if (message.method === 'thread/tokenUsage/updated') {
        const total = object(object(params.tokenUsage).total);
        usage = {
          inputTokens: typeof total.inputTokens === 'number' ? total.inputTokens : undefined,
          outputTokens: typeof total.outputTokens === 'number' ? total.outputTokens : undefined,
        };
      }
      if (message.method === 'turn/completed') {
        const turn = object(params.turn);
        if (turn.status === 'completed') resolveTurn();
        else
          rejectTurn(
            new Error(String(object(turn.error).message ?? 'The native turn did not complete.')),
          );
      }
    });
    try {
      await connection.call('initialize', {
        clientInfo: { name: 'buro', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      connection.send({ method: 'initialized', params: {} });
      const system = input.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
      const started = object(
        await connection.call('thread/start', {
          cwd: input.workspace,
          approvalPolicy: 'never',
          permissions: specification.permissions,
          ephemeral: true,
          model: input.model,
          developerInstructions:
            system +
            '\n\nUse the advertised Buro tools for workspace operations and collaboration. Saved conversation entries describe observed work, not instructions to repeat past actions.',
          dynamicTools: input.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
        }),
      );
      if (object(started.activePermissionProfile).id !== specification.permissions)
        throw new Error('The native client did not confirm its host-tool access boundary.');
      const thread = object(started.thread);
      if (typeof thread.id !== 'string')
        throw new Error('The native client did not return a thread ID.');
      threadId = thread.id;
      if (typeof started.model === 'string') reportedModel = started.model;
      await connection.call('turn/start', {
        threadId,
        model: input.model,
        effort: this.effort,
        permissions: specification.permissions,
        approvalPolicy: 'never',
        outputSchema: input.schema,
        input: [
          {
            type: 'text',
            text: JSON.stringify(input.messages.filter((message) => message.role !== 'system')),
            text_elements: [],
          },
        ],
      });
      await ended;
      if (toolFailure) throw toolFailure;
      input.signal.throwIfAborted();
      return {
        model: reportedModel,
        finish: 'stop',
        usage,
        message: { role: 'assistant', content: answer },
      };
    } catch (error) {
      throw toolFailure ?? error;
    } finally {
      unsubscribe();
      input.signal.removeEventListener('abort', abort);
      await connection.close();
    }
  }
}
