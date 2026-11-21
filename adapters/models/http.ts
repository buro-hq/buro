import {
  RequestGate as NeutralRequestGate,
  type HttpOptions as NeutralHttpOptions,
} from '../../agent/providers/http.ts';
import { isProviderFailure } from '../../agent/contracts/provider-errors.ts';
import { providerFailure } from './provider-failures.ts';
export {
  endpointURL,
  json,
  lines,
  object,
  parseJSON,
  request,
  sse,
  tokenCount,
} from '../../agent/providers/http.ts';
export type { RequestLimiter } from '../../agent/providers/http.ts';
/** Buro composition uses its ambient fetch only at this application boundary. */
export type HttpOptions = Omit<NeutralHttpOptions, 'fetch'> & { fetch?: typeof fetch };
/** Preserve the existing host abort contract while the queue itself is portable. */
export class RequestGate extends NeutralRequestGate {
  override async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    try {
      return await super.run(signal, operation);
    } catch (error) {
      if (
        isProviderFailure(error) &&
        error.code === 'MODEL_ABORTED' &&
        error.outcome === 'not-dispatched'
      )
        throw providerFailure(error);
      throw error;
    }
  }
}
