import type { RunAttemptStop } from '../protocol/run-attempt.ts';
import type { ExecutionActionCatalog } from './execution-actions.ts';
import { runGoalOrchestration } from './goal-orchestration.ts';
import { validateProjectRole } from './project-entities.ts';
import { executionPolicy as savedExecutionPolicy } from './project-settings.ts';
import type { ExecutionPhase } from './project-runs.ts';
import { runWorkerAssignments } from './worker-assignments.ts';
import { ManagedBudgetErrorCodeSchema } from '../protocol/run-budget.ts';
import { sessionResource } from '../protocol/resources.ts';
import { operationIds } from './operation-catalog.ts';
import type { WorkflowRoleResolver } from './workflow-roles.ts';
import { projectRunAutonomy } from './autonomy-policy.ts';
import { recordableRuntimeEvent } from './runtime-events.ts';
import { applyRuntimeEvent } from './runtime-projection.ts';
import { checkContext, changeContext } from './agent-context.ts';
import type { ExecutionEnvironmentPort } from './environment-ports.ts';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../protocol/domain.ts';
import { materialInstructions } from '../protocol/context.ts';
import type { Run, Role, Goal, DomainEvent } from '../protocol/domain.ts';
import {
  DomainError,
  type AgentRuntime,
  type ProjectRegistry,
  type RuntimeEvent,
  type RuntimeSelection,
  type ProjectDocument,
} from './ports.ts';
import {
  writeAllowed,
  matchesPlannedPath,
  terminal,
  type ExecutionPolicy,
  type WorkspacePort,
  type CheckPort,
} from './execution-ports.ts';
import { withEnvironmentRepair, dependencyManifestPreserved } from './environment-repair.ts';
import { canAccept } from './services.ts';
import { sameWorkspaceRevision, type WorkspaceRevision } from './workspace-revision.ts';
import { canonicalOutputPaths, type VerificationView } from './verification-view.ts';
import {
  assertRunReconciled,
  isKnownTurnRejection,
  reconciliationForError,
  reconciliationForPendingTurn,
  reconciliationIssue,
  retainRunReconciliation,
} from './run-reconciliation.ts';
import { EnvelopeSchema, ReviewSchema, reviewOutputSchema } from '../protocol/execution.ts';

type Environment = {
  actions: ExecutionActionCatalog;
  environments?: ExecutionEnvironmentPort;
  projects: ProjectRegistry;
  runtime: AgentRuntime;
  workflowRoles: WorkflowRoleResolver;
  selection?: RuntimeSelection;
  workspaces: WorkspacePort;
  checks: CheckPort;
  policies: Record<string, ExecutionPolicy>;
  now: () => string;
  id: () => string;
  onCompleted?: (projectId: string, runId: string) => void;
};
export type ExecutionContext = {
  projectId: string;
  runId: string;
  workspace: { path: string; base: string };
  policy: ExecutionPolicy;
  signal: AbortSignal;
  threads: string[];
  attemptId?: string;
};
/** An issued check handle is valid only in the execution service that performed the checks. */
export type CheckedRun = Awaited<ReturnType<ExecutionService['verify']>>;
function runCommandResult(value: unknown): { runId: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 1 ||
    !Object.hasOwn(value, 'runId') ||
    typeof (value as { runId?: unknown }).runId !== 'string' ||
    !(value as { runId: string }).runId.length
  )
    throw new DomainError('INVALID_RUN_RECEIPT', 'The command receipt is not a run admission.');
  return { runId: (value as { runId: string }).runId };
}
/** The coordinator chooses work; this service bounds effects, ownership and acceptance. */
export class ExecutionService {
  env: Environment;
  jobs = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; attemptId?: string }
  >();
  private executionOwners = new Map<string, string>();
  closing = false;
  unsubscribe: () => void;
  eventQueue: Promise<unknown> = Promise.resolve();
  seen = new Set<string>();
  private verificationViews = new Map<string, VerificationView>();
  private checkedRuns = new WeakMap<
    CheckedRun,
    {
      projectId: string;
      runId: string;
      attemptId?: string;
      result: CheckedRun;
      review?: { sessionId: string; result: ReturnType<typeof ReviewSchema.parse> };
    }
  >();
  constructor(env: Environment) {
    env.actions.assertSealed();
    if (!env.workflowRoles || typeof env.workflowRoles.ensureRole !== 'function')
      throw new DomainError(
        'WORKFLOW_REQUIRED',
        'Configure a workflow role resolver before execution.',
      );
    this.env = env;
    this.unsubscribe =
      env.runtime.subscribe?.((event) => {
        if (!recordableRuntimeEvent(event)) return;
        this.eventQueue = this.eventQueue.then(() => this.observe(event)).catch(() => {});
      }) || (() => {});
  }
  policy(projectId: string) {
    const p = Object.hasOwn(this.env.policies, projectId)
      ? this.env.policies[projectId]
      : undefined;
    if (!p)
      throw new DomainError('EXECUTION_DISABLED', 'Execution is not configured for this project.');
    return p;
  }
  assertActionCatalog(run: Run) {
    if (run.workflow?.actionsRevision !== this.env.actions.revision)
      throw new DomainError(
        'EXECUTION_ACTIONS_CHANGED',
        'The admitted action catalog is unavailable. Restore the configured contributions.',
      );
  }
  private assertManagedBudgetOpen(run: Run) {
    if (run.managedBudget?.status === 'exceeded')
      throw new DomainError(
        'RUN_BUDGET_USAGE_EXCEEDED',
        'The managed run budget is blocked by invalid or excessive usage. Start a new run.',
      );
  }
  assertEnvironmentRepair(goal: Goal, policy: ExecutionPolicy) {
    if (
      goal.repairEnvironment &&
      (!policy.profile || (!this.env.environments && !this.env.workspaces.synchronizeDependencies))
    )
      throw new DomainError(
        'ENVIRONMENT_REPAIR_UNAVAILABLE',
        'Environment repair requires a managed project and an execution environment.',
      );
  }
  private async requireRevision(
    projectId: string,
    runId: string,
    workspace: { path: string; base: string },
    expected: WorkspaceRevision,
    phase: string,
  ) {
    let current: WorkspaceRevision;
    try {
      current = await this.env.workspaces.captureRevision(workspace.path, workspace.base);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'VERIFICATION_REVISION_CHANGED')
        throw new DomainError(
          'WORKSPACE_IDENTITY_CHANGED',
          'The original workspace identity cannot be verified. Reconcile its Git state before continuing.',
        );
      throw error;
    }
    if (
      current.version !== expected.version ||
      current.base !== expected.base ||
      current.head !== expected.head ||
      current.index !== expected.index
    )
      throw new DomainError(
        'WORKSPACE_IDENTITY_CHANGED',
        'The workspace Git identity or staged index changed after verification. Reconcile it before continuing.',
      );
    if (sameWorkspaceRevision(expected, current)) return;
    const message = `The workspace revision changed during ${phase}. The changes are saved, but checks and review must be rerun before acceptance.`;
    await this.update(projectId, runId, (run) => {
      run.changedFiles = current.changes;
      run.review = undefined;
      run.independentReviewer = false;
      run.acceptance = {
        passed: 0,
        total: 1,
        results: [{ name: 'Verified workspace revision', passed: false, error: message }],
      };
      run.events.push({ at: this.env.now(), type: 'checks.invalidated', text: message });
    });
    throw new DomainError('VERIFICATION_REVISION_CHANGED', message);
  }
  private async openVerificationView(
    projectId: string,
    runId: string,
    workspace: string,
    revision: WorkspaceRevision,
    policy: ExecutionPolicy,
    signal: AbortSignal,
  ) {
    if (!this.env.workspaces.openVerificationView || !this.env.workspaces.releaseVerificationView)
      throw new DomainError(
        'VERIFICATION_UNAVAILABLE',
        'The workspace adapter cannot provide immutable verification input.',
      );
    await this.closeVerificationView(projectId, runId);
    const selected = new Set(this.get(projectId, runId).checkIds || []);
    const outputPaths = canonicalOutputPaths(
      (policy.profile?.checks || [])
        .filter((check) => selected.has(check.id))
        .flatMap((check) => check.outputPaths || []),
    );
    const view = await this.env.workspaces.openVerificationView(workspace, revision, {
      projectId,
      runId,
      outputPaths,
      signal,
    });
    try {
      if (
        view.projectId !== projectId ||
        view.runId !== runId ||
        view.sourceWorkspace !== workspace ||
        view.base !== revision.base ||
        view.tree !== revision.tree
      )
        throw new DomainError(
          'VERIFICATION_UNAVAILABLE',
          'The issued verification source does not match this run and revision.',
        );
      this.verificationViews.set(runId, view);
      await this.update(projectId, runId, (run) => {
        run.verificationView = view;
        run.events.push({
          at: this.env.now(),
          type: 'verification.opened',
          text: `${view.id}: ${view.tree}`,
        });
      });
      return view;
    } catch (error) {
      this.verificationViews.delete(runId);
      await this.env.workspaces.releaseVerificationView(view).catch(() => {});
      throw error;
    }
  }
  async closeVerificationView(projectId: string, runId: string) {
    const view = this.verificationViews.get(runId);
    if (!view) return;
    await this.env.checks.releaseVerificationView?.(view);
    await this.env.workspaces.releaseVerificationView?.(view);
    this.verificationViews.delete(runId);
    await this.update(projectId, runId, (run) => {
      if (run.verificationView?.id === view.id) run.verificationView = undefined;
      run.events.push({ at: this.env.now(), type: 'verification.closed', text: view.id });
    });
  }
  async verify(
    projectId: string,
    runId: string,
    workspace: { path: string; base: string },
    policy: ExecutionPolicy,
    signal: AbortSignal,
    options: { keepView?: boolean } = {},
  ) {
    let changes = await this.env.workspaces.changes(workspace.path, workspace.base);
    const pathsSafe = () =>
      changes.every((f) => writeAllowed(f.path, policy.scope) && !f.after.startsWith('[symlink '));
    const safe = () => pathsSafe() && dependencyManifestPreserved(changes);
    const blocked = () => ({
      changes,
      scope: pathsSafe(),
      specsUnchanged: dependencyManifestPreserved(changes),
      scopeObservation: undefined,
      revision: undefined,
      view: undefined,
      checks: {
        passed: 0,
        total: 1,
        results: [
          {
            name: 'Change boundaries and check commands',
            passed: false,
            error: !pathsSafe()
              ? 'Changes violate the file policy. Protected paths are always forbidden; strict mode also forbids changes outside planned paths.'
              : 'The protected package.json definition changed. This check-integrity rule is separate from the planned file scope.',
          },
        ],
      },
    });
    if (!safe()) return blocked();
    if (this.env.environments && policy.profile) {
      await this.prepareEnvironment(projectId, runId, workspace, policy, signal);
      changes = await this.env.workspaces.changes(workspace.path, workspace.base);
      if (!safe()) return blocked();
    } else if (this.get(projectId, runId).repairEnvironment) {
      const installation = await this.env.workspaces.synchronizeDependencies!(
        workspace.path,
        signal,
      );
      if (installation) {
        await this.update(projectId, runId, (r) =>
          r.events.push({
            at: this.env.now(),
            type: 'environment.install-completed',
            text: `${installation.passed ? 'Dependencies installed' : 'Dependency installation failed'} in a separate workspace.
${installation.command}
${installation.output || installation.error || ''}`,
          }),
        );
        if (!installation.passed)
          return {
            changes,
            scope: true,
            specsUnchanged: true,
            scopeObservation: undefined,
            checks: { passed: 0, total: 1, results: [installation] },
            revision: undefined,
            view: undefined,
          };
        changes = await this.env.workspaces.changes(workspace.path, workspace.base);
        if (!safe()) return blocked();
      }
    }
    const revision = await this.env.workspaces.captureRevision(workspace.path, workspace.base);
    changes = revision.changes;
    if (!safe()) return blocked();
    const view = await this.openVerificationView(
      projectId,
      runId,
      workspace.path,
      revision,
      policy,
      signal,
    );
    let retained = false;
    try {
      const checks = await this.measure(projectId, runId, 'checks', () =>
        this.env.checks.run(
          projectId,
          workspace.path,
          this.get(projectId, runId).checkIds!,
          signal,
          policy.profile,
          { requirePreparedIsolation: !!policy.profile, verificationView: view },
        ),
      );
      await this.requireRevision(projectId, runId, workspace, revision, 'verification');
      await this.update(projectId, runId, (run) => {
        run.verificationEvidence = {
          version: 1,
          viewId: view.id,
          base: view.base,
          tree: view.tree,
          checkIds: [...(run.checkIds || [])],
          profileRevision: policy.profile?.revision,
          checkedAt: this.env.now(),
        };
      });
      retained = !!options.keepView;
      return {
        changes,
        scope: true,
        specsUnchanged: true,
        checks,
        revision,
        scopeObservation: {
          mode: policy.scope.mode,
          tree: revision.tree,
          additionalPaths: policy.scope.plannedPaths.length
            ? changes
                .filter((file) => !matchesPlannedPath(file.path, policy.scope.plannedPaths))
                .map((file) => file.path)
            : [],
          violations: [],
        },
        view: retained ? view : undefined,
      };
    } finally {
      if (!retained) await this.closeVerificationView(projectId, runId);
    }
  }
  async prepareEnvironment(
    projectId: string,
    runId: string,
    workspace: { path: string; base: string },
    policy: ExecutionPolicy,
    signal: AbortSignal,
  ) {
    const preparation = await this.env.environments!.prepare({
      projectId,
      runId,
      workspace: workspace.path,
      base: workspace.base,
      profile: policy.profile!,
      signal,
      report: async (check) => {
        await this.update(projectId, runId, (r) =>
          r.events.push({
            at: this.env.now(),
            type: 'environment.command-completed',
            text: `${check.name}: ${check.passed ? 'passed' : 'failed'}\n${check.command || ''}\n${check.output || check.error || ''}`,
            durationMs: check.durationMs,
          }),
        );
      },
    });
    await this.update(projectId, runId, (r) =>
      r.events.push({
        at: this.env.now(),
        type: 'environment.ready',
        text: preparation.output || preparation.error,
        durationMs: preparation.durationMs,
      }),
    );
    if (!preparation.passed)
      throw new DomainError(
        'ENVIRONMENT_FAILED',
        preparation.error || 'Project environment is not ready.',
      );
  }
  private assertAttemptOwner(projectId: string, runId: string, expectedAttemptId?: string) {
    const owner = expectedAttemptId ?? this.executionOwners.get(runId);
    if (owner !== undefined && this.get(projectId, runId).attemptId !== owner)
      throw new DomainError('STALE_RUN_ATTEMPT', 'This attempt no longer owns the run.');
    return owner;
  }
  async startRuntime(input: Parameters<AgentRuntime['start']>[0]) {
    return this.measure(input.projectId, input.runId!, 'agent.start', () =>
      this.env.runtime.start(input),
    );
  }
  async completedTurn(
    projectId: string,
    runId: string,
    threadId: string,
    text: string,
    schema: unknown,
    signal: AbortSignal,
    timeoutMs: number,
    toolPolicy?: 'none',
  ) {
    const owner = this.assertAttemptOwner(projectId, runId);
    if (signal.aborted) throw new DOMException('Interrupted', 'AbortError');
    if (!this.env.runtime.turn) throw Error('The runtime does not support completed phases.');
    const pending = {
      version: 1 as const,
      id: 'OT-' + this.env.id(),
      threadId,
      runtimeId: this.env.runtime.id,
      startedAt: this.env.now(),
    };
    await this.update(
      projectId,
      runId,
      (run) => {
        assertRunReconciled(run);
        run.pendingTurn = pending;
      },
      undefined,
      owner,
    );
    let answer: Awaited<ReturnType<NonNullable<AgentRuntime['turn']>>>;
    try {
      answer = await this.measure(projectId, runId, 'agent.turn', () =>
        this.env.runtime.turn!(threadId, text, {
          schema,
          signal,
          timeoutMs,
          ...(toolPolicy ? { toolPolicy } : {}),
        }),
      );
    } catch (error) {
      await this.update(
        projectId,
        runId,
        (run) => {
          const unknown =
            reconciliationForError(error, { detectedAt: this.env.now(), threadId }) ||
            (!isKnownTurnRejection(error)
              ? reconciliationForPendingTurn(pending, this.env.now())
              : undefined);
          run.reconciliation = retainRunReconciliation(run.reconciliation, unknown);
          if (run.reconciliation) run.issue = reconciliationIssue(run.reconciliation);
          else run.pendingTurn = undefined;
        },
        undefined,
        owner,
      );
      throw error;
    }
    await this.update(
      projectId,
      runId,
      (r) => {
        if (r.pendingTurn?.id !== pending.id)
          throw new DomainError('RUN_RECONCILIATION_REQUIRED', 'The saved turn identity changed.');
        r.pendingTurn = undefined;
        if (answer.model) {
          if (r.threadId === threadId && r.coordinatorSession)
            r.coordinatorSession.reportedModel = answer.model;
          const session = r.agents.find((agent) => agent.threadId === threadId)?.session;
          if (session) session.reportedModel = answer.model;
        }
      },
      undefined,
      owner,
    );
    try {
      return JSON.parse(answer.text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new DomainError(
        'INVALID_AGENT_OUTPUT',
        'The completed response is not valid JSON. Return one complete object matching the requested schema.',
      );
    }
  }
  async measure<T>(
    projectId: string,
    runId: string,
    stage: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const owner = this.assertAttemptOwner(projectId, runId);
    const started = performance.now();
    try {
      return await action();
    } finally {
      await this.update(
        projectId,
        runId,
        (r) =>
          r.events.push({
            at: this.env.now(),
            type: 'performance.measured',
            text: stage,
            durationMs: performance.now() - started,
          }),
        undefined,
        owner,
      );
    }
  }
  async start(
    requestId: string,
    fingerprint: string,
    input: { projectId: string; goalId: string; checkIds?: string[] },
  ) {
    const captured = structuredClone(input);
    if (this.closing) throw new DomainError('STOPPING', 'The service is stopping.');
    const store = this.env.projects.get(captured.projectId),
      runs = store.runs;
    if (
      store.project.id !== captured.projectId ||
      !runs ||
      runs.projectId !== captured.projectId ||
      store.entities.projectId !== captured.projectId ||
      store.settings.projectId !== captured.projectId
    )
      throw new DomainError(
        'PROJECT_STORAGE_MISMATCH',
        'The run store belongs to another project.',
      );
    const command = { id: requestId, fingerprint };
    const cached = await runs.receipt(command);
    if (cached) {
      const result = runCommandResult(cached.result);
      this.schedule(captured.projectId, result.runId);
      return result;
    }
    const configured = structuredClone(this.policy(captured.projectId));
    const [goal, profile] = await Promise.all([
      store.entities.goal(captured.goalId),
      store.settings.profile(),
    ]);
    if (!goal) throw new DomainError('NOT_FOUND', 'Goal not found.');
    const policy = profile ? savedExecutionPolicy(profile) : configured;
    const resources = this.env.selection?.forProject(captured.projectId, { profile });
    if (!resources)
      throw new DomainError(
        'RESOURCE_PROFILE_REQUIRED',
        'Execution requires a saved resource profile.',
      );
    if (this.closing) throw new DomainError('STOPPING', 'The service is stopping.');
    this.env.actions.outputSchema();
    const runId = 'R-' + this.env.id();
    const proposal = {
      runId,
      admissionId: 'admission-' + runId,
      attemptId: 'initial-' + runId,
      goalId: goal.id,
      now: this.env.now(),
      expectedGoalRevision: goal.revision,
      expectedProfileRevision: profile?.revision ?? null,
      policy,
      resources,
      workflow: {
        ...structuredClone(this.env.workflowRoles.workflow),
        actionsRevision: this.env.actions.revision,
      },
      ...(captured.checkIds ? { checkIds: captured.checkIds } : {}),
      repairCapabilities: {
        managedEnvironment: !!this.env.environments,
        synchronizeDependencies: !!this.env.workspaces.synchronizeDependencies,
      },
    };
    const result = await runs.transaction(command, (tx) =>
      tx.admit(proposal, this.env.workflowRoles),
    );
    this.schedule(captured.projectId, result.runId);
    return result;
  }
  async resume(
    requestId: string,
    fingerprint: string,
    input: {
      projectId: string;
      runId: string;
      mode: 'repair' | 'recheck';
      instructions: string;
      checkIds?: string[];
      useCurrentProfile: boolean;
    },
  ) {
    const captured = structuredClone(input);
    if (this.closing) throw new DomainError('STOPPING', 'The service is stopping.');
    const runs = this.runCommands(captured.projectId),
      command = { id: requestId, fingerprint };
    const cached = await runs.receipt(command);
    if (cached) {
      const result = runCommandResult(cached.result);
      this.schedule(captured.projectId, result.runId);
      return result;
    }
    const owner = await runs.currentAttempt(captured.runId);
    const store = this.env.projects.get(captured.projectId);
    if (
      store.entities.projectId !== captured.projectId ||
      store.settings.projectId !== captured.projectId
    )
      throw new DomainError(
        'PROJECT_STORAGE_MISMATCH',
        'The run store belongs to another project.',
      );
    const [goal, profile] = await Promise.all([
      store.entities.goal(owner.context.goal.id),
      store.settings.profile(),
    ]);
    if (!goal) throw new DomainError('NOT_FOUND', 'Run or goal not found.');
    const policy = captured.useCurrentProfile
      ? profile
        ? savedExecutionPolicy(profile)
        : structuredClone(this.policy(captured.projectId))
      : owner.context.policy;
    if (this.closing) throw new DomainError('STOPPING', 'The service is stopping.');
    const result = await runs.transaction(command, (tx) =>
      tx.continueAttempt({
        runId: captured.runId,
        attemptId: 'attempt-' + this.env.id(),
        expectedAttemptId: owner.attempt.id,
        expectedGoalRevision: goal.revision,
        expectedProfileRevision: profile?.revision ?? null,
        mode: captured.mode,
        instructions: captured.instructions,
        checkIds: captured.checkIds,
        useCurrentProfile: captured.useCurrentProfile,
        now: this.env.now(),
        policy,
        repairCapabilities: {
          managedEnvironment: !!this.env.environments,
          synchronizeDependencies: !!this.env.workspaces.synchronizeDependencies,
        },
      }),
    );
    this.schedule(captured.projectId, result.runId);
    return result;
  }

  async continueRun(
    projectId: string,
    runId: string,
    signal: AbortSignal,
    threads: string[],
    onWorkspaceAcquired?: (path: string) => void,
  ) {
    const attempt = await this.runCommands(projectId).currentAttempt(runId);
    const run = this.get(projectId, runId),
      policy = withEnvironmentRepair(
        run.executionPolicySnapshot || this.policy(projectId),
        !!run.repairEnvironment,
      );
    assertRunReconciled(run);
    const binding = await this.runCommands(projectId).workspace(runId);
    if (!binding || !this.env.workspaces.restore)
      throw new DomainError(
        'NO_WORKSPACE',
        'The adapter does not support restoring this workspace.',
      );
    await this.beginExecution(projectId, runId);
    const activated = this.get(projectId, runId);
    assertRunReconciled(activated);
    this.assertActionCatalog(activated);
    if (signal.aborted || activated.cancelRequested)
      throw new DOMException('Interrupted', 'AbortError');
    const workspace = await this.env.workspaces.restore(
      projectId,
      runId,
      binding.path,
      binding.baseCommit,
      {
        profile: policy.profile,
        repairEnvironment: !!run.repairEnvironment,
        managedEnvironment: !!this.env.environments && !!policy.profile,
        materials: run.contextMaterials,
      },
    );
    onWorkspaceAcquired?.(workspace.path);
    if (workspace.path !== binding.path || workspace.base !== binding.baseCommit)
      throw new DomainError(
        'WORKSPACE_BINDING_CONFLICT',
        'The restored workspace differs from its saved preparation binding.',
      );
    this.assertAttemptOwner(projectId, runId, attempt.attempt.id);
    const restored = this.get(projectId, runId);
    assertRunReconciled(restored);
    if (signal.aborted || restored.cancelRequested)
      throw new DOMException('Interrupted', 'AbortError');
    const ctx: ExecutionContext = {
      projectId,
      runId,
      workspace,
      policy,
      signal,
      threads,
      attemptId: attempt.attempt.id,
    };
    if (run.continuation?.mode === 'recheck') {
      const envelope = {
        status: 'success' as const,
        summary: 'Rechecking the saved implementation: ' + run.title,
        artifacts: run.changedFiles.map((file) => file.path),
        notesForNextAgent: '',
      };
      const checked = await this.checkRun(ctx);
      await this.reviewRun(ctx, checked, envelope);
      await this.acceptRun(ctx, checked, envelope);
      return;
    }
    await this.orchestrate(projectId, runId, workspace, policy, signal, threads, true);
  }
  schedule(projectId: string, runId: string) {
    if (this.jobs.has(runId) || this.closing) return;
    const run = this.get(projectId, runId);
    if (terminal(run)) return;
    const controller = new AbortController();
    const job: { controller: AbortController; promise: Promise<void>; attemptId?: string } = {
      controller,
      promise: Promise.resolve(),
      attemptId: run.attemptId,
    };
    job.promise = Promise.resolve()
      .then(async () => {
        const current = await this.runCommands(projectId).current(runId);
        if (!current || !['queued', 'running', 'canceling'].includes(current.status)) return;
        if (job.attemptId !== undefined && current.attemptId !== job.attemptId) return;
        job.attemptId = current.attemptId;
        await this.execute(projectId, runId, controller.signal, current.attemptId);
      })
      .finally(async () => {
        if (this.jobs.get(runId) !== job) return;
        this.jobs.delete(runId);
        if (this.closing || !job.attemptId) return;
        const current = await this.runCommands(projectId).current(runId);
        if (
          current?.status === 'canceling' &&
          current.cancelRequested &&
          current.attemptId !== job.attemptId
        ) {
          await this.finish(
            projectId,
            runId,
            'interrupted',
            'Interrupted before the continued attempt started.',
            undefined,
            undefined,
            current.attemptId,
          );
          return;
        }
        if (
          current?.status === 'queued' &&
          !current.cancelRequested &&
          current.attemptId !== job.attemptId
        ) {
          const saved = this.get(projectId, runId);
          if (!saved.reconciliation && !saved.pendingTurn) this.schedule(projectId, runId);
        }
      });
    this.jobs.set(runId, job);
    // Keep the original rejection available to lifecycle awaiters without crashing detached jobs.
    void job.promise.catch(() => {});
  }

  get(projectId: string, runId: string) {
    const run = this.env.projects
      .get(projectId)
      .snapshot()
      .runs.find((r) => r.id === runId);
    if (!run) throw new DomainError('NOT_FOUND', 'Run not found.');
    return run;
  }
  private autonomyContext(doc: ProjectDocument, run: Run) {
    return {
      goalExists: doc.goals.some((goal) => goal.id === run.goalId),
      goalUnsettled: doc.runs.some(
        (other) =>
          other.id !== run.id &&
          other.goalId === run.goalId &&
          !!(other.reconciliation || other.pendingTurn),
      ),
      projectBusy: doc.runs.some((other) => other.id !== run.id && !terminal(other)),
      resumeSupported: true,
      startSupported: true,
      settingsSupported: !!this.env.policies[doc.project.id]?.profile,
    };
  }
  async update(
    projectId: string,
    runId: string,
    apply: (run: Run, goal: Goal, doc: ProjectDocument) => void,
    roles?: Role[],
    expectedAttemptId?: string,
  ) {
    const owner = expectedAttemptId ?? this.executionOwners.get(runId);
    return this.env.projects
      .get(projectId)
      .transact('internal-' + this.env.id(), 'internal', (doc) => {
        const run = doc.runs.find((r) => r.id === runId),
          goal = doc.goals.find((g) => g.id === run?.goalId);
        if (!run || !goal) throw new DomainError('NOT_FOUND', 'Run or goal was deleted.');
        if (owner !== undefined && run.attemptId !== owner)
          throw new DomainError('STALE_RUN_ATTEMPT', 'This attempt no longer owns the run.');
        apply(run, goal, doc);
        Object.assign(run, projectRunAutonomy(run, this.autonomyContext(doc, run)));
        run.updatedAt = this.env.now();
        return {
          result: null,
          change: {
            type: 'run.changed',
            run,
            goal,
            ...(roles ? { roles } : {}),
          } as DomainEvent['change'],
        };
      });
  }
  private runCommands(projectId: string) {
    const store = this.env.projects.get(projectId),
      runs = store.runs;
    if (store.project.id !== projectId || !runs || runs.projectId !== projectId)
      throw new DomainError(
        'PROJECT_STORAGE_MISMATCH',
        'The run store belongs to another project.',
      );
    return runs;
  }
  async beginExecution(projectId: string, runId: string) {
    const runs = this.runCommands(projectId),
      expectedAttemptId = this.executionOwners.get(runId) ?? (await runs.current(runId))?.attemptId;
    return runs.transaction(
      { id: 'internal-' + this.env.id(), fingerprint: 'run.begin-execution' },
      (tx) => tx.beginExecution({ runId, now: this.env.now(), expectedAttemptId }),
    );
  }
  async bindPreparedWorkspace(
    projectId: string,
    runId: string,
    workspace: { path: string; base: string },
  ) {
    const captured = structuredClone(workspace);
    const runs = this.runCommands(projectId),
      expectedAttemptId = this.executionOwners.get(runId) ?? (await runs.current(runId))?.attemptId;
    return runs.transaction(
      { id: 'internal-' + this.env.id(), fingerprint: 'run.bind-workspace' },
      (tx) =>
        tx.bindPreparedWorkspace({
          runId,
          path: captured.path,
          baseCommit: captured.base,
          now: this.env.now(),
          expectedAttemptId,
        }),
    );
  }
  async phase(projectId: string, runId: string, phase: ExecutionPhase, text: string) {
    const runs = this.runCommands(projectId);
    const expectedAttemptId =
      this.executionOwners.get(runId) ?? (await runs.current(runId))?.attemptId;
    const result = await runs.transaction(
      { id: 'internal-' + this.env.id(), fingerprint: 'run.advance-phase' },
      (tx) => tx.advancePhase({ runId, now: this.env.now(), phase, text, expectedAttemptId }),
    );
    // Cancellation can commit after the phase transaction while its result is being delivered.
    const current = await runs.current(runId);
    if (current?.attemptId !== expectedAttemptId)
      throw new DomainError('STALE_RUN_ATTEMPT', 'This attempt no longer owns the run.');
    if (current?.cancelRequested || current?.status === 'canceling')
      throw new DOMException('Interrupted', 'AbortError');
    if (!current || current.status !== 'running')
      throw new DomainError('INVALID_STATE', 'This run is no longer executing.');
    return result;
  }
  async cancel(
    requestId: string,
    fingerprint: string,
    input: { projectId: string; runId: string },
  ) {
    const captured = structuredClone(input),
      store = this.env.projects.get(captured.projectId),
      runs = store.runs;
    if (store.project.id !== captured.projectId || !runs || runs.projectId !== captured.projectId)
      throw new DomainError(
        'PROJECT_STORAGE_MISMATCH',
        'The run store belongs to another project.',
      );
    const result = await runs.transaction({ id: requestId, fingerprint }, (tx) =>
      tx.requestCancel({ runId: captured.runId, now: this.env.now() }),
    );
    const current = await runs.current(captured.runId);
    const job = this.jobs.get(captured.runId);
    if (
      current?.status === 'canceling' &&
      current.cancelRequested &&
      job &&
      (job.attemptId === undefined || job.attemptId === current.attemptId)
    )
      job.controller.abort();
    return result;
  }
  async recover() {
    for (const project of this.env.projects.list())
      for (const run of this.env.projects.get(project.id).snapshot().runs) {
        if (terminal(run)) continue;
        if (
          run.pendingTurn &&
          !run.reconciliation &&
          (await this.env.runtime.canRetry?.(run.pendingTurn.threadId).catch(() => false))
        ) {
          await this.update(project.id, run.id, (current) => {
            if (current.pendingTurn?.id === run.pendingTurn!.id && !current.reconciliation)
              current.pendingTurn = undefined;
          });
          await this.finish(
            project.id,
            run.id,
            'interrupted',
            'The service stopped before receiving the model reply. Saved work is preserved and can be retried.',
          );
        } else if (run.pendingTurn) {
          await this.update(project.id, run.id, (current) => {
            current.reconciliation = retainRunReconciliation(
              current.reconciliation,
              reconciliationForPendingTurn(run.pendingTurn!, this.env.now()),
            );
            current.issue = reconciliationIssue(current.reconciliation!);
          });
          await this.finish(
            project.id,
            run.id,
            'needs-attention',
            reconciliationIssue(this.get(project.id, run.id).reconciliation!).message,
          );
        } else if (run.status === 'queued' && !run.cancelRequested)
          this.schedule(project.id, run.id);
        else
          await this.finish(
            project.id,
            run.id,
            'interrupted',
            'The service stopped during execution. The workspace is preserved; execution was not automatically retried.',
          );
      }
  }
  async finish(
    projectId: string,
    runId: string,
    status: RunAttemptStop['status'],
    text: string,
    issue?: Run['issue'],
    errorCode?: string,
    expectedAttemptId?: string,
  ) {
    const runs = this.runCommands(projectId);
    const owner =
      expectedAttemptId ??
      this.executionOwners.get(runId) ??
      (await runs.current(runId))?.attemptId;
    await this.eventQueue;
    if (!['failed', 'interrupted', 'needs-attention'].includes(status))
      throw new DomainError(
        'ACCEPTANCE_REQUIRED',
        'Completion requires the verified acceptance writer.',
      );
    if (!owner) throw new DomainError('NOT_FOUND', 'Run not found.');
    return runs.transaction(
      { id: 'internal-' + this.env.id(), fingerprint: 'run.finish-stopped' },
      (tx) =>
        tx.finishStopped({
          runId,
          attemptId: owner,
          now: this.env.now(),
          status,
          text,
          ...(issue ? { issue } : {}),
          ...(errorCode !== undefined ? { errorCode } : {}),
        }),
    );
  }

  async execute(projectId: string, runId: string, signal: AbortSignal, expectedAttemptId?: string) {
    const current = await this.runCommands(projectId).current(runId);
    if (!current) throw new DomainError('NOT_FOUND', 'Run not found.');
    const owner = expectedAttemptId ?? current.attemptId;
    if (current.attemptId !== owner)
      throw new DomainError('STALE_RUN_ATTEMPT', 'This attempt no longer owns the run.');
    if (this.executionOwners.has(runId))
      throw new DomainError('RUN_ALREADY_EXECUTING', 'This run already has an acquired execution.');
    const record = this.get(projectId, runId),
      policy = withEnvironmentRepair(
        record.executionPolicySnapshot || this.policy(projectId),
        !!record.repairEnvironment,
      ),
      threads: string[] = [];
    let acquiredWorkspace: string | undefined;
    this.executionOwners.set(runId, owner);
    const abort = () => {
      if (this.get(projectId, runId).attemptId !== owner)
        throw new DomainError('STALE_RUN_ATTEMPT', 'This attempt no longer owns the run.');
      assertRunReconciled(this.get(projectId, runId));
      if (signal.aborted || this.get(projectId, runId).cancelRequested)
        throw new DOMException('Interrupted', 'AbortError');
    };
    try {
      abort();
      if (this.get(projectId, runId).continuation) {
        await this.continueRun(projectId, runId, signal, threads, (path) => {
          acquiredWorkspace = path;
        });
        return;
      }
      await this.beginExecution(projectId, runId);
      abort();
      this.assertActionCatalog(this.get(projectId, runId));
      let base = record.baseBranch;
      if (record.parentRunId) {
        const parent = this.env.projects
          .get(projectId)
          .snapshot()
          .runs.find((r) => r.id === record.parentRunId);
        if (!parent || parent.status !== 'completed' || !parent.commit)
          throw new DomainError('INVALID_PARENT', 'Parent run is unavailable.');
        base = parent.commit;
      }
      await this.phase(projectId, runId, 'preparing', 'Preparing the workspace and environment');
      const workspace = await this.env.workspaces.prepare(projectId, runId, base, {
        profile: policy.profile,
        repairEnvironment: !!record.repairEnvironment,
        managedEnvironment: !!this.env.environments && !!policy.profile,
        materials: record.contextMaterials,
        signal,
      });
      acquiredWorkspace = workspace.path;
      await this.bindPreparedWorkspace(projectId, runId, workspace);
      abort();
      await this.orchestrate(projectId, runId, workspace, policy, signal, threads);
    } catch (error) {
      if (this.get(projectId, runId).attemptId !== owner)
        throw new DomainError('STALE_RUN_ATTEMPT', 'This attempt no longer owns the run.');
      const run = this.get(projectId, runId);
      const unknown = reconciliationForError(error, { detectedAt: this.env.now() });
      if (unknown || (!run.reconciliation && run.pendingTurn))
        await this.update(projectId, runId, (current) => {
          current.reconciliation = retainRunReconciliation(
            current.reconciliation,
            unknown || reconciliationForPendingTurn(run.pendingTurn!, this.env.now()),
          );
          current.issue = reconciliationIssue(current.reconciliation!);
        });
      const reconciliation = this.get(projectId, runId).reconciliation;
      const interrupted =
        signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      const budgetFailure =
        error instanceof DomainError
          ? ManagedBudgetErrorCodeSchema.safeParse(error.code)
          : undefined;
      const budgetCode = budgetFailure?.success ? budgetFailure.data : undefined;
      await this.finish(
        projectId,
        runId,
        reconciliation
          ? 'needs-attention'
          : interrupted
            ? 'interrupted'
            : budgetCode ||
                (error instanceof DomainError &&
                  [
                    'BASELINE_CHECKS_FAILED',
                    'ENVIRONMENT_FAILED',
                    'ENVIRONMENT_UNAVAILABLE',
                    'EXECUTION_ACTIONS_CHANGED',
                    'EXECUTION_ACTIONS_EMPTY',
                    'FIXED_RUNTIME_UNAVAILABLE',
                    'BACKEND_CAPABILITY_UNAVAILABLE',
                    'BACKEND_CAPABILITIES_CHANGED',
                    'SESSION_SCOPE_CHANGED',
                    'CHECK_DEFINITION_CHANGED',
                    'VERIFICATION_REVISION_CHANGED',
                    'WORKSPACE_IDENTITY_CHANGED',
                    'VERIFICATION_UNAVAILABLE',
                    'VERIFICATION_VIEW_UNAVAILABLE',
                    'VERIFICATION_VIEW_CHANGED',
                  ].includes(error.code))
              ? 'needs-attention'
              : 'failed',
        error instanceof Error ? error.message : String(error),
        reconciliation
          ? reconciliationIssue(reconciliation)
          : !interrupted && budgetCode
            ? {
                code: 'MANAGED_BUDGET_BLOCKED',
                budgetCode,
                message: error instanceof Error ? error.message : String(error),
                checks: [],
              }
            : error instanceof DomainError &&
                [
                  'CHECK_DEFINITION_CHANGED',
                  'BACKEND_CAPABILITY_UNAVAILABLE',
                  'BACKEND_CAPABILITIES_CHANGED',
                  'SESSION_SCOPE_CHANGED',
                  'VERIFICATION_REVISION_CHANGED',
                  'WORKSPACE_IDENTITY_CHANGED',
                  'VERIFICATION_UNAVAILABLE',
                  'VERIFICATION_VIEW_UNAVAILABLE',
                  'VERIFICATION_VIEW_CHANGED',
                ].includes(error.code)
              ? { code: 'EXECUTION_FAILED', message: error.message, checks: [] }
              : undefined,
        error instanceof DomainError ? error.code : undefined,
        owner,
      );
    } finally {
      try {
        await Promise.allSettled(threads.map((id) => this.env.runtime.release?.(id)));
        try {
          await this.closeVerificationView(projectId, runId);
        } catch (error) {
          await this.update(projectId, runId, (run) =>
            run.events.push({
              at: this.env.now(),
              type: 'verification.cleanup-failed',
              text: String(error),
            }),
          ).catch(() => {});
        }
        const workspace = acquiredWorkspace;
        if (workspace) {
          try {
            await this.env.environments?.release(workspace);
          } catch (error) {
            await this.update(projectId, runId, (r) =>
              r.events.push({
                at: this.env.now(),
                type: 'environment.stop-failed',
                text: String(error),
              }),
            );
          }
        }
      } finally {
        if (this.executionOwners.get(runId) === owner) this.executionOwners.delete(runId);
      }
    }
  }
  async orchestrate(
    projectId: string,
    runId: string,
    workspace: { path: string; base: string },
    policy: ExecutionPolicy,
    signal: AbortSignal,
    threads: string[],
    restoreSession = false,
  ) {
    return runGoalOrchestration(
      this,
      {
        projectId,
        runId,
        workspace,
        policy,
        signal,
        threads,
        attemptId: this.get(projectId, runId).attemptId,
      },
      restoreSession,
    );
  }
  async dispatchWorkers(
    projectId: string,
    runId: string,
    roles: Role[],
    workspace: { path: string; base: string },
    policy: ExecutionPolicy,
    signal: AbortSignal,
    threads: string[],
    ask: (threadId: string, text: string, schema: unknown) => Promise<unknown>,
  ) {
    assertRunReconciled(this.get(projectId, runId));
    return runWorkerAssignments({
      projectId,
      run: this.get(projectId, runId),
      readAssignment: (roleId) => this.runCommands(projectId).assignment(runId, roleId),
      roles,
      workspace,
      policy,
      runtime: this.env.runtime,
      workspaces: this.env.workspaces,
      signal,
      now: this.env.now,
      id: this.env.id,
      update: (apply) => this.update(projectId, runId, apply),
      track: (threadId) => threads.push(threadId),
      flush: () => this.eventQueue,
      ask,
    });
  }
  private assertExecutionContext(ctx: ExecutionContext) {
    this.assertAttemptOwner(ctx.projectId, ctx.runId, ctx.attemptId);
    const run = this.get(ctx.projectId, ctx.runId);
    assertRunReconciled(run);
    if (ctx.signal.aborted || run.cancelRequested)
      throw new DOMException('Interrupted', 'AbortError');
    if (run.status !== 'running')
      throw new DomainError('INVALID_STATE', 'This run is no longer executing.');
    this.assertManagedBudgetOpen(run);
    return run;
  }

  /** Execute one requested check operation; no reviewer or repair is scheduled here. */
  async checkRun(ctx: ExecutionContext): Promise<CheckedRun> {
    const { projectId, runId, workspace, policy, signal } = ctx;
    this.assertExecutionContext(ctx);
    await this.closeVerificationView(projectId, runId);
    await this.update(projectId, runId, (run) => {
      run.review = undefined;
      run.independentReviewer = false;
      run.verificationEvidence = undefined;
    });
    await this.phase(projectId, runId, 'checking', 'Checking the requested source revision');
    const result = await this.verify(projectId, runId, workspace, policy, signal, {
      keepView: true,
    });
    this.assertExecutionContext(ctx);
    await this.update(projectId, runId, (run) => {
      run.changedFiles = result.changes;
      run.scopePreserved = result.scope;
      run.specsUnchanged = result.specsUnchanged;
      run.scopeObservation = result.scopeObservation;
      run.acceptance = result.checks;
      run.events.push({
        at: this.env.now(),
        type: 'checks.completed',
        text: `Checks: ${result.checks.passed}/${result.checks.total}; boundaries: ${result.scope ? 'respected' : 'violated'}${result.revision ? '; source tree: ' + result.revision.tree : ''}`,
      });
    });
    const checked = structuredClone(result);
    this.checkedRuns.set(checked, {
      projectId,
      runId,
      attemptId: this.get(projectId, runId).attemptId,
      result: structuredClone(result),
    });
    return checked;
  }

  /** Reuse current service evidence or obtain it without asking the model to order prerequisites. */
  async ensureChecks(ctx: ExecutionContext, checked?: CheckedRun, openView = false) {
    if (checked) {
      try {
        await this.checkedRun(ctx, checked, openView);
        return checked;
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          !['CHECKS_REQUIRED', 'VERIFICATION_REVISION_CHANGED'].includes(error.code)
        )
          throw error;
      }
    }
    return this.checkRun(ctx);
  }

  /** A finish request runs missing verification; only the existing acceptance writer can commit. */
  async completeRun(
    ctx: ExecutionContext,
    candidate: CheckedRun | undefined,
    proposedEnvelope: ReturnType<typeof EnvelopeSchema.parse>,
  ) {
    const envelope = EnvelopeSchema.parse(proposedEnvelope);
    let checked = await this.ensureChecks(ctx, candidate);
    const passed = () =>
      checked.scope &&
      checked.specsUnchanged &&
      checked.checks.total > 0 &&
      checked.checks.passed === checked.checks.total;
    if (!passed() || envelope.status !== 'success') return { checked, accepted: false as const };
    const current = this.assertExecutionContext(ctx);
    const issued = this.checkedRuns.get(checked)?.review;
    let review =
      issued &&
      current.independentReviewer &&
      current.verificationEvidence?.reviewerSessionId === issued.sessionId &&
      JSON.stringify(current.review) === JSON.stringify(issued.result)
        ? issued.result
        : undefined;
    if (!review) {
      checked = await this.ensureChecks(ctx, checked, true);
      if (!passed()) return { checked, accepted: false as const };
      review = await this.reviewRun(ctx, checked, envelope);
    }
    if (review.verdict !== 'approved' || review.blockingFindings.length)
      return { checked, review, accepted: false as const };
    await this.acceptRun(ctx, checked, envelope);
    return { checked, review, accepted: true as const };
  }

  /** Resolve host-issued evidence, never revision/check assertions supplied by an action. */
  private async checkedRun(ctx: ExecutionContext, checked: CheckedRun, openView = false) {
    const run = this.assertExecutionContext(ctx);
    const issued = this.checkedRuns.get(checked);
    if (!issued || issued.projectId !== ctx.projectId || issued.runId !== ctx.runId)
      throw new DomainError('CHECKS_REQUIRED', 'Run fresh service checks before this action.');
    if (issued.attemptId !== run.attemptId)
      throw new DomainError('STALE_RUN_ATTEMPT', 'The checks belong to another execution attempt.');
    const result = issued.result;
    if (
      !result.revision ||
      !result.view ||
      !result.scope ||
      !result.specsUnchanged ||
      !result.checks.total ||
      result.checks.passed !== result.checks.total
    )
      throw new DomainError(
        'CHECKS_REQUIRED',
        'Passing service checks and preserved boundaries are required.',
      );
    const evidence = run.verificationEvidence;
    if (
      !evidence ||
      evidence.viewId !== result.view.id ||
      evidence.tree !== result.revision.tree ||
      evidence.base !== result.revision.base ||
      JSON.stringify(evidence.checkIds) !== JSON.stringify(run.checkIds || []) ||
      evidence.profileRevision !== ctx.policy.profile?.revision ||
      JSON.stringify(run.acceptance) !== JSON.stringify(result.checks) ||
      (openView &&
        (run.verificationView?.id !== result.view.id ||
          this.verificationViews.get(ctx.runId)?.id !== result.view.id))
    )
      throw new DomainError(
        'CHECKS_REQUIRED',
        'The current check receipt is unavailable; run checks again.',
      );
    try {
      await this.requireRevision(
        ctx.projectId,
        ctx.runId,
        ctx.workspace,
        result.revision,
        'requested action',
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === 'VERIFICATION_REVISION_CHANGED') {
        await this.closeVerificationView(ctx.projectId, ctx.runId);
        await this.update(ctx.projectId, ctx.runId, (current) => {
          current.verificationEvidence = undefined;
        });
      }
      throw error;
    }
    this.assertExecutionContext(ctx);
    return result as CheckedRun & { revision: WorkspaceRevision; view: VerificationView };
  }

  /** Obtain one fresh independent review of the exact checked revision. */
  async reviewRun(
    ctx: ExecutionContext,
    checked: CheckedRun,
    envelope: ReturnType<typeof EnvelopeSchema.parse>,
  ) {
    const { projectId, runId, workspace, policy, threads } = ctx;
    const result = await this.checkedRun(ctx, checked, true);
    const { revision, view, changes, checks } = result;
    const run = this.get(projectId, runId);
    await this.phase(
      projectId,
      runId,
      'review',
      'Independent reviewer is checking the requested revision',
    );
    const reviewerRole = run.roleSnapshots?.find((role) => role.id === 'reviewer');
    if (!reviewerRole)
      throw new DomainError('INVALID_ASSIGNMENT', 'The reviewer role snapshot is missing.');
    const reviewerSession = {
      id: 'S-' + this.env.id(),
      roleId: reviewerRole.id,
      roleVersion: reviewerRole.version,
      ...sessionResource(run.resources, 'review', this.env.runtime.id, run.roleResources?.reviewer),
      parentId: run.coordinatorSession?.id,
    };
    await this.update(projectId, runId, (current) => {
      current.review = undefined;
      current.independentReviewer = false;
      current.agents.push({
        session: reviewerSession,
        threadId: reviewerSession.id,
        name: reviewerRole.id,
        agentPath: '/root/' + reviewerRole.id,
        startedAt: this.env.now(),
        completedAt: '',
        messages: [],
        commands: 0,
        status: 'starting',
      });
      current.events.push({
        at: this.env.now(),
        type: 'agent.dispatch-requested',
        threadId: reviewerSession.id,
        text: 'Independent reviewer',
      });
    });
    this.assertExecutionContext(ctx);
    const reviewer = await this.startRuntime({
      projectId,
      runId,
      workspace: view.readRoot,
      readOnly: true,
      purpose: 'review',
      operationId: operationIds.review,
      roleId: reviewerRole.id,
      instructions:
        reviewerRole.instructions +
        '\nRead only. Do not modify files, start agents or use the network. You did not participate in implementation. Request changes for blocking issues.\nProject context: ' +
        (policy.context || '') +
        materialInstructions(run.contextMaterials || [], view.readRoot, true),
    });
    threads.push(reviewer.threadId);
    let reviewed: ReturnType<typeof ReviewSchema.parse>;
    try {
      await this.update(projectId, runId, (current) => {
        const agent = current.agents.find((item) => item.session?.id === reviewerSession.id)!;
        agent.threadId = reviewer.threadId;
        agent.status = 'running';
        current.events.push({
          at: this.env.now(),
          type: 'agent.started',
          threadId: reviewer.threadId,
          text: 'Independent reviewer',
        });
      });
      const answer = await this.completedTurn(
        projectId,
        runId,
        reviewer.threadId,
        `Review goal: ${run.title}\n${run.goalText}\nFile policy: ${JSON.stringify(policy.scope)}.\nExecutor result: ${JSON.stringify(envelope)}\nIndependent checks: ${JSON.stringify(checkContext(checks))}\nChanged files: ${JSON.stringify(changeContext(changes))}. Read the actual diff against ${workspace.base} and relevant files in the workspace; the file list is not a substitute for inspecting changes.\nRead relevant sources and verify actual correctness, including preservation of existing behavior. Return approved only when there are no blocking findings.`,
        reviewOutputSchema,
        ctx.signal,
        run.timePolicy?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      );
      const parsed = ReviewSchema.safeParse(answer);
      if (!parsed.success)
        throw new DomainError(
          'INVALID_AGENT_OUTPUT',
          'The reviewer did not return a valid review result.',
        );
      const review = parsed.data;
      await this.eventQueue;
      this.assertExecutionContext(ctx);
      await this.requireRevision(projectId, runId, workspace, revision, 'independent review');
      await this.update(projectId, runId, (current) => {
        if (
          !current.verificationEvidence ||
          current.verificationEvidence.viewId !== view.id ||
          current.verificationEvidence.tree !== revision.tree
        )
          throw new DomainError(
            'VERIFICATION_REVISION_CHANGED',
            'The reviewed verification input changed.',
          );
        current.review = review;
        current.independentReviewer = true;
        current.verificationEvidence.reviewedAt = this.env.now();
        current.verificationEvidence.reviewerSessionId = reviewerSession.id;
        const agent = current.agents.find((item) => item.session?.id === reviewerSession.id)!;
        agent.completedAt = this.env.now();
        agent.status = 'completed';
        current.events.push({
          at: this.env.now(),
          type: 'agent.completed',
          threadId: reviewer.threadId,
          text: review.summary,
        });
        current.events.push({
          at: this.env.now(),
          type: 'review.completed',
          text: review.verdict + ': ' + review.summary,
        });
      });
      reviewed = review;
    } finally {
      await this.env.runtime.release?.(reviewer.threadId);
      await this.eventQueue;
      await this.closeVerificationView(projectId, runId);
    }
    this.checkedRuns.get(checked)!.review = {
      sessionId: reviewerSession.id,
      result: structuredClone(reviewed),
    };
    return reviewed;
  }

  /** Finalize only independently checked/reviewed current bytes; the model cannot accept itself. */
  async acceptRun(
    ctx: ExecutionContext,
    checked: CheckedRun,
    proposedEnvelope: ReturnType<typeof EnvelopeSchema.parse>,
  ) {
    const { projectId, runId, workspace, policy } = ctx;
    const envelope = EnvelopeSchema.parse(proposedEnvelope);
    const result = await this.checkedRun(ctx, checked);
    const acceptedRevision = result.revision;
    const observed = this.get(projectId, runId);
    const reviewed = this.checkedRuns.get(checked)?.review;
    const assignments = await this.runCommands(projectId).assignments(runId);
    const workersReady = (current: Run) => {
      if (
        JSON.stringify(Object.keys(current.roleAssignments || {}).sort()) !==
        JSON.stringify(assignments.map((assignment) => assignment.role.id).sort())
      )
        return false;
      return assignments.every((assignment) => {
        const agent = [...current.agents]
          .reverse()
          .find((item) => item.assignment?.grantId === assignment.id);
        const session = agent?.session;
        return (
          agent?.status === 'completed' &&
          session?.result?.status === 'success' &&
          session.roleId === assignment.role.id &&
          session.roleVersion === assignment.role.version &&
          session.runtimeId === assignment.resource.resource.id &&
          session.providerId === assignment.resource.resource.providerId &&
          session.model === assignment.resource.resource.model &&
          session.configurationRevision === assignment.resource.resource.configurationRevision &&
          JSON.stringify(agent.assignment?.paths || []) === JSON.stringify(assignment.paths) &&
          JSON.stringify(current.roleAssignments?.[assignment.role.id]) ===
            JSON.stringify(assignment.paths)
        );
      });
    };
    const acceptable = (current: Run) =>
      workersReady(current) &&
      envelope.status === 'success' &&
      current.independentReviewer &&
      reviewed !== undefined &&
      current.verificationEvidence?.reviewerSessionId === reviewed.sessionId &&
      JSON.stringify(current.review) === JSON.stringify(reviewed.result) &&
      current.agents.some(
        (agent) =>
          agent.session?.id === reviewed.sessionId &&
          agent.session.roleId === 'reviewer' &&
          agent.status === 'completed',
      ) &&
      canAccept({
        testsPassed:
          current.acceptance.total > 0 && current.acceptance.passed === current.acceptance.total,
        scopePreserved: current.scopePreserved,
        specsUnchanged: current.specsUnchanged,
        review: current.review
          ? {
              verdict: current.review.verdict,
              blockingFindings: current.review.blockingFindings.length,
            }
          : undefined,
      });
    if (!reviewed || !observed.review || !observed.independentReviewer)
      throw new DomainError(
        'REVIEW_REQUIRED',
        'Obtain a fresh independent review of the checked revision.',
      );
    if (!acceptable(observed))
      throw new DomainError(
        'ACCEPTANCE_NOT_READY',
        'Checks, review, assigned work and the execution result must all succeed.',
      );
    const catalog = this.env.projects.get(projectId).snapshot().roles;
    const acceptedRoles: Role[] = [];
    for (const assignment of assignments.filter((item) => item.origin === 'created')) {
      const role = assignment.role;
      const current = catalog.find((item) => item.id === role.id);
      if (
        current &&
        (current.version < role.version ||
          (current.version === role.version &&
            JSON.stringify({ ...validateProjectRole(current), createdAt: '', updatedAt: '' }) !==
              JSON.stringify({ ...validateProjectRole(role), createdAt: '', updatedAt: '' })))
      )
        throw new DomainError('ROLE_CHANGED', 'Role catalog conflict: ' + role.id);
      if (!current) acceptedRoles.push(role);
    }
    this.assertExecutionContext(ctx);
    const commit = await this.measure(projectId, runId, 'workspace.checkpoint', () =>
      this.env.workspaces.checkpoint(workspace.path, runId, acceptedRevision),
    );
    this.assertExecutionContext(ctx);
    await this.eventQueue;
    await this.update(
      projectId,
      runId,
      (current, goal, doc) => {
        this.assertManagedBudgetOpen(current);
        assertRunReconciled(current);
        if (
          !acceptable(current) ||
          !current.verificationEvidence ||
          current.verificationEvidence.tree !== acceptedRevision.tree ||
          current.verificationEvidence.base !== acceptedRevision.base ||
          current.verificationEvidence.viewId !== result.view.id ||
          !current.scopeObservation ||
          current.scopeObservation.tree !== acceptedRevision.tree ||
          current.scopeObservation.mode !== policy.scope.mode ||
          current.scopeObservation.violations.length > 0 ||
          JSON.stringify(current.scopeObservation.additionalPaths) !==
            JSON.stringify(
              policy.scope.plannedPaths.length
                ? acceptedRevision.changes
                    .filter((file) => !matchesPlannedPath(file.path, policy.scope.plannedPaths))
                    .map((file) => file.path)
                : [],
            ) ||
          !current.verificationEvidence.reviewedAt ||
          !current.verificationEvidence.reviewerSessionId ||
          JSON.stringify(current.verificationEvidence.checkIds) !==
            JSON.stringify(current.checkIds || [])
        )
          throw new DomainError(
            'VERIFICATION_REVISION_CHANGED',
            'The accepted revision no longer has matching check and review evidence.',
          );
        for (const role of acceptedRoles) {
          if (doc.roleVersions.some((item) => item.id === role.id))
            throw new DomainError('ROLE_CHANGED', 'Role catalog conflict: ' + role.id);
          doc.roleVersions.push(role);
          current.events.push({
            at: this.env.now(),
            type: 'role.saved',
            text: role.id + ' v' + role.version,
          });
        }
        if (current.cancelRequested) throw new DOMException('Interrupted', 'AbortError');
        doc.executionHead = commit;
        current.issue = undefined;
        current.commit = commit;
        current.status = 'completed';
        current.phase = 'done';
        current.completedAt = this.env.now();
        current.result = envelope.summary;
        current.summary = envelope.summary;
        goal.status = 'completed';
        for (const agent of current.agents)
          if (!agent.completedAt) {
            agent.completedAt = current.completedAt;
            agent.status = 'completed';
          }
        current.events.push({
          at: current.completedAt,
          type: 'goal.completed',
          text: envelope.summary,
        });
      },
      acceptedRoles,
    );
    try {
      this.env.onCompleted?.(projectId, runId);
    } catch (error) {
      await this.update(projectId, runId, (current) =>
        current.events.push({
          at: this.env.now(),
          type: 'delivery.start-failed',
          text: String(error),
        }),
      );
    }
    return { commit };
  }

  async observe(event: RuntimeEvent) {
    if (!recordableRuntimeEvent(event)) return;
    const project = this.env.projects.list().find((p) =>
      this.env.projects
        .get(p.id)
        .snapshot()
        .runs.some((r) => r.id === event.runId),
    );
    if (!project) return;
    const run = this.get(project.id, event.runId);
    if (terminal(run)) return;
    const key = JSON.stringify([event.runId, event.id]);
    if (this.seen.has(key)) return;
    await this.update(project.id, event.runId, (r) => {
      applyRuntimeEvent(r, event, this.env.now());
    });
    // A failed transaction must not suppress a later delivery of the same event.
    this.seen.add(key);
  }

  async dispose() {
    this.closing = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
    await this.eventQueue;
    for (const view of [...this.verificationViews.values()])
      await this.closeVerificationView(view.projectId, view.runId).catch(() => {});
    this.unsubscribe();
  }
}
