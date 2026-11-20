import type { RuntimeResource } from '../protocol/resources.ts';
import { resourceForPurpose } from '../protocol/resources.ts';
import {
  DomainError,
  type AgentRuntime,
  type ProjectRegistry,
  type RuntimeEvent,
  type RuntimeRegistry,
  type RuntimeSelection,
} from './ports.ts';

export type RuntimeRoute = {
  id: string;
  projectId: string;
  runId?: string;
  ownerRunId?: string;
  workspace?: string;
  resource: RuntimeResource;
  externalThreadId?: string;
  status: 'starting' | 'ready' | 'unknown';
};
export interface RuntimeRouteStore {
  load(id: string): Promise<RuntimeRoute | undefined>;
  save(route: RuntimeRoute): Promise<void>;
}

/** Stable Buro handles scope every native thread to its saved runtime configuration. */
export class RuntimeRouter implements AgentRuntime {
  readonly id = 'buro-router';
  private options: {
    registry: RuntimeRegistry;
    selection: RuntimeSelection;
    projects: ProjectRegistry;
    resources: RuntimeResource[];
    routes: RuntimeRouteStore;
    id: () => string;
  };
  private loaded = new Map<string, RuntimeRoute>();
  private native = new Map<string, string>();
  private observed = new Map<string, { id: string; runId: string }>();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private unsubscribe: (() => void)[] = [];
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  constructor(options: RuntimeRouter['options']) {
    this.options = options;
    for (const id of options.registry.list()) {
      const unsubscribe = options.registry.get(id).subscribe?.((event) => this.relay(id, event));
      if (unsubscribe) this.unsubscribe.push(unsubscribe);
    }
  }
  private key(runtimeId: string, threadId: string) {
    return JSON.stringify([runtimeId, threadId]);
  }
  private bind(route: RuntimeRoute) {
    this.loaded.set(route.id, route);
    if (route.externalThreadId)
      this.native.set(this.key(route.resource.id, route.externalThreadId), route.id);
  }
  private adapter(route: RuntimeRoute) {
    const current = this.options.resources.find((resource) => resource.id === route.resource.id);
    if (!current || current.configurationRevision !== route.resource.configurationRevision)
      throw new DomainError(
        'RUNTIME_CONFIG_CHANGED',
        'The saved runtime configuration is unavailable. Restore it or start a new attempt.',
      );
    return this.options.registry.get(route.resource.id);
  }
  private assertOpen() {
    if (this.closed) throw new DomainError('RUNTIME_CLOSED', 'The runtime router stopped.');
  }
  private async route(id: string) {
    this.assertOpen();
    const route = this.loaded.get(id) || (await this.options.routes.load(id));
    if (!route) throw new DomainError('THREAD_NOT_FOUND', 'Saved runtime route not found.');
    if (route.status !== 'ready' || !route.externalThreadId)
      throw new DomainError(
        'SESSION_RECONCILIATION_REQUIRED',
        'The client start outcome is unknown; it will not be repeated automatically.',
      );
    this.bind(route);
    return route;
  }
  private async operation<T>(action: () => Promise<T>) {
    this.assertOpen();
    const work = Promise.resolve().then(action);
    this.pending.add(work);
    try {
      return await work;
    } finally {
      this.pending.delete(work);
    }
  }
  start(input: Parameters<AgentRuntime['start']>[0]) {
    return this.operation(() => this.startSession(input));
  }
  private async startSession(input: Parameters<AgentRuntime['start']>[0]) {
    this.assertOpen();
    const snapshot = this.options.projects.get(input.projectId).snapshot();
    const run = snapshot.runs.find((r) => r.id === (input.ownerRunId || input.runId));
    if (input.ownerRunId && !run)
      throw new DomainError('NOT_FOUND', 'The owning run is unavailable.');
    const selection = run?.resources || this.options.selection.forProject(input.projectId);
    const resource = resourceForPurpose(selection, input.purpose);
    if (selection.policy === 'local-only' && !resource.local)
      throw new DomainError(
        'DATA_POLICY_BLOCKED',
        'A local-only session cannot use a remote runtime.',
      );
    const route: RuntimeRoute = {
      id: 'B-' + this.options.id(),
      projectId: input.projectId,
      runId: input.runId,
      ownerRunId: input.ownerRunId,
      workspace: input.workspace || snapshot.project.root,
      resource,
      status: 'starting',
    };
    await this.options.routes.save(route);
    let runtime: AgentRuntime | undefined;
    try {
      this.assertOpen();
      runtime = this.adapter(route);
      const started = await runtime.start({ ...input, workspace: route.workspace });
      route.externalThreadId = started.threadId;
      this.assertOpen();
      route.status = 'ready';
      await this.options.routes.save(route);
      this.assertOpen();
      this.bind(route);
      return { threadId: route.id };
    } catch (error) {
      route.status = 'unknown';
      await this.options.routes.save(route).catch(() => {});
      if (route.externalThreadId) await runtime?.release?.(route.externalThreadId);
      throw error;
    }
  }
  resume(input: Parameters<NonNullable<AgentRuntime['resume']>>[0]) {
    return this.operation(() => this.resumeSession(input));
  }
  private async resumeSession(input: Parameters<NonNullable<AgentRuntime['resume']>>[0]) {
    this.assertOpen();
    let saved = this.loaded.get(input.threadId) || (await this.options.routes.load(input.threadId));
    if (!saved) {
      // Explicit compatibility for a recorded pre-router Codex run, never an arbitrary fallback.
      const run = this.options.projects
        .get(input.projectId)
        .snapshot()
        .runs.find((r) => r.id === input.runId);
      const codex = this.options.resources.find(
        (resource) => resource.id === 'codex' && resource.client === 'codex',
      );
      if (!run || run.resources || run.threadId !== input.threadId || !codex)
        throw new DomainError('THREAD_NOT_FOUND', 'Saved runtime route not found.');
      if (run.workspace !== input.workspace)
        throw new DomainError(
          'SESSION_MISMATCH',
          'The historical workspace does not match this continuation.',
        );
      if (this.options.selection.forProject(input.projectId).policy === 'local-only')
        throw new DomainError(
          'DATA_POLICY_BLOCKED',
          'An old Codex session requires an explicitly permitted remote profile.',
        );
      saved = {
        id: input.threadId,
        projectId: input.projectId,
        runId: input.runId,
        workspace: input.workspace,
        resource: codex,
        externalThreadId: input.threadId,
        status: 'ready',
      };
      await this.options.routes.save(saved);
    }
    if (
      saved.projectId !== input.projectId ||
      saved.runId !== input.runId ||
      saved.workspace !== input.workspace ||
      saved.ownerRunId !== input.ownerRunId
    )
      throw new DomainError(
        'SESSION_MISMATCH',
        'The saved route belongs to another project, run or workspace.',
      );
    if (saved.status !== 'ready' || !saved.externalThreadId)
      throw new DomainError(
        'SESSION_RECONCILIATION_REQUIRED',
        'The client start outcome is unknown.',
      );
    const adapter = this.adapter(saved);
    if (!adapter.resume)
      throw new DomainError(
        'RESUME_UNSUPPORTED',
        'This runtime does not support saved-session continuation.',
      );
    this.bind(saved);
    const resumed = await adapter.resume({ ...input, threadId: saved.externalThreadId });
    if (this.closed) {
      await adapter.release?.(resumed.threadId);
      this.assertOpen();
    }
    if (resumed.threadId !== saved.externalThreadId)
      throw new DomainError('SESSION_MISMATCH', 'The client resumed a different session.');
    return { threadId: saved.id };
  }
  async submit(id: string, text: string) {
    const route = await this.route(id);
    return this.adapter(route).submit(route.externalThreadId!, text);
  }
  async turn(id: string, text: string, options: Parameters<NonNullable<AgentRuntime['turn']>>[2]) {
    const route = await this.route(id),
      runtime = this.adapter(route);
    if (!runtime.turn)
      throw new DomainError('TURN_UNSUPPORTED', 'This runtime cannot complete a structured turn.');
    return runtime.turn(route.externalThreadId!, text, options);
  }
  async interrupt(id: string, turnId: string) {
    const route = await this.route(id);
    return this.adapter(route).interrupt(route.externalThreadId!, turnId);
  }
  async release(id: string) {
    const route = this.loaded.get(id);
    if (route?.externalThreadId) await this.adapter(route).release?.(route.externalThreadId);
  }
  private relay(runtimeId: string, event: RuntimeEvent) {
    if (this.closed) return;
    const key = this.key(runtimeId, event.threadId);
    const observed = this.observed.get(key);
    if (observed && observed.runId !== event.runId) return;
    let id = this.native.get(key) || observed?.id;
    let parentThreadId: string | undefined;
    if (event.type === 'agent.activity') {
      parentThreadId = this.native.get(this.key(runtimeId, event.parentThreadId));
      if (!parentThreadId || this.loaded.get(parentThreadId)?.runId !== event.runId) return;
      if (!id && parentThreadId) {
        id = 'N-' + this.options.id();
        this.observed.set(key, { id, runId: event.runId });
      }
    }
    if (!id) return;
    const route = this.loaded.get(id);
    if (route && route.runId !== event.runId) return;
    const normalized = {
      ...event,
      id: JSON.stringify([runtimeId, id, event.id]),
      threadId: id,
      ...(parentThreadId ? { parentThreadId } : {}),
    } as RuntimeEvent;
    for (const listener of this.listeners) {
      try {
        listener(normalized);
      } catch {}
    }
  }
  subscribe(listener: (event: RuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async dispose() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    const results = await Promise.allSettled([...this.loaded.keys()].map((id) => this.release(id)));
    this.unsubscribe.forEach((unsubscribe) => unsubscribe());
    this.listeners.clear();
    this.loaded.clear();
    this.native.clear();
    this.observed.clear();
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, 'Runtime route cleanup failed.');
  }
}
