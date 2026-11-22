import {
  DomainError,
  type AgentRuntime,
  type RegisteredRuntime,
  type RuntimeEvent,
} from './ports.ts';
import type { BackendCapabilities } from '../agent/contracts/capabilities.ts';
import { isAgentLoopFailure } from '../agent/contracts/loop-errors.ts';
import type { ManagedSession } from './model-ports.ts';
import { resolveWorkSegmentPolicy, validateSegmentLimits } from './work-segments.ts';
import type { ManagedTurnState, ManagedTurnHost } from './managed-turn-state.ts';
import { failManagedTurn } from './managed-host-effects.ts';
import { initializeManagedCodingContext } from './managed-coding-context.ts';
import { ManagedLoopHost } from './managed-loop-host.ts';
import type { ManagedRuntimeOptions } from './managed-runtime-options.ts';
import {
  prepareManagedSession,
  prepareManagedResume,
  assertManagedReconciled,
  assertManagedCurrentWorkspace,
  managedBudgetOwner,
  managedToolDefinitions,
  managedToolRevision,
  assertManagedToolRevision,
  assertManagedSessionProvenance,
} from './managed-session-authority.ts';

/** Managed lifecycle; the injected runner schedules while Buro owns authority and receipts. */
export class ManagedAgentRuntime implements RegisteredRuntime {
  readonly id: string;
  readonly capabilities: BackendCapabilities = Object.freeze({
    version: 1,
    revision: 'managed-host-tools-scope-v2',
    structuredTurns: true,
    toolsFreeTurns: true,
    readOnlySessions: true,
    immutableReview: true,
    // Strict sessions expose only bounded source tools, never candidate-controlled commands.
    strictPlannedWrites: true,
    hostToolLifecycle: true,
    usage: 'reported',
    resumeSessions: true,
    cancellation: 'settled-or-unknown',
  });
  private options: ManagedRuntimeOptions;
  private loaded = new Map<string, ManagedSession>();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private active = new Map<
    string,
    { turnId: string; controller: AbortController; done: Promise<unknown> }
  >();
  private closed = false;
  private resuming = new Map<string, Promise<{ threadId: string }>>();
  private disposal?: Promise<void>;

  constructor(options: ManagedRuntimeOptions) {
    managedToolRevision(options);
    const limits = options.limits;
    if (
      ![limits.contextTokens, limits.maxOutputTokens].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      Object.values(limits).some((n) => n !== undefined && (!Number.isSafeInteger(n) || n < 1)) ||
      limits.maxOutputTokens >= limits.contextTokens
    )
      throw new DomainError(
        'INVALID_RUNTIME_LIMITS',
        'Managed runtime limits must be positive and reserve input context.',
      );
    if (!options.loopRunner || typeof options.loopRunner.run !== 'function')
      throw new DomainError(
        'AGENT_LOOP_UNAVAILABLE',
        'Configure an agent loop runner before starting managed sessions.',
      );
    this.id = options.id;
    this.options = options;
    if (options.segmentPolicy) {
      validateSegmentLimits(options.segmentPolicy.limits);
      if (
        options.segmentPolicy.revision !== options.segmentPolicy.limits.revision ||
        typeof options.segmentPolicy.decide !== 'function' ||
        !options.segmentEvidence
      )
        throw new DomainError('INVALID_SEGMENT_POLICY', 'The work segment policy is incomplete.');
    }
  }

  async start(input: Parameters<AgentRuntime['start']>[0]) {
    this.assertOpen();
    const id = 'M-' + this.options.idGenerator();
    const session = prepareManagedSession({ ...this.options, id: this.id }, input, id);
    await this.options.sessions.save(session);
    this.assertOpen();
    this.loaded.set(id, session);
    return { threadId: id };
  }

  async resume(input: Parameters<NonNullable<AgentRuntime['resume']>>[0]) {
    this.assertOpen();
    if (this.active.has(input.threadId) || this.resuming.has(input.threadId))
      throw new DomainError('SESSION_BUSY', 'The session is already running.');
    const done = Promise.resolve().then(() => this.resumeSession(input));
    this.resuming.set(input.threadId, done);
    try {
      return await done;
    } finally {
      this.resuming.delete(input.threadId);
    }
  }

  private async resumeSession(input: Parameters<NonNullable<AgentRuntime['resume']>>[0]) {
    const session = await this.session(input.threadId);
    this.assertOpen();
    const next = prepareManagedResume({ ...this.options, id: this.id }, session, input);
    await this.options.sessions.save(next);
    this.assertOpen();
    this.loaded.set(next.id, next);
    return { threadId: next.id };
  }

  async submit(threadId: string, text: string) {
    const result = await this.turn(threadId, text, {
      schema: {},
      signal: new AbortController().signal,
      timeoutMs: 600000,
    });
    return { turnId: result.turnId };
  }

  async turn(
    threadId: string,
    text: string,
    options: { schema: unknown; signal: AbortSignal; timeoutMs: number; toolPolicy?: 'none' },
  ) {
    this.assertOpen();
    if (this.active.has(threadId) || this.resuming.has(threadId))
      throw new DomainError('SESSION_BUSY', 'The session is already running.');
    const turnId = 'T-' + this.options.idGenerator();
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) controller.abort();
    // Reserve before loading so concurrent calls cannot enter the same checkpoint.
    const done = Promise.resolve().then(() =>
      this.execute(threadId, turnId, text, options, controller),
    );
    this.active.set(threadId, { turnId, controller, done });
    try {
      return await done;
    } finally {
      this.active.delete(threadId);
      options.signal.removeEventListener('abort', abort);
    }
  }

  private async execute(
    threadId: string,
    turnId: string,
    text: string,
    options: { schema: unknown; timeoutMs: number; toolPolicy?: 'none' },
    controller: AbortController,
  ) {
    const session = await this.session(threadId);
    assertManagedReconciled(session);
    if (
      session.purpose === 'review' ||
      session.scope.verificationViewId ||
      session.scope.verificationTree
    )
      assertManagedCurrentWorkspace(this.options, session);
    if (session.purpose === 'review' && (!session.scope.readOnly || session.assignment))
      throw new DomainError('SESSION_MISMATCH', 'Review requires a read-only service session.');
    const noTools = options.toolPolicy === 'none';
    const state: ManagedTurnState = {
      session,
      threadId,
      turnId,
      schema: options.schema,
      noTools,
      separate: !noTools && this.options.provider.structuredToolMode === 'separate-turn',
      finalizing: false,
      closing: false,
      segmentCompleteEmitted: false,
      responseSettled: false,
      effectDispatched: false,
      generationDispatched: false,
      dispatchedActions: new Set<string>(),
      round: 0,
      calls: 0,
    };
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const host: ManagedTurnHost = {
      runtimeId: this.id,
      options: this.options,
      signal: controller.signal,
      budgetOwner: this.options.budgets ? managedBudgetOwner(this.options, session) : undefined,
      budgetPhase: session.purpose === 'review' ? 'review' : 'work',
      check: () => {
        if (controller.signal.aborted || state.session.cancelRequested)
          throw new DOMException('Interrupted', 'AbortError');
        const current = state.session;
        assertManagedToolRevision(this.options, current);
        if (
          current.purpose === 'review' ||
          current.scope.verificationViewId ||
          current.scope.verificationTree
        )
          assertManagedCurrentWorkspace(this.options, current);
      },
      touch: () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), options.timeoutMs);
      },
      emit: (body) => {
        const event = {
          id: `${turnId}:${++sequence}`,
          runId: state.session.scope.runId || '',
          threadId,
          ...body,
        } as RuntimeEvent;
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch {}
        }
      },
      commit: async (next) => {
        if (state.session.cancelRequested) next.cancelRequested = true;
        await this.options.sessions.save(next);
        if (state.session.cancelRequested) next.cancelRequested = true;
        state.session = next;
        this.loaded.set(threadId, next);
      },
      toolDefinitions: (scope) => managedToolDefinitions(this.options, scope),
      assertReconciled: (current) => assertManagedReconciled(current),
    };
    try {
      host.check();
      await initializeManagedCodingContext(state, host, text);
      state.session.status = 'running';
      state.session.turnAuthorities ||= [];
      state.session.turnAuthorities.push({
        turnId,
        toolPolicy: noTools ? 'none' : 'normal',
        startedAtRequest: state.session.requests,
        scopeRevision: state.session.scopeRevisions.at(-1)!.revision,
      });
      state.session.messages.push({ role: 'user', content: text });
      await host.commit(state.session);
      host.emit({ type: 'turn.started', turnId });
      if (state.session.workSegments)
        host.emit({
          type: 'segment.started',
          turnId,
          segmentIndex: state.session.workSegments.active.index,
        });
      host.touch();
      const loopHost = new ManagedLoopHost(state, host);
      // Resume committed context windows; model/tool scheduling belongs only to the runner.
      while (true) {
        host.check();
        const previousRound = state.round;
        const outcome = await this.options.loopRunner.run(loopHost, host.signal);
        host.check();
        const result = loopHost.result;
        if (outcome.kind === 'yield') {
          if (result || state.round <= previousRound)
            throw new DomainError(
              'AGENT_LOOP_INVALID_STATE',
              'A scheduler yield must follow a committed context transition.',
            );
          continue;
        }
        if (outcome.kind !== 'complete' || !result)
          throw new DomainError(
            'AGENT_LOOP_INVALID_STATE',
            'The scheduler ended without a host-confirmed result.',
          );
        state.session.status = 'ready';
        await host.commit(state.session);
        if (state.session.workSegments && !state.segmentCompleteEmitted)
          host.emit({
            type: 'segment.completed',
            turnId,
            segmentIndex: state.session.workSegments.active.index,
            reason: 'complete',
          });
        host.emit({ type: 'message.completed', text: result.text.slice(0, 12000) });
        host.emit({ type: 'turn.completed', turnId, status: 'completed' });
        return result;
      }
    } catch (error) {
      if (isAgentLoopFailure(error)) {
        const applicationError = new DomainError(error.code, error.message);
        Object.defineProperty(applicationError, 'cause', { value: error });
        return await failManagedTurn(state, host, applicationError);
      }
      return await failManagedTurn(state, host, error);
    } finally {
      clearTimeout(timer);
    }
  }

  private assertOpen() {
    if (this.closed) throw new DomainError('RUNTIME_CLOSED', 'The runtime stopped.');
  }
  private async session(id: string) {
    let session = this.loaded.get(id);
    if (!session) {
      session = await this.options.sessions.load(id);
      if (!session) throw new DomainError('THREAD_NOT_FOUND', 'Managed session not found.');
      const cached = this.loaded.get(id);
      if (cached) {
        assertManagedSessionProvenance(cached);
        assertManagedToolRevision(this.options, cached);
        return cached;
      }
      if (
        session.runtimeId !== this.id ||
        session.providerId !== this.options.provider.id ||
        session.providerRevision !== this.options.provider.revision ||
        session.requestedModel !== this.options.model
      )
        throw new DomainError(
          'SESSION_MISMATCH',
          'The checkpoint uses another provider configuration or model.',
        );
      if (session.workSegments) {
        if (!this.options.segmentEvidence)
          throw new DomainError(
            'SEGMENT_POLICY_CHANGED',
            'The saved work segment evidence service is unavailable.',
          );
        resolveWorkSegmentPolicy(session.workSegments.limits, this.options.segmentPolicy);
      }
      if (session.workerStepChecks && !this.options.workerStepChecks)
        throw new DomainError(
          'WORKER_CHECK_CHANGED',
          'The saved worker check service is unavailable.',
        );
      assertManagedToolRevision(this.options, session);
      this.loaded.set(id, session);
    }
    assertManagedSessionProvenance(session);
    assertManagedToolRevision(this.options, session);
    return session;
  }
  subscribe(listener: (event: RuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async interrupt(threadId: string, turnId: string) {
    const active = this.active.get(threadId);
    if (!active || active.turnId !== turnId) return;
    const session = await this.session(threadId);
    session.cancelRequested = true;
    try {
      await this.options.sessions.save(session);
    } finally {
      active.controller.abort();
    }
  }
  async release(threadId: string) {
    await this.resuming.get(threadId)?.catch(() => {});
    const active = this.active.get(threadId);
    let failure: unknown;
    if (active) {
      try {
        await this.interrupt(threadId, active.turnId);
      } catch (error) {
        failure = error;
      }
      await active.done.catch(() => {});
    }
    this.loaded.delete(threadId);
    if (failure) throw failure;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = (async () => {
      await Promise.allSettled([...this.resuming.values()]);
      const results = await Promise.allSettled(
        [...this.active.keys()].map((id) => this.release(id)),
      );
      this.loaded.clear();
      this.listeners.clear();
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, 'Managed runtime cleanup failed.');
    })();
    return this.disposal;
  }
}
