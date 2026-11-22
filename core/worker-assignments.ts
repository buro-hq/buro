import { validateProjectRole } from './project-entities.ts';
import type { RunWorkerAssignment } from '../protocol/run-plan.ts';
import { operationIds } from './operation-catalog.ts';
import type { AgentSession, FileChange, Role, Run } from '../protocol/domain.ts';
import { EnvelopeSchema, envelopeOutputSchema } from '../protocol/execution.ts';
import { DomainError, type AgentRuntime } from './ports.ts';
import {
  matchesPlannedPath,
  writeAllowed,
  planPathAllowed,
  type ExecutionPolicy,
  type WorkspacePort,
} from './execution-ports.ts';
import type { WorkScope } from '../protocol/work-scope.ts';
import { sessionResource } from '../protocol/resources.ts';
import { validateAssignmentResource } from './assignment-routing.ts';
import { buildWorkerEnvelope, workerInstructions, workerPrompt } from './worker-envelope.ts';

/** Compare observed edits, including a worker reverting an earlier worker's change. */
export function assignmentScopePreserved(
  before: FileChange[],
  after: FileChange[],
  scope: WorkScope,
) {
  const previous = new Map(before.map((f) => [f.path, f.after]));
  const current = new Map(after.map((f) => [f.path, f.after]));
  return [...new Set([...previous.keys(), ...current.keys()])].every(
    (path) =>
      previous.get(path) === current.get(path) ||
      (writeAllowed(path, scope) && !current.get(path)?.startsWith('[symlink ')),
  );
}

/** Advisory deviations and earlier edits reverted by this serial worker remain review evidence. */
export function assignmentScopeObservations(
  before: FileChange[],
  after: FileChange[],
  scope: WorkScope,
) {
  const previous = new Map(before.map((file) => [file.path, file.after]));
  const current = new Map(after.map((file) => [file.path, file.after]));
  const changed = [...new Set([...previous.keys(), ...current.keys()])]
    .filter((file) => previous.get(file) !== current.get(file))
    .sort();
  return {
    additionalPaths: scope.plannedPaths.length
      ? changed.filter((file) => !matchesPlannedPath(file, scope.plannedPaths))
      : [],
    revertedPaths: changed.filter((file) => previous.has(file) && !current.has(file)),
  };
}

/** One writer at a time. The service owns identity, dispatch and completion evidence. */
export async function runWorkerAssignments(options: {
  projectId: string;
  run: Run;
  roles: Role[];
  readAssignment: (roleId: string) => Promise<RunWorkerAssignment | undefined>;
  workspace: { path: string; base: string };
  policy: ExecutionPolicy;
  runtime: AgentRuntime;
  workspaces: WorkspacePort;
  signal: AbortSignal;
  now: () => string;
  id: () => string;
  update: (apply: (run: Run) => void) => Promise<unknown>;
  track: (threadId: string) => void;
  flush: () => Promise<unknown>;
  ask: (threadId: string, text: string, schema: unknown) => Promise<unknown>;
}): Promise<AgentSession[]> {
  const { projectId, run, roles, workspace, policy, runtime, workspaces, signal, update, now } =
    options;
  const results: AgentSession[] = [];
  const abort = () => {
    if (signal.aborted) throw new DOMException('Interrupted', 'AbortError');
  };
  for (const role of roles) {
    abort();
    const grant = await options.readAssignment(role.id);
    abort();
    if (
      !grant ||
      grant.runId !== run.id ||
      grant.role.id !== role.id ||
      JSON.stringify(validateProjectRole(grant.role)) !== JSON.stringify(validateProjectRole(role))
    )
      throw new DomainError('INVALID_ASSIGNMENT', `No accepted assignment grant for ${role.id}.`);
    const paths = grant.paths;
    if (
      (policy.scope.mode === 'strict' && !paths.length) ||
      paths.some((path) => !planPathAllowed(path, policy.scope))
    )
      throw new DomainError('INVALID_ASSIGNMENT', `Assignment exceeds current scope: ${role.id}.`);
    const scope: WorkScope = {
      ...policy.scope,
      plannedPaths: [...paths],
      protectedPaths: [...policy.scope.protectedPaths],
    };
    const savedDecision = grant.resource;
    if (run.resources?.workerPool && !savedDecision)
      throw new DomainError('INVALID_ASSIGNMENT', `No saved resource decision for ${role.id}.`);
    if (savedDecision && !run.resources)
      throw new DomainError('INVALID_ASSIGNMENT', 'A resource decision requires its saved pool.');
    const decision = savedDecision
      ? validateAssignmentResource(run.resources!, role, savedDecision, {
          ...(policy.scope.mode === 'strict' ? { strictPlannedWrites: true } : {}),
        })
      : undefined;
    const envelope = buildWorkerEnvelope({
      run,
      role,
      paths,
      policy,
      workspace: workspace.path,
      assignment: grant,
    });
    const previous = [...run.agents]
      .reverse()
      .find((agent) => agent.assignment?.grantId === grant.id);
    if (previous && (!previous.completedAt || !['completed', 'failed'].includes(previous.status)))
      throw new DomainError(
        'SESSION_RECONCILIATION_REQUIRED',
        'Settle the previous specialist action before continuing it.',
      );
    const resume = !!(
      previous?.session &&
      runtime.resume &&
      decision?.resource.capabilities.resumeSessions &&
      (previous.session.result || previous.assignment?.knownFailure?.scopeVerified) &&
      previous.assignment?.knownFailure?.code !== 'MODEL_CONTEXT_EXHAUSTED' &&
      JSON.stringify(previous.assignment?.envelope?.task) === JSON.stringify(envelope.task) &&
      JSON.stringify(previous.assignment?.envelope?.scope) === JSON.stringify(envelope.scope)
    );
    const session: AgentSession = resume
      ? structuredClone(previous!.session!)
      : {
          id: 'S-' + options.id(),
          roleId: role.id,
          roleVersion: role.version,
          ...(decision
            ? {
                runtimeId: decision.resource.id,
                providerId: decision.resource.providerId,
                model: decision.resource.model,
                configurationRevision: decision.resource.configurationRevision,
                selection: { source: decision.source, reason: decision.reason },
              }
            : sessionResource(run.resources, 'implementation', runtime.id)),
          parentId: previous?.session?.id || run.coordinatorSession?.id,
        };
    // Persist dispatch intent before opening a client. An unknown outcome is never replayed on restart.
    await update((r) => {
      if (resume) {
        const agent = r.agents.find((item) => item.session?.id === session.id)!;
        agent.status = 'starting';
        agent.completedAt = '';
        agent.session!.result = undefined;
        agent.assignment = {
          grantId: grant.id,
          paths: [...paths],
          envelope: structuredClone(envelope),
        };
      } else
        r.agents.push({
          session,
          threadId: session.id,
          name: role.id,
          agentPath: '/root/' + role.id,
          startedAt: now(),
          completedAt: '',
          messages: [],
          commands: 0,
          status: 'starting',
          assignment: { grantId: grant.id, paths: [...paths], envelope: structuredClone(envelope) },
        });
      r.events.push({
        at: now(),
        type: 'agent.dispatch-requested',
        threadId: session.id,
        text: role.id,
      });
    });
    let threadId: string | undefined;
    let before: FileChange[] | undefined;
    let failedTurn: unknown;
    let releaseAttempted = false;
    let observations: ReturnType<typeof assignmentScopeObservations> | undefined;
    const recordObservations = (current: Run, thread: string) => {
      if (
        observations &&
        (observations.additionalPaths.length || observations.revertedPaths.length) &&
        !current.events.some(
          (event) => event.type === 'agent.scope-observed' && event.threadId === thread,
        )
      )
        current.events.push({
          at: now(),
          type: 'agent.scope-observed',
          threadId: thread,
          text: JSON.stringify({ mode: scope.mode, ...observations }),
        });
    };
    try {
      abort();
      before = await workspaces.changes(workspace.path, workspace.base);
      const input = {
        projectId,
        runId: run.id,
        purpose: 'implementation' as const,
        operationId: operationIds.implementation,
        workspace: workspace.path,
        assignment: {
          sessionId: session.id,
          roleId: role.id,
          scope: structuredClone(scope),
        },
        instructions: workerInstructions(role, policy),
      };
      const started = resume
        ? await runtime.resume!({ ...input, threadId: previous!.threadId })
        : await runtime.start(input);
      threadId = started.threadId;
      options.track(threadId);
      abort();
      await update((r) => {
        const agent = r.agents.find((a) => a.session?.id === session.id)!;
        agent.threadId = started.threadId;
        agent.status = 'running';
        r.events.push({
          at: now(),
          type: 'agent.started',
          threadId: started.threadId,
          text: role.id,
        });
      });
      let response: unknown;
      try {
        response = await options.ask(threadId, workerPrompt(envelope), envelopeOutputSchema);
      } catch (error) {
        failedTurn = error;
        throw error;
      }
      const result = EnvelopeSchema.parse(response);
      abort();
      const after = await workspaces.changes(workspace.path, workspace.base);
      observations = assignmentScopeObservations(before, after, scope);
      if (!assignmentScopePreserved(before, after, scope))
        throw new DomainError(
          'WORKER_SCOPE_VIOLATION',
          `Worker ${role.id} changed files forbidden by its ${scope.mode} scope.`,
        );
      await options.flush();
      await update((r) => {
        const agent = r.agents.find((a) => a.session?.id === session.id)!;
        agent.session!.result = result;
        agent.status = result.status === 'success' ? 'completed' : 'failed';
        agent.completedAt = now();
        agent.messages.push(result.summary);
        recordObservations(r, started.threadId);
        r.events.push({
          at: now(),
          type: result.status === 'success' ? 'agent.completed' : 'agent.failed',
          threadId: started.threadId,
          text: result.summary,
        });
      });
      results.push({ ...session, result });
      if (result.status !== 'success')
        throw new DomainError('WORKER_FAILED', `Worker ${role.id}: ${result.summary}`);
    } catch (error) {
      let failure = error;
      let knownFailure:
        | { code: 'MODEL_INCOMPLETE' | 'MODEL_CONTEXT_EXHAUSTED'; scopeVerified: true }
        | undefined;
      if (
        !signal.aborted &&
        threadId &&
        error === failedTurn &&
        before &&
        error instanceof DomainError &&
        (error.code === 'MODEL_INCOMPLETE' || error.code === 'MODEL_CONTEXT_EXHAUSTED')
      ) {
        try {
          const after = await workspaces.changes(workspace.path, workspace.base);
          observations = assignmentScopeObservations(before, after, scope);
          if (!assignmentScopePreserved(before, after, scope))
            failure = new DomainError(
              'WORKER_SCOPE_VIOLATION',
              `Worker ${role.id} changed files forbidden by its ${scope.mode} scope.`,
            );
          else knownFailure = { code: error.code, scopeVerified: true };
        } catch {
          failure = new DomainError(
            'WORKER_OUTCOME_UNVERIFIED',
            'The failed worker scope could not be independently verified.',
          );
        }
      }
      await options.flush();
      // A replacement is eligible only after the failed turn and its client have both settled.
      if (knownFailure && threadId) {
        releaseAttempted = true;
        await runtime.release?.(threadId);
      }
      await update((r) => {
        if (failure instanceof DomainError && failure.code === 'WORKER_SCOPE_VIOLATION')
          r.scopePreserved = false;
        const agent = r.agents.find((a) => a.session?.id === session.id)!;
        if (knownFailure) agent.assignment!.knownFailure = knownFailure;
        agent.status = signal.aborted ? 'interrupted' : 'failed';
        agent.completedAt = now();
        recordObservations(r, agent.threadId);
        r.events.push({
          at: now(),
          type: 'agent.' + agent.status,
          threadId: agent.threadId,
          text: failure instanceof Error ? failure.message : String(failure),
        });
      });
      throw failure;
    } finally {
      if (threadId && !releaseAttempted) await runtime.release?.(threadId);
    }
  }
  return results;
}
