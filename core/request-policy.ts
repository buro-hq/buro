import type { ModelMessage, ToolDefinition } from '../agent/contracts/model.ts';
import { DomainError } from './ports.ts';

export type ManagedRequestInput = {
  phase: 'work' | 'final';
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  schema: unknown;
  limits: { contextTokens: number; maxOutputTokens: number };
};
export type ManagedRequestDecision = {
  maxOutputTokens: number;
  reason: 'configured-limit' | 'policy-limit';
};
/** An explicitly installed policy may lower the user's output allowance. */
export interface ManagedRequestPolicy {
  readonly revision: string;
  prepare(input: ManagedRequestInput): ManagedRequestDecision;
}

/** The backend owns tokenization and physical context admission. */
export const configuredRequestPolicy: ManagedRequestPolicy = Object.freeze({
  revision: 'managed-configured-output-v2',
  prepare(input: ManagedRequestInput): ManagedRequestDecision {
    return { maxOutputTokens: input.limits.maxOutputTokens, reason: 'configured-limit' };
  },
});

/** Preserve the request and the configured cap; never infer tokens from serialized bytes. */
export function prepareManagedRequest(
  input: ManagedRequestInput,
  policy: ManagedRequestPolicy = configuredRequestPolicy,
): ManagedRequestDecision {
  const proposed = policy.prepare(structuredClone(input));
  if (
    !proposed ||
    !Number.isSafeInteger(proposed.maxOutputTokens) ||
    proposed.maxOutputTokens < 1 ||
    proposed.maxOutputTokens > input.limits.maxOutputTokens ||
    !['configured-limit', 'policy-limit'].includes(proposed.reason)
  )
    throw new DomainError(
      'INVALID_REQUEST_POLICY',
      'The request policy exceeded the configured output allowance.',
    );
  return { maxOutputTokens: proposed.maxOutputTokens, reason: proposed.reason };
}
