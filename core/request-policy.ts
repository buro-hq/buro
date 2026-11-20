import type { ModelMessage, ToolDefinition } from './model-ports.ts';
import { DomainError } from './ports.ts';

export type ManagedRequestInput = {
  phase: 'work' | 'final';
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  schema: unknown;
  limits: { contextTokens: number; maxOutputTokens: number };
};
export type ManagedRequestDecision = {
  estimatedInput: number;
  maxOutputTokens: number;
  reason: 'configured-limit' | 'context-headroom' | 'policy-limit';
};
/** A policy may reduce a request's output reservation, never its context or tool authority. */
export interface ManagedRequestPolicy {
  readonly revision: string;
  prepare(input: ManagedRequestInput): ManagedRequestDecision;
}

/** UTF-8 bytes and message overhead remain an upper estimate, not observed token usage. */
export function estimateManagedRequest(
  input: Pick<ManagedRequestInput, 'messages' | 'tools' | 'schema'>,
) {
  const payload: unknown[] = [input.messages, input.tools];
  if (input.schema !== undefined) payload.push(input.schema);
  return new TextEncoder().encode(JSON.stringify(payload)).length + input.messages.length * 16;
}

function minimumOutput(input: ManagedRequestInput) {
  // Existing configurations below 128 retain their explicitly configured cap.
  return Math.min(128, input.limits.maxOutputTokens);
}
function exhausted() {
  return new DomainError(
    'MODEL_CONTEXT_EXHAUSTED',
    'The conservative context estimate exceeds the configured token budget. Start a focused assignment.',
  );
}

export const conservativeRequestPolicy: ManagedRequestPolicy = Object.freeze({
  revision: 'managed-request-budget-v1',
  prepare(input: ManagedRequestInput): ManagedRequestDecision {
    const estimatedInput = estimateManagedRequest(input);
    const maxOutputTokens = Math.min(
      input.limits.maxOutputTokens,
      input.limits.contextTokens - estimatedInput,
    );
    if (maxOutputTokens < minimumOutput(input)) throw exhausted();
    return {
      estimatedInput,
      maxOutputTokens,
      reason:
        maxOutputTokens === input.limits.maxOutputTokens ? 'configured-limit' : 'context-headroom',
    };
  },
});

/** The core validates a policy decision against the unchanged request and frozen session limits. */
export function prepareManagedRequest(
  input: ManagedRequestInput,
  policy: ManagedRequestPolicy = conservativeRequestPolicy,
): ManagedRequestDecision {
  const estimatedInput = estimateManagedRequest(input);
  if (input.limits.contextTokens - estimatedInput < minimumOutput(input)) throw exhausted();
  const proposed = policy.prepare(structuredClone(input));
  const decision = proposed && {
    estimatedInput: proposed.estimatedInput,
    maxOutputTokens: proposed.maxOutputTokens,
    reason: proposed.reason,
  };
  if (
    !decision ||
    decision.estimatedInput !== estimatedInput ||
    !Number.isSafeInteger(decision.maxOutputTokens) ||
    decision.maxOutputTokens < minimumOutput(input) ||
    decision.maxOutputTokens > input.limits.maxOutputTokens ||
    estimatedInput + decision.maxOutputTokens > input.limits.contextTokens ||
    !['configured-limit', 'context-headroom', 'policy-limit'].includes(decision.reason)
  )
    throw new DomainError(
      'INVALID_REQUEST_POLICY',
      'The request policy exceeded the saved limits or changed the context estimate.',
    );
  return decision;
}
