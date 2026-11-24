import type { ApiMethods, ApiNotification, ApiResponse } from './contract.ts';
import type { Notification } from '../events/notifications.ts';

/** One socket client for browser, CLI and automation, without mutable domain projections. */
export class ApiClient {
  private url: string;
  private socket?: WebSocket;
  private ready?: Promise<void>;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private listeners = new Set<(notification: Notification) => void>();
  private sequence = 0;

  /** Selects the local daemon without connecting until explicitly requested. */
  constructor(input: { url?: string } = {}) {
    this.url = input.url ?? 'ws://127.0.0.1:4341';
  }

  /** Opens one shared connection or joins the connection already being established. */
  connect(): Promise<void> {
    if (this.ready) return this.ready;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.ready = new Promise<void>((resolve, reject) => {
      socket.onopen = () =>
        this.socket === socket ? resolve() : reject(new Error('Connection was replaced.'));
      socket.onerror = () => reject(new Error('The Buro API is unavailable.'));
      socket.onclose = () => {
        reject(new Error('The Buro API connection closed.'));
        if (this.socket !== socket) return;
        this.ready = undefined;
        this.socket = undefined;
        for (const entry of this.pending.values())
          entry.reject(new Error('Connection lost. Read current state before retrying a command.'));
        this.pending.clear();
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        try {
          const message = JSON.parse(String(event.data)) as ApiResponse | ApiNotification;
          if ('type' in message && message.type === 'notification') {
            for (const listener of this.listeners) {
              try {
                listener(structuredClone(message.notification));
              } catch {
                /* Observers cannot fail the connection. */
              }
            }
          } else if ('id' in message) {
            const entry = this.pending.get(message.id);
            if (!entry) return;
            this.pending.delete(message.id);
            if (message.ok) entry.resolve(message.result);
            else entry.reject(new Error(message.error ?? 'API request failed.'));
          }
        } catch {
          socket.close();
        }
      };
    });
    return this.ready;
  }

  /** Executes a feature command; disconnected mutations are never replayed automatically. */
  async call<K extends keyof ApiMethods>(
    method: K,
    params: ApiMethods[K]['params'],
  ): Promise<ApiMethods[K]['result']> {
    await this.connect();
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as ApiMethods[K]['result']),
        reject,
      });
      try {
        this.socket!.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Subscribes to notifications; reconnecting callers re-read the feature state they display. */
  subscribe(listener: (notification: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Closes the connection and rejects pending requests without changing persisted work. */
  close(): void {
    this.socket?.close();
    this.socket = undefined;
    this.ready = undefined;
    for (const entry of this.pending.values()) entry.reject(new Error('API client closed.'));
    this.pending.clear();
  }
}
