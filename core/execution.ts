import { runWorkerAssignments } from './worker-assignments.ts';
import { resolveWorkerResource, workerResourcePool } from './assignment-resources.ts';
import type { AssignmentResource } from '../protocol/resources.ts';
import { sessionResource } from '../protocol/resources.ts';
import { recordableRuntimeEvent } from './runtime-events.ts';
import { applyRuntimeEvent } from './runtime-projection.ts';
import { checkContext, changeContext, roleContext } from './agent-context.ts';
import type { ExecutionEnvironmentPort } from './environment-ports.ts';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../protocol/domain.ts';
import { materialInstructions } from '../protocol/context.ts';
import { goalMaterials } from './context.ts';
import type { Run, Role, Goal, DomainEvent, Snapshot } from '../protocol/domain.ts';
import {
  DomainError,
  type AgentRuntime,
  type ProjectRegistry,
  type RuntimeEvent,
  type RuntimeSelection,
  type ProjectDocument,
} from './ports.ts';
import {
  inScope,
  resolveTeam,
  terminal,
  type ExecutionPolicy,
  type WorkspacePort,
  type CheckPort,
  type TeamPlan,
} from './execution-ports.ts';
import {
  withEnvironmentRepair,
  dependencyManifestPreserved,
  environmentRepairInstructions,
} from './environment-repair.ts';
import { unchangedDependencyFailures } from './check-failures.ts';
import { canAccept } from './services.ts';
import {
  TeamPlanSchema,
  EnvelopeSchema,
  ReviewSchema,
  teamOutputSchema,
  envelopeOutputSchema,
  reviewOutputSchema,
} from '../protocol/execution.ts';

type Environment = {
  environments?: ExecutionEnvironmentPort;
  projects: ProjectRegistry;
  runtime: AgentRuntime;
  selection?: RuntimeSelection;
  workspaces: WorkspacePort;
  checks: CheckPort;
  policies: Record<string, ExecutionPolicy>;
  now: () => string;
  id: () => string;
  onCompleted?: (projectId: string, runId: string) => void;
};
/** Durable workflow. Adapters own processes, Git and checks; this class owns decisions. */
export class ExecutionService {
  env: Environment;
  jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  closing = false;
  unsubscribe: () => void;
  eventQueue: Promise<unknown> = Promise.resolve();
  seen = new Set<string>();
  constructor(env: Environment) {
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
  async verify(
    projectId: string,
    runId: string,
    workspace: { path: string; base: string },
    policy: ExecutionPolicy,
    signal: AbortSignal,
  ) {
    let changes = await this.env.workspaces.changes(workspace.path, workspace.base);
    const safe = () =>
      changes.every(
        (f) =>
          inScope(f.path, policy.allowedPaths, policy.protectedPaths) &&
          !f.after.startsWith('[symlink '),
      ) && dependencyManifestPreserved(changes);
    const blocked = () => ({
      changes,
      scope: false,
      checks: {
        passed: 0,
        total: 1,
        results: [
          {
            name: 'Change boundaries and check commands',
            passed: false,
            error:
              'Changes exceed the allowed scope or modify protected package.json fields. Preserve scripts and check configuration.',
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
          return { changes, scope: true, checks: { passed: 0, total: 1, results: [installation] } };
        changes = await this.env.workspaces.changes(workspace.path, workspace.base);
        if (!safe()) return blocked();
      }
    }
    const checks = await this.measure(projectId, runId, 'checks', () =>
      this.env.checks.run(
        projectId,
        workspace.path,
        this.get(projectId, runId).checkIds!,
        signal,
        policy.profile,
      ),
    );
    return { changes, scope: true, checks };
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
  ) {
    if (signal.aborted) throw new DOMException('Interrupted', 'AbortError');
    if (!this.env.runtime.turn) throw Error('The runtime does not support completed phases.');
    const answer = await this.measure(projectId, runId, 'agent.turn', () =>
      this.env.runtime.turn!(threadId, text, { schema, signal, timeoutMs }),
    );
    if (answer.model)
      await this.update(projectId, runId, (r) => {
        if (r.threadId === threadId && r.coordinatorSession)
          r.coordinatorSession.reportedModel = answer.model;
        const session = r.agents.find((agent) => agent.threadId === threadId)?.session;
        if (session) session.reportedModel = answer.model;
      });
    return JSON.parse(answer.text);
  }
  async measure<T>(
    projectId: string,
    runId: string,
    stage: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    try {
      return await action();
    } finally {
      await this.update(projectId, runId, (r) =>
        r.events.push({
          at: this.env.now(),
          type: 'performance.measured',
          text: stage,
          durationMs: performance.now() - started,
        }),
      );
    }
  }
  async start(
    requestId: string,
    fingerprint: string,
    input: { projectId: string; goalId: string; checkIds?: string[] },
  ) {
    if (this.closing) throw new DomainError('STOPPING', 'The service is stopping.');
    const policy = this.policy(input.projectId),
      checkIds = [...new Set(input.checkIds || policy.defaultCheckIds)];
    if (!checkIds.length || checkIds.some((id) => !policy.checks.some((c) => c.id === id)))
      throw new DomainError('INVALID_CHECK', 'Select registered checks.');
    const result = await this.env.projects
      .get(input.projectId)
      .transact(requestId, fingerprint, (doc) => {
        const goal = doc.goals.find((g) => g.id === input.goalId);
        if (!goal) throw new DomainError('NOT_FOUND', 'Goal not found.');
        this.assertEnvironmentRepair(goal, policy);
        if (doc.runs.some((r) => !terminal(r)))
          throw new DomainError('PROJECT_BUSY', 'A goal is already running in this project.');
        const now = this.env.now(),
          run: Run = {
            id: 'R-' + this.env.id(),
            key: goal.id,
            title: goal.title,
            summary: 'Goal queued',
            createdAt: now,
            updatedAt: now,
            threadId: '',
            status: 'queued',
            phase: 'queued',
            delegation: 'buro',
            resources: this.env.selection?.forProject(input.projectId),
            goalId: goal.id,
            contextMaterials: goalMaterials(doc, goal),
            parentRunId: goal.parentRunId,
            baseBranch: policy.profile?.baseBranch,
            outcome: structuredClone(
              goal.outcome || { kind: policy.profile ? 'pull-request' : 'local' },
            ),
            checkIds,
            repairEnvironment: !!goal.repairEnvironment,
            timePolicy: { kind: 'inactivity', idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS },
            executionPolicySnapshot: structuredClone(policy),
            agents: [],
            events: [{ at: now, type: 'run.queued', text: 'Goal queued' }],
            commands: [],
            plan: [],
            changedFiles: [],
            baseline: { passed: 0, total: 0, results: [] },
            acceptance: { passed: 0, total: 0, results: [] },
            specsUnchanged: true,
            scopePreserved: true,
            independentReviewer: false,
            goalText: goal.body + '\n\nAcceptance criteria:\n' + goal.criteria,
            result: '',
            sourceHash: '',
          };
        doc.runs.unshift(run);
        goal.status = 'running';
        goal.runId = run.id;
        return { result: { runId: run.id }, change: { type: 'run.changed', run, goal } };
      });
    this.schedule(input.projectId, result.runId);
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
    if (this.closing) throw new DomainError('STOPPING', 'The service is stopping.');
    const result = await this.env.projects
      .get(input.projectId)
      .transact(requestId, fingerprint, (doc) => {
        const run = doc.runs.find((r) => r.id === input.runId),
          goal = doc.goals.find((g) => g.id === run?.goalId);
        if (!run || !goal) throw new DomainError('NOT_FOUND', 'Run or goal not found.');
        if (
          input.mode === 'recheck' &&
          !run.planSavedAt &&
          !run.roleSnapshots?.some((role) => !['coordinator', 'reviewer'].includes(role.id))
        )
          throw new DomainError(
            'REPLAN_REQUIRED',
            'No plan has been saved. Choose Continue to finish planning.',
          );
        if (!terminal(run) || run.status === 'completed')
          throw new DomainError(
            'INVALID_STATE',
            'Only stopped or unsuccessful runs can be continued.',
          );
        if (doc.runs.some((r) => !terminal(r)))
          throw new DomainError('PROJECT_BUSY', 'A goal is already running in this project.');
        if (!run.workspace || !run.baseCommit)
          throw new DomainError(
            'NO_WORKSPACE',
            'This run has no saved workspace. Start the goal again.',
          );
        const policy = input.useCurrentProfile
            ? this.policy(input.projectId)
            : run.executionPolicySnapshot || this.policy(input.projectId),
          checkIds = [...new Set(input.checkIds || run.checkIds || policy.defaultCheckIds)];
        this.assertEnvironmentRepair(goal, policy);
        if (!checkIds.length || checkIds.some((id) => !policy.checks.some((c) => c.id === id)))
          throw new DomainError('INVALID_CHECK', 'Select registered checks.');
        const now = this.env.now();
        run.attempts ??= [];
        run.attempts.push({
          at: now,
          status: run.status || 'failed',
          result: run.result,
          goalText: run.goalText,
          contextMaterials: run.contextMaterials,
          repairEnvironment: run.repairEnvironment,
          timePolicy: run.timePolicy,
          policy: run.executionPolicySnapshot,
        });
        if (input.mode === 'repair') {
          const updated = goalMaterials(doc, goal);
          const shared = input.useCurrentProfile
            ? updated.filter((m) => m.scope === 'project')
            : (run.contextMaterials || []).filter((m) => m.scope === 'project');
          const selected = new Set(goal.materialIds || []);
          run.contextMaterials = [
            ...new Map(
              [...shared, ...updated.filter((m) => selected.has(m.id))].map((m) => [m.id, m]),
            ).values(),
          ];
        }
        run.repairEnvironment = !!goal.repairEnvironment;
        run.timePolicy = { kind: 'inactivity', idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS };
        run.continuation = { mode: input.mode, instructions: input.instructions, requestedAt: now };
        run.executionPolicySnapshot = structuredClone(policy);
        run.checkIds = checkIds;
        run.status = 'queued';
        run.phase = 'queued';
        run.cancelRequested = false;
        run.completedAt = undefined;
        run.review = undefined;
        run.independentReviewer = false;
        run.issue = undefined;
        run.title = goal.title;
        run.goalText = goal.body + '\n\nAcceptance criteria:\n' + goal.criteria;
        run.agents = run.agents.filter((a) => a.threadId !== run.threadId);
        run.events.push({
          at: now,
          type: 'run.resume-requested',
          text: `${input.mode === 'recheck' ? 'Rechecking' : 'Continuing with repair'} in the saved workspace. ${input.useCurrentProfile ? 'Using the current profile.' : 'Keeping the original profile.'} ${input.instructions}`,
        });
        goal.status = 'running';
        goal.runId = run.id;
        return { result: { runId: run.id }, change: { type: 'run.changed', run, goal } };
      });
    this.schedule(input.projectId, result.runId);
    return result;
  }
  async continueRun(projectId: string, runId: string, signal: AbortSignal, threads: string[]) {
    const run = this.get(projectId, runId),
      policy = withEnvironmentRepair(
        run.executionPolicySnapshot || this.policy(projectId),
        !!run.repairEnvironment,
      );
    if (!run.workspace || !run.baseCommit || !this.env.workspaces.restore)
      throw new DomainError(
        'NO_WORKSPACE',
        'The adapter does not support restoring this workspace.',
      );
    await this.update(projectId, runId, (r) => {
      r.status = 'running';
    });
    const workspace = await this.env.workspaces.restore(
        projectId,
        runId,
        run.workspace,
        run.baseCommit,
        {
          profile: policy.profile,
          repairEnvironment: !!run.repairEnvironment,
          managedEnvironment: !!this.env.environments && !!policy.profile,
          materials: run.contextMaterials,
        },
      ),
      initial = this.env.projects.get(projectId).snapshot();
    if (this.env.environments && policy.profile)
      await this.prepareEnvironment(projectId, runId, workspace, policy, signal);
    const roles =
      run.roleSnapshots?.filter((role) => !['coordinator', 'reviewer'].includes(role.id)) || [];
    if (!roles.length && !run.planSavedAt) {
      if (run.continuation?.mode === 'recheck')
        throw new DomainError(
          'NO_TEAM',
          'No plan has been saved. Continue with repair to finish planning.',
        );
      await this.planAndImplement(projectId, runId, workspace, policy, signal, threads, true);
      return;
    }
    const team = { roles, origins: run.roleOrigins || {} },
      proposed = roles.filter(
        (role) =>
          team.origins[role.id] === 'created' && !initial.roles.some((r) => r.id === role.id),
      );
    const ask = (threadId: string, text: string, schema: unknown) =>
      this.completedTurn(
        projectId,
        runId,
        threadId,
        text,
        schema,
        signal,
        run.timePolicy?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      );
    let root = { threadId: run.threadId },
      envelope: ReturnType<typeof EnvelopeSchema.parse> = {
        status: 'success',
        summary: 'Rechecking the saved implementation: ' + run.title,
        artifacts: run.changedFiles.map((c) => c.path),
        notesForNextAgent: '',
      };
    if (run.continuation?.mode === 'repair') {
      const instructions =
        'Continue the existing goal in its saved workspace. Do not start agents: Buro dispatches workers. Do not commit or modify protected files. Project context: ' +
        (policy.context || '') +
        materialInstructions(run.contextMaterials || [], workspace.path, true) +
        (run.repairEnvironment ? '\n' + environmentRepairInstructions : '');
      if (run.threadId && this.env.runtime.resume) {
        root = await this.env.runtime.resume({
          projectId,
          runId,
          threadId: run.threadId,
          workspace: workspace.path,
          instructions,
        });
        await this.update(projectId, runId, (r) =>
          r.events.push({
            at: this.env.now(),
            type: 'runtime.resumed',
            threadId: root.threadId,
            text: 'Original coordinator session restored',
          }),
        );
      } else {
        root = await this.startRuntime({
          projectId,
          runId,
          purpose: 'coordination',
          workspace: workspace.path,
          instructions,
        });
        await this.update(projectId, runId, (r) => {
          r.threadId = root.threadId;
          r.events.push({
            at: this.env.now(),
            type: 'runtime.replaced',
            threadId: root.threadId,
            text: 'Opened a new session with the saved workspace and context',
          });
        });
      }
      threads.push(root.threadId);
      await this.phase(
        projectId,
        runId,
        'repair',
        'Continuing the saved session with user clarification',
      );
      await this.update(projectId, runId, (r) => {
        r.delegation = 'buro';
      });
      const workerResults = await this.dispatchWorkers(
        projectId,
        runId,
        roles,
        workspace,
        policy,
        signal,
        threads,
        ask,
      );
      envelope = EnvelopeSchema.parse(
        await ask(
          root.threadId,
          `Continue without restarting the implementation. Goal: ${run.goalText}. Clarification: ${run.continuation.instructions}. Previous result: ${run.result}. Checks: ${JSON.stringify(checkContext(run.acceptance))}. Allowed paths: ${JSON.stringify(policy.allowedPaths)}. Plan: ${JSON.stringify(run.plan)}. ${run.repairEnvironment ? environmentRepairInstructions : ''} Buro has dispatched the saved team. Worker results: ${JSON.stringify(workerResults)}. Integrate these changes; do not start agents. The service starts an independent reviewer.`,
          envelopeOutputSchema,
        ),
      );
    }
    await this.validateAndAccept({
      projectId,
      runId,
      signal,
      threads,
      workspace,
      policy: run.continuation?.mode === 'recheck' ? { ...policy, maxRepairs: 0 } : policy,
      run,
      initial,
      team,
      proposed,
      root,
      envelope,
      ask,
    });
  }
  schedule(projectId: string, runId: string) {
    if (this.jobs.has(runId) || this.closing) return;
    const run = this.get(projectId, runId);
    if (terminal(run)) return;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.execute(projectId, runId, controller.signal))
      .finally(() => this.jobs.delete(runId));
    this.jobs.set(runId, { controller, promise });
  }
  get(projectId: string, runId: string) {
    const run = this.env.projects
      .get(projectId)
      .snapshot()
      .runs.find((r) => r.id === runId);
    if (!run) throw new DomainError('NOT_FOUND', 'Run not found.');
    return run;
  }
  async update(
    projectId: string,
    runId: string,
    apply: (run: Run, goal: Goal, doc: ProjectDocument) => void,
    roles?: Role[],
  ) {
    return this.env.projects
      .get(projectId)
      .transact('internal-' + this.env.id(), 'internal', (doc) => {
        const run = doc.runs.find((r) => r.id === runId),
          goal = doc.goals.find((g) => g.id === run?.goalId);
        if (!run || !goal) throw new DomainError('NOT_FOUND', 'Run or goal was deleted.');
        apply(run, goal, doc);
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
  async phase(projectId: string, runId: string, phase: Run['phase'], text: string) {
    await this.update(projectId, runId, (r) => {
      r.phase = phase;
      r.events.push({ at: this.env.now(), type: 'phase.' + phase, text });
    });
  }
  async cancel(
    requestId: string,
    fingerprint: string,
    input: { projectId: string; runId: string },
  ) {
    const result = await this.env.projects
      .get(input.projectId)
      .transact(requestId, fingerprint, (doc) => {
        const run = doc.runs.find((r) => r.id === input.runId),
          goal = doc.goals.find((g) => g.id === run?.goalId);
        if (!run || !goal) throw new DomainError('NOT_FOUND', 'Run not found.');
        if (!terminal(run)) {
          run.cancelRequested = true;
          run.status = 'canceling';
          run.updatedAt = this.env.now();
          run.events.push({
            at: this.env.now(),
            type: 'run.cancel-requested',
            text: 'Stop requested',
          });
        }
        return { result: { runId: run.id }, change: { type: 'run.changed', run, goal } };
      });
    this.jobs.get(input.runId)?.controller.abort();
    return result;
  }
  async recover() {
    for (const project of this.env.projects.list())
      for (const run of this.env.projects.get(project.id).snapshot().runs) {
        if (terminal(run)) continue;
        if (run.status === 'queued' && !run.cancelRequested) this.schedule(project.id, run.id);
        else
          await this.finish(
            project.id,
            run.id,
            'interrupted',
            'The service stopped during execution. The workspace is preserved; execution was not automatically retried.',
          );
      }
  }
  async finish(projectId: string, runId: string, status: Run['status'], text: string) {
    await this.eventQueue;
    await this.update(projectId, runId, (r, g) => {
      r.status = status;
      r.phase = 'done';
      r.completedAt = this.env.now();
      r.result = text;
      r.summary = text;
      g.status = status === 'completed' ? 'completed' : 'failed';
      for (const a of r.agents)
        if (!a.completedAt) {
          a.completedAt = r.completedAt;
          a.status = status === 'completed' ? 'completed' : 'interrupted';
        }
      r.events.push({
        at: r.completedAt,
        type: status === 'completed' ? 'goal.completed' : 'run.' + status,
        text,
      });
    });
  }
  async execute(projectId: string, runId: string, signal: AbortSignal) {
    const record = this.get(projectId, runId),
      policy = withEnvironmentRepair(
        record.executionPolicySnapshot || this.policy(projectId),
        !!record.repairEnvironment,
      ),
      threads: string[] = [];
    const abort = () => {
      if (signal.aborted || this.get(projectId, runId).cancelRequested)
        throw new DOMException('Interrupted', 'AbortError');
    };
    try {
      abort();
      if (this.get(projectId, runId).continuation) {
        await this.continueRun(projectId, runId, signal, threads);
        return;
      }
      await this.update(projectId, runId, (r) => {
        r.status = 'running';
      });
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
      abort();
      await this.update(projectId, runId, (r) => {
        r.workspace = workspace.path;
        r.baseCommit = workspace.base;
        if (r.repairEnvironment)
          r.events.push({
            at: this.env.now(),
            type: 'environment.isolated',
            text: 'Environment repair is allowed for this goal. Dependencies and caches are isolated from the source project.',
          });
      });
      await this.planAndImplement(projectId, runId, workspace, policy, signal, threads);
    } catch (error) {
      await this.finish(
        projectId,
        runId,
        signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
          ? 'interrupted'
          : error instanceof DomainError &&
              [
                'BASELINE_CHECKS_FAILED',
                'ENVIRONMENT_FAILED',
                'ENVIRONMENT_UNAVAILABLE',
                'FIXED_RUNTIME_UNAVAILABLE',
              ].includes(error.code)
            ? 'needs-attention'
            : 'failed',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await Promise.all(threads.map((id) => this.env.runtime.release?.(id)));
      const workspace = this.get(projectId, runId).workspace;
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
    }
  }
  async planAndImplement(
    projectId: string,
    runId: string,
    workspace: { path: string; base: string },
    policy: ExecutionPolicy,
    signal: AbortSignal,
    threads: string[],
    restoreThread = false,
  ) {
    const baseline = (await this.verify(projectId, runId, workspace, policy, signal)).checks;
    await this.update(projectId, runId, (r) => {
      r.baseline = baseline;
    });
    const initial = this.env.projects.get(projectId).snapshot(),
      run = this.get(projectId, runId);
    await this.phase(projectId, runId, 'planning', 'Coordinator is planning and selecting roles');
    const coordinator = initial.roles.find((r) => r.id === 'coordinator');
    const input = {
      projectId,
      runId,
      purpose: 'coordination' as const,
      workspace: workspace.path,
      instructions:
        (coordinator?.instructions || 'Coordinate work on the goal.') +
        '\nDo not start agents: Buro dispatches workers. Do not run Git commit/reset/checkout. An external service accepts changes. Modify only allowed files. Do not touch .git. Network use is limited to preparing project tools and dependencies when a managed environment is provided.\nProject context: ' +
        (policy.context || '') +
        materialInstructions(run.contextMaterials || [], workspace.path, true) +
        (run.repairEnvironment ? '\n' + environmentRepairInstructions : ''),
    };
    await this.update(projectId, runId, (r) => {
      r.delegation = 'buro';
      r.coordinatorSession ||= {
        id: 'S-' + this.env.id(),
        roleId: 'coordinator',
        roleVersion: coordinator?.version || 0,
        ...sessionResource(r.resources, 'coordination', this.env.runtime.id),
      };
    });
    const root =
      restoreThread && run.threadId && this.env.runtime.resume
        ? await this.env.runtime.resume({ ...input, threadId: run.threadId })
        : await this.env.runtime.start(input);
    if (restoreThread)
      await this.update(projectId, runId, (r) =>
        r.events.push({
          at: this.env.now(),
          type: 'runtime.resumed',
          threadId: root.threadId,
          text: 'Resumed planning in the saved workspace',
        }),
      );
    threads.push(root.threadId);
    await this.update(projectId, runId, (r) => {
      r.threadId = root.threadId;
    });
    const ask = (threadId: string, text: string, schema: unknown) =>
      this.completedTurn(
        projectId,
        runId,
        threadId,
        text,
        schema,
        signal,
        run.timePolicy?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      );
    let plan: TeamPlan | undefined,
      team: ReturnType<typeof resolveTeam> | undefined,
      correction = '',
      planningRoles = initial.roles;
    for (let attempt = 0; attempt < 2; attempt++) {
      const workerCatalog = planningRoles.filter(
        (role) => !['local_preview', 'delivery_pr', 'production_delivery'].includes(role.id),
      );
      const pool = run.resources ? workerResourcePool(run.resources) : [];
      const answer = await ask(
        root.threadId,
        `First, only inspect the project and create a plan; do not edit files or start agents.
Goal: ${run.title}
${run.goalText}
Only these paths may change: ${JSON.stringify(policy.allowedPaths)}. Protected paths: ${JSON.stringify(policy.protectedPaths || [])}. Project context: ${policy.context || ''}.
For a small coherent change, return an empty team and implement directly as coordinator. Otherwise choose between 1 and ${policy.maxWorkers} workers only when delegation is useful. Reuse suitable catalog roles where possible. If none fits, create a concise reusable role without this goal, filenames or specific test values. New roles also require roleId, for example react_developer or dependency-maintainer: lowercase Latin letters, digits, underscores and hyphens, starting with a letter, up to 64 characters. steps.owner must use the exact roleId, not the title. The coordinator and independent reviewer are supplied by the service; exclude them from team. local_preview/delivery_pr/production_delivery run separately after acceptance; exclude them from team. Assign nonoverlapping paths to workers. Steps may use coordinator/reviewer as owners.
Baseline checks: ${JSON.stringify(checkContext(baseline))}
${run.repairEnvironment ? environmentRepairInstructions : ''}
Catalog: ${JSON.stringify(roleContext(workerCatalog))}
Permitted worker runtimes: ${JSON.stringify(pool.map(({ id, client, providerId, model, local }) => ({ id, client, providerId, model, local })))}.
Choose a runtime for each worker only from this pool when that improves its assignment. Use runtimeId null and runtimeReason "" to follow its user preference or the profile default. Respect fixed user preferences. Explain a different choice when a user prefers another runtime. A runtime selection applies only to this assignment; never put it in reusable role instructions or create a new connection. Runtime metadata is not evidence of coding quality; the service still checks capabilities, scope, tests and independent review.
${correction}`,
        teamOutputSchema,
      );
      try {
        const candidatePlan = TeamPlanSchema.parse(answer);
        const candidateTeam = resolveTeam(candidatePlan, planningRoles, policy, this.env.now());
        let assignments: Record<string, AssignmentResource> | undefined;
        if (run.resources)
          assignments = Object.fromEntries(
            candidateTeam.roles.map((role) => [
              role.id,
              resolveWorkerResource(
                run.resources!,
                role,
                candidatePlan.team.find((worker) => worker.roleId === role.id),
              ),
            ]),
          );
        else if (
          candidatePlan.team.some((worker) => worker.runtimeId != null) ||
          candidateTeam.roles.some(
            (role) => role.runtimePreference && role.runtimePreference.mode !== 'auto',
          )
        )
          throw new DomainError(
            'RESOURCE_PROFILE_REQUIRED',
            'Model selection requires a saved execution resource profile.',
          );
        await this.update(projectId, runId, (r, _goal, doc) => {
          // A user changing a pin while the model plans must get a fresh decision, not stale dispatch.
          for (const role of candidateTeam.roles) {
            const current = doc.roleVersions.filter((item) => item.id === role.id).at(-1);
            if (
              (candidateTeam.origins[role.id] === 'reused' && current?.version !== role.version) ||
              (candidateTeam.origins[role.id] === 'created' && current)
            )
              throw new DomainError(
                'ROLE_CHANGED',
                `Role ${role.id} changed during planning. Choose from the updated catalog.`,
              );
          }
          r.plan = candidatePlan.steps;
          r.planSavedAt = this.env.now();
          r.summary = candidatePlan.summary;
          r.roleSnapshots = [
            ...initial.roles.filter((role) => ['coordinator', 'reviewer'].includes(role.id)),
            ...candidateTeam.roles,
          ];
          r.roleOrigins = candidateTeam.origins;
          r.roleAssignments = Object.fromEntries(
            candidatePlan.team.map((worker) => [worker.roleId, worker.paths]),
          );
          if (assignments) r.assignmentResources = assignments;
          for (const role of candidateTeam.roles) {
            r.events.push({
              at: this.env.now(),
              type: candidateTeam.origins[role.id] === 'created' ? 'role.proposed' : 'role.reused',
              text: `${role.id}: ${role.title}`,
            });
            const selected = assignments?.[role.id];
            if (selected)
              r.events.push({
                at: this.env.now(),
                type: 'agent.resource-selected',
                text: `${role.id}: ${selected.resource.model || selected.resource.id}. ${selected.reason}`,
              });
          }
          r.events.push({ at: this.env.now(), type: 'plan.saved', text: candidatePlan.summary });
        });
        plan = candidatePlan;
        team = candidateTeam;
        break;
      } catch (e) {
        if (e instanceof DomainError && e.code === 'FIXED_RUNTIME_UNAVAILABLE') throw e;
        if (e instanceof DomainError && e.code === 'ROLE_CHANGED')
          planningRoles = this.env.projects.get(projectId).snapshot().roles;
        correction = 'Correct the previous plan: ' + String(e);
        await this.update(projectId, runId, (r) =>
          r.events.push({ at: this.env.now(), type: 'plan.rejected', text: correction }),
        );
      }
    }
    if (!plan || !team) throw Error('The revised plan did not pass validation. ' + correction);
    const proposed = team.roles.filter((r) => team!.origins[r.id] === 'created');
    await this.phase(projectId, runId, 'implementation', 'Workers are implementing the plan');
    const workerResults = await this.dispatchWorkers(
      projectId,
      runId,
      team.roles,
      workspace,
      policy,
      signal,
      threads,
      ask,
    );
    const envelope = EnvelopeSchema.parse(
      await ask(
        root.threadId,
        `Plan accepted. Buro has executed the assigned workers. If team is empty, implement directly. Integrate the current changes and repair inconsistencies. Do not start agents: worker dispatch and independent review belong to Buro. Do not commit. Prefer targeted local verification; the service runs the registered acceptance commands, so do not repeat a full successful suite without a reason.
Plan: ${JSON.stringify(plan)}
Worker results: ${JSON.stringify(workerResults)}
Baseline checks: ${JSON.stringify(checkContext(baseline))}
Use relevant user materials at their staged paths. Return the formal execution result.`,
        envelopeOutputSchema,
      ),
    );
    await this.validateAndAccept({
      projectId,
      runId,
      signal,
      threads,
      workspace,
      policy,
      run,
      initial,
      team,
      proposed,
      root,
      envelope,
      ask,
    });
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
    return runWorkerAssignments({
      projectId,
      run: this.get(projectId, runId),
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
  async validateAndAccept(ctx: {
    projectId: string;
    runId: string;
    signal: AbortSignal;
    threads: string[];
    workspace: { path: string; base: string };
    policy: ExecutionPolicy;
    run: Run;
    initial: Snapshot;
    team: ReturnType<typeof resolveTeam>;
    proposed: Role[];
    root: { threadId: string };
    envelope: ReturnType<typeof EnvelopeSchema.parse>;
    ask: (threadId: string, text: string, schema: unknown) => Promise<any>;
  }) {
    const {
      projectId,
      runId,
      signal,
      threads,
      workspace,
      policy,
      run,
      initial,
      team,
      proposed,
      root,
      ask,
    } = ctx;
    let envelope = ctx.envelope;
    const abort = () => {
      if (signal.aborted || this.get(projectId, runId).cancelRequested)
        throw new DOMException('Interrupted', 'AbortError');
    };
    let accepted = false,
      finalText = '',
      acceptedRoles: Role[] = [];
    for (let iteration = 0; iteration <= policy.maxRepairs; iteration++) {
      abort();
      await this.phase(
        projectId,
        runId,
        'checking',
        'The service is verifying changes and running independent checks',
      );
      const { changes, scope, checks } = await this.verify(
        projectId,
        runId,
        workspace,
        policy,
        signal,
      );
      await this.update(projectId, runId, (r) => {
        r.changedFiles = changes;
        r.scopePreserved = scope;
        r.specsUnchanged = scope;
        r.acceptance = checks;
        r.events.push({
          at: this.env.now(),
          type: 'checks.completed',
          text: `Checks: ${checks.passed}/${checks.total}; boundaries: ${scope ? 'respected' : 'violated'}`,
        });
      });
      const environment = unchangedDependencyFailures(
        this.get(projectId, runId).baseline.results,
        checks.results,
      );
      if (environment.length && (!run.repairEnvironment || iteration === policy.maxRepairs)) {
        const message =
          'The source environment blocks acceptance: ' +
          environment.join(', ') +
          '. Dependency declaration errors match the baseline. The workspace is preserved; update check settings or repair dependencies and rerun checks.';
        await this.update(projectId, runId, (r) => {
          r.issue = { code: 'BASELINE_CHECKS_FAILED', message, checks: environment };
        });
        throw new DomainError('BASELINE_CHECKS_FAILED', message);
      }
      if (
        !scope ||
        !checks.total ||
        checks.passed !== checks.total ||
        envelope.status !== 'success'
      ) {
        if (iteration === policy.maxRepairs)
          throw Error(
            `Acceptance failed: ${checks.passed}/${checks.total} checks; boundaries ${scope ? 'respected' : 'violated'}. ${envelope.summary}`,
          );
        await this.phase(
          projectId,
          runId,
          'repair',
          'Checks returned to the same coordinator session',
        );
        envelope = EnvelopeSchema.parse(
          await ask(
            root.threadId,
            `Repair the result in this same workspace. Goal: ${run.goalText}. Boundaries respected: ${scope}. Checks: ${JSON.stringify(checkContext(checks))}. Do not start agents. Do not modify protected instructions or check commands. ${run.repairEnvironment ? environmentRepairInstructions : ''} Return the formal result.`,
            envelopeOutputSchema,
          ),
        );
        continue;
      }
      await this.phase(projectId, runId, 'review', 'Independent reviewer is checking the result');
      const reviewerRole = initial.roles.find((r) => r.id === 'reviewer');
      const reviewerSession = {
        id: 'S-' + this.env.id(),
        roleId: 'reviewer',
        roleVersion: reviewerRole?.version || 0,
        ...sessionResource(this.get(projectId, runId).resources, 'review', this.env.runtime.id),
        parentId: this.get(projectId, runId).coordinatorSession?.id,
      };
      await this.update(projectId, runId, (r) => {
        r.agents.push({
          session: reviewerSession,
          threadId: reviewerSession.id,
          name: 'reviewer',
          agentPath: '/root/reviewer',
          startedAt: this.env.now(),
          completedAt: '',
          messages: [],
          commands: 0,
          status: 'starting',
        });
        r.events.push({
          at: this.env.now(),
          type: 'agent.dispatch-requested',
          threadId: reviewerSession.id,
          text: 'Independent reviewer',
        });
      });
      const reviewer = await this.startRuntime({
        projectId,
        runId,
        workspace: workspace.path,
        readOnly: true,
        purpose: 'review',
        instructions:
          (reviewerRole?.instructions ||
            'Independently verify the goal and correctness of the changes.') +
          '\nRead only. Do not modify files, start agents or use the network. You did not participate in implementation. Request changes for blocking issues.\nProject context: ' +
          (policy.context || '') +
          materialInstructions(run.contextMaterials || [], workspace.path, true),
      });
      threads.push(reviewer.threadId);
      await this.update(projectId, runId, (r) => {
        const agent = r.agents.find((a) => a.session?.id === reviewerSession.id)!;
        agent.threadId = reviewer.threadId;
        agent.status = 'running';
        r.events.push({
          at: this.env.now(),
          type: 'agent.started',
          threadId: reviewer.threadId,
          text: 'Independent reviewer',
        });
      });
      const review = ReviewSchema.parse(
        await ask(
          reviewer.threadId,
          `Review goal: ${run.title}
${run.goalText}
Allowed paths: ${JSON.stringify(policy.allowedPaths)}.
Executor result: ${JSON.stringify(envelope)}
Independent checks: ${JSON.stringify(checkContext(checks))}
Changed files: ${JSON.stringify(changeContext(changes))}. Read the actual diff against ${workspace.base} and relevant files in the workspace; the file list is not a substitute for inspecting changes.
Read relevant sources and verify actual correctness, including preservation of existing behavior. Return approved only when there are no blocking findings.`,
          reviewOutputSchema,
        ),
      );
      await this.eventQueue;
      await this.update(projectId, runId, (r) => {
        r.review = review;
        r.independentReviewer = true;
        const a = r.agents.find((a) => a.threadId === reviewer.threadId)!;
        a.completedAt = this.env.now();
        a.status = 'completed';
        r.events.push({
          at: this.env.now(),
          type: 'agent.completed',
          threadId: a.threadId,
          text: review.summary,
        });
        r.events.push({
          at: this.env.now(),
          type: 'review.completed',
          text: review.verdict + ': ' + review.summary,
        });
      });
      await this.env.runtime.release?.(reviewer.threadId);
      await this.eventQueue;
      const observed = this.get(projectId, runId);
      const workersReady = team.roles.every((role) => {
        if (observed.delegation !== 'buro')
          return observed.agents.some((a) => a.name === role.id && a.status === 'completed');
        const assignment = [...observed.agents]
          .reverse()
          .find((a) => a.session?.roleId === role.id);
        return (
          assignment?.status === 'completed' && assignment.session?.result?.status === 'success'
        );
      });
      accepted =
        workersReady &&
        envelope.status === 'success' &&
        canAccept({
          testsPassed: checks.total > 0 && checks.passed === checks.total,
          scopePreserved: scope,
          specsUnchanged: scope,
          review: { verdict: review.verdict, blockingFindings: review.blockingFindings.length },
        });
      finalText = envelope.summary;
      if (accepted) break;
      if (iteration === policy.maxRepairs)
        throw Error(
          `Acceptance failed: ${checks.passed}/${checks.total} checks; scope=${scope}; workers=${workersReady}; ${review.blockingFindings.join('; ') || review.verdict}; ${envelope.summary}`,
        );
      await this.phase(
        projectId,
        runId,
        'repair',
        'Findings returned to the same coordinator session',
      );
      envelope = EnvelopeSchema.parse(
        await ask(
          root.threadId,
          `Repair the result in this same session. Acceptance failed. Boundaries respected: ${scope}. All assigned workers actually started and finished: ${workersReady}.
Checks: ${JSON.stringify(checkContext(checks))}
Independent review: ${JSON.stringify(review)}
Do not start agents. Do not modify checks or instructions, and do not commit. Return a new formal result.`,
          envelopeOutputSchema,
        ),
      );
    }
    abort();
    // Fail closed if a role with the proposed id was edited while agents were running.
    const catalog = this.env.projects.get(projectId).snapshot().roles;
    for (const role of proposed) {
      const current = catalog.find((r) => r.id === role.id);
      if (
        current &&
        JSON.stringify({ ...current, createdAt: '', updatedAt: '' }) !==
          JSON.stringify({ ...role, createdAt: '', updatedAt: '' })
      )
        throw Error('Role catalog conflict: ' + role.id);
      if (!current) acceptedRoles.push(role);
    }
    const commit = await this.measure(projectId, runId, 'workspace.checkpoint', () =>
      this.env.workspaces.checkpoint(workspace.path, runId),
    );
    abort();
    await this.eventQueue;
    await this.update(
      projectId,
      runId,
      (r, g, doc) => {
        for (const role of acceptedRoles) {
          if (doc.roleVersions.some((x) => x.id === role.id))
            throw Error('Role catalog conflict: ' + role.id);
          doc.roleVersions.push(role);
          r.events.push({
            at: this.env.now(),
            type: 'role.saved',
            text: role.id + ' v' + role.version,
          });
        }
        if (r.cancelRequested) throw new DOMException('Interrupted', 'AbortError');
        doc.executionHead = commit;
        r.issue = undefined;
        r.commit = commit;
        r.status = 'completed';
        r.phase = 'done';
        r.completedAt = this.env.now();
        r.result = finalText;
        r.summary = finalText;
        g.status = 'completed';
        for (const a of r.agents)
          if (!a.completedAt) {
            a.completedAt = r.completedAt;
            a.status = 'completed';
          }
        r.events.push({ at: r.completedAt, type: 'goal.completed', text: finalText });
      },
      acceptedRoles,
    );
    try {
      this.env.onCompleted?.(projectId, runId);
    } catch (error) {
      await this.update(projectId, runId, (r) =>
        r.events.push({ at: this.env.now(), type: 'delivery.start-failed', text: String(error) }),
      );
    }
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
    this.unsubscribe();
  }
}
