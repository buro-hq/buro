import type {
  AgentLoopActionResult,
  AgentLoopBatch,
  AgentLoopDecision,
  AgentLoopHost,
  AgentLoopRequest,
} from '../agent/contracts/loop.ts';
import { DomainError } from './ports.ts';
import { prepareManagedCodingRequest, afterManagedResponse } from './managed-coding-context.ts';
import { generateManagedBatch, dispatchManagedAction } from './managed-host-effects.ts';
import type {
  ManagedPreparedRequest,
  ManagedTurnHost,
  ManagedTurnResult,
  ManagedTurnState,
} from './managed-turn-state.ts';

type Phase = 'prepare' | 'generate' | 'tools' | 'advance' | 'done';

/** The scheduler gets opaque IDs and copies, never Buro authority, stores or context controls. */
export class ManagedLoopHost implements AgentLoopHost {
  #state: ManagedTurnState;
  #host: ManagedTurnHost;
  #phase: Phase = 'prepare';
  #busy = false;
  #closed = false;
  #prepared?: ManagedPreparedRequest;
  #requestId?: string;
  #batchId?: string;
  #actionIds: string[] = [];
  #result?: ManagedTurnResult;

  constructor(state: ManagedTurnState, host: ManagedTurnHost) {
    this.#state = state;
    this.#host = host;
  }

  get result(): ManagedTurnResult | undefined {
    return this.#closed ? undefined : structuredClone(this.#result);
  }

  #fault(): never {
    this.#closed = true;
    throw new DomainError(
      'INVALID_LOOP_PHASE',
      'The agent scheduler requested an invalid operation.',
    );
  }

  #assertOpen() {
    if (this.#closed) this.#fault();
  }

  async #step<T>(phase: Phase, operation: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#busy || this.#phase !== phase) this.#fault();
    this.#busy = true;
    try {
      this.#host.check();
      const result = await operation();
      this.#assertOpen();
      return result;
    } catch (error) {
      this.#closed = true;
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  prepare(): Promise<AgentLoopRequest> {
    return this.#step('prepare', async () => {
      const state = this.#state,
        limits = state.session.limits;
      if (limits.maxRequestsPerTurn !== undefined && state.round >= limits.maxRequestsPerTurn)
        throw new DomainError('MODEL_BUDGET_EXHAUSTED', 'The turn request budget is exhausted.');
      if (
        limits.maxSessionRequests !== undefined &&
        state.session.requests >= limits.maxSessionRequests
      )
        throw new DomainError('MODEL_BUDGET_EXHAUSTED', 'The session request budget is exhausted.');
      this.#host.assertReconciled(state.session);
      this.#prepared = structuredClone(await prepareManagedCodingRequest(state, this.#host));
      this.#assertOpen();
      this.#requestId = `${state.turnId}:${state.round}`;
      this.#phase = 'generate';
      return structuredClone({
        id: this.#requestId,
        model: {
          id: state.session.requestedModel,
          providerId: this.#host.options.provider.id,
          contextTokens: limits.contextTokens,
          maxOutputTokens: this.#prepared.budget.maxOutputTokens,
        },
        messages: this.#prepared.messages,
        tools: this.#prepared.definitions,
      });
    });
  }

  generate(requestId: string): Promise<AgentLoopBatch> {
    return this.#step('generate', async () => {
      if (requestId !== this.#requestId || !this.#prepared) this.#fault();
      const batch = await generateManagedBatch(this.#state, this.#host, this.#prepared);
      this.#assertOpen();
      const canonical = this.#state.activeBatch;
      if (!canonical || canonical.requestId !== this.#requestId) this.#fault();
      this.#batchId = canonical.requestId;
      this.#actionIds = [...canonical.actionIds];
      const actions = this.#actionIds.map((id) => {
        const saved = this.#state.session.actions.find((action) => action.id === id);
        if (!saved) this.#fault();
        return { id, call: structuredClone(saved.call) };
      });
      this.#prepared = undefined;
      this.#phase = actions.length ? 'tools' : 'advance';
      return {
        id: this.#batchId,
        response: structuredClone(batch.response),
        actions,
        ...(canonical.disposition ? { disposition: canonical.disposition } : {}),
      };
    });
  }

  execute(batchId: string, actionId: string): Promise<AgentLoopActionResult> {
    return this.#step('tools', async () => {
      if (batchId !== this.#batchId || !this.#actionIds.includes(actionId)) this.#fault();
      await dispatchManagedAction(this.#state, this.#host, actionId);
      this.#assertOpen();
      const saved = this.#state.session.actions.find((action) => action.id === actionId);
      const batch = this.#state.activeBatch;
      if (
        !saved?.result ||
        saved.status !== 'completed' ||
        !batch ||
        batch.requestId !== batchId ||
        batch.inFlight
      )
        this.#fault();
      this.#phase = batch.nextAction === this.#actionIds.length ? 'advance' : 'tools';
      return structuredClone({
        content: saved.result.content,
        ...(saved.result.isError !== undefined ? { isError: saved.result.isError } : {}),
      });
    });
  }

  advance(batchId: string): Promise<AgentLoopDecision> {
    return this.#step('advance', async () => {
      if (batchId !== this.#batchId) this.#fault();
      const index = this.#state.session.workSegments?.active.index;
      const decision = await afterManagedResponse(this.#state, this.#host);
      this.#assertOpen();
      if (decision.kind === 'complete') {
        this.#result = structuredClone(decision.result);
        this.#phase = 'done';
        return { kind: 'complete' };
      }
      // Round/accounting belongs to the logical host turn and is never reset by a scheduler yield.
      this.#state.round++;
      const yielded = this.#state.session.workSegments?.active.index !== index;
      this.#phase = 'prepare';
      this.#batchId = undefined;
      this.#actionIds = [];
      this.#requestId = undefined;
      return { kind: yielded ? 'yield' : 'continue' };
    });
  }
}
