import type { AgentSession, FileChange, Role, Run } from '../protocol/domain.ts';
import { materialInstructions } from '../protocol/context.ts';
import { EnvelopeSchema, envelopeOutputSchema } from '../protocol/execution.ts';
import { DomainError, type AgentRuntime } from './ports.ts';
import { inScope, type ExecutionPolicy, type WorkspacePort } from './execution-ports.ts';
import { checkContext } from './agent-context.ts';
import { sessionResource } from '../protocol/resources.ts';
import { validateAssignmentResource } from './assignment-routing.ts';

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
        assignment: { paths: [...paths] },
      });
      r.events.push({
        at: now(),
        type: 'agent.dispatch-requested',
        threadId: session.id,
        text: role.id,
      });
    });
    let threadId: string | undefined;
    try {
      abort();
      const before = await workspaces.changes(workspace.path, workspace.base);
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
        instructions:
          role.instructions +
          '\nYou are a worker assigned by Buro. Work only within your assigned paths. Do not start agents, commit, reset, checkout, modify .git or change check definitions. Buro owns other assignments and independent acceptance.\nProject context: ' +
          (policy.context || '') +
          materialInstructions(run.contextMaterials || [], workspace.path, true),
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
      const result = EnvelopeSchema.parse(
        await options.ask(
          threadId,
          `Execute your assigned work in the existing workspace.\nGoal: ${run.title}\n${run.goalText}\nRole: ${role.id}. Assigned paths: ${JSON.stringify(paths)}. Protected paths: ${JSON.stringify(policy.protectedPaths || [])}.\nYour plan steps: ${JSON.stringify(run.plan.filter((step) => step.owner === role.id))}.\nCurrent checks: ${JSON.stringify(checkContext(run.acceptance.total ? run.acceptance : run.baseline))}.\n${run.continuation ? 'Continue saved work with this clarification: ' + run.continuation.instructions : ''}\nUse relevant user materials at the supplied staged paths. Do not repeat already completed external actions. Report concrete changes and limitations. Return the formal execution result.`,
          envelopeOutputSchema,
        ),
      );
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
      await options.flush();
      await update((r) => {
        if (error instanceof DomainError && error.code === 'WORKER_SCOPE_VIOLATION')
          r.scopePreserved = false;
        const agent = r.agents.find((a) => a.session?.id === session.id)!;
        agent.status = signal.aborted ? 'interrupted' : 'failed';
        agent.completedAt = now();
        r.events.push({
          at: now(),
          type: 'agent.' + agent.status,
          threadId: agent.threadId,
          text: error instanceof Error ? error.message : String(error),
        });
      });
      throw error;
    } finally {
      if (threadId) await runtime.release?.(threadId);
    }
  }
  return results;
}
