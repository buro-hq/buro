import {
  operationIds,
  serviceOperationContext,
  savedOperationContext,
  type ServiceOperation,
} from './operation-catalog.ts';
import type { Run, Snapshot, Role } from '../protocol/domain.ts';
import type {
  RuntimeResource,
  AssignmentResource,
  ResourceSnapshot,
} from '../protocol/resources.ts';
import { validateRoleResource } from './role-routing.ts';
import { resourceForPurpose } from '../protocol/resources.ts';
import { WorkScopeSchema } from '../protocol/work-scope.ts';
import { planPathAllowed } from './execution-ports.ts';
import { withEnvironmentRepair } from './environment-repair.ts';
import { validateAssignmentResource } from './assignment-routing.ts';
import { assertBackendAdmission, requireBackendCapabilities } from './backend-capabilities.ts';
import type { BackendRequirements } from '../agent/contracts/capabilities.ts';
import type { RuntimePurpose } from '../protocol/resources.ts';
import { observedTurnFailure } from './run-reconciliation.ts';
import {
  DomainError,
  type AgentRuntime,
  type ProjectRegistry,
  type RuntimeEvent,
  type RuntimeRegistry,
  type RuntimeSelection,
  type RegisteredRuntime,
} from './ports.ts';

export type RuntimeRoute = {
  id: string;
  projectId: string;
  runId?: string;
  ownerRunId?: string;
  workspace?: string;
  resource: RuntimeResource;
  requirements: BackendRequirements;
  readOnly?: boolean;
  purpose?: RuntimePurpose;
  roleId?: string;
  operationId?: string;
  roleDecision?: AssignmentResource;
  roleGrant?: { role: Role; resources: ResourceSnapshot };
  verificationViewId?: string;
  externalThreadId?: string;
  status: 'starting' | 'ready' | 'unknown' | 'rejected';
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
    resolveRuntime?: (resource: RuntimeResource) => RegisteredRuntime | undefined;
    routes: RuntimeRouteStore;
    id: () => string;
  };
  private loaded = new Map<string, RuntimeRoute>();
  private native = new Map<string, string>();
  private observed = new Map<string, { id: string; runId: string; parentThreadId: string }>();
  /** Cleanup and stop retain the original process-local ownership, not a new execution grant. */
  private leases = new Map<
    string,
    { runtime: RegisteredRuntime; threadId: string; releasing?: Promise<void> }
  >();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private unsubscribe: (() => void)[] = [];
  private subscribed = new WeakSet<RegisteredRuntime>();
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  constructor(options: RuntimeRouter['options']) {
    this.options = options;
    for (const id of options.resolveRuntime ? [] : options.registry.list()) {
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
  private operationContext(
    input: { operationId?: string; purpose?: RuntimePurpose; readOnly?: boolean; roleId?: string },
    snapshot: Snapshot,
    owner?: Run,
  ): ServiceOperation | undefined {
    const defaultIds: Partial<Record<RuntimePurpose, string>> = {
      coordination: operationIds.coordination,
      implementation: operationIds.implementation,
      review: operationIds.review,
      research: operationIds.research,
      environment: operationIds.environment,
    };
    const id = input.operationId || (input.purpose ? defaultIds[input.purpose] : undefined);
    if (!id) {
      if (input.purpose === 'delivery')
        throw new DomainError(
          'OPERATION_REQUIRED',
          'Result preparation requires its explicit service operation.',
        );
      return undefined;
    }
    const profile = owner?.executionPolicySnapshot?.profile || snapshot.profile;
    const boundProfile =
      profile && owner?.delivery?.config
        ? { ...profile, delivery: owner.delivery.config }
        : profile;
    const scope =
      owner?.executionPolicySnapshot?.scope ||
      snapshot.profile?.scope ||
      snapshot.executionPolicy?.scope;
    const operation =
      savedOperationContext(owner, id) ||
      serviceOperationContext(id, boundProfile, scope?.mode === 'strict');
    if (operation.purpose === 'delivery' && !input.roleId)
      throw new DomainError(
        'INVALID_ASSIGNMENT',
        'Result preparation requires its explicit saved role identity.',
      );
    if (
      input.purpose !== operation.purpose ||
      (operation.readOnly && !input.readOnly) ||
      (input.roleId && operation.roles.kind === 'fixed' && input.roleId !== operation.roles.roleId)
    )
      throw new DomainError(
        'INVALID_ASSIGNMENT',
        'The requested session does not match its service operation.',
      );
    return operation;
  }
  private serviceDecision(
    owner: Run | undefined,
    operation: ServiceOperation | undefined,
    roleId: string,
  ) {
    if (!owner || !operation) return undefined;
    const explicit = owner.operationResources?.[operation.id]?.[roleId];
    if (explicit) return explicit;
    if (operation.id === operationIds.review && owner.verificationEvidence?.reviewerResource)
      return owner.verificationEvidence.reviewerResource;
    if (operation.id === operationIds.coordination || operation.id === operationIds.review)
      return owner.roleResources?.[roleId];
    return undefined;
  }
  private adapter(route: RuntimeRoute) {
    if (!route.requirements)
      throw new DomainError(
        'SESSION_MISMATCH',
        'The saved route has no explicit admission requirements.',
      );
    const current = this.options.resources.find((resource) => resource.id === route.resource.id);
    const identity = (resource: RuntimeResource) =>
      JSON.stringify([
        resource.id,
        resource.backendId,
        resource.providerId,
        resource.model,
        resource.configurationRevision,
        resource.local,
      ]);
    const retained = this.options.resolveRuntime?.(route.resource);
    if (!retained && (!current || identity(current) !== identity(route.resource)))
      throw new DomainError(
        'RUNTIME_CONFIG_CHANGED',
        'The saved runtime configuration is unavailable. Restore it or start a new attempt.',
      );
    const runtime = retained || this.options.registry.get(route.resource.id);
    if (this.options.resolveRuntime && !this.subscribed.has(runtime)) {
      const unsubscribe = runtime.subscribe?.((event) => this.relay(route.resource.id, event));
      if (unsubscribe) this.unsubscribe.push(unsubscribe);
      this.subscribed.add(runtime);
    }
    assertBackendAdmission(retained ? route.resource : current!, runtime, route.requirements);
    assertBackendAdmission(route.resource, runtime, route.requirements);
    const snapshot = this.options.projects.get(route.projectId).snapshot();
    const research =
      route.purpose === 'research' && snapshot.research?.id === route.runId
        ? snapshot.research
        : undefined;
    const owner = snapshot.runs.find((run) => run.id === (route.ownerRunId || route.runId));
    const scope =
      owner?.executionPolicySnapshot?.scope ||
      snapshot.profile?.scope ||
      snapshot.executionPolicy?.scope;
    if (!route.readOnly && scope?.mode === 'strict')
      requireBackendCapabilities(runtime.capabilities, { strictPlannedWrites: true });
    const operation = this.operationContext(route, snapshot, owner);
    if (
      operation &&
      Object.entries(operation.requirements).some(
        ([key, value]) => value && !route.requirements[key as keyof BackendRequirements],
      )
    )
      throw new DomainError(
        'INVALID_ASSIGNMENT',
        'The saved route lost its operation requirements.',
      );
    const researchGrant = route.purpose === 'research' ? route.roleGrant : undefined;
    if (route.purpose === 'research' && (research || route.roleDecision) && !researchGrant)
      throw new DomainError('INVALID_ASSIGNMENT', 'The research route has no original role grant.');
    if (researchGrant) {
      if (
        !operation ||
        operation.roles.kind !== 'fixed' ||
        !route.roleDecision ||
        route.roleId !== researchGrant.role.id ||
        operation.roles.roleId !== researchGrant.role.id
      )
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'The research route has no captured role decision.',
        );
      const saved = validateRoleResource(
        researchGrant.resources,
        researchGrant.role,
        route.roleDecision,
        operation,
      );
      const authority = (value: AssignmentResource) =>
        JSON.stringify([value.resource, value.roleVersion, value.preference, value.source]);
      if (JSON.stringify(saved.resource) !== JSON.stringify(route.resource))
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'The research route differs from its original grant.',
        );
      if (research) {
        if (
          !research.roleSnapshot ||
          !research.roleResource ||
          JSON.stringify(research.roleSnapshot) !== JSON.stringify(researchGrant.role) ||
          JSON.stringify(research.resources) !== JSON.stringify(researchGrant.resources)
        )
          throw new DomainError('INVALID_ASSIGNMENT', 'The admitted research role grant changed.');
        const current = validateRoleResource(
          research.resources,
          research.roleSnapshot,
          research.roleResource,
          operation,
        );
        if (authority(current) !== authority(saved))
          throw new DomainError(
            'INVALID_ASSIGNMENT',
            'The admitted research resource decision changed.',
          );
      }
    }
    const serviceRoleId =
      route.roleId || (operation?.roles.kind === 'fixed' ? operation.roles.roleId : undefined);
    const decision = serviceRoleId
      ? this.serviceDecision(owner, operation, serviceRoleId)
      : undefined;
    if (
      !researchGrant &&
      serviceRoleId &&
      (route.roleDecision || decision || (owner && operation?.roles.kind === 'fixed'))
    ) {
      const role = owner?.roleSnapshots?.find(
        (item) => item.id === serviceRoleId && item.version === decision?.roleVersion,
      );
      if (!decision || !route.roleDecision || !role || !owner?.resources || !operation)
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'The saved service operation resource grant is unavailable.',
        );
      const saved = validateRoleResource(owner.resources, role, route.roleDecision, operation);
      const current = validateRoleResource(owner.resources, role, decision, operation);
      const identity = (value: AssignmentResource) =>
        JSON.stringify([value.resource, value.roleVersion, value.preference, value.source]);
      if (
        identity(saved) !== identity(current) ||
        JSON.stringify(saved.resource) !== JSON.stringify(route.resource)
      )
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'The service operation grant changed after this session started.',
        );
    }
    if (route.requirements.immutableReview) {
      const run = this.options.projects
        .get(route.projectId)
        .snapshot()
        .runs.find((item) => item.id === (route.ownerRunId || route.runId));
      const view = run?.verificationView;
      if (
        !view ||
        view.id !== route.verificationViewId ||
        view.readRoot !== route.workspace ||
        view.sourceWorkspace !== run?.workspace ||
        view.base !== run?.baseCommit ||
        view.runId !== run?.id ||
        view.projectId !== route.projectId
      )
        throw new DomainError(
          'VERIFICATION_VIEW_CHANGED',
          'The saved immutable review input is no longer active.',
        );
    }
    return runtime;
  }
  private assertOpen() {
    if (this.closed) throw new DomainError('RUNTIME_CLOSED', 'The runtime router stopped.');
  }
  private async preflight<T>(check: () => T | Promise<T>): Promise<T> {
    try {
      return await check();
    } catch (error) {
      throw observedTurnFailure(error);
    }
  }
  private async route(id: string) {
    this.assertOpen();
    const route = this.loaded.get(id) || (await this.options.routes.load(id));
    if (!route) throw new DomainError('THREAD_NOT_FOUND', 'Saved runtime route not found.');
    if (route.status === 'rejected')
      throw new DomainError(
        'SESSION_START_REJECTED',
        'The backend session was not dispatched because its admission changed.',
      );
    if (route.status !== 'ready' || !route.externalThreadId)
      throw new DomainError(
        'SESSION_RECONCILIATION_REQUIRED',
        'The client start outcome is unknown; it will not be repeated automatically.',
      );
    this.adapter(route);
    if (!this.leases.has(id))
      throw new DomainError(
        'THREAD_NOT_FOUND',
        'Resume the saved session before dispatching another turn.',
      );
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
  async canRetry(threadId: string) {
    this.assertOpen();
    const route = this.loaded.get(threadId) || (await this.options.routes.load(threadId));
    if (!route || route.status !== 'ready' || !route.externalThreadId) return false;
    const runtime = this.adapter(route);
    return runtime.capabilities.hostToolLifecycle && runtime.canRetry
      ? runtime.canRetry(route.externalThreadId)
      : false;
  }
  start(input: Parameters<AgentRuntime['start']>[0]) {
    return this.operation(() => this.startSession(input));
  }
  private async startSession(input: Parameters<AgentRuntime['start']>[0]) {
    const dispatch = structuredClone(input);
    const { route, runtime: selected } = await this.preflight(() => this.prepareStart(dispatch));
    let runtime = selected;
    await this.options.routes.save(route);
    try {
      this.assertOpen();
      runtime = this.adapter(route);
    } catch (error) {
      route.status = 'rejected';
      await this.options.routes.save(route);
      throw observedTurnFailure(error);
    }
    try {
      const started = await runtime.start({ ...dispatch, workspace: route.workspace });
      route.externalThreadId = started.threadId;
      this.assertOpen();
      route.status = 'ready';
      await this.options.routes.save(route);
      this.assertOpen();
      this.bind(route);
      this.leases.set(route.id, { runtime, threadId: started.threadId });
      return { threadId: route.id };
    } catch (error) {
      route.status = 'unknown';
      await this.options.routes.save(route).catch(() => {});
      if (route.externalThreadId) await runtime.release?.(route.externalThreadId);
      throw error;
    }
  }
  private prepareStart(input: Parameters<AgentRuntime['start']>[0]) {
    this.assertOpen();
    if (input.purpose === 'review' && !input.readOnly)
      throw new DomainError(
        'BACKEND_CAPABILITY_UNAVAILABLE',
        'Review requires a read-only session.',
      );
    if (input.assignment && input.roleId && input.roleId !== input.assignment.roleId)
      throw new DomainError(
        'INVALID_ASSIGNMENT',
        'The requested role does not match its worker assignment.',
      );
    const snapshot = this.options.projects.get(input.projectId).snapshot();
    const run = snapshot.runs.find((r) => r.id === (input.ownerRunId || input.runId));
    if (input.assignment && !run)
      throw new DomainError(
        'INVALID_ASSIGNMENT',
        'A worker assignment requires its saved owning run.',
      );
    if (input.ownerRunId && !run)
      throw new DomainError('NOT_FOUND', 'The owning run is unavailable.');
    const research =
      input.purpose === 'research' && snapshot.research?.id === input.runId
        ? snapshot.research
        : undefined;
    if (research && !research.resources)
      throw new DomainError(
        'RESOURCE_PROFILE_UNAVAILABLE',
        'The admitted research has no frozen resource profile.',
      );
    const selection =
      research?.resources || run?.resources || this.options.selection.forProject(input.projectId);
    let resource = resourceForPurpose(selection, input.purpose);
    const policyScope =
      run?.executionPolicySnapshot?.scope ||
      snapshot.profile?.scope ||
      snapshot.executionPolicy?.scope;
    const operation = this.operationContext(input, snapshot, run);
    const serviceRoleId = !input.assignment
      ? input.roleId || (operation?.roles.kind === 'fixed' ? operation.roles.roleId : undefined)
      : undefined;
    let serviceDecision: AssignmentResource | undefined;
    if (research) {
      if (
        !operation ||
        operation.roles.kind !== 'fixed' ||
        !research.roleSnapshot ||
        !research.roleResource ||
        input.roleId !== research.roleSnapshot.id ||
        operation.roles.roleId !== research.roleSnapshot.id
      )
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'Research dispatch requires its captured role and resource decision.',
        );
      serviceDecision = validateRoleResource(
        research.resources,
        research.roleSnapshot,
        research.roleResource,
        operation,
      );
      resource = serviceDecision.resource;
    }
    if (
      !research &&
      serviceRoleId &&
      (input.roleId ||
        this.serviceDecision(run, operation, serviceRoleId) ||
        (run && operation?.roles.kind === 'fixed'))
    ) {
      const decision = this.serviceDecision(run, operation, serviceRoleId);
      const role = run?.roleSnapshots?.find(
        (item) => item.id === serviceRoleId && item.version === decision?.roleVersion,
      );
      if (!run?.resources || !decision || !role || !operation)
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'Service operation dispatch requires its frozen role and resource decision.',
        );
      serviceDecision = validateRoleResource(run.resources, role, decision, operation);
      resource = serviceDecision.resource;
    }
    if (
      run &&
      (run.assignmentResources !== undefined || run.resources?.workerPool !== undefined) &&
      (input.purpose === 'implementation' || input.assignment)
    ) {
      const assignment = input.assignment;
      const decision = assignment && run.assignmentResources?.[assignment.roleId];
      const agent =
        assignment && run.agents.find((item) => item.session?.id === assignment.sessionId);
      const role = assignment && run.roleSnapshots?.find((item) => item.id === assignment.roleId);
      const policyScope = WorkScopeSchema.safeParse(
        run.executionPolicySnapshot
          ? withEnvironmentRepair(run.executionPolicySnapshot, !!run.repairEnvironment).scope
          : undefined,
      );
      const assignedScope = WorkScopeSchema.safeParse(assignment?.scope);
      if (
        input.purpose !== 'implementation' ||
        !assignment ||
        !decision ||
        !agent?.session ||
        !role ||
        !run.resources ||
        !policyScope.success ||
        !assignedScope.success ||
        assignedScope.data.mode !== policyScope.data.mode ||
        assignedScope.data.plannedPaths.some((path) => !planPathAllowed(path, policyScope.data)) ||
        JSON.stringify([...assignedScope.data.protectedPaths].sort()) !==
          JSON.stringify([...policyScope.data.protectedPaths].sort()) ||
        run.status !== 'running' ||
        run.cancelRequested ||
        agent.status !== 'starting' ||
        agent.threadId !== assignment.sessionId ||
        agent.session.roleId !== assignment.roleId ||
        agent.session.roleVersion !== role.version ||
        JSON.stringify([...(agent.assignment?.paths || [])].sort()) !==
          JSON.stringify([...assignedScope.data.plannedPaths].sort()) ||
        JSON.stringify([...(run.roleAssignments?.[assignment.roleId] || [])].sort()) !==
          JSON.stringify([...assignedScope.data.plannedPaths].sort())
      )
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'Worker dispatch requires its saved role, scope and session intent.',
        );
      const validated = validateAssignmentResource(
        run.resources,
        role,
        decision,
        assignedScope.data.mode === 'strict' ? { strictPlannedWrites: true } : {},
      );
      const session = agent.session;
      if (
        session.runtimeId !== validated.resource.id ||
        session.providerId !== validated.resource.providerId ||
        session.model !== validated.resource.model ||
        session.configurationRevision !== validated.resource.configurationRevision ||
        session.selection?.source !== validated.source ||
        session.selection?.reason !== validated.reason
      )
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'The saved session does not match its resource decision.',
        );
      resource = validated.resource;
    }
    if (selection.policy === 'local-only' && !resource.local)
      throw new DomainError(
        'DATA_POLICY_BLOCKED',
        'A local-only session cannot use a remote runtime.',
      );
    const verification = run?.verificationView;
    if (input.readOnly && verification && verification.readRoot !== input.workspace)
      throw new DomainError(
        'VERIFICATION_VIEW_CHANGED',
        'Review must use its active immutable input.',
      );
    const immutableReview = !!input.readOnly && !!verification;
    const route: RuntimeRoute = {
      id: 'B-' + this.options.id(),
      projectId: input.projectId,
      runId: input.runId,
      ownerRunId: input.ownerRunId,
      workspace: input.workspace || snapshot.project.root,
      resource: structuredClone(resource),
      requirements: {
        ...operation?.requirements,
        ...(input.readOnly ? { readOnlySessions: true } : {}),
        ...(immutableReview ? { immutableReview: true } : {}),
        ...(!input.readOnly &&
        (
          run?.executionPolicySnapshot?.scope ||
          snapshot.profile?.scope ||
          snapshot.executionPolicy?.scope
        )?.mode === 'strict'
          ? { strictPlannedWrites: true }
          : {}),
      },
      ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(operation ? { operationId: operation.id } : {}),
      ...(serviceDecision
        ? { roleId: serviceRoleId, roleDecision: structuredClone(serviceDecision) }
        : {}),
      ...(research
        ? {
            roleGrant: {
              role: structuredClone(research.roleSnapshot),
              resources: structuredClone(research.resources),
            },
          }
        : {}),
      ...(immutableReview && verification ? { verificationViewId: verification.id } : {}),
      status: 'starting',
    };
    // Pure configuration/capability admission precedes the durable dispatch intent.
    const runtime = this.adapter(route);
    return { route, runtime };
  }
  resume(input: Parameters<NonNullable<AgentRuntime['resume']>>[0]) {
    return this.operation(() => this.resumeSession(input));
  }
  private async resumeSession(input: Parameters<NonNullable<AgentRuntime['resume']>>[0]) {
    const dispatch = structuredClone(input);
    const { saved, adapter } = await this.preflight(() => this.prepareResume(dispatch));
    const resumed = await adapter.resume!({
      ...dispatch,
      threadId: saved.externalThreadId!,
      readOnly: saved.readOnly,
      purpose: saved.purpose,
      roleId: saved.roleId,
      operationId: saved.operationId,
    });
    if (this.closed) {
      await adapter.release?.(resumed.threadId);
      this.assertOpen();
    }
    if (resumed.threadId !== saved.externalThreadId)
      throw new DomainError('SESSION_MISMATCH', 'The client resumed a different session.');
    this.bind(saved);
    this.leases.set(saved.id, { runtime: adapter, threadId: resumed.threadId });
    return { threadId: saved.id };
  }
  private async prepareResume(input: Parameters<NonNullable<AgentRuntime['resume']>>[0]) {
    this.assertOpen();
    const saved =
      this.loaded.get(input.threadId) || (await this.options.routes.load(input.threadId));
    if (!saved) throw new DomainError('THREAD_NOT_FOUND', 'Saved runtime route not found.');
    if (
      saved.projectId !== input.projectId ||
      saved.runId !== input.runId ||
      saved.workspace !== input.workspace ||
      saved.ownerRunId !== input.ownerRunId ||
      (input.roleId !== undefined && saved.roleId !== input.roleId) ||
      (input.operationId !== undefined && saved.operationId !== input.operationId)
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
    assertBackendAdmission(saved.resource, adapter, {
      ...saved.requirements,
      resumeSessions: true,
    });
    if (!adapter.resume)
      throw new DomainError(
        'RESUME_UNSUPPORTED',
        'This runtime does not support saved-session continuation.',
      );
    return { saved, adapter };
  }
  async submit(id: string, text: string) {
    const { route, runtime } = await this.preflight(async () => {
      const route = await this.route(id);
      return { route, runtime: this.adapter(route) };
    });
    return runtime.submit(route.externalThreadId!, text);
  }
  async turn(id: string, text: string, options: Parameters<NonNullable<AgentRuntime['turn']>>[2]) {
    const { route, runtime } = await this.preflight(async () => {
      const route = await this.route(id),
        runtime = this.adapter(route);
      assertBackendAdmission(route.resource, runtime, {
        ...route.requirements,
        structuredTurns: true,
        ...(options.toolPolicy === 'none' ? { toolsFreeTurns: true } : {}),
      });
      if (!runtime.turn)
        throw new DomainError(
          'TURN_UNSUPPORTED',
          'This runtime cannot complete a structured turn.',
        );
      return { route, runtime };
    });
    return runtime.turn!(route.externalThreadId!, text, options);
  }
  async interrupt(id: string, turnId: string) {
    const lease = await this.preflight(() => {
      this.assertOpen();
      const owned = this.leases.get(id);
      if (!owned)
        throw new DomainError('THREAD_NOT_FOUND', 'Resume the saved session before stopping it.');
      requireBackendCapabilities(owned.runtime.capabilities, {
        cancellation: 'settled-or-unknown',
      });
      return owned;
    });
    return lease.runtime.interrupt(lease.threadId, turnId);
  }
  async release(id: string) {
    const lease = this.leases.get(id);
    if (!lease) return;
    if (lease.releasing) return lease.releasing;
    const releasing = Promise.resolve().then(async () => {
      await lease.runtime.release?.(lease.threadId);
      if (this.leases.get(id) !== lease) return;
      this.leases.delete(id);
      this.loaded.delete(id);
      for (const [key, mapped] of this.native) if (mapped === id) this.native.delete(key);
      for (const [key, observed] of this.observed)
        if (observed.parentThreadId === id) this.observed.delete(key);
    });
    lease.releasing = releasing;
    try {
      await releasing;
    } finally {
      lease.releasing = undefined;
    }
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
        this.observed.set(key, { id, runId: event.runId, parentThreadId });
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
    const results = await Promise.allSettled([...this.leases.keys()].map((id) => this.release(id)));
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
