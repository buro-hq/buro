import type {
  CreateGoal,
  DomainEvent,
  Goal,
  Role,
  SaveRole,
  Snapshot,
} from '../protocol/domain.ts';
import {
  parseDomainEvent,
  parseSnapshot,
  type ClientCommand,
  type Request,
} from '../protocol/schema.ts';
import type { Connection, ProjectClient } from './project-client.ts';

type Pending = {
  request: Request;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export function applyEvent(snapshot: Snapshot, event: DomainEvent): Snapshot {
  if (event.projectId !== snapshot.project.id || event.seq <= snapshot.sequence) return snapshot;
  if (event.seq !== snapshot.sequence + 1) throw Error('Event gap: a new snapshot is required.');
  const next = { ...snapshot, sequence: event.seq, revision: snapshot.revision + 1 };
  const c = event.change;
  if (c.type === 'context.materials.added')
    next.contextMaterials = [
      ...(snapshot.contextMaterials || []),
      ...c.materials.filter((m) => !snapshot.contextMaterials?.some((old) => old.id === m.id)),
    ];
  if (c.type === 'context.material.removed')
    next.contextMaterials = snapshot.contextMaterials?.map((m) =>
      m.id === c.id ? { ...m, active: false } : m,
    );
  if (c.type === 'goal.created' || c.type === 'goal.updated')
    next.goals = [...snapshot.goals.filter((g) => g.id !== c.goal.id), c.goal];
  if (c.type === 'goal.deleted') next.goals = snapshot.goals.filter((g) => g.id !== c.id);
  if (c.type === 'role.saved')
    next.roles = [...snapshot.roles.filter((r) => r.id !== c.role.id), c.role];
  if (c.type === 'project.verified') next.verification = c.verification;
  if (c.type === 'project.research.changed') next.research = c.research;
  if (c.type === 'project.configured') {
    if (c.research) next.research = c.research;
    next.profile = c.profile;
    next.executionPolicy = c.executionPolicy;
  }
  if (c.type === 'run.changed') {
    next.runs = [c.run, ...snapshot.runs.filter((r) => r.id !== c.run.id)];
    next.goals = [...snapshot.goals.filter((g) => g.id !== c.goal.id), c.goal];
    if (c.roles)
      for (const role of c.roles)
        next.roles = [...next.roles.filter((r) => r.id !== role.id), role];
  }
  return next;
}
/** Transport-only client, shared by the browser and CLI. It never imports core or Cordis. */
export class SocketProjectClient implements ProjectClient {
  readonly mode = 'service' as const;
  url: string;
  projectId: string;
  ws: WebSocket | null = null;
  state: Snapshot | null = null;
  closed = false;
  ready = false;
  listeners = new Set<(s: Snapshot) => void>();
  connections = new Set<(s: Connection) => void>();
  pending = new Map<string, Pending>();
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  initial: { resolve: (s: Snapshot) => void; reject: (e: Error) => void } | undefined;
  constructor(url = 'ws://127.0.0.1:4341', projectId = 'codex-panel') {
    this.url = url;
    this.projectId = projectId;
  }
  connect() {
    this.closed = false;
    return new Promise<Snapshot>((resolve, reject) => {
      this.initial = { resolve, reject };
      this.open();
    });
  }
  open() {
    if (this.closed) return;
    this.status(this.state ? 'reconnecting' : 'connecting');
    this.ready = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      void this.handshake().catch((error) => {
        this.initial?.reject(error);
        this.initial = undefined;
        ws.close();
      });
    };
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.version !== 1) throw Error('Unsupported protocol version.');
        if (message.type === 'response') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.ok) pending.resolve(message.result);
          else
            pending.reject(
              Object.assign(Error(message.error.message), { code: message.error.code }),
            );
        } else if (message.type === 'event' && this.state) {
          try {
            this.state = applyEvent(this.state, parseDomainEvent(message.event));
            this.notify();
          } catch {
            ws.close();
          }
        }
      } catch {
        ws.close();
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      this.ready = false;
      this.status(this.closed ? 'offline' : 'reconnecting');
      // Handshake reads can be retried with fresh ids. Mutations retain their original id.
      for (const [id, p] of this.pending)
        if (
          ['project.snapshot', 'events.subscribe', 'project.list'].includes(
            p.request.command.method,
          )
        ) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(Error('Connection interrupted.'));
        }
      if (!this.closed) this.reconnectTimer = setTimeout(() => this.open(), 700);
    };
  }
  async handshake() {
    const snapshot = parseSnapshot(
      await this.request(
        { method: 'project.snapshot', params: { projectId: this.projectId } },
        true,
      ),
    );
    this.state = snapshot;
    this.notify();
    await this.request(
      {
        method: 'events.subscribe',
        params: { projectId: this.projectId, after: snapshot.sequence },
      },
      true,
    );
    this.ready = true;
    this.status('connected');
    for (const p of this.pending.values()) this.ws?.send(JSON.stringify(p.request));
    this.initial?.resolve(this.snapshot());
    this.initial = undefined;
  }
  request<T>(command: ClientCommand, handshake = false): Promise<T> {
    if (this.closed) return Promise.reject(Error('The client is closed.'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const request: Request = { version: 1, type: 'request', id, command };
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(Error('The service did not respond. Retry after reconnecting.'));
        },
        command.method === 'project.verify'
          ? 4 * 60 * 60 * 1000
          : command.method === 'resources.probe'
            ? 135000
            : command.method === 'resources.models'
              ? 20000
              : command.method === 'context.import'
                ? 180000
                : command.method === 'run.apply'
                  ? 60000
                  : 15000,
      );
      this.pending.set(id, { request, resolve, reject, timer });
      if ((this.ready || handshake) && this.ws?.readyState === WebSocket.OPEN)
        this.ws.send(JSON.stringify(request));
    });
  }
  command<T>(command: ClientCommand) {
    return this.request<T>(command);
  }
  createGoal(input: CreateGoal) {
    return this.command<Goal>({ method: 'goal.create', params: input });
  }
  deleteGoal(projectId: string, id: string) {
    return this.command({ method: 'goal.delete', params: { projectId, id } });
  }
  saveRole(input: SaveRole) {
    return this.command<Role>({ method: 'role.save', params: input });
  }
  snapshot() {
    if (!this.state) throw Error('The client is not connected yet.');
    return this.state;
  }
  onChange(listener: (s: Snapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onConnection(listener: (s: Connection) => void) {
    this.connections.add(listener);
    return () => this.connections.delete(listener);
  }
  status(value: Connection) {
    for (const listener of this.connections) listener(value);
  }
  notify() {
    for (const listener of this.listeners) listener(this.snapshot());
  }
  close() {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error('The client is closed.'));
    }
    this.pending.clear();
    this.listeners.clear();
    this.connections.clear();
  }
}
