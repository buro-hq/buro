import { isProviderFailure, type ProviderOutcome } from '../../agent/contracts/provider-errors.ts';
import { DomainError } from '../../core/ports.ts';
import { recordTurnOutcome } from '../../core/run-reconciliation.ts';

/** Application errors and effect receipts stay outside portable provider implementations. */
export function providerFailure(error: unknown, generationOutcome?: ProviderOutcome): unknown {
  if (!isProviderFailure(error)) return error;
  const translated =
    error.code === 'MODEL_ABORTED'
      ? new DOMException('Interrupted', 'AbortError')
      : new DomainError(error.code, error.message);
  Object.defineProperty(translated, 'cause', { value: error, configurable: true });
  return recordTurnOutcome(translated, generationOutcome || error.outcome);
}
export async function providerOperation<T>(
  operation: () => Promise<T>,
  generationOutcome?: ProviderOutcome,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw providerFailure(error, generationOutcome);
  }
}
