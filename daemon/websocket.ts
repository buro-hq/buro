import { WebSocketServer, WebSocket } from 'ws';
import type { Context, Plugin } from 'cordis';
import { RequestSchema, type ServerMessage, type Request } from '../protocol/schema.ts';
import { DomainError } from '../core/ports.ts';
import { capabilities } from '../core/defaults.ts';
import { fingerprint } from './fingerprint.ts';

export type TransportOptions = {
  port: number;
  host?: '127.0.0.1';
  onListen?: (port: number) => void;
};
function send(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function allowedOrigin(origin?: string) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (
      ['http:', 'https:'].includes(u.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    );
  } catch {
    return false;
  }
}
export const websocketPlugin: Plugin.Object<TransportOptions> = {
  name: 'websocket',
  inject: ['projects', 'commands'],
  async apply(ctx: Context, options) {
    const server = new WebSocketServer({
      host: options.host || '127.0.0.1',
      port: options.port,
      maxPayload: 12 * 1024 * 1024,
      verifyClient: (info: { origin?: string }) => allowedOrigin(info.origin),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    } catch (e) {
      server.close();
      throw e;
    }
    const address = server.address();
    if (address && typeof address === 'object') options.onListen?.(address.port);
    server.on('connection', (ws) => {
      let unsubscribe = () => {};
      send(ws, { version: 1, type: 'hello', capabilities });
      ws.on('message', async (bytes) => {
        let request: Request | undefined;
        let requestId = 'invalid_request';
        try {
          const raw = JSON.parse(bytes.toString());
          if (typeof raw?.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(raw.id))
            requestId = raw.id;
          request = RequestSchema.parse(raw);
          let result: unknown;
          if (request.command.method === 'events.subscribe') {
            const { projectId, after } = request.command.params;
            const store = ctx.projects.registry.get(projectId);
            unsubscribe();
            unsubscribe = store.subscribe(after, (event) =>
              send(ws, { version: 1, type: 'event', event }),
            );
            result = { projectId, sequence: store.snapshot().sequence };
          } else
            result = await ctx.commands.bus.execute(request.command, {
              id: request.id,
              fingerprint: fingerprint(request.command),
            });
          send(ws, { version: 1, type: 'response', id: request.id, ok: true, result });
        } catch (error) {
          send(ws, {
            version: 1,
            type: 'response',
            id: request?.id || requestId,
            ok: false,
            error: {
              code:
                error instanceof DomainError
                  ? error.code
                  : error instanceof SyntaxError || (error as Error).name === 'ZodError'
                    ? 'BAD_REQUEST'
                    : 'INTERNAL_ERROR',
              message:
                error instanceof DomainError
                  ? error.message
                  : error instanceof SyntaxError || (error as Error).name === 'ZodError'
                    ? 'Invalid command or protocol version.'
                    : 'The service could not execute the command.',
            },
          });
        }
      });
      ws.on('error', () => {});
      ws.on('close', () => unsubscribe());
    });
    ctx.effect(
      () => () =>
        new Promise<void>((resolve, reject) => {
          for (const client of server.clients) client.terminate();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
  },
};
