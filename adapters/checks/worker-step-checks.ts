import { createHash } from 'node:crypto';
import type { ProjectRegistry } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import type { CheckPort } from '../../core/execution-ports.ts';
import { inScope, terminal } from '../../core/execution-ports.ts';
import type { ToolScope } from '../../core/model-ports.ts';
import type { SegmentEvidencePort } from '../../core/work-segments.ts';
import { validateSegmentEvidence } from '../../core/work-segments.ts';
import type {
  WorkerStepCheckPort,
  WorkerStepCheckPlan,
  WorkerStepCheckResult,
} from '../../core/worker-step-checks.ts';
import {
  validateWorkerStepCheckPlan,
  validateWorkerStepCheckResult,
} from '../../core/worker-step-checks.ts';
import { workerResourcePool } from '../../core/assignment-resources.ts';
import type { EnvironmentExecutors } from '../environments/executors.ts';

type Options = {
  projects: ProjectRegistry;
  checks: CheckPort;
  evidence: SegmentEvidencePort;
  executors: Pick<EnvironmentExecutors, 'get'>;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function blocked(): never {
  throw new DomainError(
    'STEP_CHECK_UNAVAILABLE',
    'The saved worker scope, checks or prepared environment is unavailable.',
  );
}

/** Service-owned checks selected only from the owning run's frozen profile. */
export class WorkerStepChecks implements WorkerStepCheckPort {
  private options: Options;
  constructor(options: Options) {
    this.options = options;
  }

  private selection(scope: ToolScope) {
    const snapshot = this.options.projects.get(scope.projectId).snapshot();
    const owner = scope.ownerRunId || scope.runId;
    const run = snapshot.runs.find((item) => item.id === owner);
    if (
      !run ||
      !owner ||
      owner !== scope.runId ||
      run.workspace !== scope.workspace ||
      run.baseCommit !== scope.baseCommit ||
      scope.readOnly ||
      terminal(run) ||
      run.cancelRequested ||
      run.delegation !== 'buro' ||
      !run.resources
    )
      blocked();
    const agent = run.agents.find((item) => item.session?.id === scope.sessionId);
    const session = agent?.session;
    const profile = run.executionPolicySnapshot?.profile;
    const policy = run.executionPolicySnapshot;
    if (
      !agent ||
      !session ||
      !agent.assignment ||
      agent.status !== 'running' ||
      !profile ||
      !policy ||
      ['coordinator', 'reviewer', 'local_preview', 'delivery_pr', 'production_delivery'].includes(
        session.roleId,
      )
    )
      blocked();
    const paths = run.roleAssignments?.[session.roleId];
    if (
      !paths?.length ||
      !same(paths, scope.allowedPaths) ||
      !same(paths, agent.assignment.paths) ||
      !same(policy.protectedPaths || [], scope.protectedPaths) ||
      paths.some((file) => !inScope(file, policy.allowedPaths, policy.protectedPaths)) ||
      !same(
        scope.commands.map(({ id, command, timeoutMs }) => ({ id, command, timeoutMs })),
        profile.checks.map(({ id, command, timeoutMs }) => ({ id, command, timeoutMs })),
      )
    )
      blocked();
    const decision = run.assignmentResources?.[session.roleId];
    if (run.resources.workerPool && !decision) blocked();
    const resource = decision?.resource || run.resources.worker;
    if (
      resource.client !== 'managed' ||
      !workerResourcePool(run.resources).some((item) => same(item, resource)) ||
      session.runtimeId !== resource.id ||
      session.providerId !== resource.providerId ||
      session.model !== resource.model ||
      session.configurationRevision !== resource.configurationRevision
    )
      blocked();
    const world = this.options.executors.get(scope.workspace);
    if (
      !world ||
      world.workspace !== scope.workspace ||
      world.root !== snapshot.project.root ||
      !world.privateDataIsolation ||
      world.config.provider !== 'native' ||
      !same(world.config, profile.environment || { provider: 'native' })
    )
      blocked();
    // A goal-wide check can legitimately fail until another specialist has finished.
    if (Object.keys(run.roleAssignments || {}).length !== 1) return;
    const ids = run.checkIds;
    if (!ids?.length || ids.length > 8 || new Set(ids).size !== ids.length) blocked();
    const commands = ids.map((id) => profile.checks.find((check) => check.id === id));
    if (commands.some((command) => !command)) blocked();
    const configurationRevision = createHash('sha256')
      .update(
        JSON.stringify({
          projectId: scope.projectId,
          owner,
          scope: {
            ...scope,
            commands: scope.commands.map(({ id, command, timeoutMs }) => ({
              id,
              command,
              timeoutMs,
            })),
          },
          policy,
          ids,
          resource,
          roleVersion: session.roleVersion,
          assignment: agent.assignment,
          roleAssignments: run.roleAssignments,
        }),
      )
      .digest('hex');
    return {
      profile: structuredClone(profile),
      commands: commands.map((command) => command!),
      plan: { version: 1 as const, checkIds: [...ids], configurationRevision },
    };
  }

  plan(scope: ToolScope) {
    return this.selection(scope)?.plan;
  }

  async run(
    scope: ToolScope,
    plan: WorkerStepCheckPlan,
    expectedFingerprint: string,
    signal: AbortSignal,
  ): Promise<WorkerStepCheckResult> {
    signal.throwIfAborted();
    scope = structuredClone(scope);
    plan = structuredClone(plan);
    validateWorkerStepCheckPlan(plan);
    const selected = this.selection(scope);
    if (!selected || !same(selected.plan, plan) || !/^[a-f0-9]{64}$/.test(expectedFingerprint))
      blocked();
    const before = await this.options.evidence.inspect(scope, signal);
    validateSegmentEvidence(before);
    if (
      before.workspaceFingerprint !== expectedFingerprint ||
      before.baseCommit !== scope.baseCommit ||
      before.headCommit !== scope.baseCommit
    )
      blocked();
    signal.throwIfAborted();
    // Await every owned check; an unknown/partial outcome is never treated as an ordinary failure.
    const observed = await this.options.checks.run(
      scope.projectId,
      scope.workspace,
      [...plan.checkIds],
      signal,
      selected.profile,
      { requirePreparedIsolation: true },
    );
    signal.throwIfAborted();
    const after = await this.options.evidence.inspect(scope, signal);
    validateSegmentEvidence(after);
    const latest = this.selection(scope);
    if (
      after.workspaceFingerprint !== expectedFingerprint ||
      after.baseCommit !== scope.baseCommit ||
      after.headCommit !== scope.baseCommit ||
      !latest ||
      !same(latest.plan, plan) ||
      observed.total !== plan.checkIds.length ||
      !Array.isArray(observed.results) ||
      observed.results.length !== observed.total ||
      observed.passed !== observed.results.filter((check) => check.passed === true).length
    )
      blocked();
    let allowance = 2048;
    const snapshot = this.options.projects.get(scope.projectId).snapshot();
    const results: WorkerStepCheckResult['results'] = observed.results.map((check, index) => {
      const command = selected.commands[index];
      if (
        check.name !== command.title ||
        check.command !== command.command ||
        typeof check.passed !== 'boolean' ||
        (check.output !== undefined && typeof check.output !== 'string') ||
        (check.error !== undefined && typeof check.error !== 'string') ||
        (check.exitCode !== undefined &&
          check.exitCode !== null &&
          !Number.isSafeInteger(check.exitCode))
      )
        blocked();
      const code = check.exitCode;
      if (typeof code === 'number' && code < 0 && code !== -1) blocked();
      const status =
        code === 0
          ? 'passed'
          : Number.isSafeInteger(code) && Number(code) > 0
            ? 'failed'
            : 'unavailable';
      if ((status === 'passed') !== check.passed) blocked();
      let diagnostic =
        status === 'passed'
          ? ''
          : check.error || check.output || 'The check did not finish with a known process exit.';
      diagnostic = diagnostic.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      for (const value of [scope.workspace, snapshot.project.root, command.command].sort(
        (a, b) => b.length - a.length,
      ))
        if (value) diagnostic = diagnostic.split(value).join('[redacted]');
      diagnostic = diagnostic.replace(
        /(^|[\s("'=,:\[{])(?:file:\/\/)?\/[^\s:)'"<>\]}]+/g,
        '$1[path]',
      );
      diagnostic = diagnostic.replace(
        /(^|[\s("'=,:\[{])(?:file:\/\/\/)?[a-z]:[\\/][^\s:)'"<>\]}]+/gi,
        '$1[path]',
      );
      diagnostic = diagnostic.slice(0, Math.min(512, allowance));
      allowance -= diagnostic.length;
      return {
        id: plan.checkIds[index],
        name: command.title,
        status,
        ...(code === undefined ? {} : { exitCode: code }),
        diagnostic,
      };
    });
    const result: WorkerStepCheckResult = {
      version: 1,
      outcome: results.every((check) => check.status !== 'unavailable')
        ? 'completed'
        : 'unavailable',
      workspaceFingerprint: expectedFingerprint,
      checkIds: [...plan.checkIds],
      passed: results.filter((check) => check.status === 'passed').length,
      total: results.length,
      results,
    };
    validateWorkerStepCheckResult(plan, expectedFingerprint, result);
    return result;
  }
}
