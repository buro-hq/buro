import { DomainError, type AgentRuntime } from './ports.ts';
import type { ManagedRuntimeOptions } from './managed-runtime-options.ts';
import type { ManagedSession, ToolScope } from './model-ports.ts';
import type { ToolDefinition } from '../agent/contracts/model.ts';
import type { WorkScope } from '../protocol/work-scope.ts';
import { WorkScopeSchema } from '../protocol/work-scope.ts';
import type { Run } from '../protocol/domain.ts';
import { VerificationViewSchema } from '../protocol/verification.ts';
import { withEnvironmentRepair } from './environment-repair.ts';
import { observedTurnFailure } from './run-reconciliation.ts';
import { toolScopeInstructions } from './work-segments.ts';
import { planPathAllowed } from './execution-ports.ts';

export function managedToolRevision(options: ManagedRuntimeOptions): string {
  if (
    typeof options.tools.revision !== 'string' ||
    !options.tools.revision.trim() ||
    typeof options.tools.effect !== 'function'
  )
    throw new DomainError(
      'INVALID_TOOL_BROKER',
      'Managed tools require explicit revision and effect metadata.',
    );
  return options.tools.revision;
}
export function assertManagedToolRevision(options: ManagedRuntimeOptions, session: ManagedSession) {
  if (session.toolRevision !== managedToolRevision(options))
    throw new DomainError(
      'TOOL_CONFIGURATION_CHANGED',
      'The saved session uses another tool configuration. Restore it before continuing.',
    );
}
import { toolEffectAllowed } from './tool-contributions.ts';

function scopeFacts(scope: ToolScope) {
  return [
    scope.projectId,
    scope.runId,
    scope.ownerRunId,
    scope.sessionId,
    scope.workspace,
    scope.verificationViewId,
    scope.verificationTree,
    scope.readOnly,
    scope.baseCommit,
    WorkScopeSchema.parse(scope.writeScope),
    scope.materials,
    scope.commands.map(({ id, command, timeoutMs }) => [id, command, timeoutMs]),
  ];
}

/** Current checkpoints retain the actual service-issued instruction/scope history. */
export function assertManagedSessionProvenance(session: ManagedSession): void {
  const revisions = session.scopeRevisions;
  if (
    !Array.isArray(revisions) ||
    !revisions.length ||
    revisions.some(
      (revision, index) =>
        !revision ||
        revision.revision !== index + 1 ||
        !revision.scope ||
        typeof revision.instructions !== 'string',
    )
  )
    throw new DomainError(
      'INVALID_CHECKPOINT',
      'The managed session requires its complete issued scope revisions.',
    );
  if (
    JSON.stringify(scopeFacts(revisions.at(-1)!.scope)) !==
    JSON.stringify(scopeFacts(session.scope))
  )
    throw new DomainError(
      'INVALID_CHECKPOINT',
      'The current scope must match its last issued revision.',
    );
  const used =
    session.requests > 0 ||
    session.actions.length > 0 ||
    !!session.generation ||
    session.messages.some((message) => message.role !== 'system') ||
    Object.values(session.usage).some((value) => value > 0) ||
    !!session.workerStepChecks?.entries.length ||
    !!session.workSegments?.archives.length;
  if (used && (!Array.isArray(session.turnAuthorities) || !session.turnAuthorities.length))
    throw new DomainError(
      'INVALID_CHECKPOINT',
      'Used managed sessions require their issued turn authorities.',
    );
}

/** Derive a detached initial grant; the owning runtime alone saves/adopts it. */
export function prepareManagedSession(
  options: ManagedRuntimeOptions,
  input: Parameters<AgentRuntime['start']>[0],
  id: string,
): ManagedSession {
  const snapshot = options.projects.get(input.projectId).snapshot();
  const ownerRunId = input.ownerRunId || input.runId;
  const run = snapshot.runs.find((r) => r.id === ownerRunId);
  if (input.ownerRunId && !run)
    throw new DomainError('SESSION_MISMATCH', 'The owning run was not found.');
  if (input.purpose === 'review' && (!input.readOnly || input.assignment))
    throw new DomainError('SESSION_MISMATCH', 'Review requires a read-only service session.');
  if (
    options.budgets &&
    ownerRunId &&
    !run &&
    !['research', 'environment'].includes(input.purpose || '')
  )
    throw new DomainError('SESSION_MISMATCH', 'The owning run was not found.');
  const workspace = input.workspace || snapshot.project.root;
  const verificationView =
    run?.verificationView?.readRoot === workspace ? run.verificationView : undefined;
  const research =
    input.purpose === 'research' && snapshot.research?.id === input.runId
      ? snapshot.research
      : undefined;
  if (research && (!research.contextMaterials || !input.readOnly))
    throw new DomainError(
      'SESSION_MISMATCH',
      'Admitted research requires its frozen material selection and read-only session.',
    );
  const materials = run
    ? run.contextMaterials || []
    : research
      ? research.contextMaterials
      : (snapshot.contextMaterials || []).filter((m) => m.active && m.scope === 'project');
  const policy = run?.executionPolicySnapshot
    ? withEnvironmentRepair(run.executionPolicySnapshot, !!run.repairEnvironment)
    : undefined;
  const policyScope = WorkScopeSchema.parse(
    policy?.scope ||
      snapshot.profile?.scope || {
        mode: 'advisory',
        plannedPaths: [],
        protectedPaths: [],
      },
  );
  const writeScope = input.assignment ? WorkScopeSchema.parse(input.assignment.scope) : policyScope;
  if (input.assignment) {
    assertManagedScopeGrant(policyScope, writeScope);
  }
  const session: ManagedSession = {
    version: 1,
    id,
    runtimeId: options.id,
    limits: structuredClone(options.limits),
    providerId: options.provider.id,
    providerRevision: options.provider.revision,
    toolRevision: managedToolRevision(options),
    requestedModel: options.model,
    scopeRevisions: [],
    ...(input.purpose ? { purpose: input.purpose } : {}),
    scope: {
      projectId: input.projectId,
      runId: input.runId,
      ownerRunId: run?.id || input.ownerRunId,
      sessionId: input.assignment?.sessionId || id,
      workspace,
      ...(verificationView
        ? {
            verificationViewId: verificationView.id,
            verificationTree: verificationView.tree,
          }
        : {}),
      readOnly: !!input.readOnly,
      writeScope: structuredClone(writeScope),
      materials: materials
        .flatMap((m) => [m.relativePath, ...(m.textPath ? [m.textPath] : [])])
        .map(
          (file) =>
            '.buro/' + (workspace === snapshot.project.root ? file : file.replace(/^local\//, '')),
        ),
      commands: structuredClone(
        (run?.executionPolicySnapshot?.profile || snapshot.profile)?.checks || [],
      ),
      baseCommit: run?.baseCommit,
    },
    messages: [
      {
        role: 'system',
        content:
          input.instructions +
          '\n' +
          toolScopeInstructions({ readOnly: !!input.readOnly, writeScope }),
      },
    ],
    status: 'ready',
    requests: 0,
    usage: { requestsWithUsage: 0, inputTokens: 0, outputTokens: 0 },
    actions: [],
    ...(input.assignment
      ? {
          assignment: {
            roleId: input.assignment.roleId,
            scope: WorkScopeSchema.parse(input.assignment.scope),
          },
        }
      : {}),
  };
  if (run) assertManagedRunWorkspace(run, session);
  session.scopeRevisions = [
    { revision: 1, scope: structuredClone(session.scope), instructions: input.instructions },
  ];
  return session;
}

/** Explicit continuation derives a new revision without mutating the durable checkpoint. */
export function prepareManagedResume(
  options: ManagedRuntimeOptions,
  session: ManagedSession,
  input: Parameters<NonNullable<AgentRuntime['resume']>>[0],
): ManagedSession {
  assertManagedSessionProvenance(session);
  if (
    session.scope.projectId !== input.projectId ||
    session.scope.workspace !== input.workspace ||
    session.scope.runId !== input.runId ||
    (session.scope.ownerRunId || session.scope.runId) !== (input.ownerRunId || input.runId)
  )
    throw new DomainError(
      'SESSION_MISMATCH',
      'The checkpoint belongs to another project, run or workspace.',
    );
  assertManagedReconciled(session);
  assertManagedToolRevision(options, session);
  const next = structuredClone(session);
  const snapshot = options.projects.get(input.projectId).snapshot();
  const ownerRunId = input.ownerRunId || session.scope.ownerRunId || input.runId;
  const run = snapshot.runs.find((r) => r.id === ownerRunId);
  if ((session.scope.ownerRunId || input.ownerRunId) && !run)
    throw new DomainError('SESSION_MISMATCH', 'The owning run was not found.');
  if (run) assertManagedRunWorkspace(run, session);
  if (run?.baseCommit && session.scope.baseCommit && run.baseCommit !== session.scope.baseCommit)
    throw new DomainError('SESSION_MISMATCH', 'The owning run uses another Git base.');
  const scope: ToolScope = structuredClone(session.scope);
  const policy = run?.executionPolicySnapshot
    ? withEnvironmentRepair(run.executionPolicySnapshot, !!run.repairEnvironment)
    : undefined;
  const assignmentBound = !!session.assignment || session.scope.sessionId !== session.id;
  if (policy) {
    // Explicit resume adopts the saved owning policy revision. Role paths remain the plan,
    // but advisory mode never carries an old hidden allowlist into the new context.
    const revised = WorkScopeSchema.parse({
      ...policy.scope,
      plannedPaths: assignmentBound
        ? session.assignment?.scope.plannedPaths || session.scope.writeScope.plannedPaths
        : policy.scope.plannedPaths,
    });
    assertManagedScopeGrant(policy.scope, revised);
    scope.writeScope = revised;
    scope.commands = structuredClone(policy.profile?.checks || []);
  }
  const research =
    session.purpose === 'research' && snapshot.research?.id === input.runId
      ? snapshot.research
      : undefined;
  if (research && !research.contextMaterials)
    throw new DomainError(
      'SESSION_MISMATCH',
      'The admitted research has no frozen material selection.',
    );
  const materials = run
    ? run.contextMaterials || []
    : session.purpose === 'research'
      ? research?.contextMaterials
      : (snapshot.contextMaterials || []).filter((m) => m.active && m.scope === 'project');
  if (materials !== undefined)
    scope.materials = materials
      .flatMap((material) => [
        material.relativePath,
        ...(material.textPath ? [material.textPath] : []),
      ])
      .map(
        (file) =>
          '.buro/' +
          (scope.workspace === snapshot.project.root ? file : file.replace(/^local\//, '')),
      );
  scope.ownerRunId = run?.id || session.scope.ownerRunId;
  scope.baseCommit = run?.baseCommit || session.scope.baseCommit;
  next.scopeRevisions.push({
    revision: next.scopeRevisions.length + 1,
    scope: structuredClone(scope),
    instructions: input.instructions,
  });
  next.scope = scope;
  next.messages.push({
    role: 'system',
    content:
      'Updated instructions for continuing saved work:\n' +
      input.instructions +
      '\n' +
      toolScopeInstructions(scope),
  });
  next.cancelRequested = false;
  next.status = 'ready';
  return next;
}

export function managedToolDefinitions(
  options: ManagedRuntimeOptions,
  scope: ToolScope,
): ToolDefinition[] {
  return options.tools
    .definitions(structuredClone(scope))
    .filter((definition) => toolEffectAllowed(options.tools.effect(definition.name), scope));
}
export function assertManagedScopeGrant(policy: WorkScope, assigned: WorkScope) {
  const protections = (scope: WorkScope) =>
    JSON.stringify([...new Set(scope.protectedPaths)].sort());
  if (
    policy.mode !== assigned.mode ||
    protections(policy) !== protections(assigned) ||
    assigned.plannedPaths.some((file) => !planPathAllowed(file, policy))
  )
    throw observedTurnFailure(
      new DomainError(
        'SESSION_SCOPE_CHANGED',
        'The assignment no longer matches its owning write policy. Revise the assignment before continuing.',
      ),
    );
}
export function assertManagedRunWorkspace(
  run: Run,
  session: Pick<ManagedSession, 'purpose' | 'scope' | 'assignment'>,
) {
  const scope = session.scope;
  if (scope.verificationViewId || scope.verificationTree) {
    const parsed = VerificationViewSchema.safeParse(run.verificationView);
    if (!parsed.success || session.purpose !== 'review' || !scope.readOnly || session.assignment)
      throw new DomainError(
        'SESSION_MISMATCH',
        'Only a read-only service reviewer can use an issued verification view.',
      );
    const view = parsed.data;
    if (
      view.id !== scope.verificationViewId ||
      view.tree !== scope.verificationTree ||
      view.projectId !== scope.projectId ||
      view.runId !== run.id ||
      view.readRoot !== scope.workspace ||
      view.sourceWorkspace !== run.workspace ||
      view.base !== run.baseCommit ||
      view.base !== scope.baseCommit
    )
      throw new DomainError(
        'SESSION_MISMATCH',
        'The saved verification view is unavailable or changed.',
      );
    return;
  }
  if (
    (run.workspace && run.workspace !== scope.workspace) ||
    (session.purpose === 'review' && run.verificationView)
  )
    throw new DomainError(
      'SESSION_MISMATCH',
      'The owning run uses another workspace or active verification view.',
    );
}
export function assertManagedCurrentWorkspace(
  options: ManagedRuntimeOptions,
  session: ManagedSession,
) {
  const owner = session.scope.ownerRunId || session.scope.runId;
  const run = options.projects
    .get(session.scope.projectId)
    .snapshot()
    .runs.find((run) => run.id === owner);
  if (run) assertManagedRunWorkspace(run, session);
  else if (session.scope.verificationViewId || session.scope.verificationTree)
    throw new DomainError('SESSION_MISMATCH', 'The owning verification run was not found.');
}
export function managedBudgetOwner(options: ManagedRuntimeOptions, session: ManagedSession) {
  const scope = session.scope;
  const ownerRunId = scope.ownerRunId || scope.runId;
  if (!ownerRunId) return undefined;
  const run = options.projects
    .get(scope.projectId)
    .snapshot()
    .runs.find((run) => run.id === ownerRunId);
  if (!run) {
    if (!scope.ownerRunId && ['research', 'environment'].includes(session.purpose || ''))
      return undefined;
    throw new DomainError('SESSION_MISMATCH', 'The owning run was not found.');
  }
  assertManagedRunWorkspace(run, session);
  return { projectId: scope.projectId, ownerRunId };
}
export function assertManagedReconciled(session: ManagedSession) {
  if (session.workerStepChecks?.entries.some((entry) => entry.status !== 'completed'))
    throw new DomainError(
      'WORKER_CHECK_RECONCILIATION_REQUIRED',
      'A saved service check has an unknown outcome. It cannot be automatically repeated.',
    );
  if (session.generation && session.generation.outcome !== 'completed')
    throw new DomainError(
      'GENERATION_RECONCILIATION_REQUIRED',
      'A saved model generation has an unknown outcome. It cannot be automatically repeated.',
    );
  if (session.actions.some((action) => action.status !== 'completed'))
    throw new DomainError(
      'ACTION_RECONCILIATION_REQUIRED',
      'A saved tool action has an unknown outcome. It cannot be automatically repeated.',
    );
}
