import { DomainError } from './ports.ts';
import type { ClientCommand } from '../protocol/schema.ts';
type Handler = (
  params: any,
  meta: { id: string; fingerprint: string },
) => unknown | Promise<unknown>;
export class CommandBus {
  handlers = new Map<string, Handler>();
  register(method: ClientCommand['method'], handler: Handler) {
    if (this.handlers.has(method)) throw new DomainError('DUPLICATE_HANDLER', method);
    this.handlers.set(method, handler);
    return () => {
      if (this.handlers.get(method) === handler) this.handlers.delete(method);
    };
  }
  execute(command: ClientCommand, meta: { id: string; fingerprint: string }) {
    const handler = this.handlers.get(command.method);
    if (!handler) throw new DomainError('UNAVAILABLE', 'This command service is unavailable.');
    return handler(command.params, meta);
  }
}
