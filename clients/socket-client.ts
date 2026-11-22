import type {
  CreateGoal,
  DomainEvent,
  Goal,
  Role,
  SaveRole,
  Snapshot,
  ServiceInfo,
  ResourceConfigurationChange,
} from '../protocol/domain.ts';
import {
  parseDomainEvent,
  parseSnapshot,
  parseServiceInfo,
  ResourceConfigurationChangeSchema,
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
const hasActiveRun = (snapshot: Snapshot) =>
  snapshot.runs.some(
    (run) => !!run.status && ['queued', 'running', 'canceling'].includes(run.status),
  );
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
  if (c.type === 'role.saved' || c.type === 'project.configured') next.effectivePolicy = undefined; // Only the service can resolve changed policy inheritance.
  if (c.type === 'project.verified') next.verification = c.verification;
  if (c.type === 'project.research.changed') {
    next.research = c.research;
    for (const role of c.roles || [])
      next.roles = [...next.roles.filter((previous) => previous.id !== role.id), role];
  }
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
  projectId: string | undefined;
  service: ServiceInfo | null = null;
  private serviceMode = false;
  private initialService?: { resolve: (s: ServiceInfo) => void; reject: (e: Error) => void };
  private serviceListeners = new Set<(s: ServiceInfo) => void>();
  private invalidationListeners = new Set<(change: ResourceConfigurationChange) => void>();
  private resourceGeneration = 0;
  private resourceRevision?: string;
  private selectionRevision = 0;
  ws: WebSocket | null = null;
  state: Snapshot | null = null;
  closed = false;
  ready = false;
  listeners = new Set<(s: Snapshot) => void>();
  connections = new Set<(s: Connection) => void>();
  pending = new Map<string, Pending>();
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  initial: { resolve: (s: Snapshot) => void; reject: (e: Error) => void } | undefined;
  private projectionRevision = 0;
  private observedProjectionRevision = 0;
  private projectionRefresh?: {
    socket: WebSocket;
    projectId: string;
    selection: number;
    events: DomainEvent[];
    promise: Promise<void>;
  };
  constructor(url = 'ws://127.0.0.1:4341', projectId?: string) {
    this.url = url;
    this.projectId = projectId;
  }
  connect() {
    if (!this.projectId) return Promise.reject(Error('Select a project before connecting.'));
    this.serviceMode = false;
    this.closed = false;
    return new Promise<Snapshot>((resolve, reject) => {
      this.initial = { resolve, reject };
      this.open();
    });
  }
  connectService(): Promise<ServiceInfo> {
    this.serviceMode = true;
    this.closed = false;
    return new Promise((resolve, reject) => {
      this.initialService = { resolve, reject };
      this.open();
    });
  }
  async refreshService(): Promise<ServiceInfo> {
    const info = parseServiceInfo(await this.request({ method: 'service.info', params: {} }));
    this.service = info;
    for (const listener of this.serviceListeners) listener(info);
    return info;
  }
  onServiceChange(listener: (info: ServiceInfo) => void) {
    this.serviceListeners.add(listener);
    return () => this.serviceListeners.delete(listener);
  }
  onServiceInvalidation(listener: (change: ResourceConfigurationChange) => void) {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }
  getResourceGeneration() {
    return this.resourceGeneration;
  }
  getResourceRevision() {
    return this.resourceRevision;
  }
  private observeConfiguration(change: ResourceConfigurationChange) {
    if (change.revision === this.resourceRevision) return;
    this.resourceRevision = change.revision;
    this.resourceGeneration++;
    this.invalidateProjection();
    for (const listener of this.invalidationListeners)
      try {
        void Promise.resolve(listener({ ...change })).catch(() => {});
      } catch {
        // Consumer notifications cannot break a healthy transport.
      }
  }
  private async readProjectSnapshot(projectId: string, handshake = false): Promise<Snapshot> {
    const socket = this.ws;
    for (;;) {
      const generation = this.resourceGeneration;
      const snapshot = parseSnapshot(
        await this.request({ method: 'project.snapshot', params: { projectId } }, handshake),
      );
      if (this.closed || this.ws !== socket) throw Error('Project refresh was superseded.');
      if (generation === this.resourceGeneration) return snapshot;
    }
  }
  async selectProject(id: string): Promise<Snapshot> {
    if (!this.ready) throw Error('Connect to the service before selecting a project.');
    const selection = ++this.selectionRevision;
    const socket = this.ws;
    const snapshot = await this.readProjectSnapshot(id);
    if (this.closed || this.ws !== socket || selection !== this.selectionRevision)
      throw Error('Project selection was superseded.');
    if (snapshot.project.id !== id) throw Error('The service returned another project.');
    this.projectId = id;
    this.state = snapshot;
    try {
      await this.request({
        method: 'events.subscribe',
        params: { projectId: id, after: snapshot.sequence },
      });
    } catch (error) {
      if (this.ws === socket && selection === this.selectionRevision) socket?.close();
      throw error;
    }
    if (this.closed || this.ws !== socket || selection !== this.selectionRevision)
      throw Error('Project selection was superseded.');
    this.notify();
    return this.snapshot();
  }
  open() {
    if (this.closed) return;
    this.resourceRevision = undefined;
    this.status(this.state ? 'reconnecting' : 'connecting');
    this.ready = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws || this.closed) return;
      this.resourceGeneration++;
      void this.handshake().catch((error) => {
        this.initialService?.reject(error);
        this.initialService = undefined;
        this.initial?.reject(error);
        this.initial = undefined;
        ws.close();
      });
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || this.closed) return;
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
        } else if (message.type === 'service.change') {
          this.observeConfiguration(ResourceConfigurationChangeSchema.parse(message.change));
        } else if (message.type === 'event' && this.state) {
          try {
            const event = parseDomainEvent(message.event);
            const busyBefore = hasActiveRun(this.state);
            if (this.projectionRefresh?.socket === ws) this.projectionRefresh.events.push(event);
            this.state = applyEvent(this.state, event);
            this.notify();
            if (
              event.change.type === 'role.saved' ||
              event.change.type === 'project.configured' ||
              event.change.type === 'goal.deleted' ||
              ((event.change.type === 'project.research.changed' ||
                event.change.type === 'run.changed') &&
                !!event.change.roles?.length) ||
              (event.change.type === 'run.changed' && busyBefore !== hasActiveRun(this.state))
            )
              this.invalidateProjection();
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
      if (this.ws !== ws) return;
      this.ready = false;
      this.status(this.closed ? 'offline' : 'reconnecting');
      // Handshake reads can be retried with fresh ids. Mutations retain their original id.
      for (const [id, p] of this.pending)
        if (
          ['service.info', 'project.snapshot', 'events.subscribe', 'project.list'].includes(
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
    if (this.serviceMode) {
      const info = parseServiceInfo(
        await this.request({ method: 'service.info', params: {} }, true),
      );
      this.service = info;
      for (const listener of this.serviceListeners) listener(info);
      this.ready = true;
      if (this.projectId && this.state) await this.selectProject(this.projectId);
      this.status('connected');
      for (const pending of this.pending.values()) this.ws?.send(JSON.stringify(pending.request));
      this.initialService?.resolve(info);
      this.initialService = undefined;
      return;
    }
    if (!this.projectId) throw Error('Select a project before connecting.');
    const snapshot = await this.readProjectSnapshot(this.projectId, true);
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
    void this.refreshProjection().catch(() => {});
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
    return this.request<T>(command).then((result) => {
      // This configuration command has no project-domain event. Its receipt remains authoritative.
      if (command.method === 'resources.use') this.invalidateProjection();
      return result;
    });
  }
  private invalidateProjection() {
    this.projectionRevision++;
    if (this.state?.effectivePolicy) {
      this.state = { ...this.state, effectivePolicy: undefined };
      this.notify();
    }
    void this.refreshProjection().catch(() => {});
  }
  private refreshProjection(): Promise<void> {
    if (!this.projectId || !this.state) return Promise.resolve();
    const projectId = this.projectId;
    const selection = this.selectionRevision;
    const socket = this.ws;
    if (
      this.closed ||
      !this.ready ||
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      this.projectionRevision === this.observedProjectionRevision
    )
      return Promise.resolve();
    if (
      this.projectionRefresh?.socket === socket &&
      this.projectionRefresh.projectId === projectId &&
      this.projectionRefresh.selection === selection
    )
      return this.projectionRefresh.promise;
    const revision = this.projectionRevision;
    const after = this.state?.sequence || 0;
    const refresh = {
      socket,
      projectId,
      selection,
      events: [] as DomainEvent[],
      promise: Promise.resolve(),
    };
    this.projectionRefresh = refresh;
    refresh.promise = (async () => {
      try {
        let next = parseSnapshot(
          await this.request({ method: 'project.snapshot', params: { projectId } }),
        );
        if (
          this.closed ||
          this.ws !== socket ||
          !this.ready ||
          this.projectId !== projectId ||
          selection !== this.selectionRevision
        )
          return;
        if (next.project.id !== this.projectId || next.sequence < after)
          throw Error('The refreshed snapshot does not cover the current project history.');
        for (const event of refresh.events)
          if (event.seq > next.sequence) next = applyEvent(next, event);
        if (this.state && next.sequence < this.state.sequence)
          throw Error('A refreshed snapshot cannot discard observed project events.');
        if (this.projectionRevision > revision) next.effectivePolicy = undefined;
        this.state = next;
        this.observedProjectionRevision = revision;
        this.notify();
      } catch (error) {
        if (
          !this.closed &&
          this.ws === socket &&
          this.projectId === projectId &&
          selection === this.selectionRevision
        )
          socket.close();
        throw error;
      } finally {
        if (this.projectionRefresh === refresh) {
          this.projectionRefresh = undefined;
          if (this.projectionRevision > this.observedProjectionRevision)
            void this.refreshProjection().catch(() => {});
        }
      }
    })();
    return refresh.promise;
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
    this.initialService?.reject(Error('The client is closed.'));
    this.initialService = undefined;
    this.initial?.reject(Error('The client is closed.'));
    this.initial = undefined;
    this.serviceListeners.clear();
    this.invalidationListeners.clear();
    this.listeners.clear();
    this.connections.clear();
  }
}
