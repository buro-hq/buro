import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Application } from '../application/application.ts';
import type { ApiNotification, ApiResponse } from './contract.ts';
import { apiMethods } from './dispatch.ts';

/** A local transport owns sockets, not application state or execution decisions. */
export interface ApiServer {
  port: number;
  /** Closes transport connections; the owning process then closes the application. */
  close(): Promise<void>;
}

const request = z.object({
  id: z.string().min(1).max(100),
  method: z.string(),
  params: z.unknown().optional(),
});
const allowedOrigin = (origin?: string) => {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
};

/** Starts a loopback-only API using ordinary feature methods and detached notifications. */
export async function startApiServer(input: {
  application: Application;
  port?: number;
  report?: (error: unknown) => void;
}): Promise<ApiServer> {
  const app = input.application;
  const methods = apiMethods(app);
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: input.port ?? 4341,
    maxPayload: 16 * 1024 * 1024,
    verifyClient: (info: { origin?: string }) => allowedOrigin(info.origin),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const pending = new Set<Promise<void>>();
  const send = (socket: WebSocket, message: ApiResponse | ApiNotification) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const unsubscribe = app.events.subscribe((notification) => {
    for (const socket of server.clients) send(socket, { type: 'notification', notification });
  });
  server.on('connection', (socket) => {
    socket.on('error', (error) => input.report?.(error));
    socket.on('message', (bytes) => {
      const work = (async () => {
        let id = 'invalid';
        try {
          const parsed = request.parse(JSON.parse(bytes.toString()));
          id = parsed.id;
          const invoke = Object.hasOwn(methods, parsed.method)
            ? methods[parsed.method as keyof typeof methods]
            : undefined;
          if (!invoke) {
            send(socket, { id, ok: false, error: 'Unknown API method.' });
            return;
          }
          const result = await invoke(parsed.params ?? {});
          send(socket, { id, ok: true, result });
        } catch (error) {
          if (!(error instanceof z.ZodError) && !(error instanceof SyntaxError))
            input.report?.(error);
          send(socket, {
            id,
            ok: false,
            error:
              error instanceof z.ZodError || error instanceof SyntaxError
                ? 'Invalid API request or parameters.'
                : 'The operation failed. See the server log for details.',
          });
        }
      })();
      pending.add(work);
      void work.finally(() => pending.delete(work)).catch((error) => input.report?.(error));
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The API did not receive a TCP port.');
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    close() {
      return (closing ??= (async () => {
        unsubscribe();
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await Promise.allSettled([...pending]);
      })());
    },
  };
}
