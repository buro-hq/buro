/** Whether the host can establish an outcome for one attempted model request. */
export type ProviderOutcome = 'not-dispatched' | 'rejected' | 'unknown';

export type ProviderFailureOptions = {
  outcome: ProviderOutcome;
  cause?: unknown;
};

/** Transport failure independent of Buro policy, workflow, journals and platform exceptions. */
export class ProviderFailure extends Error {
  declare readonly code: string;
  declare readonly outcome: ProviderOutcome;

  constructor(code: string, message: string, options: ProviderFailureOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    if (!/^[A-Z][A-Z0-9_]*$/.test(code))
      throw new TypeError('A provider failure needs a stable uppercase code.');

    if (!['not-dispatched', 'rejected', 'unknown'].includes(options.outcome))
      throw new TypeError('A provider failure needs an explicit request outcome.');

    this.name = 'ProviderFailure';
    Object.defineProperties(this, {
      code: { value: code, enumerable: true, writable: false, configurable: false },
      outcome: { value: options.outcome, enumerable: true, writable: false, configurable: false },
    });
  }
}

/** Plain response data or a similarly named Error cannot declare a trusted transport outcome. */
export function isProviderFailure(error: unknown): error is ProviderFailure {
  return error instanceof ProviderFailure;
}

/** Inspect only a real direct failure; the host owns any explicit error/cause translation. */
export function providerFailureOutcome(error: unknown): ProviderOutcome | undefined {
  return isProviderFailure(error) ? error.outcome : undefined;
}
