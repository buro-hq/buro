import { ProviderFailure, isProviderFailure } from '../contracts/provider-errors.ts';

const failure = (
  code: string,
  message: string,
  outcome: 'not-dispatched' | 'rejected' | 'unknown' = 'unknown',
) => new ProviderFailure(code, message, {
  outcome,
});
/** Delivers optional progress without allowing observer failures to change the request. */
export const observer = (callback: (() => void) | undefined): void => {
  if (!callback)
    return;

  try {
    void Promise.resolve(callback()).catch(() => {});
  } catch {
    // Progress telemetry never controls the model request or its outcome.
  }
};
const aborted = (outcome: 'not-dispatched' | 'unknown') =>
  failure('MODEL_ABORTED', 'Interrupted', outcome);

/** Ceiling for one model response stream; oversized streams fail rather than grow unbounded. */
export const defaultResponseBytes = 64 * 1024 * 1024;

const isValidCapacity = (capacity: number): boolean => {
  const isWhole = Number.isSafeInteger(capacity);
  const isPositive = isWhole && capacity > 0;

  return isWhole && isPositive;
};

export class RequestGate {
  private active = 0;
  private waiting: { grant: () => void; signal: AbortSignal }[] = [];
  constructor(capacity: number) {
    if (!isValidCapacity(capacity))
      throw failure(
        'INVALID_PROVIDER_CONFIGURATION',
        'Invalid endpoint capacity.',
        'not-dispatched',
      );

    this.capacity = capacity;
  }

  private capacity: number;
  /** Apply a capacity change without dropping active work or queued cancellation handlers. */
  setCapacity(capacity: number): void {
    if (!isValidCapacity(capacity))
      throw failure(
        'INVALID_PROVIDER_CONFIGURATION',
        'Invalid endpoint capacity.',
        'not-dispatched',
      );

    this.capacity = capacity;
    while (this.active < this.capacity && this.waiting.length) {
      const next = this.waiting.shift()!;
      if (!next.signal.aborted)
        next.grant();
    }
  }

  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (signal.aborted)
      throw aborted('not-dispatched');

    await new Promise<void>((resolve, reject) => {
      const entry = {
        signal,
        grant: () => {
          signal.removeEventListener('abort', abort);
          this.active++;
          resolve();
        },
      };
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0)
          this.waiting.splice(index, 1);

        reject(aborted('not-dispatched'));
      };
      if (this.active < this.capacity)
        entry.grant();
      else {
        this.waiting.push(entry);
        signal.addEventListener('abort', abort, {
          once: true,
        });
      }
    });
    try {
      if (signal.aborted)
        throw aborted('not-dispatched');

      return await action();
    } finally {
      this.active--;
      while (this.active < this.capacity && this.waiting.length) {
        const next = this.waiting.shift()!;
        if (!next.signal.aborted)
          next.grant();
      }
    }
  }
}

export interface RequestLimiter {
  run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T>;
}
export type HttpOptions = { endpoint: string; fetch: typeof fetch; gate?: RequestLimiter };
/** Validates a credential-free HTTP endpoint at the transport boundary. */
export const endpointURL = (endpoint: string): URL => {
  let url: URL;
  try {
    url = new URL(endpoint.endsWith('/') ? endpoint : endpoint + '/');
  } catch {
    throw failure(
      'INVALID_ENDPOINT',
      'Use a valid HTTP(S) endpoint without embedded credentials.',
      'not-dispatched',
    );
  }
  const usesHttp = ['http:', 'https:'].includes(url.protocol);
  const hasCredentials = Boolean(url.username || url.password);
  const hasQuery = Boolean(url.search) || endpoint.includes('?');
  const hasFragment = Boolean(url.hash) || endpoint.includes('#');
  const hasUserInfo = endpoint.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]?.includes('@');
  if (!usesHttp || hasCredentials || hasQuery || hasFragment || hasUserInfo)
    throw failure(
      'INVALID_ENDPOINT',
      'Use an HTTP(S) endpoint without embedded credentials, query or fragment.',
      'not-dispatched',
    );

  return url;
};
/** Reads an object-shaped wire value without trusting its fields. */
export const object = (value: unknown): Record<string, unknown> => {
  const isObject = value !== null && typeof value === 'object';
  const isRecord = isObject && !Array.isArray(value);
  if (!isRecord)
    return {};

  return value as Record<string, unknown>;
};
/** Returns a reported nonnegative integer count, or no count when unavailable. */
export const tokenCount = (value: unknown): number | undefined => {
  const isWhole = typeof value === 'number' && Number.isSafeInteger(value);
  const isNonnegative = isWhole && value >= 0;
  if (!isNonnegative)
    return undefined;

  return value;
};

/** Serializes outgoing data without exposing its private contents through an error. */
export const encodeJSON = (value: unknown): string => {
  try {
    const result = JSON.stringify(value);
    if (result === undefined)
      throw Error();

    return result;
  } catch (cause) {
    throw new ProviderFailure(
      'MODEL_INVALID_REQUEST',
      'The model request is not JSON serializable.',
      {
        outcome: 'not-dispatched',
        cause,
      },
    );
  }
};

/** Dispatches one HTTP request and preserves whether a failed request reached the endpoint. */
export const request = async (options: HttpOptions, route: string, init: RequestInit): Promise<Response> => {
  if (init.signal?.aborted)
    throw aborted('not-dispatched');

  if (typeof options.fetch !== 'function')
    throw failure(
      'INVALID_PROVIDER_CONFIGURATION',
      'An explicit fetch implementation is required.',
      'not-dispatched',
    );

  const url = new URL(route, endpointURL(options.endpoint));
  let response: Response;
  try {
    response = await options.fetch(url, {
      ...init,
      redirect: 'error',
    });
  } catch (error) {
    if (init.signal?.aborted)
      throw aborted('unknown');

    throw new ProviderFailure(
      'MODEL_UNAVAILABLE',
      'The configured model endpoint could not be reached.',
      {
        outcome: 'unknown',
        cause: error,
      },
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const codes: Record<number, string> = {
      400: 'MODEL_REQUEST_REJECTED',
      401: 'MODEL_AUTH_FAILED',
      402: 'MODEL_BILLING_BLOCKED',
      403: 'MODEL_AUTH_FAILED',
      404: 'MODEL_NOT_FOUND',
      429: 'MODEL_RATE_LIMITED',
    };
    throw failure(
      codes[response.status] || 'MODEL_UNAVAILABLE',
      `Model endpoint returned HTTP ${response.status}. No provider fallback was used.`,
      codes[response.status] ? 'rejected' : 'unknown',
    );
  }

  return response;
};

/** Reads bounded UTF-8 lines and releases the response reader on completion or cancellation. */
export const lines = async function* (response: Response, onProgress: () => void, maxBytes = defaultResponseBytes): AsyncGenerator<string> {
  if (!response.body)
    throw failure('MODEL_INVALID_RESPONSE', 'The model response has no body.');

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw failure('MODEL_INVALID_RESPONSE', 'The model response body cannot be read.');
  }
  const decoder = new TextDecoder('utf-8', {
    fatal: true,
  });
  const decode = (value?: Uint8Array, streaming = false) => {
    try {
      return decoder.decode(value, {
        stream: streaming,
      });
    } catch {
      throw failure('MODEL_INVALID_RESPONSE', 'The endpoint returned invalid UTF-8.');
    }
  };
  let buffer = '';
  let size = 0;
  let finished = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        buffer += decode();
        break;
      }

      size += chunk.value.byteLength;
      if (size > maxBytes)
        throw failure('MODEL_RESPONSE_LIMIT', 'The model response exceeds the response size limit.');

      observer(onProgress);
      buffer += decode(chunk.value, true);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
      }
    }
    if (buffer)
      yield buffer.replace(/\r$/, '');
  } catch (error) {
    if (isProviderFailure(error)) {
      if (error.outcome === 'unknown')
        throw error;

      throw new ProviderFailure(error.code, error.message, {
        outcome: 'unknown',
        cause: error,
      });
    }

    const wasAborted = error instanceof DOMException && error.name === 'AbortError';
    if (wasAborted)
      throw aborted('unknown');

    throw new ProviderFailure(
      'MODEL_STREAM_INTERRUPTED',
      'The model response stream was interrupted.',
      {
        outcome: 'unknown',
        cause: error,
      },
    );
  } finally {
    if (!finished)
      await reader.cancel().catch(() => {});

    reader.releaseLock();
  }
};
/** Reads one bounded JSON response without assigning trusted domain types. */
export const json = async (response: Response): Promise<unknown> => {
  let body = '';
  for await (const line of lines(response, () => {}))
    body += line + '\n';
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw failure('MODEL_INVALID_RESPONSE', 'The endpoint returned invalid JSON.');
  }
};
/** Parses model JSON while keeping malformed payload contents out of public errors. */
export const parseJSON = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw failure('MODEL_INVALID_RESPONSE', 'The model returned malformed JSON or tool arguments.');
  }
};
/** Yields complete SSE data frames, preserving request cancellation and stream failures. */
export const sse = async function* (response: Response, onProgress: () => void, maxBytes?: number): AsyncGenerator<string> {
  let data: string[] = [];
  for await (const line of lines(response, onProgress, maxBytes)) {
    if (!line) {
      if (data.length)
        yield data.join('\n');

      data = [];
    } else if (line.startsWith('data:'))
      data.push(line.slice(5).trimStart());
  }
  if (data.length)
    yield data.join('\n');
};
