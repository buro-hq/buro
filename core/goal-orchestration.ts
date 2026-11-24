import type { ExecutionService, ExecutionContext, CheckedRun } from './execution.ts';
import type { ExecutionActionOperations } from './execution-actions.ts';
import type { Run, Role } from '../protocol/domain.ts';
import type { ToolResult } from './model-ports.ts';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../protocol/domain.ts';
import { materialInstructions } from '../protocol/context.ts';
import { operationIds } from './operation-catalog.ts';
import { sessionResource } from '../protocol/resources.ts';
import { DomainError } from './ports.ts';
import { assertRunReconciled } from './run-reconciliation.ts';
import { terminal, isWorkerRoleId } from './execution-ports.ts';
import { workerResourcePool } from './assignment-resources.ts';
import { checkContext } from './agent-context.ts';
import { environmentRepairInstructions } from './environment-repair.ts';

const observed = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });

/** These are known proposal/precondition failures, never uncertain effects or configuration errors. */
const correctable = new Set([
  'EXECUTION_ACTION_ARGUMENTS',
  'INVALID_EXECUTION_DECISION',
  'EXECUTION_ACTION_UNAVAILABLE',
  'INVALID_AGENT_OUTPUT',
  'INVALID_PLAN',
  'INVALID_ASSIGNMENT',
  'ASSIGNMENT_EXISTS',
  'INVALID_RUNTIME_REASON',
  'RUNTIME_NOT_ALLOWED',
  'ROLE_RUNTIME_FIXED',
  'RUNTIME_REASON_REQUIRED',
  'ROLE_CHANGED',
  'CHECKS_REQUIRED',
  'REVIEW_REQUIRED',
  'ACCEPTANCE_NOT_READY',
  'VERIFICATION_REVISION_CHANGED',
]);

function assertCurrent(service: ExecutionService, ctx: ExecutionContext): Run {
  const run = service.get(ctx.projectId, ctx.runId);
  if (run.attemptId !== ctx.attemptId)
    throw new DomainError('STALE_RUN_ATTEMPT', 'Another attempt owns this goal.');
  assertRunReconciled(run);
  ctx.signal.throwIfAborted();
  if (run.cancelRequested) throw new DOMException('Interrupted', 'AbortError');
  if (run.status !== 'running')
    throw new DomainError('INVALID_STATE', 'The run is no longer executing.');
  service.assertActionCatalog(run);
  return run;
}

/** One session chooses work; registered actions expose bounded service operations, not a workflow. */
export async function runGoalOrchestration(
  service: ExecutionService,
  ctx: ExecutionContext,
  restoreSession = false,
) {
  const { projectId, runId, workspace, policy, signal, threads } = ctx;
  const attemptId = ctx.attemptId;
  if (!attemptId) throw new DomainError('STALE_RUN_ATTEMPT', 'An acquired attempt is required.');
  let run = assertCurrent(service, ctx);
  const actions = service.env.actions;
  actions.assertSealed();
  const runs = service.env.projects.get(projectId).runs;
  if (!runs) throw new DomainError('RUN_COMMANDS_REQUIRED', 'Run commands are unavailable.');
  if (service.env.environments && policy.profile)
    await service.prepareEnvironment(projectId, runId, workspace, policy, signal);
  assertCurrent(service, ctx);
  const role = run.roleSnapshots?.find((item) => item.id === 'coordinator');
  const decision = run.roleResources?.coordinator;
  if (!role || !decision)
    throw new DomainError('INVALID_ASSIGNMENT', 'The admitted coordinator grant is missing.');
  const instructions =
    role.instructions +
    '\nYou own the goal. Choose the next useful action from the registered capabilities using actual evidence. ' +
    'Use repository tools to inspect, plan, implement and repair as needed. You may work directly or delegate specialists. ' +
    'There is no mandatory planning, delegation, integration or repair sequence. A working plan grants no permissions. ' +
    'Do not start native child agents; delegate through Buro actions. Do not commit, reset, checkout or modify .git. ' +
    'Respect the saved scope and protected files. Service checks and fresh independent review must approve the exact final revision. ' +
    'Do not claim a tool result, check or review you did not observe. Ask the user when information is missing.\n' +
    'When the candidate is ready, request finish. The service runs missing checks and independent review before acceptance, and returns real failures for repair. You may request checks or review earlier when useful. A repository command result does not replace service verification.\n' +
    'A reviewer can help diagnose failing tests. Repeated unchanged check results require investigation or repair, not another identical check by default. Reassign the same specialist with updated assignment instructions/task when needed; select another available runtime for the next assignment if its result warrants it. Workers can request a runtime change in notesForNextAgent.\n' +
    'Project context: ' +
    (policy.context || '') +
    materialInstructions(run.contextMaterials || [], workspace.path, true) +
    (run.repairEnvironment ? '\n' + environmentRepairInstructions : '');
  const input = {
    projectId,
    runId,
    workspace: workspace.path,
    instructions,
    purpose: 'coordination' as const,
    operationId: operationIds.coordination,
    roleId: role.id,
    readOnly: false,
  };
  const resume =
    restoreSession &&
    run.threadId &&
    service.env.runtime.resume &&
    decision.resource.capabilities.resumeSessions;
  if (!resume) {
    await service.update(projectId, runId, (current) => {
      current.coordinatorSession = {
        id: 'S-' + service.env.id(),
        roleId: role.id,
        roleVersion: role.version,
        ...sessionResource(current.resources, 'coordination', service.env.runtime.id, decision),
        ...(current.coordinatorSession ? { parentId: current.coordinatorSession.id } : {}),
      };
    });
  }
  assertCurrent(service, ctx);
  const root = resume
    ? await service.env.runtime.resume!({ ...input, threadId: run.threadId })
    : await service.startRuntime(input);
  threads.push(root.threadId);
  await service.update(projectId, runId, (current) => {
    current.threadId = root.threadId;
    current.delegation = 'buro';
    current.events.push({
      at: service.env.now(),
      type: resume ? 'runtime.resumed' : 'runtime.started',
      threadId: root.threadId,
      text: 'Goal coordinator is choosing work from registered actions',
    });
  });
  await service.phase(projectId, runId, 'implementation', 'Coordinator is working on the goal');
  let checked: CheckedRun | undefined;
  let expectedInput = await runs.delegationContext(runId);
  let expectedRoles: Role[] = [];
  let expectedAssignments = await runs.assignments(runId);
  const invalidate = async () => {
    assertCurrent(service, ctx);
    checked = undefined;
    await service.closeVerificationView(projectId, runId);
    await service.update(projectId, runId, (current) => {
      current.review = undefined;
      current.independentReviewer = false;
      current.verificationEvidence = undefined;
    });
  };
  const operations: ExecutionActionOperations = {
    async delegate({ worker }) {
      assertCurrent(service, ctx);
      const grant = await runs.transaction(
        { id: 'delegate-' + service.env.id(), fingerprint: 'run.delegate-worker' },
        (tx) =>
          tx.delegateWorker({
            runId,
            assignmentId: 'assignment-' + service.env.id(),
            now: service.env.now(),
            worker,
            expectedRoleVersion:
              expectedAssignments.find((item) => item.role.id === worker.roleId)?.role.version ??
              expectedRoles.find((item) => item.id === worker.roleId)?.version ??
              null,
            expectedInput,
            expectedAttemptId: attemptId,
          }),
      );
      assertCurrent(service, ctx);
      const before = service.get(projectId, runId);
      const priorFeedback = JSON.stringify({
        checks: checkContext(before.acceptance),
        review: before.review,
      });
      await invalidate();
      await service.phase(projectId, runId, 'implementation', 'Running the selected specialist');
      try {
        const result = await service.dispatchWorkers(
          projectId,
          runId,
          [grant.role],
          workspace,
          policy,
          signal,
          threads,
          (thread, text, schema) =>
            service.completedTurn(
              projectId,
              runId,
              thread,
              text + '\nService-observed feedback for this assignment: ' + priorFeedback,
              schema,
              signal,
              run.timePolicy?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
            ),
        );
        // Routing/session metadata stays in its authority; current worker envelopes are
        // supplied once in the next state packet rather than serialized a second time.
        return observed({
          assignmentId: grant.id,
          roleId: grant.role.id,
          results: result.map((session) => ({
            status: session.result?.status,
            summary: session.result?.summary,
          })),
        });
      } catch (error) {
        assertCurrent(service, ctx);
        // Only a host-observed settled worker failure may return to the coordinator.
        const current = service.get(projectId, runId);
        const agent = [...current.agents]
          .reverse()
          .find((item) => item.assignment?.grantId === grant.id);
        if (
          error instanceof DomainError &&
          agent?.completedAt &&
          agent.status === 'failed' &&
          (error.code === 'WORKER_FAILED' ||
            ((error.code === 'MODEL_INCOMPLETE' ||
              error.code === 'MODEL_CONTEXT_EXHAUSTED' ||
              error.code === 'MODEL_RESPONSE_LOST') &&
              agent.assignment?.knownFailure?.scopeVerified))
        )
          return {
            content: JSON.stringify({
              assignmentId: grant.id,
              error: error.code,
              message: error.message,
              result: agent.session?.result,
            }),
            isError: true,
          };
        throw error;
      }
    },
    async check() {
      assertCurrent(service, ctx);
      checked = await service.checkRun(ctx);
      return observed({
        checks: checkContext(checked.checks),
        scopePreserved: checked.scope,
        specsUnchanged: checked.specsUnchanged,
        revision: checked.revision?.tree,
        accepted: false,
      });
    },
    async review({ result, runtimeId, runtimeReason }) {
      assertCurrent(service, ctx);
      checked = await service.ensureChecks(ctx, checked, true, false);
      const review = await service.reviewRun(ctx, checked, result, { runtimeId, runtimeReason });
      return observed({ review, checks: checkContext(checked.checks), accepted: false });
    },
    async finish({ result }) {
      assertCurrent(service, ctx);
      const completed = await service.completeRun(ctx, checked, result);
      checked = completed.checked;
      return {
        ...observed({
          accepted: completed.accepted,
          checks: checkContext(checked.checks),
          scopePreserved: checked.scope,
          specsUnchanged: checked.specsUnchanged,
          review: completed.review,
          commit: service.get(projectId, runId).commit,
        }),
        ...(!completed.accepted ? { isError: true } : {}),
      };
    },
    async askUser({ question }) {
      assertCurrent(service, ctx);
      await service.closeVerificationView(projectId, runId);
      await service.finish(
        projectId,
        runId,
        'needs-attention',
        question,
        { code: 'OPERATOR_INPUT_REQUIRED', message: question, checks: [] },
        undefined,
        ctx.attemptId,
      );
      return observed({ waitingForUser: true, question });
    },
    async plan({ summary, steps }) {
      assertCurrent(service, ctx);
      await service.update(projectId, runId, (current) => {
        current.plan = structuredClone(steps);
        current.events.push({
          at: service.env.now(),
          type: 'plan.updated',
          text: JSON.stringify({ summary, steps }),
        });
      });
      return observed({ recorded: true, dispatchAuthority: false });
    },
  };
  let feedback = 'Goal: ' + run.title + '\nChoose useful work from the available actions.';
  let lastRejectedProposal: unknown;
  let lastObservation: { signature: string; action: string; repetitions: number } | undefined;
  while (true) {
    if (terminal(service.get(projectId, runId))) return;
    run = assertCurrent(service, ctx);
    if (terminal(run)) return;
    expectedInput = await runs.delegationContext(runId);
    expectedRoles = service.env.projects.get(projectId).snapshot().roles;
    expectedAssignments = await runs.assignments(runId);
    // This complete service packet remains usable after a context rollover. Historical
    // model text is never the authority for current assignments, checks or review.
    const currentState = {
      goal: { title: run.title, text: run.goalText },
      ...(lastRejectedProposal ? { untrustedRejectedProposal: lastRejectedProposal } : {}),
      plan: run.plan,
      checks: checkContext(run.acceptance),
      review: run.review,
      continuation: run.continuation,
      ...(lastObservation && lastObservation.repetitions > 1
        ? {
            progress: {
              action: lastObservation.action,
              unchangedObservations: lastObservation.repetitions,
              guidance:
                'The same action has returned unchanged evidence. Investigate the failure, repair the code, request diagnostic review, or reassign work/model. Repeating checks alone does not repair it.',
            },
          }
        : {}),
      assignments: expectedAssignments.map((item) => ({
        id: item.id,
        roleId: item.role.id,
        task: item.task,
        paths: item.paths,
        resourceId: item.resource.resource.id,
      })),
      workers: run.agents
        .filter((item) => item.assignment)
        .map((item) => ({
          roleId: item.session?.roleId,
          status: item.status,
          result: item.session?.result,
        })),
      reusableSpecialists: expectedRoles
        .filter((item) => isWorkerRoleId(item.id))
        .map(({ id, version, title, description, kind, runtimePreference }) => ({
          id,
          version,
          title,
          description,
          kind,
          runtimePreference,
        })),
      workerRuntimes: run.resources
        ? workerResourcePool(run.resources).map(({ id, model, providerId, local }) => ({
            id,
            model,
            providerId,
            local,
          }))
        : [],
      teamAllowance: policy.maxWorkers ?? null,
      filePolicy: policy.scope,
      availableActions: actions.definitions().map(({ id, description }) => ({ id, description })),
    };
    const task =
      feedback +
      '\nCurrent service-owned execution state: ' +
      JSON.stringify(currentState) +
      '\nReuse only existing worker IDs; otherwise create a reusable specialist role. ' +
      'Return one registered action when service work or user input is needed.';
    let proposal: unknown;
    try {
      proposal = await service.completedTurn(
        projectId,
        runId,
        root.threadId,
        task,
        actions.outputSchema(),
        signal,
        run.timePolicy?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      );
      assertCurrent(service, ctx);
      const choice = actions.parse(proposal);
      lastRejectedProposal = undefined;
      await service.update(projectId, runId, (current) => {
        current.events.push({
          at: service.env.now(),
          type: 'action.requested',
          threadId: root.threadId,
          text: JSON.stringify(choice),
        });
      });
      const result = await actions.invoke(proposal, operations);
      if (terminal(service.get(projectId, runId))) return;
      assertCurrent(service, ctx);
      let observation: unknown = result.content;
      try {
        observation = JSON.parse(result.content);
      } catch {}
      const signature = JSON.stringify([choice.action, observation], (key, value) =>
        ['durationMs', 'checkedAt', 'reviewedAt'].includes(key) ? undefined : value,
      );
      lastObservation = {
        signature,
        action: choice.action,
        repetitions: lastObservation?.signature === signature ? lastObservation.repetitions + 1 : 1,
      };
      feedback =
        'Service observation for ' +
        choice.action +
        (result.isError ? ' (error)' : '') +
        ': ' +
        result.content +
        (result.exitCode !== undefined ? '\nService exit code: ' + result.exitCode : '') +
        (lastObservation.repetitions > 1
          ? '\nThis action returned unchanged evidence ' +
            lastObservation.repetitions +
            ' times. Use investigation, repair, review or reassignment to make progress; rerun only when it serves a concrete diagnostic purpose.'
          : '') +
        '\nChoose the next useful work from the actual evidence. Repository tools remain available.';
    } catch (error) {
      if (terminal(service.get(projectId, runId))) return;
      assertCurrent(service, ctx);
      if (!(error instanceof DomainError) || !correctable.has(error.code)) throw error;
      lastRejectedProposal = proposal;
      if (error.code === 'VERIFICATION_REVISION_CHANGED') checked = undefined;
      feedback =
        'The service rejected this action before acceptance: ' +
        error.code +
        ': ' +
        error.message +
        '\nReconsider the action using its prerequisites and the goal. No permissions were expanded.';
    }
  }
}
