/**
 * An unexpected scheduler-internal failure, never a wrapper for host failures or
 * parent cancellation. It conveys neither action outcome nor goal acceptance.
 */
export class AgentLoopFailure extends Error {
  declare readonly code: 'AGENT_LOOP_FAILED';

  constructor(cause?: unknown) {
    super(
      'The agent scheduler stopped before completion.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'AgentLoopFailure';
    Object.defineProperty(this, 'code', {
      value: 'AGENT_LOOP_FAILED',
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
}

/** Response data, lookalikes and nested causes cannot declare a scheduler failure. */
export function isAgentLoopFailure(error: unknown): error is AgentLoopFailure {
  return error instanceof AgentLoopFailure;
}
