import type { AgentSession, FileChange, Role, Run } from '../protocol/domain.ts';
import { EnvelopeSchema, envelopeOutputSchema } from '../protocol/execution.ts';
import { DomainError, type AgentRuntime } from './ports.ts';
import { inScope, type ExecutionPolicy, type WorkspacePort } from './execution-ports.ts';
import { sessionResource } from '../protocol/resources.ts';
import { validateAssignmentResource } from './assignment-routing.ts';
import { buildWorkerEnvelope, workerInstructions, workerPrompt } from './worker-envelope.ts';

/** Compare observed edits, including a worker reverting an earlier worker's change. */
export function assignmentScopePreserved(
  before: FileChange[],
  after: FileChange[],
  paths: string[],
  protectedPaths: string[],
) {
  const previous = new Map(before.map((f) => [f.path, f.after]));
  const current = new Map(after.map((f) => [f.path, f.after]));
  return [...new Set([...previous.keys(), ...current.keys()])].every(
    (path) =>
      previous.get(path) === current.get(path) ||
      (inScope(path, paths, protectedPaths) && !current.get(path)?.startsWith('[symlink ')),
  );
}

/** One writer at a time. The service owns identity, dispatch and completion evidence. */
export async function runWorkerAssignments(options: {
  projectId: string;
  run: Run;
  roles: Role[];
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
    const paths = run.roleAssignments?.[role.id];
    if (!paths?.length)
      throw new DomainError('INVALID_ASSIGNMENT', `No saved paths for ${role.id}.`);
    if (paths.some((path) => !inScope(path, policy.allowedPaths, policy.protectedPaths)))
      throw new DomainError('INVALID_ASSIGNMENT', `Assignment exceeds current scope: ${role.id}.`);
    const savedDecision = run.assignmentResources?.[role.id];
    if (run.resources?.workerPool && !savedDecision)
      throw new DomainError('INVALID_ASSIGNMENT', `No saved resource decision for ${role.id}.`);
    if (savedDecision && !run.resources)
      throw new DomainError('INVALID_ASSIGNMENT', 'A resource decision requires its saved pool.');
    const decision = savedDecision
      ? validateAssignmentResource(run.resources!, role, savedDecision)
      : undefined;
    const envelope = buildWorkerEnvelope({ run, role, paths, policy, workspace: workspace.path });
    const session: AgentSession = {
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
      parentId: run.coordinatorSession?.id,
    };
    // Persist dispatch intent before opening a client. An unknown outcome is never replayed on restart.
    await update((r) => {
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
        assignment: { paths: [...paths], envelope: structuredClone(envelope) },
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
    try {
      abort();
      before = await workspaces.changes(workspace.path, workspace.base);
      const started = await runtime.start({
        projectId,
        runId: run.id,
        purpose: 'implementation',
        workspace: workspace.path,
        assignment: {
          sessionId: session.id,
          roleId: role.id,
          allowedPaths: [...paths],
          protectedPaths: policy.protectedPaths || [],
        },
        instructions: workerInstructions(role, policy),
      });
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
      if (!assignmentScopePreserved(before, after, paths, policy.protectedPaths || []))
        throw new DomainError(
          'WORKER_SCOPE_VIOLATION',
          `Worker ${role.id} changed files outside its assignment.`,
        );
      await options.flush();
      await update((r) => {
        const agent = r.agents.find((a) => a.session?.id === session.id)!;
        agent.session!.result = result;
        agent.status = result.status === 'success' ? 'completed' : 'failed';
        agent.completedAt = now();
        agent.messages.push(result.summary);
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
          if (!assignmentScopePreserved(before, after, paths, policy.protectedPaths || []))
            failure = new DomainError(
              'WORKER_SCOPE_VIOLATION',
              `Worker ${role.id} changed files outside its assignment.`,
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
